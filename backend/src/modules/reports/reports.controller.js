const prisma = require('../../services/prisma')
const cache = require('../../services/cache')
const { ok, badRequest, serverError } = require('../../utils/response')
const { OPERATIONAL_BRANCH_FILTER } = require('../../utils/operationalBranch')

/** Map frontend itemCategory param to Prisma ItemType enum value, or null for all. */
function resolveReportItemType(itemCategory) {
  if (itemCategory === 'books') return 'BOOK'
  if (itemCategory === 'uniforms') return 'UNIFORM'
  return null
}

const SUPPORTED_CLASS_GRADE = { gte: -2, lte: 10 }

function dateRange(daysBack) {
  const to = new Date()
  const from = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000)
  return { from, to }
}

/** Calendar-day bounds from YYYY-MM-DD in the server local timezone (matches browser presets). */
function parseDayStart(isoDate) {
  const s = String(isoDate || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const [y, m, d] = s.split('-').map((x) => parseInt(x, 10))
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d, 0, 0, 0, 0)
}

function parseDayEnd(isoDate) {
  const s = String(isoDate || '').slice(0, 10)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
  const [y, m, d] = s.split('-').map((x) => parseInt(x, 10))
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d, 23, 59, 59, 999)
}

function resolveDashboardRange(q) {
  if (q.dateFrom && q.dateTo) {
    const from = parseDayStart(q.dateFrom)
    const to = parseDayEnd(q.dateTo)
    if (from && to && from <= to) {
      return { from, to, cacheSuffix: `${q.dateFrom}:${q.dateTo}` }
    }
  }
  const now = new Date()
  const from = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0)
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
  return { from, to, cacheSuffix: 'today' }
}

function resolveBranchPerfRange(q) {
  if (q.dateFrom && q.dateTo) {
    const from = parseDayStart(q.dateFrom)
    const to = parseDayEnd(q.dateTo)
    if (from && to && from <= to) {
      return { from, to, cacheSuffix: `r:${q.dateFrom}:${q.dateTo}` }
    }
  }
  const days = Math.min(Math.max(parseInt(q.days, 10) || 30, 1), 366)
  const to = new Date()
  to.setHours(23, 59, 59, 999)
  const from = new Date(to.getTime() - (days - 1) * 24 * 60 * 60 * 1000)
  from.setHours(0, 0, 0, 0)
  return { from, to, cacheSuffix: `d${days}` }
}

function countDistinctStudents(rows) {
  return new Set((rows ?? []).map((row) => row.studentId).filter(Boolean)).size
}

function distinctStudentsByBranch(rows) {
  const byBranch = {}
  for (const row of rows ?? []) {
    if (!row.branchId || !row.studentId) continue
    if (!byBranch[row.branchId]) byBranch[row.branchId] = new Set()
    byBranch[row.branchId].add(row.studentId)
  }
  return Object.fromEntries(Object.entries(byBranch).map(([branchId, set]) => [branchId, set.size]))
}

async function branchPerformance(req, res) {
  try {
    const { from, to, cacheSuffix } = resolveBranchPerfRange(req.query)
    const { itemCategory } = req.query
    const itemType = resolveReportItemType(itemCategory)
    const scopeKey =
      req.query.branchId ||
      (req.user?.role !== 'SUPER_ADMIN' && req.user?.branchId ? req.user.branchId : 'all')
    const cacheKey = `reports:branch-perf:v5:${cacheSuffix}:s:${scopeKey}:c:${itemCategory || 'all'}`
    const cached = cache.get(cacheKey)
    if (cached) return ok(res, cached)

    const branchWhere = {
      ...OPERATIONAL_BRANCH_FILTER,
      ...(req.query.branchId ? { id: req.query.branchId } : {}),
    }

    const branches = await prisma.branch.findMany({
      where: branchWhere,
      select: { id: true, name: true, code: true, type: true },
      orderBy: { name: 'asc' },
    })
    const branchIds = branches.map((b) => b.id)
    if (branchIds.length === 0) {
      const empty = []
      cache.set(cacheKey, empty, cache.TTL.MEDIUM)
      return ok(res, empty)
    }

    const itemTypeFilter = itemType ? { items: { some: { itemType } } } : {}
    const orderBaseWhere = { branchId: { in: branchIds }, orderDate: { gte: from, lte: to }, ...itemTypeFilter }

    const [orderRows, revenueData, pendingOrders, uniqueStudentRows] = await Promise.all([
      prisma.order.findMany({ where: orderBaseWhere, select: { branchId: true } }),
      itemType
        ? prisma.transaction.findMany({
            where: { branchId: { in: branchIds }, paidAt: { gte: from, lte: to }, order: { items: { some: { itemType } } } },
            select: {
              branchId: true,
              amount: true,
              order: { select: { total: true, items: { select: { itemType: true, totalPrice: true } } } },
            },
          })
        : prisma.transaction.groupBy({
            by: ['branchId'],
            where: { branchId: { in: branchIds }, paidAt: { gte: from, lte: to } },
            _sum: { amount: true },
          }),
      prisma.order.findMany({
        where: { ...orderBaseWhere, paymentStatus: { in: ['UNPAID', 'PARTIAL'] } },
        select: { branchId: true, total: true, paidAmount: true },
      }),
      prisma.order.findMany({ where: orderBaseWhere, select: { branchId: true, studentId: true } }),
    ])

    const orderCountMap = {}
    for (const o of orderRows) {
      orderCountMap[o.branchId] = (orderCountMap[o.branchId] || 0) + 1
    }
    const uniqueStudentMap = distinctStudentsByBranch(uniqueStudentRows)

    const revenueMap = {}
    if (itemType) {
      for (const t of revenueData) {
        const items = t.order?.items ?? []
        const hasBooks = items.some((i) => i.itemType === 'BOOK')
        const hasUniforms = items.some((i) => i.itemType === 'UNIFORM')
        const amt = Number(t.amount)
        if (!hasBooks || !hasUniforms) {
          revenueMap[t.branchId] = (revenueMap[t.branchId] || 0) + amt
          continue
        }
        const categorySubtotal = items
          .filter((i) => i.itemType === itemType)
          .reduce((s, i) => s + Number(i.totalPrice ?? 0), 0)
        const allSubtotal = items.reduce((s, i) => s + Number(i.totalPrice ?? 0), 0)
        revenueMap[t.branchId] = (revenueMap[t.branchId] || 0) + amt * (categorySubtotal / (allSubtotal || 1))
      }
    } else {
      for (const r of revenueData) {
        revenueMap[r.branchId] = Number(r._sum.amount || 0)
      }
    }

    const pendingMap = {}
    for (const o of pendingOrders) {
      const bal = Math.max(0, Number(o.total) - Number(o.paidAmount))
      pendingMap[o.branchId] = (pendingMap[o.branchId] || 0) + bal
    }

    const data = branches.map((b) => ({
      id: b.id,
      name: b.name,
      code: b.code,
      type: b.type,
      totalOrders: orderCountMap[b.id] ?? 0,
      uniqueStudents: uniqueStudentMap[b.id] ?? 0,
      revenue: revenueMap[b.id] ?? 0,
      pendingRevenue: pendingMap[b.id] ?? 0,
    }))

    cache.set(cacheKey, data, cache.TTL.MEDIUM)
    return ok(res, data)
  } catch {
    return serverError(res)
  }
}

async function salesTrend(req, res) {
  try {
    const { branchId, days = 7, dateFrom, dateTo, itemCategory } = req.query
    const itemType = resolveReportItemType(itemCategory)
    let from
    let to
    let cacheKeyPart

    if (dateFrom && dateTo) {
      const a = parseDayStart(dateFrom)
      const b = parseDayEnd(dateTo)
      if (!a || !b || a > b) return badRequest(res, 'Invalid dateFrom / dateTo')
      from = a
      to = b
      cacheKeyPart = `r:${dateFrom}:${dateTo}:${branchId || 'all'}:${itemCategory || 'all'}`
    } else {
      const dr = dateRange(parseInt(days, 10) || 7)
      from = dr.from
      to = dr.to
      cacheKeyPart = `${branchId || 'all'}:${days}:${itemCategory || 'all'}`
    }

    const cacheKey = `reports:trend:v5:${cacheKeyPart}`
    const cached = cache.get(cacheKey)
    if (cached) return ok(res, cached)

    const where = {
      paidAt: { gte: from, lte: to },
      ...(branchId ? { branchId } : { branch: OPERATIONAL_BRANCH_FILTER }),
      ...(itemType ? { order: { items: { some: { itemType } } } } : {}),
    }

    const transactions = await prisma.transaction.findMany({
      where,
      select: {
        amount: true,
        paidAt: true,
        order: {
          select: {
            studentId: true,
            total: true,
            ...(itemType ? { items: { select: { itemType: true, totalPrice: true } } } : {}),
          },
        },
      },
      orderBy: { paidAt: 'asc' },
    })

    const grouped = {}
    for (const t of transactions) {
      const day = t.paidAt.toISOString().slice(0, 10)
      if (!grouped[day]) grouped[day] = { total: 0, transactionCount: 0, students: new Set() }

      let amount = Number(t.amount)
      if (itemType && t.order?.items) {
        const items = t.order.items
        const hasBooks = items.some((i) => i.itemType === 'BOOK')
        const hasUniforms = items.some((i) => i.itemType === 'UNIFORM')
        if (hasBooks && hasUniforms) {
          const categorySubtotal = items
            .filter((i) => i.itemType === itemType)
            .reduce((s, i) => s + Number(i.totalPrice ?? 0), 0)
          const allSubtotal = items.reduce((s, i) => s + Number(i.totalPrice ?? 0), 0)
          amount = amount * (categorySubtotal / (allSubtotal || 1))
        }
      }

      grouped[day].total += amount
      grouped[day].transactionCount += 1
      if (t.order?.studentId) grouped[day].students.add(t.order.studentId)
    }

    const trend = Object.entries(grouped).map(([date, row]) => ({
      date,
      total: row.total,
      transactionCount: row.transactionCount,
      uniqueStudents: row.students.size,
    }))
    cache.set(cacheKey, trend, cache.TTL.KPI)
    return ok(res, trend)
  } catch {
    return serverError(res)
  }
}

async function superDashboard(req, res) {
  try {
    const { from, to, cacheSuffix } = resolveDashboardRange(req.query)
    // v5: order counts use business orderDate (not createdAt audit time)
    const cacheKey = `reports:super-dashboard:v5:${cacheSuffix}`
    const cached = cache.get(cacheKey)
    if (cached) return ok(res, cached)

    const orderWindow = {
      orderDate: { gte: from, lte: to },
      branch: OPERATIONAL_BRANCH_FILTER,
    }

    const [
      revenueAgg,
      ordersCount,
      pendingRows,
      totalBranches,
      recentOrders,
      branchStats,
      branchRevenueRows,
      studentRows,
      branchStudentRows,
    ] = await Promise.all([
      prisma.transaction.aggregate({
        _sum: { amount: true },
        where: {
          paidAt: { gte: from, lte: to },
          branch: OPERATIONAL_BRANCH_FILTER,
        },
      }),
      prisma.order.count({ where: orderWindow }),
      prisma.order.findMany({
        where: {
          ...orderWindow,
          paymentStatus: { in: ['UNPAID', 'PARTIAL'] },
        },
        select: { total: true, paidAmount: true },
      }),
      prisma.branch.count({ where: OPERATIONAL_BRANCH_FILTER }),
      prisma.order.findMany({
        take: 10,
        where: orderWindow,
        orderBy: [{ orderDate: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          orderId: true,
          total: true,
          paymentStatus: true,
          orderDate: true,
          createdAt: true,
          student: { select: { name: true, initials: true } },
          branch: { select: { name: true, code: true } },
        },
      }),
      prisma.branch.findMany({
        where: OPERATIONAL_BRANCH_FILTER,
        include: {
          _count: { select: { orders: true } },
        },
      }),
      prisma.transaction.groupBy({
        by: ['branchId'],
        where: {
          paidAt: { gte: from, lte: to },
          branch: OPERATIONAL_BRANCH_FILTER,
        },
        _sum: { amount: true },
      }),
      prisma.order.findMany({
        where: orderWindow,
        select: { studentId: true },
      }),
      prisma.order.findMany({
        where: orderWindow,
        select: { branchId: true, studentId: true },
      }),
    ])

    let pendingRevenue = 0
    for (const o of pendingRows) {
      const bal = Number(o.total) - Number(o.paidAmount)
      if (bal > 0) pendingRevenue += bal
    }
    const pendingPayments = pendingRows.length

    const revByBranch = Object.fromEntries(
      branchRevenueRows.map((r) => [r.branchId, Number(r._sum.amount || 0)]),
    )
    const studentsByBranch = distinctStudentsByBranch(branchStudentRows)

    const data = {
      kpis: {
        revenueToday: Number(revenueAgg._sum.amount || 0),
        ordersToday: ordersCount,
        studentsToday: countDistinctStudents(studentRows),
        uniqueStudents: countDistinctStudents(studentRows),
        pendingRevenue,
        pendingPayments,
        totalBranches,
      },
      recentOrders,
      branchStats: branchStats.map((b) => {
        const tr = revByBranch[b.id] ?? 0
        return {
          id: b.id,
          name: b.name,
          code: b.code,
          type: b.type,
          totalOrders: b._count.orders,
          studentsToday: studentsByBranch[b.id] ?? 0,
          uniqueStudents: studentsByBranch[b.id] ?? 0,
          todayRevenue: tr,
          revenue: tr,
        }
      }),
    }
    cache.set(cacheKey, data, cache.TTL.KPI)
    return ok(res, data)
  } catch {
    return serverError(res)
  }
}

async function adminDashboard(req, res) {
  try {
    const { branchId } = req.query
    const { from, to, cacheSuffix } = resolveDashboardRange(req.query)
    const cacheKey = `reports:admin-dashboard:v5:${branchId || 'none'}:${cacheSuffix}`
    const cached = cache.get(cacheKey)
    if (cached) return ok(res, cached)

    const baseOrder = branchId ? { branchId } : { branch: OPERATIONAL_BRANCH_FILTER }

    const [revenueAgg, ordersCount, studentRows, pendingOrdersInPeriod, recentOrders, inventorySnapshot] = await Promise.all([
      prisma.transaction.aggregate({
        _sum: { amount: true },
        where: {
          ...(branchId ? { branchId } : { branch: OPERATIONAL_BRANCH_FILTER }),
          paidAt: { gte: from, lte: to },
        },
      }),
      prisma.order.count({
        where: {
          ...baseOrder,
          orderDate: { gte: from, lte: to },
        },
      }),
      prisma.order.findMany({
        where: {
          ...baseOrder,
          orderDate: { gte: from, lte: to },
        },
        select: { studentId: true },
      }),
      prisma.order.findMany({
        where: {
          ...baseOrder,
          orderDate: { gte: from, lte: to },
          paymentStatus: { in: ['UNPAID', 'PARTIAL'] },
        },
        select: { total: true, paidAmount: true },
      }),
      prisma.order.findMany({
        where: {
          ...baseOrder,
          orderDate: { gte: from, lte: to },
        },
        take: 10,
        orderBy: [{ orderDate: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          orderId: true,
          total: true,
          paymentStatus: true,
          orderDate: true,
          createdAt: true,
          student: { select: { name: true, initials: true } },
          branch: { select: { name: true, code: true } },
        },
      }),
      branchId
        ? Promise.all([
            prisma.bookStock.aggregate({
              _sum: { quantity: true },
              where: {
                branchId,
                item: { kit: { class: { grade: SUPPORTED_CLASS_GRADE } } },
              },
            }),
            prisma.uniformStock.aggregate({ _sum: { quantity: true }, where: { branchId } }),
          ])
        : Promise.resolve([{ _sum: { quantity: 0 } }, { _sum: { quantity: 0 } }]),
    ])

    let pendingRevenue = 0
    for (const o of pendingOrdersInPeriod) {
      const bal = Number(o.total) - Number(o.paidAmount)
      if (bal > 0) pendingRevenue += bal
    }

    const [booksSnap, uniformsSnap] = inventorySnapshot
    const data = {
      kpis: {
        revenueToday: Number(revenueAgg._sum.amount || 0),
        ordersToday: ordersCount,
        studentsToday: countDistinctStudents(studentRows),
        uniqueStudents: countDistinctStudents(studentRows),
        pendingRevenue,
        pendingPayments: pendingOrdersInPeriod.length,
      },
      recentOrders,
      inventorySnapshot: {
        booksStock: Number(booksSnap._sum.quantity || 0),
        uniformsStock: Number(uniformsSnap._sum.quantity || 0),
      },
    }
    cache.set(cacheKey, data, cache.TTL.KPI)
    return ok(res, data)
  } catch {
    return serverError(res)
  }
}

module.exports = { branchPerformance, salesTrend, superDashboard, adminDashboard }
