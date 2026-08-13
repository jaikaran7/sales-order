/**
 * DEV-ONLY API tests: orderDate + OrderEditRequest workflow.
 * Aborts unless DATABASE_URL host contains ep-rough-rain.
 */
require('dotenv').config({ path: require('path').join(__dirname, '../.env') })

const { PrismaClient } = require('@prisma/client')

const API = process.env.TEST_API_BASE || 'http://127.0.0.1:4000/api'
const HOST = (() => {
  try {
    return new URL(String(process.env.DATABASE_URL || '').replace(/^postgresql:/, 'http:')).hostname
  } catch {
    return ''
  }
})()

if (!HOST.includes('ep-rough-rain') || HOST.includes('ep-small-art')) {
  console.error('ABORT: refusing to run — DB host is not confirmed DEV:', HOST)
  process.exit(2)
}

const prisma = new PrismaClient()
const results = []

function record(name, ok, detail = '') {
  results.push({ name, ok, detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${name}${detail ? ` — ${detail}` : ''}`)
}

async function req(method, path, { token, body } = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })
  let json = null
  const text = await res.text()
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    json = { raw: text }
  }
  return { status: res.status, json, data: json?.data ?? json }
}

async function login(username, password) {
  const r = await req('POST', '/auth/login', { body: { username, password } })
  const token = r.data?.token || r.json?.token || r.data?.accessToken
  if (!token) throw new Error(`login failed for ${username}: ${r.status} ${JSON.stringify(r.json)}`)
  return token
}

function istYmd(d = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d)
}

function daysAgoIst(n) {
  const now = new Date()
  // shift by calendar days in IST roughly via UTC noon trick
  const [y, m, d] = istYmd(now).split('-').map(Number)
  const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
  base.setUTCDate(base.getUTCDate() - n)
  return base.toISOString().slice(0, 10)
}

async function main() {
  console.log('=== ENV GUARD ===')
  console.log('DB_HOST=', HOST)
  console.log('API=', API)

  const superToken = await login('superadmin', 'NHSBooks@26')
  const adminToken = await login('admin_darga', 'TestEdit@26')
  record('login.superadmin', true)
  record('login.admin_darga', true)

  const branchId = 'cmobxtnf90001zser4zoh709f' // Darga
  const itemId = 'cmp5wgo5l00qrrgkbazhxsyfl' // Notebook Bundle grade 1 @ ₹33
  const students = await prisma.students.findMany({
    where: { isActive: true, class: { branchId, grade: 1 } },
    take: 8,
    select: { id: true, name: true, rollNumber: true },
  })
  if (students.length < 4) throw new Error('Need >=4 Darga grade-1 students on DEV')

  // Use a unique-enough past day + unique qty per student to avoid duplicate-order guard.
  const pastDate = daysAgoIst(7)
  const futureDate = (() => {
    const [y, m, d] = istYmd().split('-').map(Number)
    const base = new Date(Date.UTC(y, m - 1, d, 12, 0, 0))
    base.setUTCDate(base.getUTCDate() + 2)
    return base.toISOString().slice(0, 10)
  })()
  const tooOld = daysAgoIst(120)

  // ─── create order with custom past date ─────────────────────────────
  const createBody = (studentId, orderDate, qty = 1) => ({
    studentId,
    branchId,
    orderDate,
    notes: `api-test ${Date.now()}`,
    items: [
      {
        itemType: 'BOOK',
        itemId,
        label: 'Notebook Bundle',
        quantity: qty,
        unitPrice: 33,
      },
    ],
    totalAmount: 33 * qty,
  })

  let orderA = null
  {
    let c1 = await req('POST', '/orders', {
      token: adminToken,
      body: createBody(students[0].id, pastDate, 1),
    })
    orderA = c1.data?.order || c1.data
    if (!orderA?.id) {
      console.log('create.orderA first attempt failed:', c1.status, c1.json?.message)
      c1 = await req('POST', '/orders', {
        token: superToken,
        body: createBody(students[0].id, daysAgoIst(9), 2),
      })
      orderA = c1.data?.order || c1.data
    }
    record(
      'create.order.customPastDate',
      (c1.status === 200 || c1.status === 201) && Boolean(orderA?.id),
      `status=${c1.status} msg=${c1.json?.message || ''} orderId=${orderA?.orderId || orderA?.id}`,
    )
  }

  let dbOrder = orderA?.id
    ? await prisma.order.findUnique({
        where: { id: orderA.id },
        include: { items: true, transactions: true },
      })
    : null
  if (dbOrder) {
    const expectedDate = istYmd(new Date(dbOrder.orderDate))
    const od = expectedDate
    record('db.orderDate.set', Boolean(dbOrder.orderDate), `orderDate=${od}`)
    const logsByDate = await prisma.inventoryLog.findMany({
      where: {
        bookItemId: itemId,
        branchId,
      },
      orderBy: { createdAt: 'desc' },
      take: 30,
    })
    const matched = logsByDate.find((l) => istYmd(new Date(l.eventDate)) === od && Number(l.quantityDelta) < 0)
    record(
      'db.inventoryLog.eventDate',
      Boolean(matched),
      matched
        ? `eventDate=${istYmd(new Date(matched.eventDate))} type=${matched.changeType} delta=${matched.quantityDelta}`
        : `no matching deduction log; sampleTypes=${[...new Set(logsByDate.map((l) => l.changeType))].join(',')}`,
    )
  } else {
    record('db.orderDate.set', false, 'order missing after create')
  }

  // pay order so we have transactions to edit
  if (orderA?.id) {
    const payAmt = Number(dbOrder?.total ?? 33)
    const pay = await req('POST', `/orders/${orderA.id}/payment`, {
      token: adminToken,
      body: {
        amount: payAmt,
        paymentMethod: 'CASH',
        paidAt: istYmd(new Date(dbOrder.orderDate)),
      },
    })
    record('create.payment', pay.status === 200 || pay.status === 201, `status=${pay.status} msg=${pay.json?.message || ''}`)
  } else {
    record('create.payment', false, 'skipped — no orderA')
  }

  // future date rejected
  const cFuture = await req('POST', '/orders', {
    token: adminToken,
    body: createBody(students[1].id, futureDate, 1),
  })
  record(
    'create.reject.futureDate',
    cFuture.status >= 400,
    `status=${cFuture.status} msg=${cFuture.json?.message || ''}`,
  )

  // too old (>90 days)
  const cOld = await req('POST', '/orders', {
    token: adminToken,
    body: createBody(students[1].id, tooOld, 1),
  })
  record(
    'create.reject.tooOldDate',
    cOld.status >= 400,
    `status=${cOld.status} msg=${cOld.json?.message || ''}`,
  )

  // missing fields
  const cMissing = await req('POST', '/orders', {
    token: adminToken,
    body: { branchId, items: [] },
  })
  record('create.reject.missingFields', cMissing.status >= 400, `status=${cMissing.status}`)

  // unauthorized create without token
  const cNoAuth = await req('POST', '/orders', { body: createBody(students[1].id, pastDate, 1) })
  record('create.reject.noAuth', cNoAuth.status === 401 || cNoAuth.status === 403, `status=${cNoAuth.status}`)

  // ─── create second order for reject smoke path ──────────────────────
  const c2 = await req('POST', '/orders', {
    token: adminToken,
    body: createBody(students[1].id, daysAgoIst(6), 1),
  })
  let orderB = c2.data?.order || c2.data
  if (!orderB?.id) {
    const c2b = await req('POST', '/orders', {
      token: superToken,
      body: createBody(students[1].id, daysAgoIst(10), 2),
    })
    orderB = c2b.data?.order || c2b.data
  }
  record('create.orderB', Boolean(orderB?.id), `orderId=${orderB?.orderId} msg=${c2.json?.message || ''}`)
  if (orderB?.id) {
    const ob = await prisma.order.findUnique({ where: { id: orderB.id } })
    await req('POST', `/orders/${orderB.id}/payment`, {
      token: adminToken,
      body: { amount: Number(ob.total), paymentMethod: 'CASH', paidAt: istYmd(new Date(ob.orderDate)) },
    })
  }

  // ─── create third order for race / pending conflict ─────────────────
  const c3 = await req('POST', '/orders', {
    token: adminToken,
    body: createBody(students[2].id, daysAgoIst(5), 1),
  })
  let orderC = c3.data?.order || c3.data
  if (!orderC?.id) {
    const c3b = await req('POST', '/orders', {
      token: superToken,
      body: createBody(students[2].id, daysAgoIst(11), 2),
    })
    orderC = c3b.data?.order || c3b.data
  }
  if (orderC?.id) {
    const oc = await prisma.order.findUnique({ where: { id: orderC.id } })
    await req('POST', `/orders/${orderC.id}/payment`, {
      token: adminToken,
      body: { amount: Number(oc.total), paymentMethod: 'CASH', paidAt: istYmd(new Date(oc.orderDate)) },
    })
  }
  record('create.orderC', Boolean(orderC?.id), `orderId=${orderC?.orderId}`)

  if (!orderA?.id || !orderB?.id || !orderC?.id) {
    throw new Error(`Missing seed orders A/B/C: ${orderA?.id}/${orderB?.id}/${orderC?.id}`)
  }

  // reload full orders for edit payloads
  async function fullOrder(id) {
    const r = await req('GET', `/orders/${id}`, { token: adminToken })
    return r.data
  }

  const fullA = await fullOrder(orderA.id)
  const fullB = await fullOrder(orderB.id)
  const fullC = await fullOrder(orderC.id)
  if (!fullA?.items?.length || !fullB?.items?.length || !fullC?.items?.length) {
    throw new Error('fullOrder missing items')
  }

  function editPayload(order, { qty = null, notes = null, orderDate = null } = {}) {
    return {
      reason: 'api-test edit',
      orderDate: orderDate || istYmd(new Date(order.orderDate || order.createdAt)),
      notes: notes ?? `${order.notes || ''} | edited`,
      bookStatus: order.bookStatus,
      uniformStatus: order.uniformStatus,
      items: (order.items || []).map((i) => ({
        itemType: i.itemType,
        itemId: i.bookItemId || i.uniformSizeId || i.accessoryId,
        label: i.label,
        quantity: qty ?? i.quantity,
        unitPrice: Number(i.unitPrice),
      })),
      transactions: (order.transactions || []).map((t) => ({
        amount: Number(t.amount),
        paymentMethod: t.paymentMethod,
        status: t.status,
        notes: t.notes,
        paidAt: istYmd(new Date(t.paidAt || t.createdAt)),
      })),
    }
  }

  // admin submits edit on A (pending)
  const beforeQtyA = fullA.items[0].quantity
  const editA = await req('POST', `/orders/${fullA.id}/edit-requests`, {
    token: adminToken,
    body: editPayload(fullA, { qty: beforeQtyA + 1, notes: 'pending-approve-path' }),
  })
  const reqA = editA.data
  record(
    'edit.submit.admin.pending',
    (editA.status === 200 || editA.status === 201) && (reqA?.status === 'PENDING' || !reqA?.status),
    `status=${editA.status} editStatus=${reqA?.status} id=${reqA?.id}`,
  )

  // live order unchanged until approve
  const liveAfterPending = await prisma.order.findUnique({
    where: { id: fullA.id },
    include: { items: true },
  })
  record(
    'edit.liveUnchangedWhilePending',
    liveAfterPending.items[0].quantity === beforeQtyA,
    `qty still ${liveAfterPending.items[0].quantity}`,
  )

  // second pending edit rejected (race / conflict)
  const editA2 = await req('POST', `/orders/${fullA.id}/edit-requests`, {
    token: adminToken,
    body: editPayload(fullA, { qty: beforeQtyA + 2, notes: 'second-pending-should-fail' }),
  })
  record(
    'edit.reject.secondPending',
    editA2.status >= 400,
    `status=${editA2.status} msg=${editA2.json?.message || ''}`,
  )

  // admin cannot approve
  const adminApprove = await req('POST', `/orders/edit-requests/${reqA.id}/approve`, {
    token: adminToken,
    body: { reviewNote: 'should fail' },
  })
  record(
    'approve.reject.nonSuperadmin',
    adminApprove.status === 401 || adminApprove.status === 403,
    `status=${adminApprove.status}`,
  )

  // approve non-existent
  const approveMissing = await req('POST', '/orders/edit-requests/does-not-exist-id/approve', {
    token: superToken,
    body: {},
  })
  record(
    'approve.reject.missingRequest',
    approveMissing.status === 404 || approveMissing.status >= 400,
    `status=${approveMissing.status}`,
  )

  // reject non-existent
  const rejectMissing = await req('POST', '/orders/edit-requests/does-not-exist-id/reject', {
    token: superToken,
    body: {},
  })
  record(
    'reject.reject.missingRequest',
    rejectMissing.status === 404 || rejectMissing.status >= 400,
    `status=${rejectMissing.status}`,
  )

  // invalid date on edit
  const editBadDate = await req('POST', `/orders/${fullC.id}/edit-requests`, {
    token: adminToken,
    body: editPayload(fullC, { notes: 'bad-future', orderDate: futureDate }),
  })
  record(
    'edit.reject.futureDate',
    editBadDate.status >= 400,
    `status=${editBadDate.status} msg=${editBadDate.json?.message || ''}`,
  )

  // no-change edit
  const noChangeBody = editPayload(fullC, {})
  noChangeBody.notes = fullC.notes
  noChangeBody.orderDate = istYmd(new Date(fullC.orderDate || fullC.createdAt))
  noChangeBody.items = fullC.items.map((i) => ({
    itemType: i.itemType,
    itemId: i.bookItemId || i.uniformSizeId || i.accessoryId,
    label: i.label,
    quantity: i.quantity,
    unitPrice: Number(i.unitPrice),
  }))
  const editNoChange = await req('POST', `/orders/${fullC.id}/edit-requests`, {
    token: adminToken,
    body: noChangeBody,
  })
  record(
    'edit.reject.noChanges',
    editNoChange.status >= 400,
    `status=${editNoChange.status} msg=${editNoChange.json?.message || ''}`,
  )

  // omitting orderDate must keep the live business date (not default to today)
  const preserveDateBody = editPayload(fullC, { notes: `preserve-date-${Date.now()}` })
  delete preserveDateBody.orderDate
  const liveDateBeforeOmit = istYmd(new Date(fullC.orderDate || fullC.createdAt))
  const editOmitDate = await req('POST', `/orders/${fullC.id}/edit-requests`, {
    token: adminToken,
    body: preserveDateBody,
  })
  const omitReq = editOmitDate.data
  const afterOmitDate = omitReq?.afterSnapshot?.orderDate
    ? istYmd(new Date(omitReq.afterSnapshot.orderDate))
    : null
  const omitOnlyNotes = Array.isArray(omitReq?.diffSummary)
    && omitReq.diffSummary.every((d) => d.field !== 'orderDate')
  record(
    'edit.omitOrderDate.preservesLiveDate',
    (editOmitDate.status === 200 || editOmitDate.status === 201)
      && afterOmitDate === liveDateBeforeOmit
      && omitOnlyNotes,
    `status=${editOmitDate.status} live=${liveDateBeforeOmit} after=${afterOmitDate} diffs=${JSON.stringify(omitReq?.diffSummary || [])}`,
  )
  if (omitReq?.id && omitReq?.status === 'PENDING') {
    await req('POST', `/orders/edit-requests/${omitReq.id}/reject`, {
      token: superToken,
      body: { reviewNote: 'cleanup omit-date regression' },
    })
  }

  // ─── smoke: approve path ────────────────────────────────────────────
  const approveA = await req('POST', `/orders/edit-requests/${reqA.id}/approve`, {
    token: superToken,
    body: { reviewNote: 'api-test approve' },
  })
  record('smoke.approve', approveA.status === 200 || approveA.status === 201, `status=${approveA.status}`)

  const afterApprove = await prisma.order.findUnique({
    where: { id: fullA.id },
    include: { items: true, editRequests: { orderBy: { createdAt: 'desc' }, take: 1 } },
  })
  record(
    'smoke.approve.appliedQty',
    afterApprove.items[0].quantity === beforeQtyA + 1,
    `qty=${afterApprove.items[0].quantity}`,
  )
  record(
    'smoke.approve.auditStatus',
    afterApprove.editRequests[0]?.status === 'APPROVED',
    `status=${afterApprove.editRequests[0]?.status}`,
  )

  // ─── smoke: reject path ─────────────────────────────────────────────
  const beforeQtyB = fullB.items[0].quantity
  const editB = await req('POST', `/orders/${fullB.id}/edit-requests`, {
    token: adminToken,
    body: editPayload(fullB, { qty: beforeQtyB + 5, notes: 'pending-reject-path' }),
  })
  const reqB = editB.data
  record('smoke.reject.submit', editB.status === 200 || editB.status === 201, `id=${reqB?.id}`)

  const rejectB = await req('POST', `/orders/edit-requests/${reqB.id}/reject`, {
    token: superToken,
    body: { reviewNote: 'api-test reject' },
  })
  record('smoke.reject', rejectB.status === 200 || rejectB.status === 201, `status=${rejectB.status}`)

  const afterReject = await prisma.order.findUnique({
    where: { id: fullB.id },
    include: { items: true, editRequests: { orderBy: { createdAt: 'desc' }, take: 1 } },
  })
  record(
    'smoke.reject.liveUnchanged',
    afterReject.items[0].quantity === beforeQtyB,
    `qty=${afterReject.items[0].quantity}`,
  )
  record(
    'smoke.reject.auditStatus',
    afterReject.editRequests[0]?.status === 'REJECTED',
    `status=${afterReject.editRequests[0]?.status}`,
  )

  // ─── superadmin auto-apply ──────────────────────────────────────────
  const beforeQtyC = fullC.items[0].quantity
  const editSuper = await req('POST', `/orders/${fullC.id}/edit-requests`, {
    token: superToken,
    body: editPayload(fullC, { qty: beforeQtyC + 1, notes: 'super-auto-apply' }),
  })
  const reqC = editSuper.data
  record(
    'edit.superadmin.autoApprove',
    (editSuper.status === 200 || editSuper.status === 201) && reqC?.status === 'APPROVED',
    `status=${editSuper.status} editStatus=${reqC?.status}`,
  )
  const afterSuper = await prisma.order.findUnique({
    where: { id: fullC.id },
    include: { items: true },
  })
  record(
    'edit.superadmin.appliedImmediately',
    afterSuper.items[0].quantity === beforeQtyC + 1,
    `qty=${afterSuper.items[0].quantity}`,
  )

  // list edit requests as superadmin
  const list = await req('GET', '/orders/edit-requests?status=APPROVED&limit=5', { token: superToken })
  record('list.editRequests', list.status === 200, `status=${list.status} count=${Array.isArray(list.data) ? list.data.length : '?'}`)

  // ─── race: two concurrent first-edits on a fresh order ──────────────
  const c4 = await req('POST', '/orders', {
    token: adminToken,
    body: createBody(students[3].id, daysAgoIst(4), 1),
  })
  let orderD = c4.data?.order || c4.data
  if (!orderD?.id) {
    const c4b = await req('POST', '/orders', {
      token: superToken,
      body: createBody(students[3].id, daysAgoIst(12), 2),
    })
    orderD = c4b.data?.order || c4b.data
  }
  if (orderD?.id) {
    const od = await prisma.order.findUnique({ where: { id: orderD.id } })
    await req('POST', `/orders/${orderD.id}/payment`, {
      token: adminToken,
      body: { amount: Number(od.total), paymentMethod: 'CASH', paidAt: istYmd(new Date(od.orderDate)) },
    })
  }
  if (!orderD?.id) throw new Error('orderD create failed')
  const fullD = await fullOrder(orderD.id)
  const payloadD1 = editPayload(fullD, { qty: 2, notes: 'race-1' })
  const payloadD2 = editPayload(fullD, { qty: 3, notes: 'race-2' })
  const [race1, race2] = await Promise.all([
    req('POST', `/orders/${fullD.id}/edit-requests`, { token: adminToken, body: payloadD1 }),
    req('POST', `/orders/${fullD.id}/edit-requests`, { token: adminToken, body: payloadD2 }),
  ])
  const raceStatuses = [race1.status, race2.status].sort()
  const pendingCount = await prisma.orderEditRequest.count({
    where: { orderId: fullD.id, status: 'PENDING' },
  })
  record(
    'edit.race.concurrentSubmit',
    pendingCount <= 1 && (raceStatuses[0] >= 400 || raceStatuses[1] >= 400 || pendingCount === 1),
    `http=${race1.status}/${race2.status} pending=${pendingCount}`,
  )

  // cleanup pending on D if any
  const pendingD = await prisma.orderEditRequest.findFirst({
    where: { orderId: fullD.id, status: 'PENDING' },
  })
  if (pendingD) {
    await req('POST', `/orders/edit-requests/${pendingD.id}/reject`, {
      token: superToken,
      body: { reviewNote: 'cleanup after race test' },
    })
  }

  console.log('\n=== SUMMARY ===')
  const passed = results.filter((r) => r.ok).length
  const failed = results.filter((r) => !r.ok)
  console.log(`passed=${passed} failed=${failed.length} total=${results.length}`)
  if (failed.length) {
    console.log('FAILURES:')
    for (const f of failed) console.log(` - ${f.name}: ${f.detail}`)
  }

  await prisma.$disconnect()
  process.exit(failed.length ? 1 : 0)
}

main().catch(async (err) => {
  console.error('FATAL', err)
  try {
    await prisma.$disconnect()
  } catch {}
  process.exit(1)
})
