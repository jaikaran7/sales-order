/**
 * Production maintenance: change payment method UPI_BHARATHI -> CASH for:
 * - #GRP-2026-9993 (group payment, Darga, 30 Jun 2026)
 * - #SKM-2026-10341 (S.Akshay Kumar, ₹1,050)
 * - #SKM-2026-10342 (Kiranmai.S, ₹1,000)
 *
 * Dry run:
 *   node prisma/correct-payment-method-grp-2026-9993.js
 *
 * Apply:
 *   APPLY_PAYMENT_METHOD_CORRECTION=1 node prisma/correct-payment-method-grp-2026-9993.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const APPLY = process.env.APPLY_PAYMENT_METHOD_CORRECTION === '1'

const GROUP_ID = 'cmr0xwpd2005v2iogt8bmp4zz'
const GROUP_REF = '#GRP-2026-9993'
const ORDER_IDS = ['#SKM-2026-10341', '#SKM-2026-10342']
const EXPECTED_STUDENTS = ['Akshay Kumar', 'Kiranmai']
const FROM_METHOD = 'UPI_BHARATHI'
const TO_METHOD = 'CASH'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function loadSnapshot(client = prisma) {
  const group = await client.transactionGroup.findUnique({
    where: { id: GROUP_ID },
    include: {
      branch: true,
      orders: {
        include: {
          student: true,
          transactions: { orderBy: { createdAt: 'asc' } },
        },
        orderBy: { orderId: 'asc' },
      },
    },
  })

  assert(group, `Transaction group ${GROUP_ID} not found`)
  assert(group.groupRef === GROUP_REF, `Group ref mismatch: ${group.groupRef}`)
  assert(group.branch.code === 'NHS_DARGA', `Branch mismatch: ${group.branch.code}`)
  assert(Number(group.totalAmount) === 2050, `Total mismatch: ${group.totalAmount}`)
  assert(Array.isArray(group.splitDetails) && group.splitDetails.length === 1, 'Expected single split detail')
  assert(group.splitDetails[0].paymentMethod === FROM_METHOD, `Group split method is ${group.splitDetails[0].paymentMethod}`)
  assert(Number(group.splitDetails[0].amount) === 2050, `Group split amount mismatch: ${group.splitDetails[0].amount}`)
  assert(group.orders.length === 2, `Expected 2 orders, found ${group.orders.length}`)

  for (const order of group.orders) {
    assert(ORDER_IDS.includes(order.orderId), `Unexpected order ${order.orderId}`)
    assert(
      EXPECTED_STUDENTS.some((name) => order.student.name.includes(name)),
      `Student mismatch for ${order.orderId}: ${order.student.name}`,
    )
    assert(order.paymentStatus === 'PAID', `${order.orderId} is not PAID`)
    assert(order.status === 'COMPLETED', `${order.orderId} is not COMPLETED`)
    assert(order.paymentMethod === FROM_METHOD, `${order.orderId} method is ${order.paymentMethod}`)
    assert(order.transactions.length === 1, `${order.orderId} has ${order.transactions.length} transactions`)
    assert(order.transactions[0].paymentMethod === FROM_METHOD, `${order.orderId} tx method is ${order.transactions[0].paymentMethod}`)
    assert(order.transactions[0].status === 'PAID', `${order.orderId} tx is not PAID`)
  }

  return group
}

function printSnapshot(group) {
  console.log(`Group: ${group.groupRef} (${group.id})`)
  console.log(`Branch: ${group.branch.name}`)
  console.log(`Total: ₹${group.totalAmount}`)
  console.log(`Split: ${JSON.stringify(group.splitDetails)}`)
  for (const order of group.orders) {
    const tx = order.transactions[0]
    console.log(`- ${order.orderId} | ${order.student.name} | ₹${order.total} | order ${order.paymentMethod} | tx ${tx.id} ${tx.paymentMethod}`)
  }
}

async function main() {
  const before = await loadSnapshot()
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log(`Change: ${FROM_METHOD} -> ${TO_METHOD}`)
  printSnapshot(before)

  if (!APPLY) {
    console.log('\nDry run passed. Re-run with APPLY_PAYMENT_METHOD_CORRECTION=1 to commit.')
    return
  }

  await prisma.$transaction(async (tx) => {
    const group = await loadSnapshot(tx)

    await tx.transactionGroup.update({
      where: { id: group.id },
      data: {
        splitDetails: [{ amount: 2050, paymentMethod: TO_METHOD }],
      },
    })

    for (const order of group.orders) {
      await tx.order.update({
        where: { id: order.id },
        data: { paymentMethod: TO_METHOD },
      })

      await tx.transaction.update({
        where: { id: order.transactions[0].id },
        data: { paymentMethod: TO_METHOD },
      })
    }
  }, { maxWait: 15_000, timeout: 60_000 })

  const after = await prisma.transactionGroup.findUnique({
    where: { id: GROUP_ID },
    include: {
      branch: true,
      orders: {
        include: { student: true, transactions: { orderBy: { createdAt: 'asc' } } },
        orderBy: { orderId: 'asc' },
      },
    },
  })
  assert(after.splitDetails[0].paymentMethod === TO_METHOD, 'Group split not updated')
  for (const order of after.orders) {
    assert(order.paymentMethod === TO_METHOD, `${order.orderId} order method not updated`)
    assert(order.transactions[0].paymentMethod === TO_METHOD, `${order.orderId} tx method not updated`)
  }

  console.log('\nPost-change verification:')
  printSnapshot(after)
  console.log('\nDone. Payment method correction committed.')
}

main()
  .catch((err) => {
    console.error('FAILED:', err.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
