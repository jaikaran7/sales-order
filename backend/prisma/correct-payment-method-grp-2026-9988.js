/**
 * Production maintenance: change payment method for #GRP-2026-9988 (Narsingi)
 * from Other ₹10,000 + Credit ₹1,355 → UPI to Poornima ₹11,355
 *
 * Orders: #SKM-2026-10322 (Anjali Vishwakarma), #SKM-2026-10323 (V Hansika)
 *
 * Dry run:
 *   node prisma/correct-payment-method-grp-2026-9988.js
 *
 * Apply:
 *   APPLY_PAYMENT_METHOD_CORRECTION=1 node prisma/correct-payment-method-grp-2026-9988.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const APPLY = process.env.APPLY_PAYMENT_METHOD_CORRECTION === '1'

const GROUP_ID = 'cmr0x7tuz006nljcm7ocm9zlx'
const GROUP_REF = '#GRP-2026-9988'
const ORDER_IDS = ['#SKM-2026-10322', '#SKM-2026-10323']
const EXPECTED_STUDENTS = ['Anjali Vishwakarma', 'Hansika']
const EXPECTED_TOTAL = 11355
const TO_METHOD = 'UPI_POORNIMA'

function money(value) {
  return Number(value ?? 0)
}

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
  assert(group.branch.code === 'SVN_NARSINGI', `Branch mismatch: ${group.branch.code}`)
  assert(money(group.totalAmount) === EXPECTED_TOTAL, `Total mismatch: ${group.totalAmount}`)

  const split = Array.isArray(group.splitDetails) ? group.splitDetails : []
  assert(split.length === 2, `Expected 2 split entries, found ${split.length}`)
  assert(split.some((s) => s.paymentMethod === 'OTHER' && money(s.amount) === 10000), 'Expected OTHER ₹10,000 split')
  assert(split.some((s) => s.paymentMethod === 'CREDIT' && money(s.amount) === 1355), 'Expected CREDIT ₹1,355 split')
  assert(group.orders.length === 2, `Expected 2 orders, found ${group.orders.length}`)

  for (const order of group.orders) {
    assert(ORDER_IDS.includes(order.orderId), `Unexpected order ${order.orderId}`)
    assert(
      EXPECTED_STUDENTS.some((name) => order.student.name.includes(name.replace(/^\s+/, ''))),
      `Student mismatch for ${order.orderId}: ${order.student.name}`,
    )
    assert(order.paymentStatus === 'PAID', `${order.orderId} is not PAID`)
    assert(order.status === 'COMPLETED', `${order.orderId} is not COMPLETED`)
    assert(order.paymentMethod === 'OTHER', `${order.orderId} method is ${order.paymentMethod}`)
  }

  const anjali = group.orders.find((o) => o.orderId === '#SKM-2026-10322')
  const hansika = group.orders.find((o) => o.orderId === '#SKM-2026-10323')
  assert(anjali.transactions.length === 1, `Anjali has ${anjali.transactions.length} transactions`)
  assert(anjali.transactions[0].paymentMethod === 'OTHER', 'Anjali tx not OTHER')
  assert(money(anjali.transactions[0].amount) === 7270, `Anjali tx amount: ${anjali.transactions[0].amount}`)
  assert(hansika.transactions.length === 2, `Hansika has ${hansika.transactions.length} transactions`)
  assert(hansika.transactions.some((t) => t.paymentMethod === 'OTHER' && money(t.amount) === 2730), 'Hansika OTHER tx missing')
  assert(hansika.transactions.some((t) => t.paymentMethod === 'CREDIT' && money(t.amount) === 1355), 'Hansika CREDIT tx missing')

  return group
}

function printSnapshot(group) {
  console.log(`Group: ${group.groupRef} (${group.id})`)
  console.log(`Branch: ${group.branch.name} (${group.branch.code})`)
  console.log(`Total: ₹${group.totalAmount}`)
  console.log(`Split: ${JSON.stringify(group.splitDetails)}`)
  for (const order of group.orders) {
    for (const tx of order.transactions) {
      console.log(`- ${order.orderId} | ${order.student.name} | order ${order.paymentMethod} | tx ${tx.id.slice(0, 12)}… ${tx.paymentMethod} ₹${tx.amount}`)
    }
  }
}

async function main() {
  const before = await loadSnapshot()
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log(`Change: OTHER + CREDIT → ${TO_METHOD} (₹${EXPECTED_TOTAL})`)
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
        splitDetails: [{ amount: EXPECTED_TOTAL, paymentMethod: TO_METHOD }],
      },
    })

    for (const order of group.orders) {
      await tx.order.update({
        where: { id: order.id },
        data: { paymentMethod: TO_METHOD },
      })

      for (const transaction of order.transactions) {
        await tx.transaction.update({
          where: { id: transaction.id },
          data: {
            paymentMethod: TO_METHOD,
            notes: [
              transaction.notes,
              `Payment method correction ${GROUP_REF}: ${transaction.paymentMethod} → ${TO_METHOD}.`,
            ].filter(Boolean).join('\n'),
          },
        })
      }
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

  assert(after.splitDetails.length === 1, 'Group split not consolidated')
  assert(after.splitDetails[0].paymentMethod === TO_METHOD, 'Group split method not updated')
  assert(money(after.splitDetails[0].amount) === EXPECTED_TOTAL, 'Group split amount wrong')

  for (const order of after.orders) {
    assert(order.paymentMethod === TO_METHOD, `${order.orderId} order method not updated`)
    assert(order.transactions.every((t) => t.paymentMethod === TO_METHOD), `${order.orderId} tx method not updated`)
    assert(!order.transactions.some((t) => t.paymentMethod === 'CREDIT' || t.paymentMethod === 'OTHER'), `${order.orderId} still has old method`)
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
