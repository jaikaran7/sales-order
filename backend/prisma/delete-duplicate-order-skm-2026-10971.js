/**
 * Darga — K.Ditya Sindhu duplicate socks order
 *
 * Keep:   #SKM-2026-10970 (earlier, Jul 14 ~10:11) — Socks Grey 4×2 + White 4×1
 * Delete: #SKM-2026-10971 (later,  Jul 14 ~11:38) — Socks Grey 4×2 + White 3×1
 *
 * Fully removes the duplicate order, its payment, inventory logs, and restores stock.
 *
 * Dry run:
 *   node prisma/delete-duplicate-order-skm-2026-10971.js
 *
 * Apply (dev first):
 *   APPLY_DELETE_DUPLICATE_10971=1 node prisma/delete-duplicate-order-skm-2026-10971.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const APPLY = process.env.APPLY_DELETE_DUPLICATE_10971 === '1'

const KEEP_ORDER_ID = '#SKM-2026-10970'
const DELETE_ORDER_ID = '#SKM-2026-10971'
const DELETE_ORDER_DB_ID = 'cmrkkuof40004xlvldpqsqzlo'
const DELETE_TX_ID = 'cmrkkuuas000ixlvln6ojiwmv'
const DELETE_LOG_IDS = ['cmrkkure0000bxlvluayznogz', 'cmrkkus9n000fxlvlj231s4qe']

const EXPECTED_STUDENT = 'K.Ditya Sindhu'
const EXPECTED_ROLL = 'CAMP-A-3-A-005'
const EXPECTED_BRANCH = 'NHS_DARGA'
const EXPECTED_TOTAL = 210

const GREY_SIZE_ID = 'b6cb6fa4-d84d-47b6-aa34-37d1dfefd7db'
const WHITE_SIZE_3_ID = 'cmqt7hgxd002mfkobon144sgw'

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

async function loadContext(client = prisma) {
  const keepOrder = await client.order.findUnique({
    where: { orderId: KEEP_ORDER_ID },
    include: {
      student: { include: { class: true } },
      branch: true,
      items: true,
      transactions: true,
    },
  })
  assert(keepOrder, `Keep order ${KEEP_ORDER_ID} not found`)
  assert(keepOrder.student.name === EXPECTED_STUDENT, `Keep student mismatch: ${keepOrder.student.name}`)
  assert(keepOrder.student.rollNumber === EXPECTED_ROLL, `Keep roll mismatch: ${keepOrder.student.rollNumber}`)
  assert(keepOrder.branch.code === EXPECTED_BRANCH, `Keep branch mismatch: ${keepOrder.branch.code}`)
  assert(money(keepOrder.total) === EXPECTED_TOTAL, `Keep total mismatch: ${keepOrder.total}`)
  assert(keepOrder.paymentStatus === 'PAID', `Keep order not PAID: ${keepOrder.paymentStatus}`)
  assert(keepOrder.transactions.length === 1, 'Keep order should have exactly 1 transaction')

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
  assert(deleteOrder, `Delete order ${DELETE_ORDER_ID} not found`)
  assert(deleteOrder.orderId === DELETE_ORDER_ID, `Delete order ref mismatch: ${deleteOrder.orderId}`)
  assert(deleteOrder.studentId === keepOrder.studentId, 'Orders are for different students')
  assert(deleteOrder.branch.code === EXPECTED_BRANCH, `Delete branch mismatch: ${deleteOrder.branch.code}`)
  assert(money(deleteOrder.total) === EXPECTED_TOTAL, `Delete total mismatch: ${deleteOrder.total}`)
  assert(deleteOrder.paymentStatus === 'PAID', `Delete order not PAID: ${deleteOrder.paymentStatus}`)
  assert(deleteOrder.transactions.length === 1, 'Delete order should have exactly 1 transaction')
  assert(deleteOrder.transactions[0].id === DELETE_TX_ID, 'Delete tx id mismatch')
  assert(!deleteOrder.transactionGroupId, 'Delete order should not be in a group')
  assert(deleteOrder.items.length === 2, `Expected 2 items on delete order, found ${deleteOrder.items.length}`)

  const greyItem = deleteOrder.items.find((i) => i.uniformSizeId === GREY_SIZE_ID)
  const whiteItem = deleteOrder.items.find((i) => i.uniformSizeId === WHITE_SIZE_3_ID)
  assert(greyItem && greyItem.quantity === 2, 'Delete order Grey socks qty mismatch')
  assert(whiteItem && whiteItem.quantity === 1, 'Delete order White socks size 3 qty mismatch')

  const greyStock = await client.uniformStock.findUnique({
    where: { sizeId_branchId: { sizeId: GREY_SIZE_ID, branchId: deleteOrder.branchId } },
    include: { size: true },
  })
  const whiteStock = await client.uniformStock.findUnique({
    where: { sizeId_branchId: { sizeId: WHITE_SIZE_3_ID, branchId: deleteOrder.branchId } },
    include: { size: true },
  })
  assert(greyStock, 'Grey socks size 4 stock row not found')
  assert(whiteStock, 'White socks size 3 stock row not found')

  const deleteLogs = await client.inventoryLog.findMany({
    where: { id: { in: DELETE_LOG_IDS } },
  })
  assert(deleteLogs.length === DELETE_LOG_IDS.length, `Expected ${DELETE_LOG_IDS.length} inventory logs, found ${deleteLogs.length}`)

  const superAdmin = await client.user.findFirst({
    where: { role: 'SUPER_ADMIN', isActive: true },
    orderBy: { createdAt: 'asc' },
  })
  assert(superAdmin, 'SUPER_ADMIN not found')

  return { keepOrder, deleteOrder, greyStock, whiteStock, deleteLogs, superAdmin, greyItem, whiteItem }
}

function printPrecheck(ctx) {
  const { keepOrder, deleteOrder, greyStock, whiteStock } = ctx
  console.log(`KEEP  ${KEEP_ORDER_ID}: ${fmt(keepOrder.createdAt)} | Cash ₹${keepOrder.total} | items: ${keepOrder.items.map((i) => i.label).join(', ')}`)
  console.log(`DELETE ${DELETE_ORDER_ID}: ${fmt(deleteOrder.createdAt)} | Cash ₹${deleteOrder.total} | items: ${deleteOrder.items.map((i) => i.label).join(', ')}`)
  console.log('')
  console.log('Stock restore on delete:')
  console.log(`- Socks Grey size 4: ${greyStock.quantity} → ${greyStock.quantity + 2}`)
  console.log(`- Socks White size 3: ${whiteStock.quantity} → ${whiteStock.quantity + 1}`)
}

async function applyFix(ctx) {
  const { deleteOrder, greyStock, whiteStock, superAdmin, greyItem, whiteItem } = ctx

  await prisma.$transaction(async (tx) => {
    await tx.transaction.delete({ where: { id: DELETE_TX_ID } })
    await tx.orderItem.deleteMany({ where: { orderId: deleteOrder.id } })
    await tx.inventoryLog.deleteMany({ where: { id: { in: DELETE_LOG_IDS } } })

    const greyBefore = greyStock.quantity
    const greyAfter = greyBefore + greyItem.quantity
    await tx.uniformStock.update({
      where: { sizeId_branchId: { sizeId: GREY_SIZE_ID, branchId: deleteOrder.branchId } },
      data: { quantity: greyAfter, tone: toneFor(greyAfter) },
    })
    await tx.inventoryLog.create({
      data: {
        branchId: deleteOrder.branchId,
        itemType: 'UNIFORM',
        uniformSizeId: GREY_SIZE_ID,
        changeType: 'ADJUSTMENT',
        quantityBefore: greyBefore,
        quantityAfter: greyAfter,
        quantityDelta: greyItem.quantity,
        performedById: superAdmin.id,
        notes: [
          'Duplicate order deletion — stock revert',
          `Deleted order: ${DELETE_ORDER_ID}`,
          `Kept order: ${KEEP_ORDER_ID}`,
          `Student: ${EXPECTED_STUDENT} (${EXPECTED_ROLL})`,
          `Product: ${greyItem.label}`,
          `Quantity: +${greyItem.quantity}`,
          'Reason: Duplicate socks sale removed; stock restored.',
        ].join('\n'),
      },
    })

    const whiteBefore = whiteStock.quantity
    const whiteAfter = whiteBefore + whiteItem.quantity
    await tx.uniformStock.update({
      where: { sizeId_branchId: { sizeId: WHITE_SIZE_3_ID, branchId: deleteOrder.branchId } },
      data: { quantity: whiteAfter, tone: toneFor(whiteAfter) },
    })
    await tx.inventoryLog.create({
      data: {
        branchId: deleteOrder.branchId,
        itemType: 'UNIFORM',
        uniformSizeId: WHITE_SIZE_3_ID,
        changeType: 'ADJUSTMENT',
        quantityBefore: whiteBefore,
        quantityAfter: whiteAfter,
        quantityDelta: whiteItem.quantity,
        performedById: superAdmin.id,
        notes: [
          'Duplicate order deletion — stock revert',
          `Deleted order: ${DELETE_ORDER_ID}`,
          `Kept order: ${KEEP_ORDER_ID}`,
          `Student: ${EXPECTED_STUDENT} (${EXPECTED_ROLL})`,
          `Product: ${whiteItem.label}`,
          `Quantity: +${whiteItem.quantity}`,
          'Reason: Duplicate socks sale removed; stock restored.',
        ].join('\n'),
      },
    })

    await tx.order.delete({ where: { id: deleteOrder.id } })
  }, { maxWait: 15_000, timeout: 120_000 })
}

async function verifyPostChange(ctx) {
  const { greyStock, whiteStock } = ctx

  const deleted = await prisma.order.findUnique({ where: { orderId: DELETE_ORDER_ID } })
  assert(!deleted, `${DELETE_ORDER_ID} still exists`)

  const kept = await prisma.order.findUnique({
    where: { orderId: KEEP_ORDER_ID },
    include: { transactions: true, items: true },
  })
  assert(kept, `${KEEP_ORDER_ID} missing after fix`)
  assert(money(kept.total) === EXPECTED_TOTAL, `Keep order total changed: ${kept.total}`)
  assert(kept.paymentStatus === 'PAID', `Keep order paymentStatus changed: ${kept.paymentStatus}`)
  assert(kept.transactions.length === 1, 'Keep order transactions changed')
  assert(kept.items.length === 2, 'Keep order items changed')

  const greyAfter = await prisma.uniformStock.findUnique({
    where: { sizeId_branchId: { sizeId: GREY_SIZE_ID, branchId: kept.branchId } },
  })
  const whiteAfter = await prisma.uniformStock.findUnique({
    where: { sizeId_branchId: { sizeId: WHITE_SIZE_3_ID, branchId: kept.branchId } },
  })
  assert(greyAfter.quantity === greyStock.quantity + 2, `Grey stock mismatch: ${greyAfter.quantity}`)
  assert(whiteAfter.quantity === whiteStock.quantity + 1, `White size 3 stock mismatch: ${whiteAfter.quantity}`)

  const oldLogs = await prisma.inventoryLog.count({ where: { id: { in: DELETE_LOG_IDS } } })
  assert(oldLogs === 0, 'Original outgoing logs for deleted order still present')

  const revertLogs = await prisma.inventoryLog.count({
    where: {
      branchId: kept.branchId,
      changeType: 'ADJUSTMENT',
      notes: { contains: DELETE_ORDER_ID },
    },
  })
  assert(revertLogs >= 2, `Expected revert adjustment logs, found ${revertLogs}`)

  console.log('\nPost-change verification:')
  console.log(`- ${DELETE_ORDER_ID}: removed`)
  console.log(`- ${KEEP_ORDER_ID}: still PAID ₹${kept.total}, ${kept.items.length} items, ${kept.transactions.length} tx`)
  console.log(`- Grey size 4 stock: ${greyAfter.quantity}`)
  console.log(`- White size 3 stock: ${whiteAfter.quantity}`)
}

async function main() {
  const url = process.env.DATABASE_URL || ''
  const target = url.includes('ep-small-art') ? 'PRODUCTION' : url.includes('ep-rough-rain') ? 'DEVELOPMENT' : 'UNKNOWN'
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'} | DB: ${target}`)

  const ctx = await loadContext()
  printPrecheck(ctx)

  if (!APPLY) {
    console.log('\nDry run passed. Re-run with APPLY_DELETE_DUPLICATE_10971=1 to commit.')
    return
  }

  await applyFix(ctx)
  await verifyPostChange(ctx)
  console.log('\nDone. Duplicate order deleted and stock restored.')
}

main()
  .catch((err) => {
    console.error('FAILED:', err.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
