const prisma = require('../../services/prisma')
const cache = require('../../services/cache')
const { ok, created, notFound, serverError, badRequest } = require('../../utils/response')
const { parsePagination, buildMeta } = require('../../utils/pagination')
const { OPERATIONAL_BRANCH_FILTER } = require('../../utils/operationalBranch')
const { currentPermissionValue } = require('../../middleware/auth')
const { allocatePayment } = require('../../utils/paymentAllocation')
const { allocateUniqueOrderId, allocateUniqueGroupRef } = require('../../utils/orderRef')
const { resolveOrderDateInput } = require('../../utils/orderDate')

const SUPPORTED_CLASS_GRADE = { gte: -2, lte: 10 }

/** Prisma default interactive tx timeout is 5s — order create runs many stock/log writes and often exceeds that on serverless + remote DB. */
const ORDER_TX_OPTIONS = { maxWait: 15_000, timeout: 60_000 }

/** KPI/report cache refresh must not block checkout response (Vercel latency). */
function scheduleOrderCacheInvalidation(branchId) {
  setImmediate(() => {
    try {
      if (branchId) cache.delByPrefix(`branch:${branchId}`)
      cache.delByPrefix('inventory:kpis')
      cache.delByPrefix('reports')
      cache.delByPrefix('transactions:kpis')
    } catch (err) {
      console.error('[orders] cache invalidation failed', err?.message)
    }
  })
}

function normalizeOrderItemSet(items) {
  return (items ?? [])
    .map((item) => ({
      itemType: item.itemType,
      key: item.bookItemId || item.uniformSizeId || item.accessoryId || item.itemId || item.label,
      quantity: Number(item.quantity || 1),
    }))
    .sort((a, b) => `${a.itemType}:${a.key}`.localeCompare(`${b.itemType}:${b.key}`))
}

function calcStockTone(qty, threshold = 50) {
  if (qty <= threshold * 0.2) return 'CRITICAL'
  if (qty <= threshold) return 'LOW'
  return 'NORMAL'
}

function buildDistributionLogNotes({
  studentName,
  rollNumber,
  classLabel,
  section,
  branchName,
  productName,
  quantityDelta,
}) {
  return [
    'Distribution',
    `Student: ${studentName}`,
    `Roll: ${rollNumber}`,
    `Class: ${classLabel} Section ${section}`,
    `Branch: ${branchName}`,
    `Product: ${productName}`,
    `Quantity: ${quantityDelta}`,
  ].join('\n')
}

/**
 * Decrement branch stock per aggregated order lines; write DISTRIBUTION inventory logs.
 * @returns {string[]} human-readable warnings when stock hits 0 after deduction
 */
async function applyOrderStockDeductions(tx, {
  branchId,
  orderItems,
  student,
  branchName,
  performedById,
  eventDate,
}) {
  const warnings = []
  const classLabel = student.class?.label ?? '—'
  const section = student.class?.section ?? '—'
  const rollNumber = student.rollNumber ?? '—'
  const studentName = student.name ?? '—'
  const logEventDate = eventDate instanceof Date ? eventDate : new Date()

  const bookDeltas = new Map()
  const uniformDeltas = new Map()
  for (const line of orderItems) {
    const qty = Math.max(0, Math.floor(Number(line.quantity ?? 1)))
    if (line.itemType === 'BOOK' && line.bookItemId) {
      bookDeltas.set(line.bookItemId, (bookDeltas.get(line.bookItemId) ?? 0) + qty)
    } else if (line.itemType === 'UNIFORM' && line.uniformSizeId) {
      uniformDeltas.set(line.uniformSizeId, (uniformDeltas.get(line.uniformSizeId) ?? 0) + qty)
    }
  }

  for (const [bookItemId, deduct] of bookDeltas) {
    const labelRow = await tx.bookKitItem.findUnique({
      where: { id: bookItemId },
      select: { label: true },
    })
    const productName = labelRow?.label ?? bookItemId

    const stock = await tx.bookStock.findUnique({
      where: { itemId_branchId: { itemId: bookItemId, branchId } },
    })
    const before = stock?.quantity ?? 0
    const after = Math.max(0, before - deduct)
    const quantityDelta = after - before

    if (before <= deduct) {
      warnings.push(
        `Stock for ${productName} is now at 0 at ${branchName}. Please replenish.`,
      )
    }

    const tone = calcStockTone(after)
    await tx.bookStock.upsert({
      where: { itemId_branchId: { itemId: bookItemId, branchId } },
      create: { itemId: bookItemId, branchId, quantity: after, tone },
      update: { quantity: after, tone },
    })

    await tx.inventoryLog.create({
      data: {
        branchId,
        itemType: 'BOOK',
        bookItemId,
        // Use enum value supported by current Prisma client for stock deduction entries.
        changeType: 'OUTGOING',
        quantityBefore: before,
        quantityAfter: after,
        quantityDelta,
        performedById,
        eventDate: logEventDate,
        notes: buildDistributionLogNotes({
          studentName,
          rollNumber,
          classLabel,
          section,
          branchName,
          productName,
          quantityDelta,
        }),
      },
    })
  }

  for (const [uniformSizeId, deduct] of uniformDeltas) {
    const sz = await tx.uniformSize.findUnique({
      where: { id: uniformSizeId },
      select: { name: true, code: true },
    })
    const productName = sz ? `${sz.name} (${sz.code})` : uniformSizeId

    const stock = await tx.uniformStock.findUnique({
      where: { sizeId_branchId: { sizeId: uniformSizeId, branchId } },
    })
    const before = stock?.quantity ?? 0
    const after = Math.max(0, before - deduct)
    const quantityDelta = after - before

    if (before <= deduct) {
      warnings.push(
        `Stock for ${productName} is now at 0 at ${branchName}. Please replenish.`,
      )
    }

    const tone = calcStockTone(after)
    await tx.uniformStock.upsert({
      where: { sizeId_branchId: { sizeId: uniformSizeId, branchId } },
      create: { sizeId: uniformSizeId, branchId, quantity: after, tone },
      update: { quantity: after, tone },
    })

    await tx.inventoryLog.create({
      data: {
        branchId,
        itemType: 'UNIFORM',
        uniformSizeId,
        // Use enum value supported by current Prisma client for stock deduction entries.
        changeType: 'OUTGOING',
        quantityBefore: before,
        quantityAfter: after,
        quantityDelta,
        performedById,
        eventDate: logEventDate,
        notes: buildDistributionLogNotes({
          studentName,
          rollNumber,
          classLabel,
          section,
          branchName,
          productName,
          quantityDelta,
        }),
      },
    })
  }

  return [...new Set(warnings)]
}

async function list(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query)
    const { branchId, paymentStatus, status, search, dateFrom, dateTo } = req.query

    const where = {
      student: { class: { grade: SUPPORTED_CLASS_GRADE } },
    }
    if (branchId) where.branchId = branchId
    if (paymentStatus) where.paymentStatus = paymentStatus
    if (status) where.status = status
    if (dateFrom || dateTo) {
      where.orderDate = {}
      if (dateFrom) where.orderDate.gte = new Date(dateFrom)
      if (dateTo) where.orderDate.lte = new Date(dateTo)
    }
    if (search) {
      where.OR = [
        { orderId: { contains: search, mode: 'insensitive' } },
        { student: { name: { contains: search, mode: 'insensitive' } } },
      ]
    }

    const [total, orders] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        skip,
        take: limit,
        orderBy: [{ orderDate: 'desc' }, { createdAt: 'desc' }],
        include: {
          student: { select: { name: true, rollNumber: true, initials: true } },
          branch: { select: { name: true, code: true } },
          _count: { select: { items: true } },
        },
      }),
    ])
    return ok(res, orders, buildMeta(total, page, limit))
  } catch {
    return serverError(res)
  }
}

async function create(req, res) {
  const startedAt = Date.now()
  console.log('[orders.create] start', { branchId: req.body?.branchId, studentId: req.body?.studentId })
  try {
    const { studentId, branchId, items, notes, discountAmount = 0, totalAmount, orderDate: orderDateRaw } = req.body
    if (!studentId || !branchId || !items?.length) {
      return badRequest(res, 'studentId, branchId, and items are required')
    }

    const dateResolved = resolveOrderDateInput(orderDateRaw)
    if (!dateResolved.ok) return badRequest(res, dateResolved.error)
    const { orderDate, bounds: orderDateBounds } = dateResolved

    const student = await prisma.students.findUnique({
      where: { id: studentId },
      include: { class: { select: { grade: true, section: true, label: true } } },
    })
    if (!student) return badRequest(res, 'Student not found')
    if (student.class.grade < -2 || student.class.grade > 10) {
      return badRequest(res, 'Orders are only supported for Nursery, LKG, UKG, and Class 1-10')
    }

    const branchRow = await prisma.branch.findFirst({
      where: { id: branchId, ...OPERATIONAL_BRANCH_FILTER },
      select: { name: true },
    })
    if (!branchRow) return badRequest(res, 'Invalid or inactive branch')
    const branchName = branchRow.name

    const result = await prisma.$transaction(async (tx) => {
      const requestedSet = normalizeOrderItemSet(items)
      const [existingToday, classData] = await Promise.all([
        tx.order.findMany({
          where: {
            studentId,
            orderDate: { gte: orderDateBounds.start, lt: orderDateBounds.end },
            status: { not: 'CANCELLED' },
          },
          include: {
            items: {
              select: {
                itemType: true,
                bookItemId: true,
                uniformSizeId: true,
                accessoryId: true,
                quantity: true,
                label: true,
              },
            },
          },
        }),
        tx.students.findUnique({
          where: { id: studentId },
          include: {
            class: {
              include: {
                bookKits: {
                  include: {
                    items: {
                      where: { isArchived: false },
                      select: { id: true },
                    },
                  },
                },
              },
            },
          },
        }),
      ])
      const duplicate = existingToday.find((existingOrder) => {
        const existingSet = normalizeOrderItemSet(existingOrder.items)
        return JSON.stringify(existingSet) === JSON.stringify(requestedSet)
      })
      if (duplicate) {
        throw new Error(`DUPLICATE_ORDER:${duplicate.orderId}`)
      }

      let subtotal = 0
      const itemsData = items.map((item) => {
        const lineTotal = item.unitPrice * item.quantity
        subtotal += lineTotal
        return {
          itemType: item.itemType,
          bookItemId: item.itemType === 'BOOK' ? item.itemId : null,
          uniformSizeId: item.itemType === 'UNIFORM' ? item.itemId : null,
          accessoryId: item.itemType === 'ACCESSORY' ? item.itemId : null,
          label: item.label,
          quantity: item.quantity,
          unitPrice: item.unitPrice,
          totalPrice: lineTotal,
        }
      })

      const adminFee = 0
      const lineSubtotal = subtotal + adminFee
      let discount = Math.max(0, Number(discountAmount) || 0)
      const hasRequestedTotal = totalAmount !== undefined && totalAmount !== null
      const requestedTotal = hasRequestedTotal ? Math.max(0, Number(totalAmount) || 0) : null
      const TOTAL_ITEMS_GAP_TOLERANCE = 150
      if (requestedTotal != null && requestedTotal - lineSubtotal > TOTAL_ITEMS_GAP_TOLERANCE) {
        throw new Error(`TOTAL_ITEMS_MISMATCH:${requestedTotal}:${lineSubtotal}`)
      }
      if (requestedTotal != null && requestedTotal < lineSubtotal) {
        discount = Math.max(discount, lineSubtotal - requestedTotal)
      }
      const totalBeforeDiscount = requestedTotal ?? lineSubtotal
      const total = Math.max(0, totalBeforeDiscount - discount)
      const storedSubtotal = requestedTotal != null ? total + discount : lineSubtotal

      const totalClassProducts =
        (classData?.class?.bookKits ?? []).reduce((n, k) => n + (k.items?.length ?? 0), 0)
      const selectedBookProducts = new Set(itemsData.filter((i) => i.itemType === 'BOOK').map((i) => i.bookItemId)).size
      const bookStatus =
        selectedBookProducts === 0 ? 'NOT_TAKEN'
          : (totalClassProducts > 0 && selectedBookProducts >= totalClassProducts ? 'TAKEN' : 'PARTIAL')

      const isFreeOrder = total === 0
      let order = null
      for (let idAttempt = 0; idAttempt < 5; idAttempt++) {
        const orderId = await allocateUniqueOrderId(tx, { reserve: idAttempt })
        try {
          order = await tx.order.create({
            data: {
              orderId,
              studentId,
              branchId,
              createdById: req.user.id,
              subtotal: storedSubtotal,
              administrativeFee: adminFee,
              total,
              paidAmount: isFreeOrder ? 0 : undefined,
              paymentStatus: isFreeOrder ? 'PAID' : 'UNPAID',
              paymentMethod: isFreeOrder ? 'OTHER' : undefined,
              status: isFreeOrder ? 'COMPLETED' : 'DRAFT',
              orderDate,
              paidAt: isFreeOrder ? orderDate : undefined,
              bookStatus,
              notes: [notes, discount > 0 ? `Discount Applied: ₹${discount.toFixed(2)}` : null].filter(Boolean).join('\n') || undefined,
              items: { create: itemsData },
            },
            include: {
              items: true,
              student: { include: { class: { select: { grade: true, section: true, label: true } } } },
            },
          })
          break
        } catch (err) {
          if (err?.code === 'P2002' && idAttempt < 4) continue
          throw err
        }
      }
      if (!order) throw new Error('ORDER_ID_EXHAUSTED')

      if (isFreeOrder) {
        await tx.transaction.create({
          data: {
            orderId: order.id,
            branchId,
            amount: 0,
            paymentMethod: 'OTHER',
            status: 'PAID',
            notes:
              discount > 0
                ? `Complimentary — full discount (₹${discount.toFixed(2)})`
                : 'Complimentary — no charge',
            paidAt: orderDate,
          },
        })
      }

      const stockWarnings = await applyOrderStockDeductions(tx, {
        branchId,
        orderItems: order.items,
        student: order.student,
        branchName,
        performedById: req.user.id,
        eventDate: orderDate,
      })

      return { order, stockWarnings }
    }, ORDER_TX_OPTIONS)

    scheduleOrderCacheInvalidation(branchId)
    console.log('[orders.create] end', { ms: Date.now() - startedAt, orderId: result.order?.orderId })
    return created(res, { order: result.order, stockWarnings: result.stockWarnings })
  } catch (err) {
    if (err?.message?.startsWith('DUPLICATE_ORDER:')) {
      const existingOrderId = err.message.split('DUPLICATE_ORDER:')[1]
      return badRequest(res, `An order with the same items already exists today (${existingOrderId}).`, [{
        code: 'DUPLICATE_ORDER',
        existingOrderId,
      }])
    }
    if (err?.message?.startsWith('TOTAL_ITEMS_MISMATCH:')) {
      const [, reqTotal, lineTotal] = err.message.split(':')
      return badRequest(
        res,
        `Order total (₹${reqTotal}) does not match selected items (₹${lineTotal}). Enable all kit bundles before placing the order.`,
        [{ code: 'TOTAL_ITEMS_MISMATCH', requestedTotal: Number(reqTotal), lineSubtotal: Number(lineTotal) }],
      )
    }
    if (err?.message === 'ORDER_ID_EXHAUSTED' || err?.message === 'GROUP_REF_EXHAUSTED') {
      return res.status(503).json({
        success: false,
        message: 'Could not assign a unique order number. Please try again.',
      })
    }
    if (err?.code === 'P2028') {
      return res.status(503).json({
        success: false,
        message: 'Database took too long to respond. Please try again.',
      })
    }
    console.error('[orders.create]', err?.code, err?.message)
    return serverError(res)
  }
}

async function getOne(req, res) {
  try {
    const branchGuard = req.user?.role !== 'SUPER_ADMIN' && req.user?.branchId
      ? { branchId: req.user.branchId }
      : {}
    const order = await prisma.order.findFirst({
      where: {
        OR: [{ id: req.params.id }, { orderId: req.params.id }],
        ...branchGuard,
        student: { class: { grade: SUPPORTED_CLASS_GRADE } },
      },
      include: {
        student: { include: { class: true } },
        branch: true,
        createdBy: { select: { displayName: true } },
        items: {
          include: {
            bookItem: { include: { kit: { include: { class: true } } } },
            uniformSize: { include: { category: true } },
            accessory: { include: { group: true } },
          },
        },
        transactions: { orderBy: { createdAt: 'desc' } },
      },
    })
    if (!order) return notFound(res, 'Order not found')
    return ok(res, order)
  } catch {
    return serverError(res)
  }
}

async function update(req, res) {
  try {
    const { status, bookStatus, uniformStatus, notes } = req.body
    const branchGuard = req.user?.role !== 'SUPER_ADMIN' && req.user?.branchId
      ? { branchId: req.user.branchId }
      : {}
    const existing = await prisma.order.findFirst({
      where: { id: req.params.id, ...branchGuard },
      select: { id: true },
    })
    if (!existing) return notFound(res, 'Order not found')
    const order = await prisma.order.update({
      where: { id: existing.id },
      data: { status, bookStatus, uniformStatus, notes },
    })
    return ok(res, order)
  } catch (err) {
    if (err.code === 'P2025') return notFound(res, 'Order not found')
    return serverError(res)
  }
}

async function processPayment(req, res) {
  const startedAt = Date.now()
  console.log('[orders.processPayment] start', { orderId: req.params.id })
  try {
    const { amount, paymentMethod, referenceId, notes, discountAmount = 0, paidAt: paidAtRaw } = req.body
    if (amount === undefined || amount === null || Number.isNaN(Number(amount))) {
      return badRequest(res, 'amount is required')
    }
    if (!paymentMethod) return badRequest(res, 'paymentMethod is required')

    const paymentAmount = Number(amount)
    if (paymentAmount < 0) return badRequest(res, 'amount cannot be negative')

    let paymentPaidAt = new Date()
    if (paidAtRaw) {
      const resolved = resolveOrderDateInput(paidAtRaw)
      if (!resolved.ok) return badRequest(res, resolved.error)
      paymentPaidAt = resolved.orderDate
    }

    const branchGuard = req.user?.role !== 'SUPER_ADMIN' && req.user?.branchId
      ? { branchId: req.user.branchId }
      : {}
    const order = await prisma.order.findFirst({ where: { id: req.params.id, ...branchGuard } })
    if (!order) return notFound(res, 'Order not found')
    if (req.user?.role !== 'SUPER_ADMIN') {
      const items = await prisma.orderItem.findMany({
        where: { orderId: order.id },
        select: { itemType: true },
      })
      const itemTypes = new Set(items.map((item) => item.itemType))
      if (itemTypes.has('BOOK') && !(await currentPermissionValue(req.user, 'canPlaceOrders'))) {
        return badRequest(res, 'Books order permission required')
      }
      if (itemTypes.has('UNIFORM') && !(await currentPermissionValue(req.user, 'canCreateUniformOrders'))) {
        return badRequest(res, 'Uniform order permission required')
      }
    }
    if (order.paymentStatus === 'PAID') {
      return badRequest(res, 'Payment is already completed for this order')
    }

    const orderTotal = Number(order.total)
    const discount = Math.max(0, Math.min(Number(discountAmount) || 0, orderTotal))
    const effectiveTotal = Math.max(0, orderTotal - discount)
    const currentPaid = Number(order.paidAmount)
    const balanceDue = Math.max(0, effectiveTotal - currentPaid)

    if (orderTotal === 0 && paymentAmount > 0) {
      return badRequest(res, 'This order has no balance due (₹0 total)')
    }
    if (paymentMethod !== 'CREDIT' && paymentAmount > balanceDue + 0.009) {
      return badRequest(res, `Payment exceeds balance due (₹${balanceDue.toFixed(2)})`)
    }
    if (paymentAmount === 0 && discount === 0 && balanceDue > 0 && paymentMethod !== 'CREDIT') {
      return badRequest(res, 'Payment amount is required')
    }

    const result = await prisma.$transaction(async (tx) => {
      const isCredit = paymentMethod === 'CREDIT'
      const paidIncrement = isCredit ? 0 : paymentAmount
      const newPaid = currentPaid + paidIncrement
      const paymentStatus =
        effectiveTotal === 0 || newPaid >= effectiveTotal - 0.009
          ? 'PAID'
          : newPaid > 0
            ? 'PARTIAL'
            : 'UNPAID'
      const txStatus = isCredit
        ? 'PARTIAL'
        : (paymentStatus === 'PAID' ? 'PAID' : 'PARTIAL')

      const transaction = await tx.transaction.create({
        data: {
          orderId: order.id,
          branchId: order.branchId,
          amount,
          paymentMethod,
          status: txStatus,
          referenceId,
          notes,
          paidAt: paymentPaidAt,
        },
      })

      const updated = await tx.order.update({
        where: { id: order.id },
        data: {
          total: discount > 0 ? effectiveTotal : order.total,
          paidAmount: newPaid,
          paymentStatus,
          paymentMethod,
          referenceId,
          paidAt: paymentStatus === 'PAID' ? paymentPaidAt : undefined,
          status: paymentStatus === 'PAID' ? 'COMPLETED' : 'PROCESSING',
          notes: discount > 0
            ? [order.notes, `Discount Applied: ₹${discount.toFixed(2)}`].filter(Boolean).join('\n') || undefined
            : order.notes,
        },
        include: { student: true, branch: true, items: true },
      })

      return { order: updated, transaction }
    }, ORDER_TX_OPTIONS)

    scheduleOrderCacheInvalidation(order.branchId)
    console.log('[orders.processPayment] end', { ms: Date.now() - startedAt, orderId: order.orderId })
    return ok(res, result)
  } catch (err) {
    console.error('[orders.processPayment] failed', err?.message)
    return serverError(res)
  }
}

async function cancel(req, res) {
  try {
    const branchGuard = req.user?.role !== 'SUPER_ADMIN' && req.user?.branchId
      ? { branchId: req.user.branchId }
      : {}
    const existing = await prisma.order.findFirst({
      where: { id: req.params.id, ...branchGuard },
      select: { id: true },
    })
    if (!existing) return notFound(res, 'Order not found')
    const order = await prisma.order.update({
      where: { id: existing.id },
      data: { status: 'CANCELLED' },
    })
    return ok(res, order)
  } catch (err) {
    if (err.code === 'P2025') return notFound(res, 'Order not found')
    return serverError(res)
  }
}

async function createGroup(req, res) {
  const startedAt = Date.now()
  console.log('[orders.createGroup] start', { branchId: req.body?.branchId, studentCount: req.body?.students?.length })
  try {
    const { branchId, students, payment, orderDate: orderDateRaw } = req.body
    if (!branchId || !students?.length || !payment?.splitDetails?.length) {
      return badRequest(res, 'branchId, students, and payment.splitDetails are required')
    }
    if (students.length < 2 || students.length > 10) {
      return badRequest(res, 'Group orders require 2–10 students')
    }

    const dateResolved = resolveOrderDateInput(orderDateRaw)
    if (!dateResolved.ok) return badRequest(res, dateResolved.error)
    const { orderDate, bounds: orderDateBounds } = dateResolved

    const studentIds = students.map((s) => s.studentId)
    if (new Set(studentIds).size !== studentIds.length) {
      return badRequest(res, 'Duplicate student IDs in group order')
    }

    const branchRow = await prisma.branch.findFirst({
      where: { id: branchId, ...OPERATIONAL_BRANCH_FILTER },
      select: { name: true },
    })
    if (!branchRow) return badRequest(res, 'Invalid or inactive branch')
    const branchName = branchRow.name

    const studentRecords = await Promise.all(
      studentIds.map((id) =>
        prisma.students.findUnique({
          where: { id },
          include: { class: { select: { grade: true, section: true, label: true, branchId: true } } },
        }),
      ),
    )

    for (const student of studentRecords) {
      if (!student) return badRequest(res, 'One or more students not found')
      if (student.class.branchId !== branchId) {
        return badRequest(res, `Student ${student.name} does not belong to branch ${branchId}`)
      }
      if (student.class.grade < -2 || student.class.grade > 10) {
        return badRequest(res, `Orders not supported for ${student.name}'s grade`)
      }
    }

    const grandTotal = students.reduce((sum, s) => sum + Math.max(0, Number(s.totalAmount ?? 0)), 0)
    const paymentTotal = payment.splitDetails.reduce((sum, p) => sum + Number(p.amount ?? 0), 0)
    if (Math.abs(paymentTotal - grandTotal) > 1) {
      return badRequest(res, `Payment total (${paymentTotal}) does not match order total (${grandTotal})`)
    }

    const result = await prisma.$transaction(async (tx) => {
      const createdOrders = []
      const allWarnings = []

      for (let i = 0; i < students.length; i++) {
        const studentInput = students[i]
        const student = studentRecords[i]
        const { items, notes, discountAmount = 0, totalAmount } = studentInput

        const requestedSet = normalizeOrderItemSet(items)
        const existingToday = await tx.order.findMany({
          where: {
            studentId: student.id,
            orderDate: { gte: orderDateBounds.start, lt: orderDateBounds.end },
            status: { not: 'CANCELLED' },
          },
          include: {
            items: {
              select: { itemType: true, bookItemId: true, uniformSizeId: true, accessoryId: true, quantity: true, label: true },
            },
          },
        })
        const duplicate = existingToday.find(
          (o) => JSON.stringify(normalizeOrderItemSet(o.items)) === JSON.stringify(requestedSet),
        )
        if (duplicate) {
          throw new Error(`DUPLICATE_ORDER:${student.name}:${duplicate.orderId}`)
        }

        let subtotal = 0
        const itemsData = items.map((item) => {
          const lineTotal = item.unitPrice * item.quantity
          subtotal += lineTotal
          return {
            itemType: item.itemType,
            bookItemId: item.itemType === 'BOOK' ? item.itemId : null,
            uniformSizeId: item.itemType === 'UNIFORM' ? item.itemId : null,
            accessoryId: item.itemType === 'ACCESSORY' ? item.itemId : null,
            label: item.label,
            quantity: item.quantity,
            unitPrice: item.unitPrice,
            totalPrice: lineTotal,
          }
        })

        const adminFee = 0
        const lineSubtotal = subtotal + adminFee
        let discount = Math.max(0, Number(discountAmount) || 0)
        const hasRequestedTotal = totalAmount !== undefined && totalAmount !== null
        const requestedTotal = hasRequestedTotal ? Math.max(0, Number(totalAmount) || 0) : null
        const TOTAL_ITEMS_GAP_TOLERANCE = 150
        if (requestedTotal != null && requestedTotal - lineSubtotal > TOTAL_ITEMS_GAP_TOLERANCE) {
          throw new Error(`TOTAL_ITEMS_MISMATCH:${student.name}:${requestedTotal}:${lineSubtotal}`)
        }
        if (requestedTotal != null && requestedTotal < lineSubtotal) {
          discount = Math.max(discount, lineSubtotal - requestedTotal)
        }
        const totalBeforeDiscount = requestedTotal ?? lineSubtotal
        const total = Math.max(0, totalBeforeDiscount - discount)
        const storedSubtotal = requestedTotal != null ? total + discount : lineSubtotal

        const classData = await tx.students.findUnique({
          where: { id: student.id },
          include: {
            class: {
              include: {
                bookKits: { include: { items: { where: { isArchived: false }, select: { id: true } } } },
              },
            },
          },
        })
        const totalClassProducts = (classData?.class?.bookKits ?? []).reduce(
          (n, k) => n + (k.items?.length ?? 0), 0,
        )
        const selectedBookProducts = new Set(
          itemsData.filter((item) => item.itemType === 'BOOK').map((item) => item.bookItemId),
        ).size
        const bookStatus =
          selectedBookProducts === 0
            ? 'NOT_TAKEN'
            : totalClassProducts > 0 && selectedBookProducts >= totalClassProducts
              ? 'TAKEN'
              : 'PARTIAL'

        let order = null
        for (let idAttempt = 0; idAttempt < 5; idAttempt++) {
          const orderId = await allocateUniqueOrderId(tx, { reserve: idAttempt })
          try {
            order = await tx.order.create({
              data: {
                orderId,
                studentId: student.id,
                branchId,
                createdById: req.user.id,
                subtotal: storedSubtotal,
                administrativeFee: adminFee,
                total,
                paidAmount: total,
                paymentStatus: 'PAID',
                paymentMethod: payment.splitDetails[0].paymentMethod,
                status: 'COMPLETED',
                orderDate,
                paidAt: orderDate,
                bookStatus,
                notes: [notes, discount > 0 ? `Discount Applied: ₹${discount.toFixed(2)}` : null].filter(Boolean).join('\n') || undefined,
                items: { create: itemsData },
              },
              include: {
                items: true,
                student: { include: { class: { select: { grade: true, section: true, label: true } } } },
              },
            })
            break
          } catch (err) {
            if (err?.code === 'P2002' && idAttempt < 4) continue
            throw err
          }
        }
        if (!order) throw new Error('ORDER_ID_EXHAUSTED')

        const warnings = await applyOrderStockDeductions(tx, {
          branchId,
          orderItems: order.items,
          student: order.student,
          branchName,
          performedById: req.user.id,
          eventDate: orderDate,
        })
        allWarnings.push(...warnings)
        createdOrders.push(order)
      }

      const allocations = allocatePayment(
        createdOrders.map((o) => ({ id: o.id, branchId, total: Number(o.total) })),
        payment.splitDetails,
      )
      for (const alloc of allocations) {
        if (alloc.amount <= 0) continue
        await tx.transaction.create({
          data: {
            orderId: alloc.orderId,
            branchId: alloc.branchId,
            amount: alloc.amount,
            paymentMethod: alloc.paymentMethod,
            status: 'PAID',
            paidAt: orderDate,
          },
        })
      }

      const groupTotal = createdOrders.reduce((sum, o) => sum + Number(o.total), 0)
      let group = null
      for (let refAttempt = 0; refAttempt < 5; refAttempt++) {
        const groupRef = await allocateUniqueGroupRef(tx, { reserve: refAttempt })
        try {
          group = await tx.transactionGroup.create({
            data: {
              groupRef,
              branchId,
              createdById: req.user.id,
              totalAmount: groupTotal,
              splitDetails: payment.splitDetails,
              paidAt: orderDate,
              orders: { connect: createdOrders.map((o) => ({ id: o.id })) },
            },
          })
          break
        } catch (err) {
          if (err?.code === 'P2002' && refAttempt < 4) continue
          throw err
        }
      }
      if (!group) throw new Error('GROUP_REF_EXHAUSTED')

      return { group, orders: createdOrders, stockWarnings: [...new Set(allWarnings)] }
    }, ORDER_TX_OPTIONS)

    scheduleOrderCacheInvalidation(branchId)
    console.log('[orders.createGroup] end', { ms: Date.now() - startedAt, groupRef: result.group?.groupRef })
    return created(res, {
      groupId: result.group.id,
      groupRef: result.group.groupRef,
      orders: result.orders,
      stockWarnings: result.stockWarnings,
    })
  } catch (err) {
    if (err?.message?.startsWith('DUPLICATE_ORDER:')) {
      const [, studentName, existingOrderId] = err.message.split(':')
      return badRequest(
        res,
        `Duplicate order for ${studentName} (${existingOrderId}). Group order cancelled — no orders were created.`,
        [{ code: 'DUPLICATE_ORDER', studentName, existingOrderId }],
      )
    }
    if (err?.message?.startsWith('TOTAL_ITEMS_MISMATCH:')) {
      const [, studentName, reqTotal, lineTotal] = err.message.split(':')
      return badRequest(
        res,
        `Total mismatch for ${studentName}: requested ₹${reqTotal}, items total ₹${lineTotal}.`,
        [{ code: 'TOTAL_ITEMS_MISMATCH', studentName }],
      )
    }
    if (err?.message === 'ORDER_ID_EXHAUSTED' || err?.message === 'GROUP_REF_EXHAUSTED') {
      return res.status(503).json({
        success: false,
        message: 'Could not assign a unique order number. Please try again.',
      })
    }
    if (err?.code === 'P2028') {
      return res.status(503).json({
        success: false,
        message: 'Database took too long. Please try again or place each student\'s order individually.',
      })
    }
    console.error('[orders.createGroup]', err?.code, err?.message)
    return serverError(res)
  }
}

async function getGroup(req, res) {
  try {
    const branchGuard =
      req.user?.role !== 'SUPER_ADMIN' && req.user?.branchId
        ? { branchId: req.user.branchId }
        : {}
    const group = await prisma.transactionGroup.findFirst({
      where: { id: req.params.groupId, ...branchGuard },
      include: {
        branch: true,
        createdBy: { select: { displayName: true } },
        orders: {
          include: {
            student: { include: { class: true } },
            branch: true,
            createdBy: { select: { displayName: true } },
            items: {
              include: {
                bookItem: { include: { kit: { include: { class: true } } } },
                uniformSize: { include: { category: true } },
                accessory: { include: { group: true } },
              },
            },
            transactions: { orderBy: { createdAt: 'desc' } },
          },
        },
      },
    })
    if (!group) return notFound(res, 'Group not found')
    return ok(res, group)
  } catch {
    return serverError(res)
  }
}

async function getStudentOrders(req, res) {
  try {
    const { studentId } = req.params
    const student = await prisma.students.findUnique({
      where: { id: studentId },
      include: { class: { select: { branchId: true } } },
    })
    if (!student) return notFound(res, 'Student not found')
    if (
      req.user?.role !== 'SUPER_ADMIN' &&
      req.user?.branchId &&
      student.class?.branchId !== req.user.branchId
    ) {
      return res.status(403).json({ success: false, message: 'Forbidden' })
    }

    const branchGuard =
      req.user?.role !== 'SUPER_ADMIN' && req.user?.branchId
        ? { branchId: req.user.branchId }
        : {}

    const orders = await prisma.order.findMany({
      where: { studentId, status: { not: 'CANCELLED' }, ...branchGuard },
      orderBy: [{ orderDate: 'desc' }, { createdAt: 'desc' }],
      include: {
        branch: { select: { name: true, code: true } },
        items: {
          include: {
            bookItem: true,
            uniformSize: { include: { category: true } },
            accessory: true,
          },
        },
        transactions: {
          orderBy: { createdAt: 'asc' },
          select: { paymentMethod: true, amount: true, status: true },
        },
      },
    })
    return ok(res, orders)
  } catch {
    return serverError(res)
  }
}

module.exports = { list, create, getOne, update, processPayment, cancel, createGroup, getGroup, getStudentOrders }
