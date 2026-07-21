/**
 * Darga branch — move all 30 Jun 2026 activity to 29 Jun 2026 (same clock time, -1 day).
 * Also retag 5 UPI_BHARATHI payments as UPI_BHARATH (UPI to Bharath Kumar).
 *
 * Dry run:
 *   node prisma/correct-darga-jun30-to-jun29-2026.js
 *
 * Apply (dev or prod — uses DATABASE_URL from .env):
 *   APPLY_DARGA_JUN30_CORRECTION=1 node prisma/correct-darga-jun30-to-jun29-2026.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const APPLY = process.env.APPLY_DARGA_JUN30_CORRECTION === '1'

const SOURCE_DAY_START = new Date('2026-06-30T00:00:00+05:30')
const SOURCE_DAY_END = new Date('2026-07-01T00:00:00+05:30')
const DAY_MS = 24 * 60 * 60 * 1000
const UPI_BHARATHI_TO_CHANGE = 5

const BRANCH_ALIASES = ['NHS_DARGA', 'CAMP-A', 'DARGA']

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function fmt(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium',
    hour12: true,
  })
}

function shiftOneDayEarlier(value) {
  if (!value) return null
  return new Date(new Date(value).getTime() - DAY_MS)
}

function istDateOnly(value) {
  return new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

async function findDargaBranch(client = prisma) {
  const branch = await client.branch.findFirst({
    where: {
      OR: [
        { code: { in: BRANCH_ALIASES } },
        { name: { contains: 'Darga', mode: 'insensitive' } },
      ],
      isActive: true,
      deletedAt: null,
      type: 'BRANCH',
    },
  })
  assert(branch, 'Darga branch not found')
  return branch
}

async function loadSnapshot(branchId, client = prisma) {
  const orders = await client.order.findMany({
    where: {
      branchId,
      createdAt: { gte: SOURCE_DAY_START, lt: SOURCE_DAY_END },
    },
    include: {
      student: { select: { name: true } },
      transactions: { orderBy: { createdAt: 'asc' } },
      items: { select: { id: true, createdAt: true } },
    },
    orderBy: { createdAt: 'asc' },
  })

  const orderIds = orders.map((o) => o.id)
  const transactions = await client.transaction.findMany({
    where: {
      branchId,
      OR: [
        { orderId: { in: orderIds } },
        { createdAt: { gte: SOURCE_DAY_START, lt: SOURCE_DAY_END } },
      ],
    },
    orderBy: { createdAt: 'asc' },
  })

  const transactionGroups = await client.transactionGroup.findMany({
    where: {
      branchId,
      createdAt: { gte: SOURCE_DAY_START, lt: SOURCE_DAY_END },
    },
    include: { orders: { select: { orderId: true } } },
    orderBy: { createdAt: 'asc' },
  })

  const inventoryLogs = await client.inventoryLog.findMany({
    where: {
      branchId,
      createdAt: { gte: SOURCE_DAY_START, lt: SOURCE_DAY_END },
    },
    orderBy: { createdAt: 'asc' },
  })

  const orderItems = await client.orderItem.findMany({
    where: { orderId: { in: orderIds } },
    orderBy: { createdAt: 'asc' },
  })

  const uniformStocks = await client.uniformStock.findMany({
    where: {
      branchId,
      updatedAt: { gte: SOURCE_DAY_START, lt: SOURCE_DAY_END },
    },
  })

  const bookStocks = await client.bookStock.findMany({
    where: {
      branchId,
      updatedAt: { gte: SOURCE_DAY_START, lt: SOURCE_DAY_END },
    },
  })

  const upiBharathiOrders = orders
    .filter((o) => o.paymentMethod === 'UPI_BHARATHI' || o.transactions.some((t) => t.paymentMethod === 'UPI_BHARATHI'))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))

  const paymentChangeTargets = upiBharathiOrders.slice(0, UPI_BHARATHI_TO_CHANGE)
  const paymentChangeOrderIds = new Set(paymentChangeTargets.map((o) => o.id))

  return {
    orders,
    transactions,
    transactionGroups,
    inventoryLogs,
    orderItems,
    uniformStocks,
    bookStocks,
    upiBharathiOrders,
    paymentChangeTargets,
    paymentChangeOrderIds,
  }
}

function printSnapshot(branch, snap) {
  console.log(`Branch: ${branch.name} (${branch.code}) — ${branch.id}`)
  console.log(`Source window (IST): ${fmt(SOURCE_DAY_START)} → ${fmt(SOURCE_DAY_END)}`)
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log('')
  console.log(`Orders: ${snap.orders.length}`)
  console.log(`Transactions: ${snap.transactions.length}`)
  console.log(`Transaction groups: ${snap.transactionGroups.length}`)
  console.log(`Inventory logs: ${snap.inventoryLogs.length}`)
  console.log(`Order items: ${snap.orderItems.length}`)
  console.log(`Uniform stock rows touched today: ${snap.uniformStocks.length}`)
  console.log(`Book stock rows touched today: ${snap.bookStocks.length}`)
  console.log(`UPI_BHARATHI orders found: ${snap.upiBharathiOrders.length}`)
  console.log(`Payment method changes planned: ${snap.paymentChangeTargets.length}`)
  console.log('')

  console.log('Orders to backdate:')
  for (const o of snap.orders) {
    const payChange = snap.paymentChangeOrderIds.has(o.id) ? ' [UPI_BHARATHI → UPI_BHARATH]' : ''
    console.log(
      `  ${o.orderId} | ${o.student?.name ?? '—'} | ${fmt(o.createdAt)} → ${fmt(shiftOneDayEarlier(o.createdAt))}${payChange}`,
    )
  }

  if (snap.paymentChangeTargets.length) {
    console.log('\nPayment method retag targets:')
    for (const o of snap.paymentChangeTargets) {
      console.log(`  ${o.orderId} | ${o.student?.name ?? '—'} | order ${o.paymentMethod}`)
      for (const t of o.transactions) {
        console.log(`    tx ${t.id.slice(0, 10)}… method ${t.paymentMethod}`)
      }
    }
  }

  if (snap.upiBharathiOrders.length !== UPI_BHARATHI_TO_CHANGE) {
    console.log(
      `\nNote: expected ${UPI_BHARATHI_TO_CHANGE} UPI_BHARATHI rows; found ${snap.upiBharathiOrders.length}. ` +
        `Will change ${snap.paymentChangeTargets.length}.`,
    )
  }
}

async function applyCorrection(branchId, snap) {
  await prisma.$transaction(async (tx) => {
    for (const order of snap.orders) {
      const paymentMethod = snap.paymentChangeOrderIds.has(order.id) ? 'UPI_BHARATH' : undefined
      await tx.order.update({
        where: { id: order.id },
        data: {
          createdAt: shiftOneDayEarlier(order.createdAt),
          paidAt: shiftOneDayEarlier(order.paidAt),
          updatedAt: shiftOneDayEarlier(order.updatedAt),
          ...(paymentMethod ? { paymentMethod } : {}),
        },
      })
    }

    for (const row of snap.transactions) {
      const paymentMethod = snap.paymentChangeOrderIds.has(row.orderId) && row.paymentMethod === 'UPI_BHARATHI'
        ? 'UPI_BHARATH'
        : undefined
      await tx.transaction.update({
        where: { id: row.id },
        data: {
          createdAt: shiftOneDayEarlier(row.createdAt),
          paidAt: shiftOneDayEarlier(row.paidAt),
          ...(paymentMethod ? { paymentMethod } : {}),
        },
      })
    }

    for (const group of snap.transactionGroups) {
      await tx.transactionGroup.update({
        where: { id: group.id },
        data: {
          createdAt: shiftOneDayEarlier(group.createdAt),
          paidAt: shiftOneDayEarlier(group.paidAt),
        },
      })
    }

    for (const item of snap.orderItems) {
      await tx.orderItem.update({
        where: { id: item.id },
        data: { createdAt: shiftOneDayEarlier(item.createdAt) },
      })
    }

    for (const log of snap.inventoryLogs) {
      await tx.inventoryLog.update({
        where: { id: log.id },
        data: { createdAt: shiftOneDayEarlier(log.createdAt) },
      })
    }

    for (const stock of snap.uniformStocks) {
      await tx.uniformStock.update({
        where: { id: stock.id },
        data: { updatedAt: shiftOneDayEarlier(stock.updatedAt) },
      })
    }

    for (const stock of snap.bookStocks) {
      await tx.bookStock.update({
        where: { id: stock.id },
        data: { updatedAt: shiftOneDayEarlier(stock.updatedAt) },
      })
    }
  }, { maxWait: 15_000, timeout: 120_000 })
}

async function verifyPostChange(branchId, beforeSnap) {
  const after = await loadSnapshot(branchId)
  assert(after.orders.length === 0, `Still found ${after.orders.length} orders on 30 Jun after correction`)

  const movedOrders = await prisma.order.findMany({
    where: {
      branchId,
      id: { in: beforeSnap.orders.map((o) => o.id) },
    },
    include: {
      student: { select: { name: true } },
      transactions: true,
    },
    orderBy: { createdAt: 'asc' },
  })

  console.log('\nPost-change verification:')
  for (const before of beforeSnap.orders) {
    const order = movedOrders.find((o) => o.id === before.id)
    assert(order, `Missing order ${before.orderId}`)
    assert(istDateOnly(order.createdAt) === '2026-06-29', `${order.orderId} createdAt not on 29 Jun`)
    if (before.paidAt) {
      assert(istDateOnly(order.paidAt) === '2026-06-29', `${order.orderId} paidAt not on 29 Jun`)
    }

    const shouldRetag = beforeSnap.paymentChangeOrderIds.has(order.id)
    if (shouldRetag) {
      assert(order.paymentMethod === 'UPI_BHARATH', `${order.orderId} order paymentMethod not UPI_BHARATH`)
      const bharathiTx = order.transactions.filter((t) => t.paymentMethod === 'UPI_BHARATHI')
      assert(bharathiTx.length === 0, `${order.orderId} still has UPI_BHARATHI transaction(s)`)
    }

    console.log(
      `  OK ${order.orderId} | ${order.student?.name ?? '—'} | ${fmt(order.createdAt)} | ${order.paymentMethod ?? '—'}`,
    )
  }

  const invOn29 = await prisma.inventoryLog.count({
    where: {
      branchId,
      id: { in: beforeSnap.inventoryLogs.map((l) => l.id) },
      createdAt: {
        gte: new Date('2026-06-29T00:00:00+05:30'),
        lt: new Date('2026-06-30T00:00:00+05:30'),
      },
    },
  })
  assert(invOn29 === beforeSnap.inventoryLogs.length, `Inventory log date shift mismatch (${invOn29}/${beforeSnap.inventoryLogs.length})`)
  console.log(`  OK ${invOn29} inventory logs now on 29 Jun`)
}

async function main() {
  const branch = await findDargaBranch()
  const snap = await loadSnapshot(branch.id)

  assert(snap.orders.length > 0, 'No Darga orders found on 30 Jun 2026 — nothing to correct')
  printSnapshot(branch, snap)

  if (!APPLY) {
    console.log('\nDry run complete. Re-run with APPLY_DARGA_JUN30_CORRECTION=1 to commit.')
    return
  }

  await applyCorrection(branch.id, snap)
  await verifyPostChange(branch.id, snap)
  console.log('\nDone. Darga 30 Jun → 29 Jun correction committed.')
}

main()
  .catch((err) => {
    console.error('FAILED:', err.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
