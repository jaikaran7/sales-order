/**
 * Smoke test: order total vs items gap guard (dev DB via API).
 * Run: node prisma/smoke-order-gap-guard.js
 * Rolls back created orders when marked with ROLLBACK_ORDER_GAP_SMOKE.
 */
require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const API = `http://localhost:${process.env.PORT || 4000}/api`
const MARKER = 'ROLLBACK_ORDER_GAP_SMOKE'

async function api(path, { method = 'GET', body, token } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await res.json().catch(() => ({}))
  return { status: res.status, data }
}

async function login() {
  const { status, data } = await api('/auth/login', {
    method: 'POST',
    body: { username: 'superadmin', password: 'NHSBooks@26' },
  })
  const token = data?.data?.token ?? data?.data?.accessToken
  if (status !== 200 || !token) {
    throw new Error(`Login failed (${status}): ${JSON.stringify(data)}`)
  }
  return token
}

async function loadKitContext(grade = 2) {
  const branch = await prisma.branch.findFirst({
    where: { name: { contains: 'Darga', mode: 'insensitive' }, isActive: true, deletedAt: null },
  })
  if (!branch) throw new Error('Darga branch not found')

  const students = await prisma.students.findMany({
    where: { isActive: true, class: { branchId: branch.id, grade } },
    include: { class: true },
    orderBy: { rollNumber: 'asc' },
    take: 6,
  })
  if (students.length < 4) throw new Error(`Need at least 4 active grade ${grade} students in Darga`)

  const cls = await prisma.academicClass.findFirst({
    where: { branchId: branch.id, grade },
    include: {
      bookKits: {
        include: {
          items: {
            where: { isArchived: false },
            include: { subItems: { where: { isActive: true } } },
            orderBy: { position: 'asc' },
          },
        },
      },
    },
  })
  if (!cls) throw new Error(`Class grade ${grade} not found`)

  const academicKit = cls.bookKits.find((k) => k.kind === 'ACADEMIC')
  const notebookKit = cls.bookKits.find((k) => k.kind === 'NOTEBOOKS')
  if (!academicKit || !notebookKit) throw new Error('Missing academic or notebook kit')

  const academicItems = academicKit.items.filter((i) => Number(i.setPrice ?? i.price) > 0)
  const notebookBundle = notebookKit.items.find((i) => /notebook/i.test(i.label)) ?? notebookKit.items[0]
  if (!academicItems.length || !notebookBundle) {
    throw new Error('Missing academic bundle(s) or notebook bundle')
  }

  const notebookOnlyTotal = Number(notebookBundle.setPrice ?? notebookBundle.price)
  const fullKitItems = [
    ...academicItems.map((item) => ({
      itemType: 'BOOK',
      itemId: item.id,
      label: item.label,
      quantity: 1,
      unitPrice: Number(item.setPrice ?? item.price),
    })),
    {
      itemType: 'BOOK',
      itemId: notebookBundle.id,
      label: notebookBundle.label,
      quantity: 1,
      unitPrice: notebookOnlyTotal,
    },
  ]
  const fullLineSubtotal = fullKitItems.reduce((s, i) => s + i.unitPrice * i.quantity, 0)
  const notebookOnlyItems = [
    {
      itemType: 'BOOK',
      itemId: notebookBundle.id,
      label: notebookBundle.label,
      quantity: 1,
      unitPrice: notebookOnlyTotal,
    },
  ]

  return {
    branch,
    students,
    grade,
    priceListTotal: { [-2]: 2200, [-1]: 2865, 0: 3145, 1: 4000, 2: 4085, 3: 4780 }[grade] ?? fullLineSubtotal,
    fullKitItems,
    fullLineSubtotal,
    notebookOnlyItems,
    notebookOnlyTotal,
  }
}

async function cleanup() {
  const deleted = await prisma.order.deleteMany({
    where: {
      OR: [
        { notes: { contains: MARKER } },
        { notes: { contains: 'MANUAL_GAP_TEST' } },
      ],
    },
  })
  if (deleted.count) console.log(`Cleaned up ${deleted.count} prior smoke order(s).`)
}

async function runCase(name, token, ctx, student, payload, expect) {
  const body = {
    studentId: student.id,
    branchId: ctx.branch.id,
    notes: `${MARKER} — ${name}`,
    ...payload,
  }
  const { status, data } = await api('/orders', { method: 'POST', body, token })
  const ok = status === expect.status
  const code = data?.errors?.[0]?.code ?? data?.error?.code ?? null
  const orderId = data?.data?.order?.orderId ?? null
  const total = data?.data?.order?.total != null ? Number(data.data.order.total) : null
  const itemCount = data?.data?.order?.items?.length ?? 0

  let pass = ok
  if (expect.code && code !== expect.code) pass = false
  if (expect.status === 201 && itemCount < 1) pass = false

  console.log(`\n${pass ? '✅' : '❌'} ${name}`)
  console.log(`   HTTP ${status} (expected ${expect.status})`)
  if (code) console.log(`   code: ${code}${expect.code ? ` (expected ${expect.code})` : ''}`)
  if (orderId) console.log(`   orderId: ${orderId}, total: ₹${total}, items: ${itemCount}`)
  if (!pass) console.log(`   response: ${JSON.stringify(data).slice(0, 400)}`)

  return { pass, orderId, status, data }
}

async function verifyStockDeduction(orderId) {
  const order = await prisma.order.findUnique({
    where: { orderId },
    include: { items: true },
  })
  if (!order) return { pass: false, reason: 'order not found' }

  const logs = await prisma.inventoryLog.findMany({
    where: { orderId: order.id },
    select: { itemType: true, label: true, quantity: true },
  })

  const bookItemIds = new Set(order.items.filter((i) => i.bookItemId).map((i) => i.bookItemId))
  const loggedBookItems = new Set(logs.filter((l) => l.itemType === 'BOOK').map((l) => l.label))

  const missingDeductions = order.items
    .filter((i) => i.itemType === 'BOOK')
    .filter((i) => !logs.some((l) => l.label === i.label && Number(l.quantity) < 0))

  return {
    pass: missingDeductions.length === 0,
    itemCount: order.items.length,
    logCount: logs.length,
    missingDeductions: missingDeductions.map((i) => i.label),
  }
}

async function main() {
  console.log('Order gap guard smoke test (dev DB)')
  console.log(`API: ${API}`)

  await cleanup()
  const token = await login()
  console.log('Logged in as superadmin')

  const ctx = await loadKitContext(2)
  console.log(`Branch: ${ctx.branch.name}`)
  console.log(`Students available: ${ctx.students.map((s) => s.rollNumber).join(', ')}`)
  console.log(`Full kit line subtotal: ₹${ctx.fullLineSubtotal}`)
  console.log(`Notebook-only subtotal: ₹${ctx.notebookOnlyTotal}`)
  console.log(`Price list total (grade 2): ₹${ctx.priceListTotal}`)

  const results = []

  // Case 1: Valid full kit — total matches items
  const [s1, s2, s3, s4] = ctx.students

  results.push(await runCase(
    'Case 1 — Full kit, total matches items (should succeed)',
    token,
    ctx,
    s1,
    { items: ctx.fullKitItems, totalAmount: ctx.fullLineSubtotal },
    { status: 201 },
  ))

  results.push(await runCase(
    'Case 2 — Bug replay: ₹4085 total, notebook-only items (should block)',
    token,
    ctx,
    s2,
    { items: ctx.notebookOnlyItems, totalAmount: ctx.priceListTotal },
    { status: 400, code: 'TOTAL_ITEMS_MISMATCH' },
  ))

  const tolerantTotal = ctx.fullLineSubtotal + 100
  results.push(await runCase(
    'Case 3 — Full kit with ₹100 rounding gap (should succeed)',
    token,
    ctx,
    s3,
    { items: ctx.fullKitItems, totalAmount: tolerantTotal },
    { status: 201 },
  ))

  const discountTotal = Math.max(0, ctx.notebookOnlyTotal - 50)
  results.push(await runCase(
    'Case 4 — Notebook only with ₹50 discount (should succeed)',
    token,
    ctx,
    s4,
    { items: ctx.notebookOnlyItems, totalAmount: discountTotal, discountAmount: 50 },
    { status: 201 },
  ))

  // Verify stock deductions on successful orders
  for (const r of results) {
    if (r.orderId) {
      const v = await verifyStockDeduction(r.orderId)
      console.log(`\n   Stock check ${r.orderId}: ${v.pass ? '✅ deductions OK' : '❌ missing'}`)
      if (!v.pass) console.log(`   missing: ${v.missingDeductions.join(', ')}`)
      r.stockPass = v.pass
    }
  }

  await cleanup()

  const failed = results.filter((r) => !r.pass || r.stockPass === false)
  console.log('\n--- Summary ---')
  console.log(`Passed: ${results.length - failed.length}/${results.length}`)
  if (failed.length) {
    console.log('FAILED cases:', failed.map((r) => r.data?.message || 'see above').join('; '))
    process.exit(1)
  }
  console.log('All smoke cases passed. No gap bug on API; guards working.')
}

main()
  .catch((err) => {
    console.error('Smoke test error:', err.message)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
