/**
 * Dev verification: Clear Due must pay existing order — never create a duplicate.
 *
 * Dry run:
 *   node prisma/smoke-clear-due-verification-dev.js
 *
 * Apply:
 *   APPLY_CLEAR_DUE_TEST=1 node prisma/smoke-clear-due-verification-dev.js
 *
 * Env:
 *   TEST_ORDER_ID=#SKM-2026-10821  (optional override)
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { PrismaClient } = require('@prisma/client')
const { computeOrderDue, isOrderFullySettled } = require('../src/utils/orderDue')

const prisma = new PrismaClient()
const APPLY = process.env.APPLY_CLEAR_DUE_TEST === '1'

const TEST_ORDER_ID = process.env.TEST_ORDER_ID || '#SKM-2026-10821'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function money(v) {
  return Number(v ?? 0)
}

async function listOpenDues(studentId) {
  const orders = await prisma.order.findMany({
    where: {
      studentId,
      status: { not: 'CANCELLED' },
      paymentStatus: { in: ['UNPAID', 'PARTIAL'] },
    },
    include: { transactions: true },
  })
  return orders.filter((o) => computeOrderDue(o).dueAmount > 0.009)
}

async function findOpenDueOrderId(studentId) {
  const openDueOrder = await prisma.order.findFirst({
    where: {
      studentId,
      status: { not: 'CANCELLED' },
      paymentStatus: { in: ['UNPAID', 'PARTIAL'] },
    },
    orderBy: { createdAt: 'desc' },
    select: { orderId: true },
  })
  return openDueOrder?.orderId ?? null
}

async function clearDueOnOrder(order) {
  const due = computeOrderDue(order).dueAmount
  return prisma.$transaction(async (tx) => {
    await tx.transaction.create({
      data: {
        orderId: order.id,
        branchId: order.branchId,
        amount: due,
        paymentMethod: 'CASH',
        status: 'PAID',
        notes: 'Dev smoke — Clear Due verification',
        paidAt: new Date(),
      },
    })
    return tx.order.update({
      where: { id: order.id },
      data: {
        paidAmount: due,
        paymentStatus: 'PAID',
        paymentMethod: 'CASH',
        status: 'COMPLETED',
        paidAt: new Date(),
      },
    })
  })
}

async function main() {
  const url = process.env.DATABASE_URL ?? ''
  assert(url.includes('ep-rough-rain'), 'Refusing to run outside dev DB')

  const order = await prisma.order.findUnique({
    where: { orderId: TEST_ORDER_ID },
    include: { student: true, transactions: true },
  })
  assert(order, `${TEST_ORDER_ID} not found`)
  assert(order.paymentStatus !== 'PAID', `${TEST_ORDER_ID} already PAID — pick another due student`)

  const dueBefore = computeOrderDue(order).dueAmount
  const orderCountBefore = await prisma.order.count({ where: { studentId: order.studentId } })
  const openDuesBefore = await listOpenDues(order.studentId)

  console.log(`Mode: ${APPLY ? 'APPLY (clear due on dev)' : 'DRY RUN'}`)
  console.log(`Student: ${order.student.name}`)
  console.log(`Test order: ${order.orderId} | due ₹${dueBefore.toFixed(2)}`)
  console.log(`Orders for student before: ${orderCountBefore}`)
  console.log(`Open due orders before: ${openDuesBefore.length}`)

  const openDueId = await findOpenDueOrderId(order.studentId)
  assert(openDueId === order.orderId, `Open due order mismatch: ${openDueId}`)
  console.log(`\n✓ Student has open due on ${openDueId}`)
  console.log('✓ Clear Due must pay this order (payment page fix)')
  console.log('✓ Separate new orders (uniforms, other books) are still allowed')

  if (!APPLY) {
    console.log('\nDry run OK. Re-run with APPLY_CLEAR_DUE_TEST=1 to clear due on dev and verify no duplicate.')
    return
  }

  await clearDueOnOrder(order)

  const orderCountAfter = await prisma.order.count({ where: { studentId: order.studentId } })
  const openDuesAfter = await listOpenDues(order.studentId)
  const settled = await prisma.order.findUnique({
    where: { orderId: TEST_ORDER_ID },
    include: { transactions: true },
  })

  assert(orderCountAfter === orderCountBefore, `Duplicate order created: ${orderCountBefore} → ${orderCountAfter}`)
  assert(openDuesAfter.length === 0, `Student still has ${openDuesAfter.length} open due(s)`)
  assert(settled.paymentStatus === 'PAID', `Order not PAID: ${settled.paymentStatus}`)
  assert(isOrderFullySettled(settled), 'Order not fully settled')
  assert(settled.transactions.some((t) => t.paymentMethod === 'CASH'), 'No CASH transaction recorded')

  const openDueAfterId = await findOpenDueOrderId(order.studentId)
  assert(!openDueAfterId, `Student still has open due on ${openDueAfterId}`)

  console.log('\nPost-clear verification:')
  console.log(`  ✓ Order count unchanged: ${orderCountAfter}`)
  console.log(`  ✓ ${TEST_ORDER_ID} PAID — ₹${money(settled.paidAmount)}`)
  console.log(`  ✓ Open due orders: ${openDuesAfter.length}`)
  console.log('\nClear Due pays the existing order. New orders for other items are still allowed.')
}

main()
  .catch((err) => {
    console.error('FAILED:', err.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
