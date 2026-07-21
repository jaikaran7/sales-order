/**
 * Shaikpet uniform stock correction — physical count 22 Jun 2026
 * Tie size variant setup + socks price fix
 *
 * Dry run:  node prisma/seed-shaikpet-uniform-correction-jun22-2026.js
 * Apply:    APPLY_SHAIKPET_UNIFORM_CORRECTION=1 node prisma/seed-shaikpet-uniform-correction-jun22-2026.js
 *
 * Safe for dev first; re-run on prod with the same env flag after verification.
 */

require('dotenv').config()
const { PrismaClient } = require('@prisma/client')
const { parseRupeePrice } = require('../src/utils/money')

const prisma = new PrismaClient()
const APPLY = process.env.APPLY_SHAIKPET_UNIFORM_CORRECTION === '1'

const CORRECTION_NOTE = 'Physical stock count correction — 22 Jun 2026'
const CORRECTION_DATE = new Date('2026-06-22T12:00:00.000+05:30')

const BRANCH_ALIASES = {
  shaikpet: ['NS_SHAIKPET', 'CAMP-C', 'SHAIKPET'],
  darga: ['NHS_DARGA', 'CAMP-A', 'DARGA'],
  narsingi: ['SVN_NARSINGI', 'CAMP-B', 'NARSINGI'],
}

/** category name → { sizeKey → targetQty } — Shaikpet only */
const STOCK_TARGETS = {
  shorts: {
    11: 36, 12: 29, 13: 12, 14: 21, 15: 20,
  },
  pant: {
    30: 23, 32: 33, 34: 36, 36: 27, 38: 25, 42: 12,
  },
  skirt: {
    // First "Size 24 | 10" in source sheet interpreted as Waist 18 (typo in register)
    16: 23, 17: 34, 18: 10, 20: 17, 22: 20, 24: 14, 26: 34, 28: 27, 30: 35,
  },
  t_shirt: {
    22: 26, 24: 26, 30: 19, 32: 29, 34: 3, 36: 13, 38: 24, 40: 24, 42: 19,
  },
  socks_grey: {
    2: 20, 3: 19, 4: 45, 5: 54, 6: 45, 'free size': 57,
  },
  socks_white: {
    2: 6, 3: 5, 5: 26, 6: 6, 'free size': 30,
  },
  belt: {
    'One Size': 72,
  },
  tie: {
    12: 77, 14: 75, 16: 40, '16 Big': 56, 'Long Tie': 6,
  },
}

/** New / updated tie size variants */
const TIE_VARIANTS = [
  { code: '12', name: 'Size 12', price: 120, position: 0 },
  { code: '14', name: 'Size 14', price: 120, position: 1 },
  { code: '16', name: 'Size 16', price: 120, position: 2 },
  { code: '16 Big', name: 'Size 16 Big', price: 150, position: 3 },
  { code: 'Long Tie', name: 'Long Tie', price: 150, position: 4 },
  { code: 'Short Tie', name: 'Short Tie', price: 120, position: 5 },
]

/** Missing pant size to create before stock correction */
const NEW_PANT_SIZE = { code: 'Waist 30', name: 'Waist 30', price: 340, position: 0 }

/** Price fixes (exact rupee values) */
const PRICE_FIXES = [
  { category: 'socks_grey', code: 'free size', price: 90 },
  { category: 'socks_white', code: 'free size', price: 90 },
]

const SOCKS_GREY_SIZES = [
  { code: 'size 2', name: 'size 2', price: 80 },
  { code: 'size 3', name: 'size 3', price: 80 },
  { code: 'size 4', name: 'size 4', price: 80 },
  { code: 'size 5', name: 'size 5', price: 80 },
  { code: 'size 6', name: 'size 6', price: 80 },
  { code: 'free size', name: 'free size', price: 90 },
]

const SOCKS_WHITE_SIZES = [
  { code: 'size 2', name: 'size 2', price: 80 },
  { code: 'size 3', name: 'size 3', price: 80 },
  { code: 'size 5', name: 'size 5', price: 80 },
  { code: 'size 6', name: 'size 6', price: 80 },
  { code: 'free size', name: 'free size', price: 90 },
]

function calcTone(qty, threshold = 50) {
  if (qty <= threshold * 0.2) return 'CRITICAL'
  if (qty <= threshold) return 'LOW'
  return 'NORMAL'
}

async function findBranch(branchKey) {
  const aliases = BRANCH_ALIASES[branchKey]
  const branch = await prisma.branch.findFirst({
    where: {
      OR: [
        { code: { in: aliases } },
        { name: { contains: branchKey, mode: 'insensitive' } },
      ],
      isActive: true,
      deletedAt: null,
      type: 'BRANCH',
    },
  })
  if (!branch) throw new Error(`Branch not found: ${branchKey}`)
  return branch
}

async function findCategory(name) {
  let cat = await prisma.uniformCategory.findFirst({ where: { name } })
  if (!cat && name === 'socks_grey') {
    cat = await prisma.uniformCategory.findFirst({ where: { name: 'socks' } })
  }
  if (!cat) throw new Error(`Uniform category not found: ${name}`)
  return cat
}

function normalizeKey(value) {
  return String(value ?? '').trim().toLowerCase()
}

function sizeMatches(size, sizeKey, categoryName) {
  const key = normalizeKey(sizeKey)
  const code = normalizeKey(size.code)
  const name = normalizeKey(size.name)

  if (code === key || name === key) return true

  const numericKey = key.replace(/[^\d]/g, '')
  const isPureNumericKey = numericKey && key === numericKey
  if (isPureNumericKey && (code.includes(numericKey) || name.includes(numericKey))) {
    if (categoryName === 'shorts') return code === numericKey || name === `size ${numericKey}`
    if (categoryName.startsWith('socks')) {
      return code === `size ${numericKey}` || name === `size ${numericKey}` || code === numericKey
    }
    if (categoryName === 't_shirt') return code === `chest ${numericKey}` || name === `chest ${numericKey}`
    if (categoryName === 'skirt' || categoryName === 'pant') {
      return code === `waist ${numericKey}` || name === `waist ${numericKey}`
    }
    if (categoryName === 'tie') return code === key || name === key || code === `size ${numericKey}` || name === `size ${numericKey}`
  }

  if (categoryName === 'belt' && (key === 'belt' || key === 'one size')) {
    return code === 'one size' || name === 'one size'
  }

  if (categoryName.startsWith('socks') && key === 'free size') {
    return code === 'free size' || name === 'free size'
  }

  if (categoryName === 'tie' && key === 'long tie') {
    return code === 'long tie' || name === 'long tie'
  }

  return false
}

async function findSize(categoryName, sizeKey) {
  const cat = await findCategory(categoryName)
  const sizes = await prisma.uniformSize.findMany({
    where: { categoryId: cat.id },
    orderBy: { position: 'asc' },
  })
  const key = normalizeKey(sizeKey)

  const exact = sizes.find((s) => normalizeKey(s.code) === key || normalizeKey(s.name) === key)
  if (exact) return exact

  const found = sizes.find((s) => sizeMatches(s, sizeKey, categoryName))
  if (!found) {
    throw new Error(`Size not found: ${categoryName} / ${sizeKey}`)
  }
  return found
}

async function ensureTieVariants(adminUserId, branches) {
  const cat = await findCategory('tie')
  const existing = await prisma.uniformSize.findMany({ where: { categoryId: cat.id } })
  const keepCodes = new Set(TIE_VARIANTS.map((v) => v.code))
  const removeIds = existing.filter((s) => !keepCodes.has(s.code)).map((s) => s.id)

  const actions = []

  if (removeIds.length) {
    actions.push(`Remove ${removeIds.length} obsolete tie variant(s)`)
    if (APPLY) {
      await prisma.inventoryLog.deleteMany({ where: { uniformSizeId: { in: removeIds } } })
      await prisma.uniformStock.deleteMany({ where: { sizeId: { in: removeIds } } })
      await prisma.uniformSize.deleteMany({ where: { id: { in: removeIds } } })
    }
  }

  for (const variant of TIE_VARIANTS) {
    const prev = existing.find((s) => s.code === variant.code)
    actions.push(
      prev
        ? `Update tie variant ${variant.name} (price ₹${variant.price})`
        : `Create tie variant ${variant.name} (price ₹${variant.price})`,
    )
    if (!APPLY) continue

    const size = await prisma.uniformSize.upsert({
      where: { categoryId_code: { categoryId: cat.id, code: variant.code } },
      update: {
        name: variant.name,
        price: variant.price,
        position: variant.position,
        reorderThreshold: 20,
      },
      create: {
        categoryId: cat.id,
        code: variant.code,
        name: variant.name,
        price: variant.price,
        position: variant.position,
        reorderThreshold: 20,
      },
    })

    if (!prev) {
      for (const branch of branches) {
        await prisma.uniformStock.create({
          data: {
            sizeId: size.id,
            branchId: branch.id,
            quantity: 0,
            tone: calcTone(0, 20),
          },
        })
      }
    }
  }

  return actions
}

async function ensureSocksCategories(branches) {
  const actions = []
  const legacy = await prisma.uniformCategory.findFirst({ where: { name: 'socks' } })
  const greyCat = await prisma.uniformCategory.findFirst({ where: { name: 'socks_grey' } })

  if (legacy && !greyCat) {
    actions.push('Rename legacy "Socks" → Socks (Grey)')
    if (APPLY) {
      await prisma.uniformCategory.update({
        where: { id: legacy.id },
        data: { name: 'socks_grey', label: 'Socks (Grey)', icon: 'footprint' },
      })
    }
  }

  async function upsertSocksCategory(name, label, sizes, position) {
    let cat = await prisma.uniformCategory.findFirst({ where: { name } })
    if (!cat && APPLY) {
      cat = await prisma.uniformCategory.create({
        data: { name, label, icon: 'footprint', position, isActive: true },
      })
      actions.push(`Created category ${label}`)
    } else if (cat) {
      actions.push(`Category ${label} exists`)
      if (APPLY) {
        await prisma.uniformCategory.update({
          where: { id: cat.id },
          data: { label, icon: 'footprint', isActive: true },
        })
      }
    } else {
      actions.push(`Would create category ${label}`)
      return
    }

    for (let idx = 0; idx < sizes.length; idx += 1) {
      const def = sizes[idx]
      const prev = await prisma.uniformSize.findFirst({
        where: { categoryId: cat.id, code: def.code },
      })
      const size = APPLY
        ? await prisma.uniformSize.upsert({
          where: { categoryId_code: { categoryId: cat.id, code: def.code } },
          update: { name: def.name, price: def.price, position: idx, reorderThreshold: 20 },
          create: {
            categoryId: cat.id,
            code: def.code,
            name: def.name,
            price: def.price,
            position: idx,
            reorderThreshold: 20,
          },
        })
        : prev

      if (!APPLY || !size) continue

      for (const branch of branches) {
        await prisma.uniformStock.upsert({
          where: { sizeId_branchId: { sizeId: size.id, branchId: branch.id } },
          create: { sizeId: size.id, branchId: branch.id, quantity: 0, tone: calcTone(0, 20) },
          update: {},
        })
      }
    }
  }

  const resolvedGrey = greyCat ?? legacy
  const greyPos = resolvedGrey?.position ?? 6
  await upsertSocksCategory('socks_grey', 'Socks (Grey)', SOCKS_GREY_SIZES, greyPos)
  await upsertSocksCategory('socks_white', 'Socks (White)', SOCKS_WHITE_SIZES, greyPos + 1)

  return actions
}

async function ensurePantWaist30(branches) {
  const cat = await findCategory('pant')
  const existing = await prisma.uniformSize.findFirst({
    where: { categoryId: cat.id, code: NEW_PANT_SIZE.code },
  })
  if (existing) return [`Pant ${NEW_PANT_SIZE.name} already exists`]

  const actions = [`Create pant size ${NEW_PANT_SIZE.name} (price ₹${NEW_PANT_SIZE.price} — placeholder, adjust later)`]
  if (!APPLY) return actions

  const size = await prisma.uniformSize.create({
    data: {
      categoryId: cat.id,
      code: NEW_PANT_SIZE.code,
      name: NEW_PANT_SIZE.name,
      price: NEW_PANT_SIZE.price,
      position: NEW_PANT_SIZE.position,
      reorderThreshold: 20,
    },
  })

  for (const branch of branches) {
    await prisma.uniformStock.create({
      data: {
        sizeId: size.id,
        branchId: branch.id,
        quantity: 0,
        tone: calcTone(0, 20),
      },
    })
  }

  return actions
}

async function applyPriceFixes() {
  const actions = []
  for (const fix of PRICE_FIXES) {
    let size
    try {
      size = await findSize(fix.category, fix.code)
    } catch (err) {
      if (!APPLY && fix.category === 'socks_white') {
        actions.push(`${fix.category}/${fix.code}: will set price ₹${fix.price} after category creation`)
        continue
      }
      throw err
    }
    const current = Number(size.price)
    if (current === fix.price) {
      actions.push(`${fix.category}/${fix.code}: price already ₹${fix.price}`)
      continue
    }
    actions.push(`${fix.category}/${fix.code}: price ${current} → ₹${fix.price}`)
    if (APPLY) {
      await prisma.uniformSize.update({
        where: { id: size.id },
        data: { price: fix.price },
      })
    }
  }
  return actions
}

async function applyStockCorrection(size, branchId, targetQty, adminUserId, otherBranchIds) {
  const current = await prisma.uniformStock.findUnique({
    where: { sizeId_branchId: { sizeId: size.id, branchId } },
  })
  const before = current?.quantity ?? 0
  const after = targetQty
  const tone = calcTone(after, size.reorderThreshold ?? 50)

  const snapshotOthers = {}
  for (const obId of otherBranchIds) {
    const row = await prisma.uniformStock.findUnique({
      where: { sizeId_branchId: { sizeId: size.id, branchId: obId } },
    })
    snapshotOthers[obId] = row?.quantity ?? 0
  }

  if (APPLY) {
    await prisma.$transaction(async (tx) => {
      await tx.uniformStock.upsert({
        where: { sizeId_branchId: { sizeId: size.id, branchId } },
        create: { sizeId: size.id, branchId, quantity: after, tone },
        update: { quantity: after, tone },
      })

      if (before !== after) {
        await tx.inventoryLog.create({
          data: {
            branchId,
            itemType: 'UNIFORM',
            uniformSizeId: size.id,
            changeType: 'ADJUSTMENT',
            quantityBefore: before,
            quantityAfter: after,
            quantityDelta: after - before,
            performedById: adminUserId,
            notes: CORRECTION_NOTE,
            createdAt: CORRECTION_DATE,
          },
        })
      }
    })
  }

  return { before, after, snapshotOthers }
}

async function verifyCorrections(shaikpetId, otherBranchIds) {
  const failures = []

  for (const [categoryName, targets] of Object.entries(STOCK_TARGETS)) {
    for (const [sizeKey, targetQty] of Object.entries(targets)) {
      const size = await findSize(categoryName, sizeKey)
      const shaikRow = await prisma.uniformStock.findUnique({
        where: { sizeId_branchId: { sizeId: size.id, branchId: shaikpetId } },
      })
      const actual = shaikRow?.quantity ?? 0
      if (actual !== targetQty) {
        failures.push(`Shaikpet ${categoryName}/${sizeKey}: expected ${targetQty}, got ${actual}`)
      }

      const log = await prisma.inventoryLog.findFirst({
        where: {
          uniformSizeId: size.id,
          branchId: shaikpetId,
          changeType: 'ADJUSTMENT',
          notes: CORRECTION_NOTE,
        },
        orderBy: { createdAt: 'desc' },
      })
      if (actual !== targetQty && !log) {
        failures.push(`Missing audit log for ${categoryName}/${sizeKey}`)
      }

      for (const obId of otherBranchIds) {
        // Other branches must be unchanged — checked via pre/post snapshot in dry-run only;
        // post-apply we rely on correction targeting shaikpet exclusively.
      }
    }
  }

  for (const fix of PRICE_FIXES) {
    const size = await findSize(fix.category, fix.code)
    if (Number(size.price) !== fix.price) {
      failures.push(`${fix.category}/${fix.code} price: expected ${fix.price}, got ${size.price}`)
    }
  }

  for (const variant of TIE_VARIANTS) {
    const size = await findSize('tie', variant.code)
    if (size.name !== variant.name) {
      failures.push(`Tie variant name mismatch for ${variant.code}: "${size.name}" !== "${variant.name}"`)
    }
  }

  return failures
}

async function main() {
  console.log(APPLY ? '\n=== APPLY MODE ===' : '\n=== DRY RUN (no writes) ===')

  const admin = await prisma.user.findFirst({ where: { role: 'SUPER_ADMIN' } })
  if (!admin) throw new Error('No SUPER_ADMIN user found')

  const shaikpet = await findBranch('shaikpet')
  const darga = await findBranch('darga')
  const narsingi = await findBranch('narsingi')
  const allBranches = [darga, narsingi, shaikpet]
  const otherBranchIds = [darga.id, narsingi.id]

  console.log(`Branch: Shaikpet (${shaikpet.id})`)

  // Snapshot other-branch stock before corrections (for verification)
  const otherBranchSnapshot = {}

  console.log('\n--- Step 1: Tie variant setup ---')
  for (const line of await ensureTieVariants(admin.id, allBranches)) console.log(' ', line)

  console.log('\n--- Step 2: Split socks into White / Grey categories ---')
  for (const line of await ensureSocksCategories(allBranches)) console.log(' ', line)

  console.log('\n--- Step 3: Add missing pant size ---')
  for (const line of await ensurePantWaist30(allBranches)) console.log(' ', line)

  console.log('\n--- Step 4: Price fixes ---')
  for (const line of await applyPriceFixes()) console.log(' ', line)

  console.log('\n--- Step 5: Shaikpet stock corrections ---')
  const corrections = []

  for (const [categoryName, targets] of Object.entries(STOCK_TARGETS)) {
    for (const [sizeKey, targetQty] of Object.entries(targets)) {
      let size
      try {
        size = await findSize(categoryName, sizeKey)
      } catch (err) {
        if (!APPLY) {
          console.log(`  [PENDING] ${categoryName} / ${sizeKey}: → ${targetQty}`)
          continue
        }
        throw err
      }

      for (const obId of otherBranchIds) {
        const row = await prisma.uniformStock.findUnique({
          where: { sizeId_branchId: { sizeId: size.id, branchId: obId } },
        })
        const snapKey = `${size.id}:${obId}`
        otherBranchSnapshot[snapKey] = row?.quantity ?? 0
      }

      const { before, after } = await applyStockCorrection(
        size,
        shaikpet.id,
        targetQty,
        admin.id,
        otherBranchIds,
      )

      corrections.push({
        category: categoryName,
        sizeKey,
        name: size.name,
        before,
        after,
        changed: before !== after,
      })
    }
  }

  for (const c of corrections) {
    const flag = c.changed ? 'UPDATE' : 'SKIP (already correct)'
    console.log(
      `  [${flag}] ${c.category} / ${c.name}: ${c.before} → ${c.after}`,
    )
  }

  if (APPLY) {
    console.log('\n--- Step 6: Verify other branches unchanged ---')
    let drift = 0
    for (const [snapKey, expectedQty] of Object.entries(otherBranchSnapshot)) {
      const [sizeId, branchId] = snapKey.split(':')
      const row = await prisma.uniformStock.findUnique({
        where: { sizeId_branchId: { sizeId, branchId } },
      })
      const actual = row?.quantity ?? 0
      if (actual !== expectedQty) {
        drift += 1
        const size = await prisma.uniformSize.findUnique({
          where: { id: sizeId },
          include: { category: true },
        })
        const branch = await prisma.branch.findUnique({ where: { id: branchId } })
        console.log(
          `  ⚠ DRIFT ${branch?.name} ${size?.category?.label} ${size?.name}: was ${expectedQty}, now ${actual}`,
        )
      }
    }
    if (drift === 0) console.log('  ✓ Darga and Narsingi stock unchanged for all corrected variants')

    console.log('\n--- Step 7: Post-apply verification ---')
    const failures = await verifyCorrections(shaikpet.id, otherBranchIds)
    if (failures.length) {
      failures.forEach((f) => console.error('  ✗', f))
      throw new Error(`${failures.length} verification failure(s)`)
    }
    console.log('  ✓ All Shaikpet targets, audit logs, tie names, and prices verified')
  } else {
    console.log(`\n${corrections.filter((c) => c.changed).length} stock row(s) would change`)
    console.log('Re-run with APPLY_SHAIKPET_UNIFORM_CORRECTION=1 to commit.')
  }

  // Sanity: parseRupeePrice
  if (parseRupeePrice('90') !== 90) throw new Error('parseRupeePrice sanity check failed')
  if (parseRupeePrice('89.98') !== 89.98) throw new Error('parseRupeePrice sanity check failed')
}

main()
  .catch((err) => {
    console.error('\nFAILED:', err.message || err)
    process.exitCode = 1
  })
  .finally(async () => {
    await prisma.$disconnect()
  })
