/**
 * Production maintenance: remove Notebook Bundle from #SKM-2026-8418.
 *
 * Default mode is dry-run verification only:
 *   node prisma/correct-order-skm-2026-8418.js
 *
 * Write mode:
 *   APPLY_ORDER_CORRECTION=1 node prisma/correct-order-skm-2026-8418.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

const ORDER_PUBLIC_ID = '#SKM-2026-8418'
const EXPECTED_STUDENT_NAME = 'Y. Yashwanth Goud'
const EXPECTED_ROLL = 'CAMP-A-7-A-032'
const EXPECTED_BRANCH_CODE = 'NHS_DARGA'
const EXPECTED_TOTAL = 5300
const CORRECTED_TOTAL = 4770
const EXPECTED_NOTEBOOK_TOTAL = 528
const APPLY = process.env.APPLY_ORDER_CORRECTION === '1'
const POSTCHECK_ONLY = process.env.POSTCHECK_ONLY === '1'
const MATCH_WINDOW_MS = 10 * 60 * 1000

function money(value) {
  return Number(value ?? 0)
}

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

function toneFor(quantity, threshold = 50) {
  if (quantity <= threshold * 0.2) return 'CRITICAL'
  if (quantity <= threshold) return 'LOW'
  return 'NORMAL'
}

async function loadContext(client = prisma) {
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

  const notebookItem = order.items.find((item) => /notebook/i.test(item.label))
  assert(notebookItem, 'Notebook Bundle order item not found')
  assert(notebookItem.bookItemId, 'Notebook Bundle order item has no bookItemId')

  const stock = await client.bookStock.findUnique({
    where: {
      itemId_branchId: {
        itemId: notebookItem.bookItemId,
        branchId: order.branchId,
      },
    },
    include: { item: true, branch: true },
  })
  assert(stock, 'Notebook Bundle stock row for order branch not found')

  const createdAt = new Date(order.createdAt)
  const logStart = new Date(createdAt.getTime() - MATCH_WINDOW_MS)
  const logEnd = new Date(createdAt.getTime() + MATCH_WINDOW_MS)
  const outgoingLogs = await client.inventoryLog.findMany({
    where: {
      branchId: order.branchId,
      itemType: 'BOOK',
      bookItemId: notebookItem.bookItemId,
      changeType: 'OUTGOING',
      quantityDelta: -1,
      createdAt: { gte: logStart, lte: logEnd },
      notes: {
        contains: EXPECTED_ROLL,
      },
    },
    orderBy: { createdAt: 'desc' },
  })

  const superAdmin = await client.user.findFirst({
    where: { role: 'SUPER_ADMIN', isActive: true },
    orderBy: { createdAt: 'asc' },
  })
  assert(superAdmin, 'Active SUPER_ADMIN user not found for audit log performedById')

  return { order, notebookItem, stock, outgoingLogs, superAdmin }
}

function verifyContext(ctx) {
  const { order, notebookItem, stock, outgoingLogs } = ctx
  const textbookItem = order.items.find((item) => /textbook/i.test(item.label))
  const workbookItem = order.items.find((item) => /workbook/i.test(item.label))
  const cashTransactions = order.transactions.filter((tx) => tx.paymentMethod === 'CASH')

  assert(order.student?.name === EXPECTED_STUDENT_NAME, `Student mismatch: ${order.student?.name}`)
  assert(order.student?.rollNumber === EXPECTED_ROLL, `Student roll mismatch: ${order.student?.rollNumber}`)
  assert(order.student?.class?.grade === 7, `Class grade mismatch: ${order.student?.class?.grade}`)
  assert(order.student?.class?.section === 'A', `Class section mismatch: ${order.student?.class?.section}`)
  assert(order.branch?.code === EXPECTED_BRANCH_CODE, `Branch code mismatch: ${order.branch?.code}`)
  assert(order.paymentStatus === 'PAID', `Payment status mismatch: ${order.paymentStatus}`)
  assert(order.status === 'COMPLETED', `Order status mismatch: ${order.status}`)
  assert(money(order.total) === EXPECTED_TOTAL, `Order total mismatch: ${order.total}`)
  assert(money(order.subtotal) === EXPECTED_TOTAL, `Order subtotal mismatch: ${order.subtotal}`)
  assert(money(order.paidAmount) === EXPECTED_TOTAL, `Order paidAmount mismatch: ${order.paidAmount}`)
  assert(order.items.length === 3, `Expected exactly 3 order items, found ${order.items.length}`)

  assert(textbookItem, 'Textbook Bundle order item not found')
  assert(workbookItem, 'Workbook Bundle order item not found')
  assert(money(textbookItem.totalPrice) === 810, `Textbook total mismatch: ${textbookItem.totalPrice}`)
  assert(money(workbookItem.totalPrice) === 3960, `Workbook total mismatch: ${workbookItem.totalPrice}`)
  assert(money(notebookItem.totalPrice) === EXPECTED_NOTEBOOK_TOTAL, `Notebook total mismatch: ${notebookItem.totalPrice}`)
  assert(notebookItem.quantity === 1, `Notebook quantity mismatch: ${notebookItem.quantity}`)

  assert(order.transactions.length === 1, `Expected exactly 1 transaction, found ${order.transactions.length}`)
  assert(cashTransactions.length === 1, `Expected exactly 1 cash transaction, found ${cashTransactions.length}`)
  assert(money(cashTransactions[0].amount) === EXPECTED_TOTAL, `Cash transaction amount mismatch: ${cashTransactions[0].amount}`)
  assert(cashTransactions[0].status === 'PAID', `Cash transaction status mismatch: ${cashTransactions[0].status}`)

  assert(stock.branch?.code === EXPECTED_BRANCH_CODE, `Stock branch mismatch: ${stock.branch?.code}`)
  assert(outgoingLogs.length >= 1, 'Matching Notebook Bundle outgoing stock log was not found')
}

function printPrecheck(ctx) {
  const { order, notebookItem, stock, outgoingLogs } = ctx
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log(`Order: ${order.orderId} (${order.id})`)
  console.log(`Student: ${order.student.name} / ${order.student.rollNumber} / ${order.student.class.label}-${order.student.class.section}`)
  console.log(`Branch: ${order.branch.name} (${order.branch.code})`)
  console.log(`Created: ${fmt(order.createdAt)}`)
  console.log(`Current totals: subtotal ${order.subtotal}, total ${order.total}, paid ${order.paidAmount}, status ${order.paymentStatus}`)
  console.log('\nItems before:')
  for (const item of order.items) {
    console.log(`- ${item.label} | qty ${item.quantity} | unit ${item.unitPrice} | total ${item.totalPrice} | id ${item.id}`)
  }
  console.log('\nTransactions before:')
  for (const tx of order.transactions) {
    console.log(`- ${tx.id} | ${tx.paymentMethod} | ${tx.amount} | ${tx.status} | ${fmt(tx.createdAt)}`)
  }
  console.log(`\nNotebook stock before: ${stock.quantity} (stock id ${stock.id}, item id ${notebookItem.bookItemId})`)
  console.log('Matched original outgoing stock log(s):')
  for (const log of outgoingLogs) {
    console.log(`- ${log.id} | delta ${log.quantityDelta} | ${log.quantityBefore} -> ${log.quantityAfter} | ${fmt(log.createdAt)}`)
  }
}

async function applyCorrection(ctx) {
  const { order, notebookItem, stock, superAdmin } = ctx
  const beforeStock = stock.quantity
  const afterStock = beforeStock + 1
  const newTone = toneFor(afterStock)
  const transaction = order.transactions[0]

  await prisma.$transaction(async (tx) => {
    await tx.orderItem.delete({
      where: { id: notebookItem.id },
    })

    await tx.order.update({
      where: { id: order.id },
      data: {
        subtotal: CORRECTED_TOTAL,
        total: CORRECTED_TOTAL,
        paidAmount: CORRECTED_TOTAL,
        updatedAt: new Date(),
      },
    })

    await tx.transaction.update({
      where: { id: transaction.id },
      data: {
        amount: CORRECTED_TOTAL,
        notes: [
          transaction.notes,
          `Order correction ${ORDER_PUBLIC_ID}: payment revised from ₹${EXPECTED_TOTAL} to ₹${CORRECTED_TOTAL} after Notebook Bundle removal.`,
        ].filter(Boolean).join('\n'),
      },
    })

    await tx.bookStock.update({
      where: {
        itemId_branchId: {
          itemId: notebookItem.bookItemId,
          branchId: order.branchId,
        },
      },
      data: {
        quantity: afterStock,
        tone: newTone,
      },
    })

    await tx.inventoryLog.create({
      data: {
        branchId: order.branchId,
        itemType: 'BOOK',
        bookItemId: notebookItem.bookItemId,
        changeType: 'ADJUSTMENT',
        quantityBefore: beforeStock,
        quantityAfter: afterStock,
        quantityDelta: 1,
        performedById: superAdmin.id,
        notes: [
          'Order correction',
          `Order: ${ORDER_PUBLIC_ID}`,
          `Student: ${order.student.name}`,
          `Roll: ${order.student.rollNumber}`,
          `Class: ${order.student.class.label} Section ${order.student.class.section}`,
          `Branch: ${order.branch.name}`,
          `Product: ${notebookItem.label}`,
          `Payment: Cash revised from INR ${EXPECTED_TOTAL} to INR ${CORRECTED_TOTAL}`,
          'Reason: Student did not take notebooks. Notebook Bundle removed from order and stock reverted by +1.',
        ].join('\n'),
      },
    })
  }, { maxWait: 15_000, timeout: 60_000 })
}

async function printPostcheck() {
  const order = await prisma.order.findUnique({
    where: { orderId: ORDER_PUBLIC_ID },
    include: {
      student: { include: { class: true } },
      branch: true,
      items: { orderBy: { createdAt: 'asc' } },
      transactions: { orderBy: { createdAt: 'asc' } },
    },
  })
  assert(order, `Order ${ORDER_PUBLIC_ID} not found`)

  const correctionLogs = await prisma.inventoryLog.findMany({
    where: {
      branchId: order.branchId,
      itemType: 'BOOK',
      changeType: 'ADJUSTMENT',
      quantityDelta: 1,
      notes: { contains: ORDER_PUBLIC_ID },
    },
    orderBy: { createdAt: 'desc' },
    take: 3,
  })
  assert(correctionLogs.length >= 1, 'Correction inventory log not found')

  const stock = await prisma.bookStock.findUnique({
    where: {
      itemId_branchId: {
        itemId: correctionLogs[0].bookItemId,
        branchId: order.branchId,
      },
    },
  })
  assert(stock, 'Notebook Bundle stock row not found during post-check')

  assert(money(order.total) === CORRECTED_TOTAL, `Post-check total mismatch: ${order.total}`)
  assert(money(order.subtotal) === CORRECTED_TOTAL, `Post-check subtotal mismatch: ${order.subtotal}`)
  assert(money(order.paidAmount) === CORRECTED_TOTAL, `Post-check paidAmount mismatch: ${order.paidAmount}`)
  assert(order.items.length === 2, `Post-check expected 2 order items, found ${order.items.length}`)
  assert(!order.items.some((item) => /notebook/i.test(item.label)), 'Post-check Notebook Bundle still appears on order')
  assert(order.transactions.length === 1, `Post-check expected 1 transaction, found ${order.transactions.length}`)
  assert(money(order.transactions[0].amount) === CORRECTED_TOTAL, `Post-check transaction amount mismatch: ${order.transactions[0].amount}`)
  assert(stock.quantity === 474, `Post-check stock mismatch: ${stock.quantity}`)

  console.log('\nPost-change verification:')
  console.log(`- total: ${order.total}`)
  console.log(`- subtotal: ${order.subtotal}`)
  console.log(`- paidAmount: ${order.paidAmount}`)
  console.log(`- paymentStatus: ${order.paymentStatus}`)
  console.log(`- item count: ${order.items.length}`)
  for (const item of order.items) {
    console.log(`  - ${item.label} | qty ${item.quantity} | total ${item.totalPrice}`)
  }
  for (const tx of order.transactions) {
    console.log(`- transaction: ${tx.paymentMethod} | ${tx.amount} | ${tx.status}`)
  }
  console.log(`- notebook stock: ${stock.quantity}`)
  console.log(`- correction logs found: ${correctionLogs.length}`)
}

async function main() {
  if (POSTCHECK_ONLY) {
    await printPostcheck()
    return
  }

  const ctx = await loadContext()
  verifyContext(ctx)
  printPrecheck(ctx)

  if (!APPLY) {
    console.log('\nDry run passed. Re-run with APPLY_ORDER_CORRECTION=1 to commit this correction.')
    return
  }

  await applyCorrection(ctx)
  await printPostcheck()
  console.log('\nDone. Order correction committed.')
}

main()
  .catch((err) => {
    console.error('FAILED:', err.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
