/**
 * Production maintenance: change payment method from CASH to OTHER for:
 * - #SKM-2026-1123
 * - #SKM-2026-1998
 *
 * Default mode is dry-run verification only:
 *   node prisma/correct-payment-method-skm-2026-1123-1998.js
 *
 * Write mode:
 *   APPLY_PAYMENT_METHOD_CORRECTION=1 node prisma/correct-payment-method-skm-2026-1123-1998.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const APPLY = process.env.APPLY_PAYMENT_METHOD_CORRECTION === '1'

const TARGETS = [
  { orderId: '#SKM-2026-1123', expectedStudentIncludes: 'Yashw' },
  { orderId: '#SKM-2026-1998', expectedStudentIncludes: 'Chethan' },
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function fmt(value) {
  return new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium',
    hour12: true,
  })
}

async function loadTarget({ orderId, expectedStudentIncludes }, client = prisma) {
  const order = await client.order.findUnique({
    where: { orderId },
    include: {
      student: { include: { class: true } },
      branch: true,
      transactions: { orderBy: { createdAt: 'asc' } },
    },
  })

  assert(order, `Order ${orderId} not found`)
  assert(
    String(order.student?.name ?? '').toLowerCase().includes(expectedStudentIncludes.toLowerCase()),
    `Student mismatch for ${orderId}: found "${order.student?.name}"`,
  )
  assert(order.status === 'COMPLETED', `${orderId} is not completed. Current status: ${order.status}`)
  assert(order.paymentStatus === 'PAID', `${orderId} is not paid. Current paymentStatus: ${order.paymentStatus}`)
  assert(order.paymentMethod === 'CASH', `${orderId} order paymentMethod is ${order.paymentMethod}, expected CASH`)

  const cashTransactions = order.transactions.filter((tx) => tx.paymentMethod === 'CASH')
  assert(order.transactions.length === 1, `${orderId} has ${order.transactions.length} transactions; aborting to avoid changing the wrong payment row`)
  assert(cashTransactions.length === 1, `${orderId} has no single CASH transaction to update`)
  assert(cashTransactions[0].status === 'PAID', `${orderId} transaction is ${cashTransactions[0].status}, expected PAID`)

  return { order, transaction: cashTransactions[0] }
}

function printTarget({ order, transaction }) {
  console.log(`- ${order.orderId}`)
  console.log(`  Student: ${order.student.name} (${order.student.rollNumber})`)
  console.log(`  Class: ${order.student.class.label}-${order.student.class.section}`)
  console.log(`  Branch: ${order.branch.name} (${order.branch.code})`)
  console.log(`  Order: total ${order.total}, paid ${order.paidAmount}, status ${order.status}/${order.paymentStatus}, method ${order.paymentMethod}`)
  console.log(`  Transaction: ${transaction.id}, amount ${transaction.amount}, method ${transaction.paymentMethod}, status ${transaction.status}, paid ${fmt(transaction.paidAt)}`)
}

async function main() {
  const targets = []
  for (const target of TARGETS) {
    targets.push(await loadTarget(target))
  }

  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log('Verified targets:')
  targets.forEach(printTarget)

  if (!APPLY) {
    console.log('\nDry run passed. Re-run with APPLY_PAYMENT_METHOD_CORRECTION=1 to commit CASH -> OTHER.')
    return
  }

  await prisma.$transaction(async (tx) => {
    for (const target of TARGETS) {
      const { order, transaction } = await loadTarget(target, tx)

      await tx.order.update({
        where: { id: order.id },
        data: { paymentMethod: 'OTHER' },
      })

      await tx.transaction.update({
        where: { id: transaction.id },
        data: { paymentMethod: 'OTHER' },
      })
    }
  }, { maxWait: 15_000, timeout: 60_000 })

  console.log('\nPost-change verification:')
  for (const target of TARGETS) {
    const order = await prisma.order.findUnique({
      where: { orderId: target.orderId },
      include: { student: true, transactions: { orderBy: { createdAt: 'asc' } } },
    })
    const methods = order.transactions.map((tx) => `${tx.paymentMethod}/${tx.status}`).join(', ')
    console.log(`- ${order.orderId}: order method ${order.paymentMethod}; transaction methods ${methods}; student ${order.student.name}`)
    assert(order.paymentMethod === 'OTHER', `${order.orderId} order method was not updated`)
    assert(order.transactions.every((tx) => tx.paymentMethod === 'OTHER'), `${order.orderId} transaction method was not updated`)
  }

  console.log('\nDone. Payment method correction committed.')
}

main()
  .catch((err) => {
    console.error('FAILED:', err.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
