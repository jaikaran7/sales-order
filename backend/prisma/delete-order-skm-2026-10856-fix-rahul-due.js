/**
 * Production maintenance — Rahul Kumar (roll 938782), Narsingi
 *
 * 1. Delete duplicate paid order #SKM-2026-10856 + revert Notebook Bundle stock (+1)
 * 2. Settle ghost credit order #SKM-2026-10768 (cash due cleared 8 Jul 2026)
 *
 * Root cause: Clear Due should pay #10768, but a new order #10856 was created instead,
 * leaving #10768 as UNPAID DRAFT on the due list.
 *
 * Dry run:
 *   node prisma/delete-order-skm-2026-10856-fix-rahul-due.js
 *
 * Apply:
 *   APPLY_RAHUL_ORDER_FIX=1 node prisma/delete-order-skm-2026-10856-fix-rahul-due.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { PrismaClient } = require('@prisma/client')
const { computeOrderDue, isPureCreditDueOrder } = require('../src/utils/orderDue')

const prisma = new PrismaClient()
const APPLY = process.env.APPLY_RAHUL_ORDER_FIX === '1'

const DELETE_ORDER_ID = '#SKM-2026-10856'
const DELETE_ORDER_DB_ID = 'cmrbykon20004qvmkd78fvx2g'
const SETTLE_ORDER_ID = '#SKM-2026-10768'
const SETTLE_ORDER_DB_ID = 'cmra6wews000gcg8jnph5n326'

const EXPECTED_STUDENT = 'Rahul Kumar'
const EXPECTED_ROLL = '938782'
const EXPECTED_BRANCH = 'SVN_NARSINGI'

const DELETE_TOTAL = 5575
const SETTLE_TOTAL = 6548
const SETTLE_DISCOUNT = 2
const SETTLE_EFFECTIVE = 6546
const SETTLE_CASH_COLLECTED = 5575
const SETTLE_REMAINING_CASH = 971

const NOTEBOOK_ITEM_ID = 'cmp5wkuq1053jrgkb6v1uu3x0'
const DELETE_TX_ID = 'cmrbykurg000iqvmkfnzfuk8g'
const DELETE_LOG_IDS = ['cmrbykrhs000bqvmkwpl51s4u', 'cmrbyksbj000fqvmkn3ctvexn']

function money(value) {
  return Number(value ?? 0)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function toneFor(quantity, threshold = 50) {
  if (quantity <= threshold * 0.2) return 'CRITICAL'
  if (quantity <= threshold) return 'LOW'
  return 'NORMAL'
}

async function loadContext(client = prisma) {
  const deleteOrder = await client.order.findUnique({
    where: { id: DELETE_ORDER_DB_ID },
    include: {
      student: { include: { class: true } },
      branch: true,
      items: true,
      transactions: true,
      transactionGroup: true,
    },
  })
  assert(deleteOrder, `Order ${DELETE_ORDER_ID} not found`)
  assert(deleteOrder.orderId === DELETE_ORDER_ID, `Delete order ref mismatch: ${deleteOrder.orderId}`)
  assert(deleteOrder.student.name === EXPECTED_STUDENT, `Student mismatch: ${deleteOrder.student.name}`)
  assert(deleteOrder.student.rollNumber === EXPECTED_ROLL, `Roll mismatch: ${deleteOrder.student.rollNumber}`)
  assert(deleteOrder.branch.code === EXPECTED_BRANCH, `Branch mismatch: ${deleteOrder.branch.code}`)
  assert(money(deleteOrder.total) === DELETE_TOTAL, `Delete order total: ${deleteOrder.total}`)
  assert(deleteOrder.paymentStatus === 'PAID', `Delete order not PAID: ${deleteOrder.paymentStatus}`)
  assert(deleteOrder.transactions.length === 1, `Expected 1 tx on delete order`)
  assert(deleteOrder.transactions[0].id === DELETE_TX_ID, 'Delete tx id mismatch')
  assert(!deleteOrder.transactionGroupId, 'Delete order should not be in a group')

  const settleOrder = await client.order.findUnique({
    where: { id: SETTLE_ORDER_DB_ID },
    include: {
      student: true,
      branch: true,
      transactions: true,
    },
  })
  assert(settleOrder, `Order ${SETTLE_ORDER_ID} not found`)
  assert(settleOrder.orderId === SETTLE_ORDER_ID, `Settle order ref mismatch: ${settleOrder.orderId}`)
  assert(settleOrder.studentId === deleteOrder.studentId, 'Orders are for different students')
  assert(money(settleOrder.total) === SETTLE_TOTAL, `Settle order total: ${settleOrder.total}`)
  assert(settleOrder.paymentStatus === 'UNPAID', `Settle order should be UNPAID: ${settleOrder.paymentStatus}`)
  assert(settleOrder.transactions.length === 0, 'Settle order should have no transactions yet')
  assert(isPureCreditDueOrder(settleOrder), 'Settle order is not a pure credit due')
  assert(computeOrderDue(settleOrder).dueAmount === SETTLE_EFFECTIVE, 'Settle due amount mismatch')

  const notebookStock = await client.bookStock.findUnique({
    where: {
      itemId_branchId: { itemId: NOTEBOOK_ITEM_ID, branchId: deleteOrder.branchId },
    },
    include: { item: true },
  })
  assert(notebookStock, 'Notebook stock row not found')

  const superAdmin = await client.user.findFirst({
    where: { role: 'SUPER_ADMIN', isActive: true },
    orderBy: { createdAt: 'asc' },
  })
  assert(superAdmin, 'SUPER_ADMIN not found')

  const deleteLogs = await client.inventoryLog.findMany({
    where: { id: { in: DELETE_LOG_IDS } },
  })
  assert(deleteLogs.length === DELETE_LOG_IDS.length, `Expected ${DELETE_LOG_IDS.length} inventory logs`)

  return { deleteOrder, settleOrder, notebookStock, superAdmin, deleteLogs }
}

function printPrecheck(ctx) {
  const { deleteOrder, settleOrder, notebookStock } = ctx
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log(`Student: ${deleteOrder.student.name} (${deleteOrder.student.rollNumber})`)
  console.log(`Branch: ${deleteOrder.branch.name}`)
  console.log('')
  console.log(`DELETE ${DELETE_ORDER_ID}: total ₹${deleteOrder.total}, ${deleteOrder.items.length} items, tx CASH ₹${deleteOrder.transactions[0].amount}`)
  console.log(`  Notebook stock: ${notebookStock.quantity} → ${notebookStock.quantity + 1}`)
  console.log('')
  console.log(`SETTLE ${SETTLE_ORDER_ID}: due ₹${SETTLE_EFFECTIVE} → PAID`)
  console.log(`  Payments: CASH ₹${SETTLE_CASH_COLLECTED} + CASH ₹${SETTLE_REMAINING_CASH}`)
}

async function applyFix(ctx) {
  const { deleteOrder, settleOrder, notebookStock, superAdmin } = ctx
  const paidAt = deleteOrder.paidAt ?? deleteOrder.transactions[0].paidAt ?? new Date()
  const beforeStock = notebookStock.quantity
  const afterStock = beforeStock + 1

  await prisma.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        orderId: settleOrder.id,
        branchId: settleOrder.branchId,
        amount: SETTLE_CASH_COLLECTED,
        paymentMethod: 'CASH',
        status: 'PARTIAL',
        notes: 'Cash paid on 07/07/2026',
        paidAt,
      },
    })

    await tx.transaction.create({
      data: {
        orderId: settleOrder.id,
        branchId: settleOrder.branchId,
        amount: SETTLE_REMAINING_CASH,
        paymentMethod: 'CASH',
        status: 'PAID',
        notes: [
          'Due clearance correction',
          `Consolidated after deleting duplicate order ${DELETE_ORDER_ID}`,
        ].join('\n'),
        paidAt,
      },
    })

    await tx.order.update({
      where: { id: settleOrder.id },
      data: {
        paidAmount: SETTLE_EFFECTIVE,
        paymentStatus: 'PAID',
        paymentMethod: 'CASH',
        status: 'COMPLETED',
        paidAt,
        notes: [
          settleOrder.notes,
          `Due cleared 8 Jul 2026. Duplicate checkout ${DELETE_ORDER_ID} removed.`,
        ].filter(Boolean).join('\n'),
        updatedAt: new Date(),
      },
    })

    await tx.transaction.delete({ where: { id: DELETE_TX_ID } })
    await tx.orderItem.deleteMany({ where: { orderId: deleteOrder.id } })
    await tx.inventoryLog.deleteMany({ where: { id: { in: DELETE_LOG_IDS } } })

    await tx.bookStock.update({
      where: {
        itemId_branchId: { itemId: NOTEBOOK_ITEM_ID, branchId: deleteOrder.branchId },
      },
      data: {
        quantity: afterStock,
        tone: toneFor(afterStock),
      },
    })

    await tx.inventoryLog.create({
      data: {
        branchId: deleteOrder.branchId,
        itemType: 'BOOK',
        bookItemId: NOTEBOOK_ITEM_ID,
        changeType: 'ADJUSTMENT',
        quantityBefore: beforeStock,
        quantityAfter: afterStock,
        quantityDelta: 1,
        performedById: superAdmin.id,
        notes: [
          'Order deletion — stock revert',
          `Deleted order: ${DELETE_ORDER_ID}`,
          `Student: ${EXPECTED_STUDENT} (${EXPECTED_ROLL})`,
          'Product: Notebook Bundle',
          'Reason: Duplicate paid order removed; notebook stock reverted +1.',
        ].join('\n'),
      },
    })

    await tx.order.delete({ where: { id: deleteOrder.id } })
  }, { maxWait: 15_000, timeout: 120_000 })
}

async function verifyPostChange() {
  const deleted = await prisma.order.findUnique({ where: { orderId: DELETE_ORDER_ID } })
  assert(!deleted, `${DELETE_ORDER_ID} still exists`)

  const settled = await prisma.order.findUnique({
    where: { orderId: SETTLE_ORDER_ID },
    include: { transactions: { orderBy: { createdAt: 'asc' } } },
  })
  assert(settled, `${SETTLE_ORDER_ID} missing`)
  assert(settled.paymentStatus === 'PAID', `Settle status: ${settled.paymentStatus}`)
  assert(money(settled.paidAmount) === SETTLE_EFFECTIVE, `Settle paid: ${settled.paidAmount}`)
  assert(computeOrderDue(settled).dueAmount <= 0.009, `Settle still has due: ${computeOrderDue(settled).dueAmount}`)
  assert(settled.transactions.length === 2, `Expected 2 settle transactions`)

  const stock = await prisma.bookStock.findUnique({
    where: { itemId_branchId: { itemId: NOTEBOOK_ITEM_ID, branchId: settled.branchId } },
  })

  const dueRows = await prisma.order.findMany({
    where: {
      studentId: settled.studentId,
      status: { not: 'CANCELLED' },
      paymentStatus: { in: ['UNPAID', 'PARTIAL'] },
    },
  })
  const openDues = dueRows.filter((o) => computeOrderDue(o).dueAmount > 0.009)
  assert(openDues.length === 0, `Student still has ${openDues.length} open due order(s)`)

  console.log('\nPost-change verification:')
  console.log(`  OK ${DELETE_ORDER_ID} deleted`)
  console.log(`  OK ${SETTLE_ORDER_ID} PAID — ₹${settled.paidAmount}`)
  console.log(`  OK Notebook stock: ${stock.quantity}`)
  console.log(`  OK Open due orders for student: ${openDues.length}`)
}

async function main() {
  const ctx = await loadContext()
  printPrecheck(ctx)

  if (!APPLY) {
    console.log('\nDry run passed. Re-run with APPLY_RAHUL_ORDER_FIX=1 to commit.')
    return
  }

  await applyFix(ctx)
  await verifyPostChange()
  console.log('\nDone.')
}

main()
  .catch((err) => {
    console.error('FAILED:', err.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
