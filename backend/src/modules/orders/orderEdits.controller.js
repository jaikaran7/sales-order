/**
 * Order edit requests — pending Superadmin approval before live order changes.
 */
const prisma = require('../../services/prisma')
const cache = require('../../services/cache')
const { ok, created, notFound, serverError, badRequest, forbidden } = require('../../utils/response')
const { parsePagination, buildMeta } = require('../../utils/pagination')
const { resolveOrderDateInput, toIstDateString } = require('../../utils/orderDate')
const { currentPermissionValue } = require('../../middleware/auth')

const ORDER_TX_OPTIONS = { maxWait: 15_000, timeout: 120_000 }
const PAYMENT_METHODS = new Set([
  'CASH', 'ONLINE', 'CANARA_UPI', 'BOB_UPI', 'UPI_BHARATH', 'UPI_POORNIMA',
  'UPI_RAJANI', 'UPI_VARALAXMI', 'UPI_INDU', 'UPI_BHARATHI',
  'CARD', 'CHEQUE', 'BANK_TRANSFER', 'GPAY', 'PHONEPE', 'PAYTM', 'CREDIT', 'OTHER',
])

function scheduleCacheInvalidation(branchId) {
  setImmediate(() => {
    try {
      if (branchId) cache.delByPrefix(`branch:${branchId}`)
      cache.delByPrefix('inventory:kpis')
      cache.delByPrefix('reports')
      cache.delByPrefix('transactions:kpis')
    } catch (err) {
      console.error('[orderEdits] cache invalidation failed', err?.message)
    }
  })
}

function calcStockTone(qty, threshold = 50) {
  if (qty <= threshold * 0.2) return 'CRITICAL'
  if (qty <= threshold) return 'LOW'
  return 'NORMAL'
}

function money(v) {
  return Number(v ?? 0)
}

function fingerprintOrder(order) {
  const items = (order.items ?? [])
    .map((i) => `${i.id}:${i.itemType}:${i.bookItemId || i.uniformSizeId || i.accessoryId}:${i.quantity}:${money(i.unitPrice)}`)
    .sort()
    .join('|')
  const txs = (order.transactions ?? [])
    .map((t) => `${t.id}:${money(t.amount)}:${t.paymentMethod}:${t.status}`)
    .sort()
    .join('|')
  return [
    order.updatedAt?.toISOString?.() ?? order.updatedAt,
    money(order.total),
    money(order.paidAmount),
    order.paymentStatus,
    order.orderDate?.toISOString?.() ?? order.orderDate,
    items,
    txs,
  ].join('::')
}

async function loadOrderFull(client, orderId, branchGuard = {}) {
  return client.order.findFirst({
    where: { id: orderId, ...branchGuard, status: { not: 'CANCELLED' } },
    include: {
      student: { include: { class: { select: { grade: true, section: true, label: true } } } },
      branch: { select: { id: true, name: true, code: true } },
      items: true,
      transactions: { orderBy: { paidAt: 'asc' } },
    },
  })
}

function snapshotFromOrder(order) {
  return {
    fingerprint: fingerprintOrder(order),
    orderId: order.orderId,
    id: order.id,
    branchId: order.branchId,
    studentId: order.studentId,
    status: order.status,
    paymentStatus: order.paymentStatus,
    paymentMethod: order.paymentMethod,
    bookStatus: order.bookStatus,
    uniformStatus: order.uniformStatus,
    subtotal: money(order.subtotal),
    administrativeFee: money(order.administrativeFee),
    total: money(order.total),
    paidAmount: money(order.paidAmount),
    notes: order.notes,
    orderDate: order.orderDate,
    paidAt: order.paidAt,
    items: (order.items ?? []).map((i) => ({
      id: i.id,
      itemType: i.itemType,
      bookItemId: i.bookItemId,
      uniformSizeId: i.uniformSizeId,
      accessoryId: i.accessoryId,
      label: i.label,
      quantity: i.quantity,
      unitPrice: money(i.unitPrice),
      totalPrice: money(i.totalPrice),
    })),
    transactions: (order.transactions ?? []).map((t) => ({
      id: t.id,
      amount: money(t.amount),
      paymentMethod: t.paymentMethod,
      status: t.status,
      referenceId: t.referenceId,
      notes: t.notes,
      paidAt: t.paidAt,
    })),
  }
}

function buildDiffSummary(before, after) {
  const changes = []
  const headerFields = ['orderDate', 'notes', 'bookStatus', 'uniformStatus', 'total', 'paidAmount', 'paymentStatus', 'paymentMethod', 'status']
  for (const f of headerFields) {
    const b = before[f]
    const a = after[f]
    const bVal = b instanceof Date ? b.toISOString() : b
    const aVal = a instanceof Date ? a.toISOString() : a
    if (JSON.stringify(bVal) !== JSON.stringify(aVal)) {
      changes.push({ field: f, from: bVal, to: aVal })
    }
  }
  const beforeItems = JSON.stringify((before.items ?? []).map((i) => ({
    t: i.itemType, k: i.bookItemId || i.uniformSizeId || i.accessoryId, q: i.quantity, p: i.unitPrice, l: i.label,
  })))
  const afterItems = JSON.stringify((after.items ?? []).map((i) => ({
    t: i.itemType, k: i.bookItemId || i.uniformSizeId || i.accessoryId, q: i.quantity, p: i.unitPrice, l: i.label,
  })))
  if (beforeItems !== afterItems) {
    changes.push({ field: 'items', from: before.items, to: after.items })
  }
  const beforeTx = JSON.stringify((before.transactions ?? []).map((t) => ({
    a: t.amount, m: t.paymentMethod, s: t.status,
  })))
  const afterTx = JSON.stringify((after.transactions ?? []).map((t) => ({
    a: t.amount, m: t.paymentMethod, s: t.status,
  })))
  if (beforeTx !== afterTx) {
    changes.push({ field: 'transactions', from: before.transactions, to: after.transactions })
  }
  return changes
}

function normalizeProposedItems(rawItems) {
  if (!Array.isArray(rawItems) || rawItems.length < 1) {
    throw new Error('At least one item is required')
  }
  return rawItems.map((item) => {
    const itemType = item.itemType
    if (!['BOOK', 'UNIFORM', 'ACCESSORY'].includes(itemType)) {
      throw new Error(`Invalid itemType: ${itemType}`)
    }
    const quantity = Math.max(1, Math.floor(Number(item.quantity ?? 1)))
    const unitPrice = Number(item.unitPrice)
    if (!(unitPrice >= 0)) throw new Error('unitPrice must be >= 0')
    const itemId = item.itemId || item.bookItemId || item.uniformSizeId || item.accessoryId
    if (!itemId) throw new Error('Each item needs itemId')
    if (!item.label) throw new Error('Each item needs label')
    return {
      itemType,
      bookItemId: itemType === 'BOOK' ? itemId : null,
      uniformSizeId: itemType === 'UNIFORM' ? itemId : null,
      accessoryId: itemType === 'ACCESSORY' ? itemId : null,
      label: String(item.label),
      quantity,
      unitPrice,
      totalPrice: unitPrice * quantity,
    }
  })
}

function normalizeProposedTransactions(rawTxs, orderDate) {
  if (!Array.isArray(rawTxs)) return []
  return rawTxs.map((tx) => {
    const amount = Number(tx.amount)
    if (Number.isNaN(amount)) throw new Error('transaction amount invalid')
    const paymentMethod = tx.paymentMethod
    if (!PAYMENT_METHODS.has(paymentMethod)) throw new Error(`Invalid paymentMethod: ${paymentMethod}`)
    let paidAt = orderDate
    if (tx.paidAt) {
      const resolved = resolveOrderDateInput(typeof tx.paidAt === 'string' ? tx.paidAt.slice(0, 10) : null)
      if (resolved.ok) paidAt = resolved.orderDate
      else if (tx.paidAt instanceof Date || !Number.isNaN(new Date(tx.paidAt).getTime())) {
        paidAt = new Date(tx.paidAt)
      }
    }
    return {
      amount,
      paymentMethod,
      status: tx.status || (paymentMethod === 'CREDIT' ? 'PARTIAL' : 'PAID'),
      referenceId: tx.referenceId || null,
      notes: tx.notes || null,
      paidAt,
    }
  })
}

function derivePaymentFields(items, transactions, orderDate, meta = {}) {
  const subtotal = items.reduce((s, i) => s + money(i.totalPrice), 0)
  const total = meta.total != null ? Math.max(0, Number(meta.total)) : subtotal
  const nonCreditPaid = transactions
    .filter((t) => t.paymentMethod !== 'CREDIT')
    .reduce((s, t) => s + money(t.amount), 0)
  const paidAmount = meta.paidAmount != null ? Math.max(0, Number(meta.paidAmount)) : nonCreditPaid
  let paymentStatus = 'UNPAID'
  if (total <= 0.009 || paidAmount >= total - 0.009) paymentStatus = 'PAID'
  else if (paidAmount > 0.009 || transactions.some((t) => t.paymentMethod === 'CREDIT')) paymentStatus = 'PARTIAL'

  const lastMethod = transactions.length ? transactions[transactions.length - 1].paymentMethod : meta.paymentMethod || null
  const status = paymentStatus === 'PAID' ? 'COMPLETED' : (paymentStatus === 'PARTIAL' ? 'PROCESSING' : (meta.status || 'DRAFT'))
  const paidAt = paymentStatus === 'PAID' ? (transactions[transactions.length - 1]?.paidAt || orderDate) : null

  return {
    subtotal,
    administrativeFee: 0,
    total,
    paidAmount,
    paymentStatus,
    paymentMethod: lastMethod,
    status,
    paidAt,
    bookStatus: meta.bookStatus || 'PARTIAL',
    uniformStatus: meta.uniformStatus || 'PENDING',
    notes: meta.notes ?? null,
    orderDate,
  }
}

async function applyStockDelta(tx, {
  branchId,
  itemType,
  bookItemId,
  uniformSizeId,
  delta,
  performedById,
  eventDate,
  notes,
}) {
  if (!delta) return
  if (itemType === 'BOOK' && bookItemId) {
    const stock = await tx.bookStock.findUnique({
      where: { itemId_branchId: { itemId: bookItemId, branchId } },
    })
    const before = stock?.quantity ?? 0
    const after = Math.max(0, before + delta)
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
        changeType: delta > 0 ? 'ADJUSTMENT' : 'OUTGOING',
        quantityBefore: before,
        quantityAfter: after,
        quantityDelta: after - before,
        performedById,
        eventDate,
        notes,
      },
    })
    return
  }
  if (itemType === 'UNIFORM' && uniformSizeId) {
    const stock = await tx.uniformStock.findUnique({
      where: { sizeId_branchId: { sizeId: uniformSizeId, branchId } },
    })
    const before = stock?.quantity ?? 0
    const after = Math.max(0, before + delta)
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
        changeType: delta > 0 ? 'ADJUSTMENT' : 'OUTGOING',
        quantityBefore: before,
        quantityAfter: after,
        quantityDelta: after - before,
        performedById,
        eventDate,
        notes,
      },
    })
  }
}

function itemKey(item) {
  return `${item.itemType}:${item.bookItemId || item.uniformSizeId || item.accessoryId || item.label}`
}

async function applyStockDiff(tx, { beforeItems, afterItems, branchId, performedById, eventDate, orderRef }) {
  const beforeMap = new Map()
  for (const i of beforeItems ?? []) {
    const k = itemKey(i)
    beforeMap.set(k, (beforeMap.get(k) ?? 0) + Number(i.quantity ?? 0))
  }
  const afterMap = new Map()
  for (const i of afterItems ?? []) {
    const k = itemKey(i)
    afterMap.set(k, (afterMap.get(k) ?? 0) + Number(i.quantity ?? 0))
  }
  const keys = new Set([...beforeMap.keys(), ...afterMap.keys()])
  for (const k of keys) {
    const [itemType, id] = k.split(':')
    const beforeQty = beforeMap.get(k) ?? 0
    const afterQty = afterMap.get(k) ?? 0
    const delta = beforeQty - afterQty // positive = return to shelf
    if (!delta) continue
    const sample = (afterItems ?? []).find((i) => itemKey(i) === k)
      || (beforeItems ?? []).find((i) => itemKey(i) === k)
    await applyStockDelta(tx, {
      branchId,
      itemType,
      bookItemId: sample?.bookItemId || (itemType === 'BOOK' ? id : null),
      uniformSizeId: sample?.uniformSizeId || (itemType === 'UNIFORM' ? id : null),
      delta,
      performedById,
      eventDate,
      notes: [
        'Order edit approved — stock adjustment',
        `Order: ${orderRef}`,
        `Product key: ${k}`,
        `Qty change to shelf: ${delta > 0 ? '+' : ''}${delta}`,
      ].join('\n'),
    })
  }
}

async function applyEditToLiveOrder(tx, { liveOrder, afterSnapshot, performedById }) {
  const orderDate = afterSnapshot.orderDate instanceof Date
    ? afterSnapshot.orderDate
    : new Date(afterSnapshot.orderDate)

  await applyStockDiff(tx, {
    beforeItems: liveOrder.items,
    afterItems: afterSnapshot.items,
    branchId: liveOrder.branchId,
    performedById,
    eventDate: orderDate,
    orderRef: liveOrder.orderId,
  })

  await tx.orderItem.deleteMany({ where: { orderId: liveOrder.id } })
  if (afterSnapshot.items?.length) {
    await tx.orderItem.createMany({
      data: afterSnapshot.items.map((i) => ({
        orderId: liveOrder.id,
        itemType: i.itemType,
        bookItemId: i.bookItemId,
        uniformSizeId: i.uniformSizeId,
        accessoryId: i.accessoryId,
        label: i.label,
        quantity: i.quantity,
        unitPrice: i.unitPrice,
        totalPrice: i.totalPrice,
      })),
    })
  }

  await tx.transaction.deleteMany({ where: { orderId: liveOrder.id } })
  for (const t of afterSnapshot.transactions ?? []) {
    await tx.transaction.create({
      data: {
        orderId: liveOrder.id,
        branchId: liveOrder.branchId,
        amount: t.amount,
        paymentMethod: t.paymentMethod,
        status: t.status,
        referenceId: t.referenceId,
        notes: t.notes,
        paidAt: t.paidAt ? new Date(t.paidAt) : orderDate,
      },
    })
  }

  await tx.order.update({
    where: { id: liveOrder.id },
    data: {
      status: afterSnapshot.status,
      paymentStatus: afterSnapshot.paymentStatus,
      paymentMethod: afterSnapshot.paymentMethod,
      bookStatus: afterSnapshot.bookStatus,
      uniformStatus: afterSnapshot.uniformStatus,
      subtotal: afterSnapshot.subtotal,
      administrativeFee: afterSnapshot.administrativeFee ?? 0,
      total: afterSnapshot.total,
      paidAmount: afterSnapshot.paidAmount,
      notes: afterSnapshot.notes,
      orderDate,
      paidAt: afterSnapshot.paidAt ? new Date(afterSnapshot.paidAt) : null,
      updatedAt: new Date(),
    },
  })
}

async function createEditRequest(req, res) {
  try {
    const orderId = req.params.id
    const { reason, items, transactions, orderDate: orderDateRaw, notes, bookStatus, uniformStatus, total, paidAmount, status, paymentStatus, paymentMethod } = req.body

    const branchGuard = req.user?.role !== 'SUPER_ADMIN' && req.user?.branchId
      ? { branchId: req.user.branchId }
      : {}

    const liveOrder = await loadOrderFull(prisma, orderId, branchGuard)
    if (!liveOrder) return notFound(res, 'Order not found')

    if (req.user?.role !== 'SUPER_ADMIN') {
      const canEdit = await currentPermissionValue(req.user, 'canRequestOrderEdits')
        || await currentPermissionValue(req.user, 'canPlaceOrders')
      if (!canEdit) return forbidden(res, 'Permission denied')
    }

    const pending = await prisma.orderEditRequest.findFirst({
      where: { orderId: liveOrder.id, status: 'PENDING' },
    })
    if (pending) {
      return badRequest(res, 'An edit request is already pending for this order', [{ code: 'PENDING_EDIT_EXISTS', id: pending.id }])
    }

    // Missing orderDate must keep the live business date (do not default to today —
    // that would silently re-date backdated orders during notes/item-only edits).
    const orderDateFallback = liveOrder.orderDate
      ? toIstDateString(liveOrder.orderDate)
      : null
    const dateResolved = resolveOrderDateInput(
      orderDateRaw != null && String(orderDateRaw).trim() !== ''
        ? orderDateRaw
        : orderDateFallback,
    )
    if (!dateResolved.ok) return badRequest(res, dateResolved.error)

    let proposedItems
    let proposedTxs
    try {
      proposedItems = normalizeProposedItems(items ?? liveOrder.items.map((i) => ({
        itemType: i.itemType,
        itemId: i.bookItemId || i.uniformSizeId || i.accessoryId,
        label: i.label,
        quantity: i.quantity,
        unitPrice: money(i.unitPrice),
      })))
      proposedTxs = normalizeProposedTransactions(
        transactions ?? liveOrder.transactions.map((t) => ({
          amount: money(t.amount),
          paymentMethod: t.paymentMethod,
          status: t.status,
          referenceId: t.referenceId,
          notes: t.notes,
          paidAt: t.paidAt,
        })),
        dateResolved.orderDate,
      )
    } catch (err) {
      return badRequest(res, err.message)
    }

    const header = derivePaymentFields(proposedItems, proposedTxs, dateResolved.orderDate, {
      total,
      paidAmount,
      notes: notes !== undefined ? notes : liveOrder.notes,
      bookStatus: bookStatus || liveOrder.bookStatus,
      uniformStatus: uniformStatus || liveOrder.uniformStatus,
      status,
      paymentMethod,
    })

    const beforeSnapshot = snapshotFromOrder(liveOrder)
    const afterSnapshot = {
      ...beforeSnapshot,
      ...header,
      fingerprint: undefined,
      items: proposedItems,
      transactions: proposedTxs,
    }
    const diffSummary = buildDiffSummary(beforeSnapshot, afterSnapshot)
    if (!diffSummary.length) {
      return badRequest(res, 'No changes detected')
    }

    const isSuper = req.user?.role === 'SUPER_ADMIN'
    const request = await prisma.$transaction(async (tx) => {
      const createdReq = await tx.orderEditRequest.create({
        data: {
          orderId: liveOrder.id,
          branchId: liveOrder.branchId,
          status: isSuper ? 'APPROVED' : 'PENDING',
          reason: reason || null,
          beforeSnapshot,
          afterSnapshot,
          diffSummary,
          requestedById: req.user.id,
          reviewedById: isSuper ? req.user.id : null,
          reviewedAt: isSuper ? new Date() : null,
          reviewNote: isSuper ? 'Auto-approved (Superadmin)' : null,
        },
      })

      if (isSuper) {
        const fresh = await loadOrderFull(tx, liveOrder.id)
        if (fingerprintOrder(fresh) !== beforeSnapshot.fingerprint) {
          throw new Error('ORDER_CHANGED')
        }
        await applyEditToLiveOrder(tx, {
          liveOrder: fresh,
          afterSnapshot,
          performedById: req.user.id,
        })
      }

      return createdReq
    }, ORDER_TX_OPTIONS)

    if (isSuper) scheduleCacheInvalidation(liveOrder.branchId)
    return created(res, request)
  } catch (err) {
    if (err?.message === 'ORDER_CHANGED') {
      return badRequest(res, 'Order changed while applying edit. Please retry.')
    }
    console.error('[orderEdits.create]', err)
    return serverError(res)
  }
}

async function listEditRequests(req, res) {
  try {
    const { page, limit, skip } = parsePagination(req.query)
    const { status, branchId, orderId } = req.query
    const where = {}

    if (req.user?.role !== 'SUPER_ADMIN') {
      where.OR = [
        { requestedById: req.user.id },
        ...(req.user.branchId ? [{ branchId: req.user.branchId, status: 'PENDING' }] : []),
      ]
    } else if (branchId) {
      where.branchId = branchId
    }

    if (status) where.status = status
    if (orderId) where.orderId = orderId

    const [total, rows] = await Promise.all([
      prisma.orderEditRequest.count({ where }),
      prisma.orderEditRequest.findMany({
        where,
        skip,
        take: limit,
        orderBy: { createdAt: 'desc' },
        include: {
          order: { select: { orderId: true, total: true, paymentStatus: true, student: { select: { name: true, rollNumber: true } } } },
          branch: { select: { name: true, code: true } },
          requestedBy: { select: { displayName: true } },
          reviewedBy: { select: { displayName: true } },
        },
      }),
    ])
    return ok(res, rows, buildMeta(total, page, limit))
  } catch (err) {
    console.error('[orderEdits.list]', err)
    return serverError(res)
  }
}

async function getEditRequest(req, res) {
  try {
    const row = await prisma.orderEditRequest.findUnique({
      where: { id: req.params.requestId },
      include: {
        order: {
          include: {
            student: { include: { class: true } },
            items: true,
            transactions: true,
          },
        },
        branch: true,
        requestedBy: { select: { displayName: true, username: true } },
        reviewedBy: { select: { displayName: true, username: true } },
      },
    })
    if (!row) return notFound(res, 'Edit request not found')
    if (req.user?.role !== 'SUPER_ADMIN' && row.requestedById !== req.user.id && row.branchId !== req.user.branchId) {
      return forbidden(res, 'Access denied')
    }
    return ok(res, row)
  } catch (err) {
    console.error('[orderEdits.get]', err)
    return serverError(res)
  }
}

async function approveEditRequest(req, res) {
  try {
    if (req.user?.role !== 'SUPER_ADMIN') return forbidden(res, 'Superadmin only')
    const { reviewNote } = req.body ?? {}

    const result = await prisma.$transaction(async (tx) => {
      const request = await tx.orderEditRequest.findUnique({ where: { id: req.params.requestId } })
      if (!request) throw new Error('NOT_FOUND')
      if (request.status !== 'PENDING') throw new Error('NOT_PENDING')

      const liveOrder = await loadOrderFull(tx, request.orderId)
      if (!liveOrder) throw new Error('ORDER_MISSING')
      if (fingerprintOrder(liveOrder) !== request.beforeSnapshot.fingerprint) {
        throw new Error('ORDER_CHANGED')
      }

      await applyEditToLiveOrder(tx, {
        liveOrder,
        afterSnapshot: request.afterSnapshot,
        performedById: req.user.id,
      })

      return tx.orderEditRequest.update({
        where: { id: request.id },
        data: {
          status: 'APPROVED',
          reviewedById: req.user.id,
          reviewedAt: new Date(),
          reviewNote: reviewNote || null,
        },
        include: {
          order: { select: { orderId: true } },
          reviewedBy: { select: { displayName: true } },
        },
      })
    }, ORDER_TX_OPTIONS)

    scheduleCacheInvalidation(result.branchId)
    return ok(res, result)
  } catch (err) {
    if (err.message === 'NOT_FOUND') return notFound(res, 'Edit request not found')
    if (err.message === 'NOT_PENDING') return badRequest(res, 'Request is not pending')
    if (err.message === 'ORDER_MISSING') return notFound(res, 'Order not found')
    if (err.message === 'ORDER_CHANGED') {
      return badRequest(res, 'Order changed since this edit was submitted. Reject and ask for a fresh edit.')
    }
    console.error('[orderEdits.approve]', err)
    return serverError(res)
  }
}

async function rejectEditRequest(req, res) {
  try {
    if (req.user?.role !== 'SUPER_ADMIN') return forbidden(res, 'Superadmin only')
    const { reviewNote } = req.body ?? {}
    const request = await prisma.orderEditRequest.findUnique({ where: { id: req.params.requestId } })
    if (!request) return notFound(res, 'Edit request not found')
    if (request.status !== 'PENDING') return badRequest(res, 'Request is not pending')

    const updated = await prisma.orderEditRequest.update({
      where: { id: request.id },
      data: {
        status: 'REJECTED',
        reviewedById: req.user.id,
        reviewedAt: new Date(),
        reviewNote: reviewNote || null,
      },
    })
    return ok(res, updated)
  } catch (err) {
    console.error('[orderEdits.reject]', err)
    return serverError(res)
  }
}

async function withdrawEditRequest(req, res) {
  try {
    const request = await prisma.orderEditRequest.findUnique({ where: { id: req.params.requestId } })
    if (!request) return notFound(res, 'Edit request not found')
    if (request.status !== 'PENDING') return badRequest(res, 'Request is not pending')
    if (req.user?.role !== 'SUPER_ADMIN' && request.requestedById !== req.user.id) {
      return forbidden(res, 'Only the requester can withdraw')
    }

    const updated = await prisma.orderEditRequest.update({
      where: { id: request.id },
      data: {
        status: 'WITHDRAWN',
        reviewedById: req.user.id,
        reviewedAt: new Date(),
        reviewNote: 'Withdrawn by requester',
      },
    })
    return ok(res, updated)
  } catch (err) {
    console.error('[orderEdits.withdraw]', err)
    return serverError(res)
  }
}

module.exports = {
  createEditRequest,
  listEditRequests,
  getEditRequest,
  approveEditRequest,
  rejectEditRequest,
  withdrawEditRequest,
}
