/**
 * Retag remaining Darga UPI_BHARATHI orders → UPI_BHARATH (UPI to Bharath Kumar).
 *
 * Dry run:  node prisma/correct-darga-remaining-upi-bharathi-2026.js
 * Apply:    APPLY_DARGA_UPI_CORRECTION=1 node prisma/correct-darga-remaining-upi-bharathi-2026.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const APPLY = process.env.APPLY_DARGA_UPI_CORRECTION === '1'

const TARGET_ORDER_IDS = [
  '#SKM-2026-10196',
  '#SKM-2026-10197',
  '#SKM-2026-10198',
  '#SKM-2026-10199',
  '#SKM-2026-10204',
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function loadTargets(client = prisma) {
  const orders = await client.order.findMany({
    where: { orderId: { in: TARGET_ORDER_IDS } },
    include: {
      student: { select: { name: true } },
      branch: { select: { name: true, code: true } },
      transactions: { orderBy: { createdAt: 'asc' } },
    },
    orderBy: { orderId: 'asc' },
  })

  assert(orders.length === TARGET_ORDER_IDS.length, `Expected ${TARGET_ORDER_IDS.length} orders, found ${orders.length}`)
  for (const order of orders) {
    assert(order.branch.code === 'NHS_DARGA', `${order.orderId} is not Darga branch`)
    assert(
      order.paymentMethod === 'UPI_BHARATHI' || order.transactions.some((t) => t.paymentMethod === 'UPI_BHARATHI'),
      `${order.orderId} has no UPI_BHARATHI to convert`,
    )
  }
  return orders
}

async function main() {
  const orders = await loadTargets()
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log(`Targets: ${orders.length}`)
  for (const o of orders) {
    console.log(`  ${o.orderId} | ${o.student.name} | order ${o.paymentMethod}`)
  }

  if (!APPLY) {
    console.log('\nDry run OK. Re-run with APPLY_DARGA_UPI_CORRECTION=1 to commit.')
    return
  }

  await prisma.$transaction(async (tx) => {
    for (const order of orders) {
      await tx.order.update({
        where: { id: order.id },
        data: { paymentMethod: 'UPI_BHARATH' },
      })
      for (const t of order.transactions) {
        if (t.paymentMethod === 'UPI_BHARATHI') {
          await tx.transaction.update({
            where: { id: t.id },
            data: { paymentMethod: 'UPI_BHARATH' },
          })
        }
      }
    }
  })

  const after = await prisma.order.findMany({
    where: { orderId: { in: TARGET_ORDER_IDS } },
    include: { student: { select: { name: true } }, transactions: true },
    orderBy: { orderId: 'asc' },
  })
  for (const o of after) {
    assert(o.paymentMethod === 'UPI_BHARATH', `${o.orderId} order method not updated`)
    assert(!o.transactions.some((t) => t.paymentMethod === 'UPI_BHARATHI'), `${o.orderId} still has UPI_BHARATHI tx`)
    console.log(`  OK ${o.orderId} | ${o.student.name} | UPI_BHARATH`)
  }
  console.log('\nDone.')
}

main()
  .catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
