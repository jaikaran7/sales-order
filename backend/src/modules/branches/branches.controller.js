const prisma = require('../../services/prisma')
const cache = require('../../services/cache')
const { ok, created, notFound, serverError, badRequest } = require('../../utils/response')
const { MIN_GRADE, MAX_GRADE, classLabelForGrade } = require('../../utils/schoolGrades')
const { OPERATIONAL_BRANCH_FILTER } = require('../../utils/operationalBranch')
const { computeOrderDue } = require('../../utils/orderDue')

function branchCacheKeys() {
  return ['branches:operational', 'branches:all:withArchived']
}

async function list(req, res) {
  try {
    const includeArchived = req.user.role === 'SUPER_ADMIN' && req.query.includeArchived === 'true'
    const cacheKey = includeArchived ? 'branches:all:withArchived' : 'branches:operational'
    const cached = cache.get(cacheKey)
    if (cached) return ok(res, cached)

    const branches = await prisma.branch.findMany({
      where: includeArchived ? {} : OPERATIONAL_BRANCH_FILTER,
      orderBy: [{ name: 'asc' }],
    })
    cache.set(cacheKey, branches, cache.TTL.LONG)
    return ok(res, branches)
  } catch {
    return serverError(res)
  }
}

async function create(req, res) {
  try {
    const { name, code, address, phone, email } = req.body
    if (!name || !code) return badRequest(res, 'name and code are required')

    const branch = await prisma.branch.create({
      data: { name, code: code.toUpperCase(), type: 'BRANCH', address, phone, email },
    })
    branchCacheKeys().forEach((k) => cache.del(k))
    return created(res, branch)
  } catch (err) {
    if (err.code === 'P2002') return badRequest(res, 'Branch code already exists')
    return serverError(res)
  }
}

async function getOne(req, res) {
  try {
    const includeArchived = req.user.role === 'SUPER_ADMIN' && req.query.includeArchived === 'true'
    const branch = await prisma.branch.findUnique({ where: { id: req.params.branchId } })
    if (!branch) return notFound(res, 'Branch not found')
    if (!includeArchived && branch.deletedAt) return notFound(res, 'Branch not found')
    return ok(res, branch)
  } catch {
    return serverError(res)
  }
}

async function update(req, res) {
  try {
    const { name, address, phone, email, isActive } = req.body
    const branch = await prisma.branch.update({
      where: { id: req.params.branchId },
      data: { name, address, phone, email, isActive },
    })
    branchCacheKeys().forEach((k) => cache.del(k))
    return ok(res, branch)
  } catch (err) {
    if (err.code === 'P2025') return notFound(res, 'Branch not found')
    return serverError(res)
  }
}

async function getKpis(req, res) {
  try {
    const branchId = req.params.branchId
    const cacheKey = `branch:${branchId}:kpis`
    const cached = cache.get(cacheKey)
    if (cached) return ok(res, cached)

    const today = new Date()
    today.setHours(0, 0, 0, 0)

    const [revenueToday, ordersToday, pendingPayments, totalStudents] = await Promise.all([
      prisma.transaction.aggregate({
        _sum: { amount: true },
        where: { branchId, paidAt: { gte: today } },
      }),
      prisma.order.count({ where: { branchId, createdAt: { gte: today } } }),
      prisma.order.count({ where: { branchId, paymentStatus: 'PARTIAL' } }),
      prisma.students.count({
        where: {
          class: { branchId, grade: { gte: MIN_GRADE, lte: MAX_GRADE } },
          isActive: true,
        },
      }),
    ])

    const data = {
      revenueToday: Number(revenueToday._sum.amount || 0),
      ordersToday,
      pendingPayments,
      totalStudents,
    }
    cache.set(cacheKey, data, cache.TTL.KPI)
    return ok(res, data)
  } catch {
    return serverError(res)
  }
}

async function getClasses(req, res) {
  try {
    const classes = await prisma.academicClass.findMany({
      where: {
        branchId: req.params.branchId,
        grade: { gte: MIN_GRADE, lte: MAX_GRADE },
      },
      orderBy: [{ grade: 'asc' }, { section: 'asc' }],
      include: { _count: { select: { students: true } } },
    })
    return ok(res, classes)
  } catch {
    return serverError(res)
  }
}

async function createClass(req, res) {
  try {
    const { grade, section, academicYear } = req.body
    if (grade === undefined || grade === null || !section) return badRequest(res, 'grade and section are required')
    if (grade < MIN_GRADE || grade > MAX_GRADE) return badRequest(res, 'grade must be Nursery, LKG, UKG, or Class 1-10')
    const label = `${classLabelForGrade(grade)}-${section}`
    const cls = await prisma.academicClass.create({
      data: { grade: parseInt(grade), section, label, branchId: req.params.branchId, academicYear },
    })
    return created(res, cls)
  } catch (err) {
    if (err.code === 'P2002') return badRequest(res, 'Class already exists for this branch and year')
    return serverError(res)
  }
}

async function getStudents(req, res) {
  try {
    const { payment, books, uniform } = req.query
    const where = { classId: req.params.classId, isActive: true }

    const students = await prisma.students.findMany({
      where,
      include: {
        orders: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            orderId: true,
            status: true,
            paymentStatus: true,
            paymentMethod: true,
            bookStatus: true,
            uniformStatus: true,
            notes: true,
            total: true,
            paidAmount: true,
            paidAt: true,
            createdAt: true,
            transactions: {
              orderBy: { createdAt: 'asc' },
              select: { paymentMethod: true, amount: true },
            },
          },
        },
      },
      orderBy: { name: 'asc' },
    })

    // Apply status filters from latest order
    const filtered = students.filter((s) => {
      const latest = s.orders[0]
      if (!latest) return true
      if (payment && payment !== 'all') {
        if (payment === 'paid' && latest.paymentStatus !== 'PAID') return false
        if (payment === 'unpaid' && latest.paymentStatus !== 'UNPAID') return false
        if (payment === 'partial' && latest.paymentStatus !== 'PARTIAL') return false
      }
      return true
    })

    const withOrderSummary = filtered.map((student) => {
      const activeOrders = student.orders.filter(
        (o) => !['CANCELLED', 'DRAFT'].includes(o.status),
      )
      const latest = student.orders[0]
      const latestConfirmedOrder = activeOrders[0]
      const latestRemarkOrder = student.orders.find((o) => String(o.notes ?? '').trim())
      const openDueOrder = student.orders.find((o) => {
        if (o.status === 'CANCELLED') return false
        if (!['UNPAID', 'PARTIAL'].includes(o.paymentStatus)) return false
        return computeOrderDue(o).dueAmount > 0.009
      })
      const dueOrder = openDueOrder ?? null
      const dueBreakdown = dueOrder ? computeOrderDue(dueOrder) : null
      const totalAmount = Number(dueOrder?.total ?? latest?.total ?? 0)
      const paidAmount = Number(dueOrder?.paidAmount ?? latest?.paidAmount ?? 0)
      const dueAmount = dueBreakdown?.dueAmount ?? 0
      const txns = (dueOrder ?? latest)?.transactions ?? []
      const methodSummary = txns.length
        ? Array.from(new Set(txns.map((t) => t.paymentMethod).filter(Boolean))).join('+')
        : (latest?.paymentMethod ?? null)

      // Cumulative status across all non-cancelled orders
      const anyTaken = activeOrders.some((o) => o.bookStatus === 'TAKEN')
      const anyPartialBook = activeOrders.some((o) => o.bookStatus === 'PARTIAL')
      const cumulativeBookStatus = anyTaken ? 'TAKEN' : anyPartialBook ? 'PARTIAL' : 'NOT_TAKEN'

      const anyComplete = activeOrders.some((o) => o.uniformStatus === 'COMPLETE')
      const cumulativeUniformStatus = anyComplete ? 'COMPLETE' : 'PENDING'

      const allPaid =
        activeOrders.length > 0 && activeOrders.every((o) => o.paymentStatus === 'PAID')
      const anyUnpaid = activeOrders.some((o) =>
        ['PARTIAL', 'UNPAID'].includes(o.paymentStatus),
      )
      const cumulativePaymentStatus = allPaid ? 'PAID' : anyUnpaid ? 'PARTIAL' : 'UNPAID'

      const allRemarks = activeOrders
        .map((o) => String(o.notes ?? '').trim())
        .filter(Boolean)

      return {
        ...student,
        latestOrderId: dueOrder?.orderId ?? latest?.orderId ?? null,
        latestOrderInternalId: dueOrder?.id ?? latest?.id ?? null,
        latestOrderDate: latestConfirmedOrder?.paidAt ?? latestConfirmedOrder?.createdAt ?? null,
        latestOrderRemarks: latestRemarkOrder?.notes?.trim() ?? null,
        latestPaymentMethod: methodSummary,
        dueAmount,
        totalAmount,
        paidAmount,
        cumulativeBookStatus,
        cumulativeUniformStatus,
        cumulativePaymentStatus,
        allRemarks,
        orderCount: activeOrders.length,
      }
    })

    return ok(res, withOrderSummary)
  } catch {
    return serverError(res)
  }
}

async function createStudent(req, res) {
  try {
    const { classId, name, rollNumber, fatherName, contactNo, address } = req.body
    if (!classId || !name) return badRequest(res, 'classId and name are required')

    const cls = await prisma.academicClass.findUnique({ where: { id: classId } })
    if (!cls) return notFound(res, 'Class not found')

    const roll = rollNumber ?? String(Date.now()).slice(-6)
    const initials = name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()

    const student = await prisma.students.create({
      data: { name, rollNumber: roll, initials, guardianName: fatherName ?? null, guardianPhone: contactNo ?? null, classId },
    })

    await prisma.academicClass.update({
      where: { id: classId },
      data: { studentCount: { increment: 1 } },
    })

    return created(res, student)
  } catch (err) {
    if (err.code === 'P2002') return badRequest(res, 'Roll number already exists in this class')
    return serverError(res)
  }
}

async function bulkCreateStudents(req, res) {
  try {
    const { classId, students } = req.body
    if (!classId || !Array.isArray(students) || students.length === 0) {
      return badRequest(res, 'classId and students array are required')
    }

    const cls = await prisma.academicClass.findUnique({ where: { id: classId } })
    if (!cls) return notFound(res, 'Class not found')

    let successCount = 0
    const errors = []

    for (const [i, s] of students.entries()) {
      if (!s.name) { errors.push({ row: i + 1, reason: 'Name is required' }); continue }
      const rollNumber = s.rollNumber ?? String(i + 1)
      const initials = s.name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase()
      try {
        await prisma.students.upsert({
          where: { rollNumber_classId: { rollNumber, classId } },
          update: { name: s.name, guardianName: s.fatherName ?? null, guardianPhone: s.contactNo ?? null },
          create: {
            name: s.name,
            rollNumber,
            initials,
            guardianName: s.fatherName ?? null,
            guardianPhone: s.contactNo ?? null,
            classId,
          },
        })
        successCount++
      } catch (err) {
        errors.push({ row: i + 1, reason: err.message })
      }
    }

    await prisma.academicClass.update({
      where: { id: classId },
      data: { studentCount: await prisma.students.count({ where: { classId, isActive: true } }) },
    })

    return ok(res, { successCount, errorCount: errors.length, errors })
  } catch {
    return serverError(res)
  }
}

/** Soft-delete (archive): hides branch from lists and blocks new operations. */
async function softDelete(req, res) {
  const { branchId } = req.params
  try {
    const existing = await prisma.branch.findUnique({ where: { id: branchId } })
    if (!existing) return notFound(res, 'Branch not found')
    if (existing.deletedAt) return badRequest(res, 'Branch is already archived')

    await prisma.branch.update({
      where: { id: branchId },
      data: { deletedAt: new Date(), isActive: false },
    })
    branchCacheKeys().forEach((k) => cache.del(k))
    cache.delByPrefix('reports')
    cache.delByPrefix('branch:')
    return ok(res, { archived: true, id: branchId })
  } catch {
    return serverError(res)
  }
}

/**
 * Hard-delete a branch and all dependent rows (students, kits, stocks, orders, etc.).
 * Requires confirmBranchCode matching the branch code. Use ?hard=true on DELETE.
 */
async function destroy(req, res) {
  const { branchId } = req.params
  const confirmBranchCode = String(req.body?.confirmBranchCode ?? '')
    .trim()
    .toUpperCase()

  try {
    const branch = await prisma.branch.findUnique({ where: { id: branchId } })
    if (!branch) return notFound(res, 'Branch not found')

    if (confirmBranchCode !== branch.code.toUpperCase()) {
      return badRequest(
        res,
        `Hard delete requires JSON body { "confirmBranchCode": "${branch.code}" }`,
      )
    }

    await prisma.$transaction(async (tx) => {
      await tx.transaction.deleteMany({ where: { branchId } })
      await tx.order.deleteMany({ where: { branchId } })
      await tx.stockTransfer.deleteMany({
        where: { OR: [{ fromBranchId: branchId }, { toBranchId: branchId }] },
      })
      await tx.procurementEntry.deleteMany({ where: { branchId } })
      await tx.inventoryLog.deleteMany({ where: { branchId } })
      await tx.bookStock.deleteMany({ where: { branchId } })
      await tx.uniformStock.deleteMany({ where: { branchId } })
      await tx.accessoryStock.deleteMany({ where: { branchId } })
      await tx.bookKit.deleteMany({ where: { class: { branchId } } })
      await tx.students.deleteMany({ where: { class: { branchId } } })
      await tx.academicClass.deleteMany({ where: { branchId } })
      await tx.user.deleteMany({ where: { branchId } })
      await tx.branch.delete({ where: { id: branchId } })
    })

    branchCacheKeys().forEach((k) => cache.del(k))
    cache.delByPrefix('reports')
    cache.delByPrefix('branch:')
    return ok(res, { deleted: true, id: branchId })
  } catch (err) {
    if (err.code === 'P2003')
      return badRequest(res, 'Cannot delete branch until related references are cleared (foreign key violation).')
    return serverError(res)
  }
}

/** Default DELETE = soft archive; hard wipe when query hard=true and body confirms code. */
async function remove(req, res) {
  const hard = req.query.hard === 'true' || req.query.hard === '1'
  if (hard) return destroy(req, res)
  return softDelete(req, res)
}

module.exports = {
  list,
  create,
  getOne,
  update,
  getKpis,
  getClasses,
  createClass,
  getStudents,
  createStudent,
  bulkCreateStudents,
  softDelete,
  destroy,
  remove,
}
