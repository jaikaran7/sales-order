/**
 * Dev smoke test — global Diary & Exam Booklet order combinations.
 *
 * Dry run (no orders created):
 *   node prisma/smoke-global-diary-exam-booklet-orders-jul20-2026.js
 *
 * Apply:
 *   APPLY_SMOKE_ORDERS=1 node prisma/smoke-global-diary-exam-booklet-orders-jul20-2026.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { PrismaClient } = require('@prisma/client')
const { allocateUniqueOrderId } = require('../src/utils/orderRef')

const prisma = new PrismaClient()
const APPLY = process.env.APPLY_SMOKE_ORDERS === '1'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function money(v) {
  return Number(v ?? 0)
}

function calcTone(qty, threshold = 50) {
  if (qty <= threshold * 0.2) return 'CRITICAL'
  if (qty <= threshold) return 'LOW'
  return 'NORMAL'
}

async function getBookItem(branchId, grade, catalogKey) {
  return prisma.bookKitItem.findFirst({
    where: {
      catalogKey,
      isArchived: false,
      kit: { kind: 'ACADEMIC', class: { grade, section: 'A', branchId } },
    },
    include: { bookStocks: { where: { branchId } } },
  })
}

async function getNotebookBundleItem(branchId, grade) {
  return prisma.bookKitItem.findFirst({
    where: {
      label: { contains: 'Notebook', mode: 'insensitive' },
      isArchived: false,
      kit: { kind: 'NOTEBOOKS', class: { grade, section: 'A', branchId } },
    },
    include: { bookStocks: { where: { branchId } } },
  })
}

async function getUniformSize(branchId, _grade, namePart) {
  const sizes = await prisma.uniformSize.findMany({
    where: {
      name: { contains: namePart, mode: 'insensitive' },
    },
    include: { uniformStocks: { where: { branchId } } },
    take: 5,
  })
  return sizes.find((s) => (s.uniformStocks[0]?.quantity ?? 0) > 0) ?? sizes[0] ?? null
}

async function findStudent(branchId, grade) {
  const student = await prisma.students.findFirst({
    where: { isActive: true, class: { branchId, grade, section: 'A' } },
    include: { class: true },
    orderBy: { name: 'asc' },
  })
  assert(student, `No student for grade ${grade} at branch`)
  return student
}

async function stockQty(bookItemId, branchId) {
  const row = await prisma.bookStock.findUnique({
    where: { itemId_branchId: { itemId: bookItemId, branchId } },
  })
  return row?.quantity ?? 0
}

async function uniformStockQty(sizeId, branchId) {
  const row = await prisma.uniformStock.findUnique({
    where: { sizeId_branchId: { sizeId, branchId } },
  })
  return row?.quantity ?? 0
}

async function deductStock(tx, { branchId, orderItems, student, branchName, performedById }) {
  const bookDeltas = new Map()
  const uniformDeltas = new Map()
  for (const line of orderItems) {
    const qty = Math.max(0, Math.floor(Number(line.quantity ?? 1)))
    if (line.itemType === 'BOOK' && line.bookItemId) {
      bookDeltas.set(line.bookItemId, (bookDeltas.get(line.bookItemId) ?? 0) + qty)
    } else if (line.itemType === 'UNIFORM' && line.uniformSizeId) {
      uniformDeltas.set(line.uniformSizeId, (uniformDeltas.get(line.uniformSizeId) ?? 0) + qty)
    }
  }

  for (const [bookItemId, deduct] of bookDeltas) {
    const labelRow = await tx.bookKitItem.findUnique({ where: { id: bookItemId }, select: { label: true } })
    const stock = await tx.bookStock.findUnique({ where: { itemId_branchId: { itemId: bookItemId, branchId } } })
    const before = stock?.quantity ?? 0
    const after = Math.max(0, before - deduct)
    await tx.bookStock.upsert({
      where: { itemId_branchId: { itemId: bookItemId, branchId } },
      create: { itemId: bookItemId, branchId, quantity: after, tone: calcTone(after) },
      update: { quantity: after, tone: calcTone(after) },
    })
    await tx.inventoryLog.create({
      data: {
        branchId,
        itemType: 'BOOK',
        bookItemId,
        changeType: 'OUTGOING',
        quantityBefore: before,
        quantityAfter: after,
        quantityDelta: after - before,
        performedById,
        notes: `Smoke test\nStudent: ${student.name}\nRoll: ${student.rollNumber}\nProduct: ${labelRow?.label}\nQuantity: ${after - before}`,
      },
    })
  }

  for (const [uniformSizeId, deduct] of uniformDeltas) {
    const stock = await tx.uniformStock.findUnique({ where: { sizeId_branchId: { sizeId: uniformSizeId, branchId } } })
    const before = stock?.quantity ?? 0
    const after = Math.max(0, before - deduct)
    await tx.uniformStock.upsert({
      where: { sizeId_branchId: { sizeId: uniformSizeId, branchId } },
      create: { sizeId: uniformSizeId, branchId, quantity: after, tone: calcTone(after) },
      update: { quantity: after, tone: calcTone(after) },
    })
    await tx.inventoryLog.create({
      data: {
        branchId,
        itemType: 'UNIFORM',
        uniformSizeId,
        changeType: 'OUTGOING',
        quantityBefore: before,
        quantityAfter: after,
        quantityDelta: after - before,
        performedById,
        notes: `Smoke test uniform\nStudent: ${student.name}`,
      },
    })
  }
}

async function placeOrder({ branch, actor, student, items, expectedTotal, label }) {
  const stockBefore = {}
  for (const item of items) {
    if (item.itemType === 'BOOK' && item.itemId) {
      stockBefore[item.itemId] = await stockQty(item.itemId, branch.id)
    } else if (item.itemType === 'UNIFORM' && item.itemId) {
      stockBefore[item.itemId] = await uniformStockQty(item.itemId, branch.id)
    }
  }

  if (!APPLY) {
    return {
      label,
      expectedTotal,
      stockBefore,
      stockAfter: null,
      orderId: '(dry-run)',
      pass: true,
    }
  }

  const result = await prisma.$transaction(async (tx) => {
    const orderId = await allocateUniqueOrderId(tx)
    let subtotal = 0
    const itemsData = items.map((item) => {
      const lineTotal = item.unitPrice * item.quantity
      subtotal += lineTotal
      return {
        itemType: item.itemType,
        bookItemId: item.itemType === 'BOOK' ? item.itemId : null,
        uniformSizeId: item.itemType === 'UNIFORM' ? item.itemId : null,
        accessoryId: null,
        label: item.label,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
        totalPrice: lineTotal,
      }
    })
    assert(Math.abs(subtotal - expectedTotal) < 0.01, `${label}: total mismatch calc ${subtotal} vs ${expectedTotal}`)

    const order = await tx.order.create({
      data: {
        orderId,
        studentId: student.id,
        branchId: branch.id,
        createdById: actor.id,
        subtotal,
        total: subtotal,
        paidAmount: subtotal,
        paymentStatus: 'PAID',
        paymentMethod: 'CASH',
        status: 'COMPLETED',
        paidAt: new Date(),
        bookStatus: 'PARTIAL',
        notes: `Smoke test — ${label}`,
        items: { create: itemsData },
      },
      include: { items: true, student: { include: { class: true } } },
    })

    await tx.transaction.create({
      data: {
        orderId: order.id,
        branchId: branch.id,
        amount: subtotal,
        paymentMethod: 'CASH',
        status: 'PAID',
        notes: `Smoke test — ${label}`,
        paidAt: new Date(),
      },
    })

    await deductStock(tx, {
      branchId: branch.id,
      orderItems: order.items,
      student: order.student,
      branchName: branch.name,
      performedById: actor.id,
    })

    return order
  }, { maxWait: 15_000, timeout: 60_000 })

  const stockAfter = {}
  for (const item of items) {
    if (item.itemType === 'BOOK' && item.itemId) {
      stockAfter[item.itemId] = await stockQty(item.itemId, branch.id)
      assert(stockAfter[item.itemId] === stockBefore[item.itemId] - item.quantity, `${label}: book stock not deducted for ${item.label}`)
    } else if (item.itemType === 'UNIFORM' && item.itemId) {
      stockAfter[item.itemId] = await uniformStockQty(item.itemId, branch.id)
      assert(stockAfter[item.itemId] === stockBefore[item.itemId] - item.quantity, `${label}: uniform stock not deducted`)
    }
  }

  return { label, expectedTotal, orderId: result.orderId, stockBefore, stockAfter, pass: true }
}

async function buildTests(branches) {
  const darga = branches.NHS_DARGA
  const narsingi = branches.SVN_NARSINGI
  const shaikpet = branches.NS_SHAIKPET
  const tests = []

  async function addTest(cfg) {
    const branch = branches[cfg.branchCode]
    const student = await findStudent(branch.id, cfg.grade)
    const items = []
    for (const line of cfg.lines) {
      if (line.type === 'diary') {
        const item = await getBookItem(branch.id, cfg.grade, 'global_diary')
        assert(item, `Diary missing grade ${cfg.grade} ${cfg.branchCode}`)
        items.push({ itemType: 'BOOK', itemId: item.id, label: 'Diary', unitPrice: 110, quantity: line.qty ?? 1 })
      } else if (line.type === 'exam') {
        const item = await getBookItem(branch.id, cfg.grade, 'global_exam_booklet')
        assert(item, `Exam Booklet missing grade ${cfg.grade} ${cfg.branchCode}`)
        items.push({ itemType: 'BOOK', itemId: item.id, label: 'Exam Booklet', unitPrice: 130, quantity: line.qty ?? 1 })
      } else if (line.type === 'notebook') {
        const item = await getNotebookBundleItem(branch.id, cfg.grade)
        assert(item, `Notebook bundle missing grade ${cfg.grade}`)
        const bundlePrice = money(item.setPrice ?? item.price)
        items.push({ itemType: 'BOOK', itemId: item.id, label: 'Notebook Bundle', unitPrice: bundlePrice, quantity: 1 })
      } else if (line.type === 'uniform') {
        const size = await getUniformSize(branch.id, cfg.grade, line.name)
        assert(size, `Uniform ${line.name} missing grade ${cfg.grade}`)
        items.push({ itemType: 'UNIFORM', itemId: size.id, label: size.name, unitPrice: money(size.price), quantity: line.qty ?? 1 })
      }
    }
    const expectedTotal = items.reduce((s, i) => s + i.unitPrice * i.quantity, 0)
    tests.push({ label: cfg.label, branch, student, items, expectedTotal })
  }

  await addTest({ label: '1. Diary only — Class 3 Darga', branchCode: 'NHS_DARGA', grade: 3, lines: [{ type: 'diary' }] })
  await addTest({ label: '2. Exam Booklet only — Class 3 Darga', branchCode: 'NHS_DARGA', grade: 3, lines: [{ type: 'exam' }] })
  await addTest({ label: '3. Diary + Exam — Class 3 Darga', branchCode: 'NHS_DARGA', grade: 3, lines: [{ type: 'diary' }, { type: 'exam' }] })
  await addTest({ label: '4. Diary only — Nursery Darga', branchCode: 'NHS_DARGA', grade: -2, lines: [{ type: 'diary' }] })
  await addTest({ label: '5. Exam Booklet only — Class 8 Darga', branchCode: 'NHS_DARGA', grade: 8, lines: [{ type: 'exam' }] })
  await addTest({ label: '6. Diary + Notebook — Class 3 Darga', branchCode: 'NHS_DARGA', grade: 3, lines: [{ type: 'diary' }, { type: 'notebook' }] })
  await addTest({ label: '7. Diary only — Class 5 Narsingi', branchCode: 'SVN_NARSINGI', grade: 5, lines: [{ type: 'diary' }] })
  await addTest({ label: '8. Exam only — Class 5 Shaikpet', branchCode: 'NS_SHAIKPET', grade: 5, lines: [{ type: 'exam' }] })
  await addTest({ label: '9. Diary + Exam — Class 1 Darga', branchCode: 'NHS_DARGA', grade: 1, lines: [{ type: 'diary' }, { type: 'exam' }] })
  await addTest({ label: '10. Exam only — Class 10 Darga', branchCode: 'NHS_DARGA', grade: 10, lines: [{ type: 'exam' }] })
  await addTest({ label: '11. Diary + Uniform socks — Class 3 Darga', branchCode: 'NHS_DARGA', grade: 3, lines: [{ type: 'diary' }, { type: 'uniform', name: 'Grey', qty: 1 }] })
  await addTest({ label: '12. Diary + Exam + Notebook — Class 8 Darga', branchCode: 'NHS_DARGA', grade: 8, lines: [{ type: 'diary' }, { type: 'exam' }, { type: 'notebook' }] })

  return tests
}

async function main() {
  const url = process.env.DATABASE_URL || ''
  const target = url.includes('ep-small-art') ? 'PRODUCTION' : url.includes('ep-rough-rain') ? 'DEVELOPMENT' : 'UNKNOWN'
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'} | DB: ${target}`)

  const branchRows = await prisma.branch.findMany({
    where: { code: { in: ['NHS_DARGA', 'SVN_NARSINGI', 'NS_SHAIKPET'] } },
  })
  const branches = Object.fromEntries(branchRows.map((b) => [b.code, b]))
  const actor = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN', isActive: true }, orderBy: { createdAt: 'asc' } })
  assert(actor, 'SUPER_ADMIN not found')

  const todayStart = new Date('2026-07-20T00:00:00.000Z')
  const revenueBefore = await prisma.order.aggregate({
    where: { createdAt: { gte: todayStart }, paymentStatus: 'PAID', branchId: branches.NHS_DARGA.id },
    _sum: { total: true },
    _count: true,
  })
  console.log(`Darga paid today before: ${revenueBefore._count} orders, ₹${money(revenueBefore._sum.total)}`)

  const tests = await buildTests(branches)
  console.log(`\nRunning ${tests.length} combination tests...\n`)

  const results = []
  let diaryG3Before = await stockQty((await getBookItem(branches.NHS_DARGA.id, 3, 'global_diary')).id, branches.NHS_DARGA.id)
  let examG3Before = await stockQty((await getBookItem(branches.NHS_DARGA.id, 3, 'global_exam_booklet')).id, branches.NHS_DARGA.id)
  console.log(`Baseline Class 3 Darga — Diary: ${diaryG3Before}, Exam Booklet: ${examG3Before}`)

  for (const test of tests) {
    try {
      const result = await placeOrder({ ...test, actor })
      results.push(result)
      const stockInfo = Object.entries(result.stockBefore ?? {}).map(([id, before]) => {
        const after = result.stockAfter?.[id]
        return after != null ? `${before}→${after}` : `${before} (dry-run)`
      }).join(', ')
      console.log(`✓ ${result.label}`)
      console.log(`  Total: ₹${result.expectedTotal} | Order: ${result.orderId} | Stock: ${stockInfo || 'n/a'}`)
    } catch (err) {
      results.push({ label: test.label, pass: false, error: err.message })
      console.log(`✗ ${test.label}: ${err.message}`)
    }
  }

  if (APPLY) {
    const diaryG3After = await stockQty((await getBookItem(branches.NHS_DARGA.id, 3, 'global_diary')).id, branches.NHS_DARGA.id)
    const examG3After = await stockQty((await getBookItem(branches.NHS_DARGA.id, 3, 'global_exam_booklet')).id, branches.NHS_DARGA.id)
    const revenueAfter = await prisma.order.aggregate({
      where: { createdAt: { gte: todayStart }, paymentStatus: 'PAID', branchId: branches.NHS_DARGA.id },
      _sum: { total: true },
      _count: true,
    })
    console.log(`\nClass 3 Darga stock after all tests — Diary: ${diaryG3After}, Exam: ${examG3After}`)
    console.log(`Darga paid today after: ${revenueAfter._count} orders, ₹${money(revenueAfter._sum.total)}`)
    console.log(`Revenue delta: ₹${money(revenueAfter._sum.total) - money(revenueBefore._sum.total)}`)
  }

  const passed = results.filter((r) => r.pass).length
  const failed = results.filter((r) => !r.pass).length
  console.log(`\nSummary: ${passed}/${results.length} passed, ${failed} failed`)

  if (failed > 0) process.exitCode = 1
  else if (!APPLY) console.log('\nDry run OK. Re-run with APPLY_SMOKE_ORDERS=1 to create test orders.')
}

main()
  .catch((err) => {
    console.error('FAILED:', err.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
