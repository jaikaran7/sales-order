/**
 * Narsingi uniform stock correction — physical count 25 Jun 2026
 *
 * Dry run:
 *   node prisma/seed-narsingi-uniform-count-jun25-2026.js
 *
 * Apply (DEV first):
 *   APPLY_NARSINGI_UNIFORM_CORRECTION=1 node prisma/seed-narsingi-uniform-count-jun25-2026.js
 *
 * To allow running on a non-dev host explicitly:
 *   APPLY_NARSINGI_UNIFORM_CORRECTION=1 ALLOW_NON_DEV_DB=1 node prisma/seed-narsingi-uniform-count-jun25-2026.js
 */

require('dotenv').config()
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()

const APPLY = process.env.APPLY_NARSINGI_UNIFORM_CORRECTION === '1'
const ALLOW_NON_DEV_DB = process.env.ALLOW_NON_DEV_DB === '1'

const NOTE_BASE = 'Physical stock count — Narsingi branch — 25 Jun 2026'
const NOTE_95_FLAG = '95cm quantity flagged — confirm with admin'
const LOG_TS = new Date('2026-06-25T12:00:00.000+05:30')

const BRANCH_ALIASES = {
  darga: ['NHS_DARGA', 'CAMP-A', 'DARGA'],
  narsingi: ['SVN_NARSINGI', 'CAMP-B', 'NARSINGI'],
  shaikpet: ['NS_SHAIKPET', 'CAMP-C', 'SHAIKPET'],
}

const STOCK_PLAN = [
  {
    key: 't_shirt',
    label: 'T-Shirts (White)',
    note: NOTE_BASE,
    variants: [
      { lookup: '20', create: { code: 'Chest 20', name: 'Chest 20', price: 230 }, qty: 0 },
      { lookup: '22', create: { code: 'Chest 22', name: 'Chest 22', price: 250 }, qty: 30 },
      { lookup: '24', create: { code: 'Chest 24', name: 'Chest 24', price: 270 }, qty: 31 },
      { lookup: '26', create: { code: 'Chest 26', name: 'Chest 26', price: 290 }, qty: 26 },
      { lookup: '28', create: { code: 'Chest 28', name: 'Chest 28', price: 310 }, qty: 20 },
      { lookup: '30', create: { code: 'Chest 30', name: 'Chest 30', price: 330 }, qty: 6 },
      { lookup: '32', create: { code: 'Chest 32', name: 'Chest 32', price: 350 }, qty: 6 },
      { lookup: '34', create: { code: 'Chest 34', name: 'Chest 34', price: 370 }, qty: 7 },
      { lookup: '36', create: { code: 'Chest 36', name: 'Chest 36', price: 390 }, qty: 2 },
      { lookup: '38', create: { code: 'Chest 38', name: 'Chest 38', price: 410 }, qty: 14 },
      { lookup: '40', create: { code: 'Chest 40', name: 'Chest 40', price: 430 }, qty: 19 },
      { lookup: '42', create: { code: 'Chest 42', name: 'Chest 42', price: 450 }, qty: 14 },
    ],
  },
  {
    key: 'skirt',
    label: 'Skirts',
    note: NOTE_BASE,
    variants: [
      { lookup: '15', create: { code: 'Waist 15', name: 'Waist 15', price: 330 }, qty: 0 },
      { lookup: '16', create: { code: 'Waist 16', name: 'Waist 16', price: 330 }, qty: 27 },
      { lookup: '17', create: { code: 'Waist 17', name: 'Waist 17', price: 350 }, qty: 13 },
      { lookup: '18', create: { code: 'Waist 18', name: 'Waist 18', price: 370 }, qty: 5 },
      { lookup: '20', create: { code: 'Waist 20', name: 'Waist 20', price: 390 }, qty: 22 },
      { lookup: '22', create: { code: 'Waist 22', name: 'Waist 22', price: 410 }, qty: 12 },
      { lookup: '24', create: { code: 'Waist 24', name: 'Waist 24', price: 430 }, qty: 5 },
      { lookup: '26', create: { code: 'Waist 26', name: 'Waist 26', price: 450 }, qty: 6 },
      { lookup: '28', create: { code: 'Waist 28', name: 'Waist 28', price: 470 }, qty: 9 },
      { lookup: '30', create: { code: 'Waist 30', name: 'Waist 30', price: 490 }, qty: 10 },
    ],
  },
  {
    key: 'shorts',
    label: 'Shorts',
    note: NOTE_BASE,
    variants: [
      { lookup: '11', create: { code: '11', name: 'Size 11', price: 200 }, qty: 22 },
      { lookup: '12', create: { code: '12', name: 'Size 12', price: 220 }, qty: 6 },
      { lookup: '13', create: { code: '13', name: 'Size 13', price: 240 }, qty: 0 },
      { lookup: '14', create: { code: '14', name: 'Size 14', price: 260 }, qty: 10 },
      { lookup: '15', create: { code: '15', name: 'Size 15', price: 280 }, qty: 10 },
      { lookup: '16', create: { code: '16', name: 'Size 16', price: 300 }, qty: 10 },
      { lookup: '17', create: { code: '17', name: 'Size 17', price: 320 }, qty: 13 },
    ],
  },
  {
    key: 'pant',
    label: 'Pants',
    note: NOTE_BASE,
    variants: [
      { lookup: '32', create: { code: 'Waist 32', name: 'Waist 32', price: 360 }, qty: 45 },
      { lookup: '34', create: { code: 'Waist 34', name: 'Waist 34', price: 400 }, qty: 24 },
      { lookup: '36', create: { code: 'Waist 36', name: 'Waist 36', price: 430 }, qty: 19 },
      { lookup: '38', create: { code: 'Waist 38', name: 'Waist 38', price: 430 }, qty: 16 },
      { lookup: '40', create: { code: 'Waist 40', name: 'Waist 40', price: 450 }, qty: 24 },
      { lookup: '42', create: { code: 'Waist 42', name: 'Waist 42', price: 450 }, qty: 0 },
    ],
  },
  {
    key: 'socks_grey_yellow_line',
    label: 'Socks — Grey Yellow Line',
    categoryCreate: { label: 'Socks (Grey Yellow Line)', icon: 'footprint' },
    note: NOTE_BASE,
    variants: [
      { lookup: '2', create: { code: 'size 2', name: 'size 2', price: 85 }, qty: 18 },
      { lookup: '3', create: { code: 'size 3', name: 'size 3', price: 85 }, qty: 143 },
      { lookup: '4', create: { code: 'size 4', name: 'size 4', price: 85 }, qty: 112 },
    ],
  },
  {
    key: 'socks_grey',
    label: 'Socks — Grey',
    fallbackKeys: ['socks'],
    categoryCreate: { label: 'Socks (Grey)', icon: 'footprint' },
    note: NOTE_BASE,
    variants: [
      { lookup: '2', create: { code: 'size 2', name: 'size 2', price: 80 }, qty: 49 },
      { lookup: '3', create: { code: 'size 3', name: 'size 3', price: 80 }, qty: 54 },
      { lookup: '4', create: { code: 'size 4', name: 'size 4', price: 80 }, qty: 72 },
      { lookup: '5', create: { code: 'size 5', name: 'size 5', price: 80 }, qty: 36 },
      { lookup: '6', create: { code: 'size 6', name: 'size 6', price: 80 }, qty: 69 },
      { lookup: 'free size', create: { code: 'free size', name: 'free size', price: 90 }, qty: 59 },
    ],
  },
  {
    key: 'socks_white',
    label: 'Socks — White',
    categoryCreate: { label: 'Socks (White)', icon: 'footprint' },
    note: NOTE_BASE,
    variants: [
      { lookup: '2', create: { code: 'size 2', name: 'size 2', price: 80 }, qty: 54 },
      { lookup: '3', create: { code: 'size 3', name: 'size 3', price: 80 }, qty: 44 },
      { lookup: '4', create: { code: 'size 4', name: 'size 4', price: 80 }, qty: 37 },
      { lookup: '5', create: { code: 'size 5', name: 'size 5', price: 80 }, qty: 42 },
      { lookup: '6', create: { code: 'size 6', name: 'size 6', price: 80 }, qty: 53 },
      { lookup: 'free size', create: { code: 'free size', name: 'free size', price: 90 }, qty: 16 },
    ],
  },
  {
    key: 'tie',
    label: 'Ties',
    note: NOTE_BASE,
    variants: [
      { lookup: 'Short Tie', create: { code: 'Short Tie', name: 'Short Tie', price: 120 }, qty: 34 },
      { lookup: 'Long Tie', create: { code: 'Long Tie', name: 'Long Tie', price: 150 }, qty: 47 },
      { lookup: 'Small Tie', create: { code: 'Small Tie', name: 'Small Tie', price: 110 }, qty: 24 },
    ],
  },
  {
    key: 'belt',
    label: 'Belts',
    note: NOTE_BASE,
    variants: [
      { lookup: 'Grey Yellow Belt', create: { code: 'Grey Yellow Belt', name: 'Grey Yellow Belt', price: 120 }, qty: 46 },
      { lookup: '85cm', create: { code: '85cm', name: '85cm', price: 120 }, qty: 40 },
      { lookup: '95cm', create: { code: '95cm', name: '95cm', price: 120 }, qty: 40, extraNote: NOTE_95_FLAG },
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
  if (atIdx === -1) return 'unknown'
  return raw.slice(atIdx + 1).split('/')[0]
}

function normalize(value) {
  return String(value ?? '').trim().toLowerCase()
}

function numericPart(value) {
  return normalize(value).replace(/[^\d]/g, '')
}

async function findBranch(branchKey) {
  const aliases = BRANCH_ALIASES[branchKey]
  const row = await prisma.branch.findFirst({
    where: {
      OR: [
        { code: { in: aliases } },
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
  const names = [planKey, ...fallbackKeys]
  let category = await prisma.uniformCategory.findFirst({
    where: { name: { in: names } },
  })
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
  const sizes = await prisma.uniformSize.findMany({
    where: { categoryId: category.id },
    orderBy: { position: 'asc' },
  })
  let size = sizes.find((s) => sizeMatches(s, variant.lookup, categoryKey))
  if (size) return { size, created: false }

  if (!APPLY) return { size: null, created: true }

  const pos = sizes.length
  size = await prisma.uniformSize.create({
    data: {
      categoryId: category.id,
      code: variant.create.code,
      name: variant.create.name,
      price: variant.create.price,
      reorderThreshold: 20,
      position: pos,
    },
  })
  return { size, created: true }
}

async function getStock(sizeId, branchId) {
  return prisma.uniformStock.findUnique({
    where: { sizeId_branchId: { sizeId, branchId } },
  })
}

async function setNarsingiStockWithLog(size, narsingiBranch, adminUserId, qty, note) {
  const current = await getStock(size.id, narsingiBranch.id)
  const before = current?.quantity ?? 0
  const after = qty
  const tone = calcTone(after, size.reorderThreshold ?? 50)

  if (APPLY) {
    await prisma.$transaction(async (tx) => {
      await tx.uniformStock.upsert({
        where: { sizeId_branchId: { sizeId: size.id, branchId: narsingiBranch.id } },
        create: { sizeId: size.id, branchId: narsingiBranch.id, quantity: after, tone },
        update: { quantity: after, tone },
      })
      await tx.inventoryLog.create({
        data: {
          branchId: narsingiBranch.id,
          itemType: 'UNIFORM',
          uniformSizeId: size.id,
          changeType: 'ADJUSTMENT',
          quantityBefore: before,
          quantityAfter: after,
          quantityDelta: after - before,
          performedById: adminUserId,
          notes: note,
          createdAt: LOG_TS,
        },
      })
    })
  }

  return { before, after }
}

function printRowsTable(title, rows) {
  console.log(`\n${title}`)
  console.log('category | variant | expected | actual | match')
  console.log('---------|---------|----------|--------|------')
  for (const row of rows) {
    console.log(`${row.category} | ${row.variant} | ${row.expected} | ${row.actual} | ${row.match ? 'MATCH' : 'MISMATCH'}`)
  }
}

async function main() {
  const host = dbHostFromUrl()
  console.log(APPLY ? '\n=== APPLY MODE ===' : '\n=== DRY RUN (no writes) ===')
  console.log(`DB host: ${host}`)

  if (APPLY && !ALLOW_NON_DEV_DB && host.includes('ep-small-art-aopkx268')) {
    throw new Error('Refusing APPLY on production host. Use dev DB or set ALLOW_NON_DEV_DB=1 explicitly.')
  }

  const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' } })
  if (!admin) throw new Error('No SUPER_ADMIN user found')

  const narsingi = await findBranch('narsingi')
  const darga = await findBranch('darga')
  const shaikpet = await findBranch('shaikpet')
  const otherBranches = [darga, shaikpet]

  console.log(`Target branch: ${narsingi.name} (${narsingi.code})`)
  console.log('Lock: only Narsingi rows will be inserted/updated.')

  // Pre-task baseline for unchanged checks (only for variants we touch).
  const otherBaseline = new Map()
  const allVerificationRows = []
  const auditChecklist = []
  const createdVariantNotes = []

  for (const plan of STOCK_PLAN) {
    console.log(`\n--- Category: ${plan.label} ---`)
    const category = await ensureCategory(plan.key, plan.fallbackKeys ?? [], plan.categoryCreate ?? null)
    if (!category) {
      if (APPLY) throw new Error(`Category not found and could not be created: ${plan.key}`)
      console.log(`  [PENDING] category ${plan.key} would be created`)
      for (const v of plan.variants) {
        console.log(`  [PENDING] ${plan.key} / ${v.lookup}: ${v.qty}`)
      }
      continue
    }

    const categoryRows = []
    for (const variant of plan.variants) {
      const { size, created } = await ensureSize(category, plan.key, variant)
      if (!size) {
        console.log(`  [PENDING] missing size ${variant.lookup} (would create)`)
        continue
      }
      if (created) {
        createdVariantNotes.push(`${plan.label}: ${size.name} (placeholder price ₹${Number(size.price)})`)
      }

      for (const ob of otherBranches) {
        const obStock = await getStock(size.id, ob.id)
        otherBaseline.set(`${size.id}:${ob.id}`, obStock?.quantity ?? null)
      }

      const note = variant.extraNote ? `${plan.note}\n${variant.extraNote}` : plan.note
      const { before, after } = await setNarsingiStockWithLog(size, narsingi, admin.id, variant.qty, note)
      const actualNow = APPLY ? (await getStock(size.id, narsingi.id))?.quantity ?? 0 : after

      console.log(`  ${created ? '[CREATE+SET]' : '[SET]'} ${size.name}: ${before} -> ${variant.qty}`)
      categoryRows.push({
        category: plan.label,
        variant: size.name,
        expected: variant.qty,
        actual: actualNow,
        match: actualNow === variant.qty,
      })
      allVerificationRows.push({
        category: plan.label,
        variant: size.name,
        expected: variant.qty,
        actual: actualNow,
        match: actualNow === variant.qty,
      })
      auditChecklist.push({
        sizeId: size.id,
        label: `${plan.label} / ${size.name}`,
        note,
      })
    }

    // Per-category select verification before moving on.
    if (categoryRows.length) {
      printRowsTable(`Verification after ${plan.label}`, categoryRows)
      const categoryMismatch = categoryRows.filter((r) => !r.match)
      if (categoryMismatch.length) {
        throw new Error(`Verification failed in category ${plan.label}`)
      }
    }
  }

  if (!APPLY) {
    console.log('\nDry run complete. Re-run with APPLY_NARSINGI_UNIFORM_CORRECTION=1 to commit.')
    return
  }

  // Final full verification table.
  printRowsTable('Final Narsingi verification', allVerificationRows)
  const mismatches = allVerificationRows.filter((r) => !r.match)
  if (mismatches.length) {
    throw new Error(`${mismatches.length} final stock mismatch(es) found`)
  }

  // Unchanged checks for Darga + Shaikpet.
  let driftCount = 0
  for (const [key, before] of otherBaseline.entries()) {
    const [sizeId, branchId] = key.split(':')
    const row = await getStock(sizeId, branchId)
    const now = row?.quantity ?? null
    if (before !== now) {
      driftCount += 1
      const b = await prisma.branch.findUnique({ where: { id: branchId }, select: { name: true } })
      const s = await prisma.uniformSize.findUnique({ where: { id: sizeId }, select: { name: true } })
      console.log(`DRIFT: ${b?.name} / ${s?.name}: before=${before} after=${now}`)
    }
  }
  if (driftCount > 0) {
    throw new Error(`Darga/Shaikpet drift detected for ${driftCount} row(s)`)
  }
  console.log('\n✓ Darga and Shaikpet stock unchanged for all updated variants.')

  // Audit log checks.
  let missingAudit = 0
  for (const item of auditChecklist) {
    const log = await prisma.inventoryLog.findFirst({
      where: {
        branchId: narsingi.id,
        itemType: 'UNIFORM',
        uniformSizeId: item.sizeId,
        changeType: 'ADJUSTMENT',
        notes: item.note,
        createdAt: LOG_TS,
      },
      select: { id: true },
    })
    if (!log) {
      missingAudit += 1
      console.log(`MISSING AUDIT: ${item.label}`)
    }
  }
  if (missingAudit > 0) {
    throw new Error(`Missing ${missingAudit} audit log entr${missingAudit === 1 ? 'y' : 'ies'}`)
  }
  console.log('✓ Audit log entries verified for every updated variant.')

  if (createdVariantNotes.length) {
    console.log('\nPlaceholder pricing used for newly created variants:')
    for (const line of createdVariantNotes) console.log(`  - ${line}`)
  }

  console.log('\nDone. Next: visually verify Narsingi stock screen in UI.')
}

main()
  .catch((err) => {
    console.error('\nFAILED:', err.message || err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
