/**
 * Darga branch — 13 Jul 2026
 *
 * 1. T.Anika (#SKM-2026-5013): Class 3 books returned; student upgraded to Class 4.
 *    Revert stock only (+1 Textbook Bundle, +1 Notebook Bundle). Order/amounts untouched.
 *
 * 2. Online Allocation: VSR Publishers / UPI To Bharathi entered as ₹5,00,000 → ₹50,000.
 *
 * Dry run:
 *   node prisma/correct-anika-5013-stock-and-vsr-expense-jul13-2026.js
 *
 * Apply:
 *   APPLY_ANIKA_VSR_CORRECTION=1 node prisma/correct-anika-5013-stock-and-vsr-expense-jul13-2026.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const APPLY = process.env.APPLY_ANIKA_VSR_CORRECTION === '1'

const ORDER_PUBLIC_ID = '#SKM-2026-5013'
const EXPECTED_STUDENT = 'T.Anika'
const EXPECTED_ROLL = 'CAMP-A-3-A-002'
const EXPECTED_BRANCH = 'NHS_DARGA'
const EXPECTED_TOTAL = 4780

const TEXTBOOK_ITEM_ID = 'cmp5xox38007xuhwzyv24vpxt'
const NOTEBOOK_ITEM_ID = 'cmp5wgw5e00zorgkbeimp8oj3'

const EXPENSE_WRONG_AMOUNT = 500000
const EXPENSE_CORRECT_AMOUNT = 50000

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

function fmt(value) {
  return new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium',
    hour12: true,
  })
}

async function loadOrderContext(client = prisma) {
  const order = await client.order.findUnique({
    where: { orderId: ORDER_PUBLIC_ID },
    include: {
      student: { include: { class: true } },
      branch: true,
      items: { include: { bookItem: true }, orderBy: { createdAt: 'asc' } },
      transactions: { orderBy: { createdAt: 'asc' } },
    },
  })
  assert(order, `Order ${ORDER_PUBLIC_ID} not found`)
  assert(order.student?.name === EXPECTED_STUDENT, `Student mismatch: ${order.student?.name}`)
  assert(order.student?.rollNumber === EXPECTED_ROLL, `Roll mismatch: ${order.student?.rollNumber}`)
  assert(order.student?.class?.grade === 3, `Class grade mismatch: ${order.student?.class?.grade}`)
  assert(order.branch?.code === EXPECTED_BRANCH, `Branch mismatch: ${order.branch?.code}`)
  assert(money(order.total) === EXPECTED_TOTAL, `Order total mismatch: ${order.total}`)
  assert(order.paymentStatus === 'PAID', `Order not PAID: ${order.paymentStatus}`)

  const textbookItem = order.items.find((item) => item.bookItemId === TEXTBOOK_ITEM_ID)
  const notebookItem = order.items.find((item) => item.bookItemId === NOTEBOOK_ITEM_ID)
  assert(textbookItem, 'Textbook Bundle order item not found')
  assert(notebookItem, 'Notebook Bundle order item not found')
  assert(textbookItem.quantity === 1 && notebookItem.quantity === 1, 'Expected qty 1 on both items')

  const stocks = await client.bookStock.findMany({
    where: {
      branchId: order.branchId,
      itemId: { in: [TEXTBOOK_ITEM_ID, NOTEBOOK_ITEM_ID] },
    },
    include: { item: true },
  })
  assert(stocks.length === 2, `Expected 2 stock rows, found ${stocks.length}`)

  const superAdmin = await client.user.findFirst({
    where: { role: 'SUPER_ADMIN', isActive: true },
    orderBy: { createdAt: 'asc' },
  })
  assert(superAdmin, 'SUPER_ADMIN not found')

  return { order, textbookItem, notebookItem, stocks, superAdmin }
}

async function loadExpenseContext(client = prisma) {
  const candidates = await client.expenseEntry.findMany({
    where: {
      amount: EXPENSE_WRONG_AMOUNT,
      entryType: 'ONLINE_ALLOCATION',
      paymentMethod: 'UPI_BHARATHI',
      entryDate: {
        gte: new Date('2026-07-07T00:00:00.000Z'),
        lte: new Date('2026-07-12T23:59:59.999Z'),
      },
      createdBy: { displayName: { contains: 'Bharathi', mode: 'insensitive' } },
    },
    include: {
      branch: true,
      publisher: true,
      createdBy: { select: { displayName: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  const entry = candidates.find((row) => {
    const recipient = `${row.recipient ?? ''} ${row.notes ?? ''}`.toLowerCase()
    const publisher = `${row.publisher?.name ?? ''}`.toLowerCase()
    return recipient.includes('vsr') || publisher.includes('vsr')
  }) ?? candidates[0]

  assert(entry, 'VSR online allocation expense entry at ₹5,00,000 not found')
  assert(money(entry.amount) === EXPENSE_WRONG_AMOUNT, `Expense amount mismatch: ${entry.amount}`)
  assert(entry.entryType === 'ONLINE_ALLOCATION', `entryType mismatch: ${entry.entryType}`)
  assert(entry.paymentMethod === 'UPI_BHARATHI', `paymentMethod mismatch: ${entry.paymentMethod}`)
  assert(entry.branch?.code === EXPECTED_BRANCH, `Expense branch mismatch: ${entry.branch?.code}`)

  return { entry }
}

function printOrderPrecheck(ctx) {
  const { order, stocks } = ctx
  console.log(`\n--- Order stock revert: ${ORDER_PUBLIC_ID} ---`)
  console.log(`Student: ${order.student.name} (${order.student.rollNumber}) | ${order.student.class.label}`)
  console.log(`Branch: ${order.branch.name} | Total: ₹${order.total} | Status: ${order.paymentStatus}`)
  console.log('Items (unchanged):')
  for (const item of order.items) {
    console.log(`- ${item.label} | qty ${item.quantity} | total ₹${item.totalPrice}`)
  }
  console.log('Stock before → after:')
  for (const stock of stocks) {
    console.log(`- ${stock.item.label}: ${stock.quantity} → ${stock.quantity + 1}`)
  }
}

function printExpensePrecheck(ctx) {
  const { entry } = ctx
  console.log('\n--- Expense amount correction ---')
  console.log(`ID: ${entry.id}`)
  console.log(`Branch: ${entry.branch.name}`)
  console.log(`Entry date: ${fmt(entry.entryDate)} | Created: ${fmt(entry.createdAt)}`)
  console.log(`Type: ${entry.entryType} | Method: ${entry.paymentMethod} | Status: ${entry.status}`)
  console.log(`Recipient: ${entry.recipient ?? '(none)'}`)
  console.log(`Publisher: ${entry.publisher?.name ?? '(none)'}`)
  console.log(`Amount: ₹${money(entry.amount)} → ₹${EXPENSE_CORRECT_AMOUNT}`)
}

async function applyStockRevert(orderCtx) {
  const { order, stocks, superAdmin } = orderCtx

  await prisma.$transaction(async (tx) => {
    for (const stock of stocks) {
      const before = stock.quantity
      const after = before + 1
      await tx.bookStock.update({
        where: {
          itemId_branchId: { itemId: stock.itemId, branchId: order.branchId },
        },
        data: {
          quantity: after,
          tone: toneFor(after),
        },
      })

      await tx.inventoryLog.create({
        data: {
          branchId: order.branchId,
          itemType: 'BOOK',
          bookItemId: stock.itemId,
          changeType: 'ADJUSTMENT',
          quantityBefore: before,
          quantityAfter: after,
          quantityDelta: 1,
          performedById: superAdmin.id,
          notes: [
            'Book return — stock revert only',
            `Order: ${ORDER_PUBLIC_ID}`,
            `Student: ${EXPECTED_STUDENT} (${EXPECTED_ROLL})`,
            `Class: ${order.student.class.label}`,
            `Product: ${stock.item.label}`,
            'Reason: Class 3 books returned 13 Jul 2026; student purchased Class 4 kit. Order and payment left unchanged.',
          ].join('\n'),
        },
      })
    }
  }, { maxWait: 15_000, timeout: 60_000 })
}

async function applyExpenseCorrection(expenseCtx) {
  const { entry } = expenseCtx
  const noteLine = `Amount corrected 13 Jul 2026: ₹${EXPENSE_WRONG_AMOUNT.toLocaleString('en-IN')} → ₹${EXPENSE_CORRECT_AMOUNT.toLocaleString('en-IN')} (data entry error).`

  await prisma.expenseEntry.update({
    where: { id: entry.id },
    data: {
      amount: EXPENSE_CORRECT_AMOUNT,
      notes: [entry.notes, noteLine].filter(Boolean).join('\n'),
    },
  })
}

async function verifyPostChange(orderCtx, expenseCtx) {
  const { order, stocks: beforeStocks } = orderCtx
  const { entry } = expenseCtx

  const afterStocks = await prisma.bookStock.findMany({
    where: {
      branchId: order.branchId,
      itemId: { in: [TEXTBOOK_ITEM_ID, NOTEBOOK_ITEM_ID] },
    },
    include: { item: true },
  })

  for (const before of beforeStocks) {
    const after = afterStocks.find((row) => row.itemId === before.itemId)
    assert(after, `Post-check stock missing for ${before.itemId}`)
    assert(after.quantity === before.quantity + 1, `Stock not reverted for ${after.item.label}: ${after.quantity}`)
  }

  const logs = await prisma.inventoryLog.count({
    where: {
      branchId: order.branchId,
      bookItemId: { in: [TEXTBOOK_ITEM_ID, NOTEBOOK_ITEM_ID] },
      changeType: 'ADJUSTMENT',
      quantityDelta: 1,
      notes: { contains: ORDER_PUBLIC_ID },
    },
  })
  assert(logs >= 2, `Expected 2 correction inventory logs, found ${logs}`)

  const unchangedOrder = await prisma.order.findUnique({
    where: { orderId: ORDER_PUBLIC_ID },
    select: { total: true, paidAmount: true, paymentStatus: true },
  })
  assert(money(unchangedOrder.total) === EXPECTED_TOTAL, 'Order total changed unexpectedly')
  assert(money(unchangedOrder.paidAmount) === EXPECTED_TOTAL, 'Order paidAmount changed unexpectedly')
  assert(unchangedOrder.paymentStatus === 'PAID', 'Order payment status changed unexpectedly')

  const afterExpense = await prisma.expenseEntry.findUnique({ where: { id: entry.id } })
  assert(money(afterExpense.amount) === EXPENSE_CORRECT_AMOUNT, `Expense amount not updated: ${afterExpense.amount}`)

  console.log('\nPost-change verification:')
  for (const stock of afterStocks) {
    console.log(`- ${stock.item.label} stock: ${stock.quantity}`)
  }
  console.log(`- ${ORDER_PUBLIC_ID} total still ₹${unchangedOrder.total} (${unchangedOrder.paymentStatus})`)
  console.log(`- expense ${entry.id} amount: ₹${afterExpense.amount}`)
}

async function main() {
  const url = process.env.DATABASE_URL || ''
  const target = url.includes('ep-small-art') ? 'PRODUCTION' : url.includes('ep-rough-rain') ? 'DEVELOPMENT' : 'UNKNOWN'
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'} | DB: ${target}`)

  const orderCtx = await loadOrderContext()
  const expenseCtx = await loadExpenseContext()

  printOrderPrecheck(orderCtx)
  printExpensePrecheck(expenseCtx)

  if (!APPLY) {
    console.log('\nDry run passed. Re-run with APPLY_ANIKA_VSR_CORRECTION=1 to commit.')
    return
  }

  await applyStockRevert(orderCtx)
  await applyExpenseCorrection(expenseCtx)
  await verifyPostChange(orderCtx, expenseCtx)
  console.log('\nDone. Stock reverted and expense amount corrected.')
}

main()
  .catch((err) => {
    console.error('FAILED:', err.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
