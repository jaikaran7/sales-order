/**
 * Darga uniform stock + global pricing update — 26 Jun 2026
 *
 * Dry run:  node prisma/seed-darga-uniform-pricing-stock-jun26-2026.js
 * Apply:    APPLY_DARGA_UNIFORM_CORRECTION=1 node prisma/seed-darga-uniform-pricing-stock-jun26-2026.js
 * Prod:     APPLY_DARGA_UNIFORM_CORRECTION=1 ALLOW_NON_DEV_DB=1 node prisma/seed-darga-uniform-pricing-stock-jun26-2026.js
 *
 * Rules:
 * - Pricing applies globally (UniformSize.price) for all branches
 * - Darga stock set via Correct/Override to register totals
 * - Shaikpet/Narsingi: never change existing stock; add missing variants at 0 only
 */

require('dotenv').config()
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const APPLY = process.env.APPLY_DARGA_UNIFORM_CORRECTION === '1'
const ALLOW_NON_DEV_DB = process.env.ALLOW_NON_DEV_DB === '1'

const NOTE_DARGA = 'Physical stock count + pricing update — Darga — 26 Jun 2026'
const NOTE_PRICE = 'Pricing update — 26 Jun 2026'
const LOG_TS = new Date('2026-06-26T12:00:00.000+05:30')

const BRANCH_ALIASES = {
  darga: ['NHS_DARGA', 'CAMP-A', 'DARGA'],
  narsingi: ['SVN_NARSINGI', 'CAMP-B', 'NARSINGI'],
  shaikpet: ['NS_SHAIKPET', 'CAMP-C', 'SHAIKPET'],
}

function chest(n, price, dargaQty) {
  return { lookup: String(n), create: { code: `Chest ${n}`, name: `Chest ${n}`, price }, dargaQty }
}
function waist(n, price, dargaQty) {
  return { lookup: String(n), create: { code: `Waist ${n}`, name: `Waist ${n}`, price }, dargaQty }
}
function shortSize(n, price, dargaQty) {
  return { lookup: String(n), create: { code: String(n), name: `Size ${n}`, price }, dargaQty }
}
function sockSize(n, price, dargaQty) {
  const code = n === 'free size' ? 'free size' : `size ${n}`
  return { lookup: String(n), create: { code, name: code, price }, dargaQty }
}
function named(code, name, price, dargaQty) {
  return { lookup: name, create: { code, name, price }, dargaQty }
}

const CATEGORY_PLAN = [
  {
    key: 't_shirt',
    label: 'T-Shirts',
    variants: [
      chest(20, 230, 20), chest(22, 250, 17), chest(24, 270, 23), chest(26, 290, 36),
      chest(28, 310, 31), chest(30, 330, 6), chest(32, 350, 4), chest(34, 370, 10),
      chest(36, 390, 20), chest(38, 410, 10), chest(40, 430, 20), chest(42, 450, 10),
    ],
  },
  {
    key: 'pant',
    label: 'Pants',
    variants: [
      waist(32, 370, 24), waist(34, 400, 26), waist(36, 430, 19),
      waist(38, 430, 13), waist(40, 450, 40), waist(42, 450, 3),
    ],
  },
  {
    key: 'shorts',
    label: 'Shorts',
    variants: [
      shortSize(11, 220, 18), shortSize(12, 240, 24), shortSize(13, 260, 36),
      shortSize(14, 280, 12), shortSize(15, 290, 11), shortSize(16, 310, 10), shortSize(17, 310, 5),
    ],
  },
  {
    key: 'skirt',
    label: 'Skirts',
    variants: [
      waist(15, 330, 14), waist(16, 330, 16), waist(17, 350, 16), waist(18, 370, 20),
      waist(20, 390, 12), waist(22, 410, 26), waist(24, 430, 13),
      waist(26, 450, 15), waist(28, 470, 14), waist(30, 490, 21),
    ],
  },
  {
    key: 'socks_grey_yellow_line',
    label: 'Socks (Grey Yellow Line)',
    categoryCreate: { label: 'Socks (Grey Yellow Line)', icon: 'footprint' },
    variants: [sockSize(2, 70, 100), sockSize(3, 70, 150), sockSize(4, 70, 8)],
  },
  {
    key: 'socks_grey',
    label: 'Socks (Grey)',
    fallbackKeys: ['socks'],
    categoryCreate: { label: 'Socks (Grey)', icon: 'footprint' },
    variants: [
      sockSize(2, 70, 0), sockSize(3, 70, 160), sockSize(4, 70, 72),
      sockSize(5, 80, 108), sockSize(6, 80, 245), sockSize('free size', 80, 55),
    ],
  },
  {
    key: 'socks_white',
    label: 'Socks (White)',
    categoryCreate: { label: 'Socks (White)', icon: 'footprint' },
    variants: [
      sockSize(2, 70, 120), sockSize(3, 70, 72), sockSize(4, 70, 90),
      sockSize(5, 80, 54), sockSize(6, 80, 84), sockSize('free size', 80, 90),
    ],
  },
  {
    key: 'tie',
    label: 'Ties',
    variants: [
      named('Short Tie', 'Short Tie', 120, 180),
      named('Long Tie', 'Long Tie', 140, 300),
      named('Small Tie', 'Small Tie', 120, null),
    ],
  },
  {
    key: 'belt',
    label: 'Belts',
    variants: [
      named('Grey Yellow Belt', 'Grey Yellow Belt', 120, 103),
      named('85cm', '85cm', 120, 200),
      named('95cm', '95cm', 140, 55),
    ],
  },
]

function calcTone(qty, threshold = 50) {
  if (qty <= threshold * 0.2) return 'CRITICAL'
  if (qty <= threshold) return 'LOW'
  return 'NORMAL'
}

function dbHostFromUrl() {
  const raw = process.env.DATABASE_URL || ''
  const atIdx = raw.indexOf('@')
  return atIdx === -1 ? 'unknown' : raw.slice(atIdx + 1).split('/')[0]
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase()
}

function numericPart(value) {
  return normalize(value).replace(/[^\d]/g, '')
}

async function findBranch(branchKey) {
  const row = await prisma.branch.findFirst({
    where: {
      OR: [
        { code: { in: BRANCH_ALIASES[branchKey] } },
        { name: { contains: branchKey, mode: 'insensitive' } },
      ],
      type: 'BRANCH',
      isActive: true,
      deletedAt: null,
    },
    select: { id: true, name: true, code: true },
  })
  if (!row) throw new Error(`Branch not found: ${branchKey}`)
  return row
}

async function ensureCategory(planKey, fallbackKeys = [], categoryCreate = null) {
  let category = await prisma.uniformCategory.findFirst({ where: { name: { in: [planKey, ...fallbackKeys] } } })
  if (!category && categoryCreate && APPLY) {
    const maxPos = await prisma.uniformCategory.aggregate({ _max: { position: true } })
    category = await prisma.uniformCategory.create({
      data: {
        name: planKey,
        label: categoryCreate.label,
        icon: categoryCreate.icon,
        position: Number(maxPos._max.position ?? 0) + 1,
        isActive: true,
      },
    })
  }
  return category
}

function sizeMatches(size, lookupKey, categoryKey) {
  const lookup = normalize(lookupKey)
  const code = normalize(size.code)
  const name = normalize(size.name)
  if (lookup === code || lookup === name) return true
  const n = numericPart(lookup)
  if (!n || lookup !== n) return false
  if (categoryKey === 't_shirt') return code === `chest ${n}` || name === `chest ${n}`
  if (categoryKey === 'skirt' || categoryKey === 'pant') return code === `waist ${n}` || name === `waist ${n}`
  if (categoryKey === 'shorts') return code === n || name === `size ${n}`
  if (categoryKey.startsWith('socks')) return code === `size ${n}` || name === `size ${n}` || code === n
  return false
}

async function ensureSize(category, categoryKey, variant) {
  const sizes = await prisma.uniformSize.findMany({ where: { categoryId: category.id }, orderBy: { position: 'asc' } })
  let size = sizes.find((s) => sizeMatches(s, variant.lookup, categoryKey))
  if (size) return { size, created: false }
  if (!APPLY) return { size: null, created: true }
  size = await prisma.uniformSize.create({
    data: {
      categoryId: category.id,
      code: variant.create.code,
      name: variant.create.name,
      price: variant.create.price,
      reorderThreshold: 20,
      position: sizes.length,
    },
  })
  return { size, created: true }
}

async function getStock(sizeId, branchId) {
  return prisma.uniformStock.findUnique({ where: { sizeId_branchId: { sizeId, branchId } } })
}

async function writeLog(tx, branchId, sizeId, adminUserId, before, after, note) {
  await tx.inventoryLog.create({
    data: {
      branchId,
      itemType: 'UNIFORM',
      uniformSizeId: sizeId,
      changeType: 'ADJUSTMENT',
      quantityBefore: before,
      quantityAfter: after,
      quantityDelta: after - before,
      performedById: adminUserId,
      notes: note,
      createdAt: LOG_TS,
    },
  })
}

async function writePricingAuditLog(branchId, sizeId, adminUserId, qty) {
  if (!APPLY) return
  await prisma.inventoryLog.create({
    data: {
      branchId,
      itemType: 'UNIFORM',
      uniformSizeId: sizeId,
      changeType: 'ADJUSTMENT',
      quantityBefore: qty,
      quantityAfter: qty,
      quantityDelta: 0,
      performedById: adminUserId,
      notes: NOTE_PRICE,
      createdAt: LOG_TS,
    },
  })
}

async function ensureBranchStock(size, branch, qty, adminUserId, note, { allowChange }) {
  const current = await getStock(size.id, branch.id)
  const before = current?.quantity ?? 0

  if (!current) {
    const after = allowChange ? qty : 0
    const tone = calcTone(after, size.reorderThreshold ?? 50)
    if (!APPLY) return { before: 0, after, changed: allowChange && after !== 0, created: true }
    await prisma.$transaction(async (tx) => {
      await tx.uniformStock.create({
        data: { sizeId: size.id, branchId: branch.id, quantity: after, tone },
      })
      if (note) await writeLog(tx, branch.id, size.id, adminUserId, 0, after, note)
    })
    return { before: 0, after, changed: allowChange, created: true }
  }

  const after = allowChange ? qty : before
  const tone = calcTone(after, size.reorderThreshold ?? 50)

  if (!APPLY) return { before, after, changed: allowChange && before !== after, created: false }

  if (allowChange && before !== after) {
    await prisma.$transaction(async (tx) => {
      await tx.uniformStock.update({
        where: { sizeId_branchId: { sizeId: size.id, branchId: branch.id } },
        data: { quantity: after, tone },
      })
      await writeLog(tx, branch.id, size.id, adminUserId, before, after, note)
    })
  }

  return { before, after, changed: allowChange && before !== after, created: false }
}

function printTable(title, rows) {
  console.log(`\n${title}`)
  console.log('category | variant | expected | actual | match')
  console.log('---------|---------|----------|--------|------')
  for (const r of rows) console.log(`${r.category} | ${r.variant} | ${r.expected} | ${r.actual} | ${r.match ? 'MATCH' : 'MISMATCH'}`)
}

async function main() {
  const host = dbHostFromUrl()
  console.log(APPLY ? '\n=== APPLY MODE ===' : '\n=== DRY RUN ===')
  console.log(`DB host: ${host}`)
  if (APPLY && !ALLOW_NON_DEV_DB && host.includes('ep-small-art-aopkx268')) {
    throw new Error('Refusing APPLY on production host. Set ALLOW_NON_DEV_DB=1 to override.')
  }

  const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' } })
  if (!admin) throw new Error('No SUPER_ADMIN user found')

  const darga = await findBranch('darga')
  const narsingi = await findBranch('narsingi')
  const shaikpet = await findBranch('shaikpet')
  const peerBranches = [narsingi, shaikpet]

  const peerBaseline = new Map()
  const dargaRows = []
  const priceChecks = []
  const dargaAudit = []
  const priceAudit = []

  for (const plan of CATEGORY_PLAN) {
    console.log(`\n--- ${plan.label} ---`)
    const category = await ensureCategory(plan.key, plan.fallbackKeys ?? [], plan.categoryCreate ?? null)
    if (!category) {
      for (const v of plan.variants) console.log(`  [PENDING] ${v.lookup}`)
      continue
    }

    const catRows = []
    for (const variant of plan.variants) {
      const { size, created } = await ensureSize(category, plan.key, variant)
      if (!size) {
        console.log(`  [PENDING] create ${variant.lookup}`)
        continue
      }

      const prevPrice = Number(size.price)
      const priceChanged = prevPrice !== variant.create.price
      if (APPLY && priceChanged) {
        await prisma.uniformSize.update({
          where: { id: size.id },
          data: { price: variant.create.price },
        })
      }

      priceChecks.push({
        category: plan.label,
        variant: size.name,
        expected: variant.create.price,
        actual: APPLY && priceChanged ? variant.create.price : prevPrice,
        match: prevPrice === variant.create.price || APPLY,
      })

      for (const peer of peerBranches) {
        const existing = await getStock(size.id, peer.id)
        const hadRow = Boolean(existing)
        const beforeQty = existing?.quantity ?? 0
        peerBaseline.set(`${size.id}:${peer.id}`, hadRow ? beforeQty : null)

        const peerResult = await ensureBranchStock(size, peer, 0, admin.id, NOTE_PRICE, { allowChange: false })
        if (peerResult.created) {
          priceAudit.push({ branchId: peer.id, sizeId: size.id, label: `${plan.label} / ${size.name}` })
        } else if (priceChanged && hadRow) {
          await writePricingAuditLog(peer.id, size.id, admin.id, beforeQty)
          priceAudit.push({ branchId: peer.id, sizeId: size.id, label: `${plan.label} / ${size.name}` })
        }
      }

      if (variant.dargaQty !== null) {
        const dResult = await ensureBranchStock(size, darga, variant.dargaQty, admin.id, NOTE_DARGA, { allowChange: true })
        const actual = APPLY ? (await getStock(size.id, darga.id))?.quantity ?? 0 : variant.dargaQty
        console.log(`  ${created ? '[CREATE] ' : ''}${size.name}: Darga ${dResult.before} -> ${variant.dargaQty}${priceChanged ? ` | price ${prevPrice}->${variant.create.price}` : ''}`)
        catRows.push({ category: plan.label, variant: size.name, expected: variant.dargaQty, actual, match: actual === variant.dargaQty })
        dargaRows.push({ category: plan.label, variant: size.name, expected: variant.dargaQty, actual, match: actual === variant.dargaQty })
        if (dResult.changed || created) dargaAudit.push({ sizeId: size.id, label: `${plan.label} / ${size.name}` })
      } else {
        const dargaExisting = await getStock(size.id, darga.id)
        const dargaQty = dargaExisting?.quantity ?? 0
        await ensureBranchStock(size, darga, 0, admin.id, null, { allowChange: false })
        if (priceChanged && dargaExisting) {
          await writePricingAuditLog(darga.id, size.id, admin.id, dargaQty)
          priceAudit.push({ branchId: darga.id, sizeId: size.id, label: `${plan.label} / ${size.name}` })
        }
        console.log(`  ${size.name}: price only -> ${variant.create.price} (Darga stock unchanged)`)
      }
    }

    if (catRows.length) {
      printTable(`Darga verify — ${plan.label}`, catRows)
      if (APPLY && catRows.some((r) => !r.match)) throw new Error(`Darga mismatch in ${plan.label}`)
    }
  }

  if (!APPLY) {
    console.log('\nDry run complete. APPLY_DARGA_UNIFORM_CORRECTION=1 to commit.')
    return
  }

  printTable('Final Darga stock verification', dargaRows)
  if (dargaRows.some((r) => !r.match)) throw new Error('Final Darga stock mismatch')

  printTable('Global pricing verification', priceChecks)
  if (priceChecks.some((r) => !r.match)) throw new Error('Pricing mismatch')

  let drift = 0
  for (const [key, before] of peerBaseline.entries()) {
    const [sizeId, branchId] = key.split(':')
    const now = (await getStock(sizeId, branchId))?.quantity ?? null
    if (before !== now && before !== null) {
      drift += 1
      const b = await prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } })
      const s = await prisma.uniformSize.findUnique({ where: { id: sizeId }, select: { name: true } })
      console.log(`DRIFT ${b?.name} ${s?.name}: ${before} -> ${now}`)
    }
  }
  if (drift) throw new Error(`${drift} peer branch stock drift(s)`)
  console.log('\n✓ Narsingi & Shaikpet existing stock unchanged')

  for (const item of dargaAudit) {
    const log = await prisma.inventoryLog.findFirst({
      where: { branchId: darga.id, uniformSizeId: item.sizeId, notes: NOTE_DARGA, createdAt: LOG_TS },
    })
    if (!log) throw new Error(`Missing Darga audit: ${item.label}`)
  }
  console.log(`✓ ${dargaAudit.length} Darga audit log(s) verified`)

  for (const item of priceAudit) {
    const log = await prisma.inventoryLog.findFirst({
      where: { branchId: item.branchId, uniformSizeId: item.sizeId, notes: NOTE_PRICE, createdAt: LOG_TS },
    })
    if (!log) throw new Error(`Missing pricing audit: ${item.label}`)
  }
  console.log(`✓ ${priceAudit.length} peer pricing audit log(s) verified`)
  console.log('\nDone — verify Darga stock and all-branch pricing in UI.')
}

main()
  .catch((e) => { console.error('\nFAILED:', e.message || e); process.exitCode = 1 })
  .finally(async () => { await prisma.$disconnect() })
