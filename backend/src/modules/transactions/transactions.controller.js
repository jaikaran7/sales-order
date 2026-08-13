const prisma = require('../../services/prisma')
const cache = require('../../services/cache')
const { ok, notFound, serverError } = require('../../utils/response')
const { parsePagination, buildMeta } = require('../../utils/pagination')
const { sumPaymentBuckets, isCashPaymentMethod, isOnlinePaymentMethod } = require('../../utils/paymentMethodBuckets')
const {
  computeOrderDue,
  isPureCreditDueOrder,
  creditOrderMatchesDateRange,
} = require('../../utils/orderDue')
const {
  resolveTransactionBranchScope,
  applyBranchToTransactionWhere,
  applyBranchToOrderWhere,
} = require('../../utils/transactionBranchScope')

/** Map itemCategory query param ('books'|'uniforms') to Prisma ItemType enum value. */
function resolveItemTypeFilter(itemCategory) {
  if (itemCategory === 'books') return 'BOOK'
  if (itemCategory === 'uniforms') return 'UNIFORM'
  return null
}

/**
 * Share of an order's line items for one category (books vs uniforms).
 * Fraction uses raw line totals as the denominator so checkout rounding in order.total is preserved.
 */
function computeCategoryFraction(orderItems, itemType) {
  const items = orderItems ?? []
  const categorySubtotal = items
    .filter((i) => i.itemType === itemType)
    .reduce((sum, i) => sum + Number(i.totalPrice ?? 0), 0)
  const allSubtotal = items.reduce((sum, i) => sum + Number(i.totalPrice ?? 0), 0)
  if (!categorySubtotal || !allSubtotal) return { categorySubtotal, fraction: 0 }
  return { categorySubtotal, fraction: categorySubtotal / allSubtotal }
}

function isCombinedOrder(orderItems) {
  const items = orderItems ?? []
  const hasBooks = items.some((i) => i.itemType === 'BOOK')
  const hasUniforms = items.some((i) => i.itemType === 'UNIFORM')
  return hasBooks && hasUniforms
}

/** Allocate a payment amount to one category; books/uniforms-only orders keep the rounded checkout total. */
function allocateCategoryPayment(orderItems, paymentAmount, itemType) {
  const amount = Number(paymentAmount) || 0
  if (!itemType || !amount) return amount
  if (!isCombinedOrder(orderItems)) return amount
  const { fraction } = computeCategoryFraction(orderItems, itemType)
  return amount * fraction
}

const SUPPORTED_CLASS_GRADE = { gte: -2, lte: 10 }

/** Shared filters for transaction list + KPI aggregates (aligned with reports queries). */
function buildTransactionWhere(query, { includeSearch = true } = {}) {
  const { status, paymentMethod, search, dateFrom, dateTo, classGrade, itemCategory } = query
  const branchScope = resolveTransactionBranchScope(query)
  if (branchScope.error) return branchScope

  const classGradeNum = classGrade != null && classGrade !== '' ? Number(classGrade) : null
  const classGradeFilter = classGradeNum != null && !Number.isNaN(classGradeNum) ? classGradeNum : null

  // Build conditions as an explicit AND array so Prisma applies each filter independently.
  const conditions = []

  // Always restrict to supported grade range; narrow to specific grade when requested.
  conditions.push({
    order: {
      student: {
        class: { grade: classGradeFilter !== null ? classGradeFilter : SUPPORTED_CLASS_GRADE },
      },
    },
  })

  applyBranchToTransactionWhere(conditions, branchScope)

  // Payment status filter
  if (status) conditions.push({ status })

  // Payment method filter
  if (paymentMethod) conditions.push({ paymentMethod })

  // Date range filter
  if (dateFrom || dateTo) {
    const paidAt = {}
    if (dateFrom) paidAt.gte = new Date(dateFrom)
    if (dateTo) paidAt.lte = new Date(dateTo)
    conditions.push({ paidAt })
  }

  // Item category filter — restrict to orders containing at least one item of the given type
  const itemType = resolveItemTypeFilter(itemCategory)
  if (itemType) {
    conditions.push({ order: { items: { some: { itemType } } } })
  }

  // Search filter — must be separate so OR doesn't bypass the AND conditions above
  if (includeSearch && search) {
    conditions.push({
      OR: [
        { order: { orderId: { contains: search, mode: 'insensitive' } } },
        { order: { student: { name: { contains: search, mode: 'insensitive' } } } },
        { order: { student: { rollNumber: { contains: search, mode: 'insensitive' } } } },
      ],
    })
  }

  return { AND: conditions }
}

/** Resolve dateFrom/dateTo from explicit range or legacy period query param. */
function resolveQueryDateRange(query) {
  const { period } = query
  let { dateFrom, dateTo } = query

  if (period && !dateFrom && !dateTo) {
    const now = new Date()
    if (period === 'today') {
      const start = new Date(now); start.setHours(0, 0, 0, 0)
      const end = new Date(now); end.setHours(23, 59, 59, 999)
      dateFrom = start.toISOString(); dateTo = end.toISOString()
    } else if (period === 'week') {
      const start = new Date(now); start.setDate(now.getDate() - 6); start.setHours(0, 0, 0, 0)
      dateFrom = start.toISOString(); dateTo = now.toISOString()
    } else if (period === 'month') {
      const start = new Date(now); start.setDate(1); start.setHours(0, 0, 0, 0)
      dateFrom = start.toISOString(); dateTo = now.toISOString()
    }
  }

  return { dateFrom, dateTo }
}

/** KPI aggregates — same filters as list, but without search (reports-style branch + paidAt). */
function buildKpiWhere(query) {
  const { status, paymentMethod, search, classGrade, itemCategory } = query
  const { dateFrom, dateTo } = resolveQueryDateRange(query)
  const branchScope = resolveTransactionBranchScope(query)
  if (branchScope.error) return branchScope

  const classGradeNum = classGrade != null && classGrade !== '' ? Number(classGrade) : null
  const classGradeFilter = classGradeNum != null && !Number.isNaN(classGradeNum) ? classGradeNum : null

  const conditions = []

  if (classGradeFilter !== null) {
    conditions.push({ order: { student: { class: { grade: classGradeFilter } } } })
  } else {
    conditions.push({ order: { student: { class: { grade: SUPPORTED_CLASS_GRADE } } } })
  }

  applyBranchToTransactionWhere(conditions, branchScope)

  if (status) conditions.push({ status })
  if (paymentMethod) conditions.push({ paymentMethod })

  if (dateFrom || dateTo) {
    const paidAt = {}
    if (dateFrom) paidAt.gte = new Date(dateFrom)
    if (dateTo) paidAt.lte = new Date(dateTo)
    conditions.push({ paidAt })
  }

  const itemType = resolveItemTypeFilter(itemCategory)
  if (itemType) {
    conditions.push({ order: { items: { some: { itemType } } } })
  }

  if (search) {
    conditions.push({
      OR: [
        { order: { orderId: { contains: search, mode: 'insensitive' } } },
        { order: { student: { name: { contains: search, mode: 'insensitive' } } } },
        { order: { student: { rollNumber: { contains: search, mode: 'insensitive' } } } },
      ],
    })
  }

  return { AND: conditions }
}

/** Open-order scope for outstanding credit KPI (date + credit type applied in memory). */
function buildOutstandingCreditOrderWhere(query) {
  const { search, classGrade } = query
  const branchScope = resolveTransactionBranchScope(query)
  if (branchScope.error) return branchScope

  const classGradeNum = classGrade != null && classGrade !== '' ? Number(classGrade) : null
  const classGradeFilter = classGradeNum != null && !Number.isNaN(classGradeNum) ? classGradeNum : null

  const conditions = [
    { status: { not: 'CANCELLED' } },
    { paymentStatus: { in: ['UNPAID', 'PARTIAL'] } },
    { paidAmount: { equals: 0 } },
    {
      student: {
        class: { grade: classGradeFilter !== null ? classGradeFilter : SUPPORTED_CLASS_GRADE },
      },
    },
  ]

  applyBranchToOrderWhere(conditions, branchScope)

  if (search) {
    conditions.push({
      OR: [
        { orderId: { contains: search, mode: 'insensitive' } },
        { student: { name: { contains: search, mode: 'insensitive' } } },
        { student: { rollNumber: { contains: search, mode: 'insensitive' } } },
      ],
    })
  }

  return { AND: conditions }
}

async function computeOutstandingCreditKpi(query) {
  const { paymentMethod, status } = query
  if (paymentMethod && paymentMethod !== 'CREDIT') return 0
  if (status && !['UNPAID', 'PARTIAL'].includes(status)) return 0

  const where = buildOutstandingCreditOrderWhere(query)
  if (where.error) return 0

  const { dateFrom, dateTo } = resolveQueryDateRange(query)

  const orders = await prisma.order.findMany({
    where,
    select: {
      total: true,
      paidAmount: true,
      notes: true,
      paymentStatus: true,
      orderDate: true,
      createdAt: true,
      transactions: {
        select: {
          notes: true,
          paymentMethod: true,
          paidAt: true,
          createdAt: true,
        },
      },
    },
  })

  return orders
    .filter((order) => isPureCreditDueOrder(order))
    .filter((order) => creditOrderMatchesDateRange(order, dateFrom, dateTo))
    .reduce((sum, order) => sum + computeOrderDue(order).dueAmount, 0)
}

/** Category KPIs: revenue computed from OrderItem.totalPrice proportioned by item type fraction. */
async function computeCategoryKpis(query, itemType) {
  const transactionWhere = buildKpiWhere(query)
  if (transactionWhere.error) return { error: transactionWhere.error }

  const txs = await prisma.transaction.findMany({
    where: transactionWhere,
    select: {
      amount: true,
      paymentMethod: true,
      order: {
        select: {
          id: true,
          studentId: true,
          total: true,
          items: { select: { itemType: true, totalPrice: true } },
        },
      },
    },
  })

  let cashReceived = 0
  let onlineReceived = 0
  const seenOrders = new Set()
  const seenStudents = new Set()

  for (const tx of txs) {
    const proportioned = allocateCategoryPayment(tx.order?.items, tx.amount, itemType)
    if (isCashPaymentMethod(tx.paymentMethod)) cashReceived += proportioned
    else if (isOnlinePaymentMethod(tx.paymentMethod)) onlineReceived += proportioned
    if (tx.order?.id) seenOrders.add(tx.order.id)
    if (tx.order?.studentId) seenStudents.add(tx.order.studentId)
  }

  return {
    revenueToday: cashReceived + onlineReceived,
    ordersToday: seenOrders.size,
    uniqueStudents: seenStudents.size,
    cashReceived,
    onlineReceived,
    creditReceived: 0,
    pendingPartial: 0,
  }
}

async function getKpis(req, res) {
  try {
    const { branchId, allBranches, dateFrom, dateTo, status, paymentMethod, classGrade, search, itemCategory } = req.query
    const { period } = req.query
    const cacheKey = `transactions:kpis:v19:${branchId || ''}:${allBranches || ''}:${period || ''}:${dateFrom || ''}:${dateTo || ''}:${status || ''}:${paymentMethod || ''}:${classGrade || ''}:${search || ''}:${itemCategory || ''}`
    const cached = cache.get(cacheKey)
    if (cached) return ok(res, cached)

    // Category-specific KPIs use item-level revenue computation
    const itemType = resolveItemTypeFilter(itemCategory)
    if (itemType) {
      const result = await computeCategoryKpis(req.query, itemType)
      if (result.error) return res.status(400).json({ success: false, message: result.error })
      cache.set(cacheKey, result, cache.TTL.KPI)
      return ok(res, result)
    }

    const transactionWhere = buildKpiWhere(req.query)
    if (transactionWhere.error) {
      return res.status(400).json({ success: false, message: transactionWhere.error })
    }
    const partialWhere = { AND: [...transactionWhere.AND, { status: { in: ['PARTIAL', 'UNPAID'] } }] }

    const [orderGroups, byMethod, partialAgg, studentRows, creditReceived] = await Promise.all([
      prisma.transaction.groupBy({
        by: ['orderId'],
        where: transactionWhere,
      }),
      prisma.transaction.groupBy({
        by: ['paymentMethod'],
        where: transactionWhere,
        _sum: { amount: true },
      }),
      prisma.transaction.aggregate({
        _sum: { amount: true },
        where: partialWhere,
      }),
      prisma.transaction.findMany({
        where: transactionWhere,
        select: { order: { select: { studentId: true } } },
      }),
      computeOutstandingCreditKpi(req.query),
    ])

    const { cashReceived, onlineReceived } = sumPaymentBuckets(byMethod)
    const uniqueStudents = new Set(studentRows.map((row) => row.order?.studentId).filter(Boolean)).size

    const data = {
      // Real collections only — credit sales count when cleared via cash/online (paidAt = pay day).
      revenueToday: cashReceived + onlineReceived,
      ordersToday: orderGroups.length,
      uniqueStudents,
      cashReceived,
      onlineReceived,
      creditReceived,
      pendingPartial: Number(partialAgg._sum.amount || 0),
    }
    cache.set(cacheKey, data, cache.TTL.KPI)
    return ok(res, data)
  } catch (err) {
    console.error('transactions.getKpis', err)
    return serverError(res)
  }
}

async function listByStudent(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query)

    const where = buildTransactionWhere(req.query, { includeSearch: true })
    if (where.error) {
      return res.status(400).json({ success: false, message: where.error })
    }

    const transactions = await prisma.transaction.findMany({
      where,
      orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        amount: true,
        paymentMethod: true,
        status: true,
        notes: true,
        paidAt: true,
        createdAt: true,
        branchId: true,
        order: {
          select: {
            id: true,
            orderId: true,
            notes: true,
            total: true,
            paidAmount: true,
            paymentStatus: true,
            orderDate: true,
            createdAt: true,
            student: {
              select: {
                id: true,
                name: true,
                initials: true,
                rollNumber: true,
                guardianName: true,
                guardianPhone: true,
                class: { select: { label: true, section: true } },
              },
            },
            branch: { select: { id: true, name: true, code: true } },
          },
        },
      },
    })

    const groups = new Map()
    for (const tx of transactions) {
      const studentId = tx.order?.student?.id
      if (!studentId) continue

      if (!groups.has(studentId)) {
        groups.set(studentId, {
          id: studentId,
          studentId,
          student: tx.order.student,
          order: tx.order,
          orderId: tx.order?.orderId ?? tx.id,
          orderPk: tx.order?.id ?? null,
          branch: tx.order?.branch ?? null,
          branchId: tx.branchId ?? tx.order?.branch?.id ?? null,
          totalAmount: 0,
          transactionCount: 0,
          paymentMethods: [],
          paymentMethodSet: new Set(),
          latestPaidAt: tx.paidAt ?? tx.createdAt,
          latestCreatedAt: tx.createdAt,
          latestRemark: '',
          orderPaymentStatuses: new Map(),
        })
      }

      const group = groups.get(studentId)
      group.totalAmount += Number(tx.amount ?? 0)
      group.transactionCount += 1
      if (tx.paymentMethod && !group.paymentMethodSet.has(tx.paymentMethod)) {
        group.paymentMethodSet.add(tx.paymentMethod)
        group.paymentMethods.push(tx.paymentMethod)
      }

      if (tx.order?.id) {
        group.orderPaymentStatuses.set(tx.order.id, tx.order.paymentStatus)
      }

      const remark = String(tx.notes || tx.order?.notes || '').trim()
      if (!group.latestRemark && remark) group.latestRemark = remark
    }

    const grouped = [...groups.values()].map((group) => {
      const statuses = [...group.orderPaymentStatuses.values()]
      const fullyPaid = statuses.length > 0 && statuses.every((status) => status === 'PAID')
      return {
        id: group.id,
        studentId: group.studentId,
        student: group.student,
        order: {
          id: group.orderPk,
          orderId: group.orderId,
          student: group.student,
          branch: group.branch,
        },
        orderPk: group.orderPk,
        orderId: group.orderId,
        branch: group.branch,
        branchId: group.branchId,
        totalAmount: group.totalAmount,
        amount: group.totalAmount,
        transactionCount: group.transactionCount,
        paymentMethods: group.paymentMethods,
        paymentMethod: group.paymentMethods.join('+'),
        status: fullyPaid ? 'FULLY_PAID' : 'PARTIAL',
        remarks: group.latestRemark,
        notes: group.latestRemark,
        paidAt: group.latestPaidAt,
        createdAt: group.latestCreatedAt,
      }
    })

    const total = grouped.length
    const rows = grouped.slice(skip, skip + limit)

    return ok(res, rows, buildMeta(total, page, limit))
  } catch (err) {
    console.error('transactions.listByStudent', err)
    return serverError(res)
  }
}

async function list(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query)
    const { itemCategory } = req.query
    const itemType = resolveItemTypeFilter(itemCategory)

    const where = buildTransactionWhere(req.query, { includeSearch: true })
    if (where.error) {
      return res.status(400).json({ success: false, message: where.error })
    }

    const [total, rows] = await Promise.all([
      prisma.transaction.count({ where }),
      prisma.transaction.findMany({
        where,
        skip,
        take: limit,
        orderBy: { paidAt: 'desc' },
        include: {
          order: {
            select: {
              id: true,
              orderId: true,
              notes: true,
              total: true,
              transactionGroupId: true,
              orderDate: true,
              createdAt: true,
              student: {
                select: {
                  id: true,
                  name: true,
                  initials: true,
                  rollNumber: true,
                  guardianName: true,
                  guardianPhone: true,
                  class: { select: { label: true, section: true } },
                },
              },
              branch: { select: { name: true, code: true } },
              items: { select: { itemType: true, totalPrice: true } },
            },
          },
        },
      }),
    ])

    // Annotate each transaction with per-category amounts when category filter is active
    const annotated = rows.map((tx) => {
      const orderItems = tx.order?.items ?? []
      const hasBooks = orderItems.some((i) => i.itemType === 'BOOK')
      const hasUniforms = orderItems.some((i) => i.itemType === 'UNIFORM')
      const isCombined = isCombinedOrder(orderItems)

      if (!itemType) {
        return { ...tx, hasBooks, hasUniforms, isCombined }
      }

      const categoryAmount = isCombined
        ? allocateCategoryPayment(orderItems, tx.amount, itemType)
        : undefined

      return {
        ...tx,
        hasBooks,
        hasUniforms,
        isCombined,
        ...(categoryAmount != null ? { categoryAmount } : {}),
      }
    })

    // Collapse group transactions: show one row per TransactionGroup
    const seenGroupIds = new Set()
    const collapsedRows = []
    for (const tx of annotated) {
      const groupId = tx.order?.transactionGroupId
      if (!groupId) {
        collapsedRows.push(tx)
        continue
      }
      if (seenGroupIds.has(groupId)) continue
      seenGroupIds.add(groupId)
      const groupTxs = annotated.filter((r) => r.order?.transactionGroupId === groupId)
      const studentNames = [
        ...new Map(
          groupTxs.map((r) => [r.order?.student?.id, r.order?.student?.name]),
        ).values(),
      ].filter(Boolean)
      const groupTotal = groupTxs.reduce((sum, r) => sum + Number(r.amount ?? 0), 0)
      const groupCategoryAmount = itemType
        ? groupTxs.reduce((sum, r) => sum + Number(r.categoryAmount ?? r.amount ?? 0), 0)
        : undefined
      collapsedRows.push({
        ...tx,
        isGroup: true,
        groupId,
        studentCount: studentNames.length,
        studentNames,
        amount: groupTotal,
        ...(groupCategoryAmount != null ? { categoryAmount: groupCategoryAmount } : {}),
      })
    }
    return ok(res, collapsedRows, buildMeta(total, page, limit))
  } catch {
    return serverError(res)
  }
}

async function listDues(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query)
    const { search, classGrade, paymentStatus, paymentMethod } = req.query
    const { dateFrom, dateTo } = resolveQueryDateRange(req.query)
    const branchScope = resolveTransactionBranchScope(req.query)
    if (branchScope.error) {
      return res.status(400).json({ success: false, message: branchScope.error })
    }

    const classGradeNum = classGrade != null && classGrade !== '' ? Number(classGrade) : null
    const classGradeFilter = classGradeNum != null && !Number.isNaN(classGradeNum) ? classGradeNum : null

    const dueConditions = [
      { status: { not: 'CANCELLED' } },
      { paymentStatus: paymentStatus || { in: ['UNPAID', 'PARTIAL'] } },
      { student: { class: { grade: classGradeFilter !== null ? classGradeFilter : SUPPORTED_CLASS_GRADE } } },
    ]

    applyBranchToOrderWhere(dueConditions, branchScope)
    if (paymentMethod) dueConditions.push({ paymentMethod })
    if (dateFrom || dateTo) {
      const orderDate = {}
      if (dateFrom) orderDate.gte = new Date(dateFrom)
      if (dateTo) orderDate.lte = new Date(dateTo)
      dueConditions.push({ orderDate })
    }
    if (search) {
      dueConditions.push({
        OR: [
          { orderId: { contains: search, mode: 'insensitive' } },
          { student: { name: { contains: search, mode: 'insensitive' } } },
          { student: { rollNumber: { contains: search, mode: 'insensitive' } } },
        ],
      })
    }

    const where = { AND: dueConditions }

    const rows = await prisma.order.findMany({
      where,
      orderBy: [{ orderDate: 'desc' }, { createdAt: 'desc' }],
      include: {
        student: {
          select: {
            id: true,
            name: true,
            initials: true,
            rollNumber: true,
            guardianName: true,
            guardianPhone: true,
            class: { select: { id: true, grade: true, label: true, section: true } },
          },
        },
        branch: { select: { id: true, name: true, code: true } },
        transactions: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            amount: true,
            paymentMethod: true,
            status: true,
            paidAt: true,
            createdAt: true,
            notes: true,
          },
        },
      },
    })

    const filtered = rows
      .map((order) => {
        const { totalAmount, paidAmount, effectiveTotal, dueAmount, discountAmount } = computeOrderDue(order)
        return {
          ...order,
          totalAmount: effectiveTotal,
          paidAmount,
          dueAmount,
          discountAmount,
          originalTotal: totalAmount,
          transactions: order.transactions.slice(0, 3),
        }
      })
      .filter((row) => row.dueAmount > 0.009)

    const totalPendingDue = filtered.reduce((sum, row) => sum + row.dueAmount, 0)
    const totalCreditDue = filtered
      .filter((row) => isPureCreditDueOrder(row))
      .reduce((sum, row) => sum + row.dueAmount, 0)

    const total = filtered.length
    const paged = filtered.slice(skip, skip + limit)

    return ok(res, paged, {
      ...buildMeta(total, page, limit),
      totalPendingDue,
      totalCreditDue,
    })
  } catch {
    return serverError(res)
  }
}

async function getOne(req, res) {
  const isTransientConnectionError = (err) => {
    const msg = String(err?.message ?? '')
    return (
      err?.code === 'P2024' || // Prisma pool timeout
      msg.includes('Server has closed the connection') ||
      msg.includes('Timed out fetching a new connection from the connection pool') ||
      msg.includes('Error in PostgreSQL connection')
    )
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

  try {
    // Support lookup by transaction id or order id
    const { id } = req.params
    let order = null
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        order = await prisma.order.findFirst({
          where: {
            OR: [{ id }, { orderId: id }],
            ...(req.user?.role !== 'SUPER_ADMIN' && req.user?.branchId ? { branchId: req.user.branchId } : {}),
            student: { class: { grade: SUPPORTED_CLASS_GRADE } },
          },
          include: {
            student: { include: { class: true } },
            branch: true,
            createdBy: { select: { displayName: true } },
            items: {
              include: {
                bookItem: true,
                uniformSize: { include: { category: true } },
                accessory: true,
              },
            },
            transactions: { orderBy: { createdAt: 'asc' } },
          },
        })
        break
      } catch (err) {
        if (!isTransientConnectionError(err) || attempt === 2) throw err
        try {
          await prisma.$connect()
        } catch {
          // Ignore connect errors; retry may still succeed.
        }
        await sleep(120)
      }
    }

    if (!order) return notFound(res, 'Transaction not found')
    return ok(res, order)
  } catch (err) {
    if (isTransientConnectionError(err)) {
      return serverError(res, 'Database is temporarily busy. Please retry in a few seconds.')
    }
    return serverError(res)
  }
}

module.exports = { getKpis, list, listByStudent, listDues, getOne }
