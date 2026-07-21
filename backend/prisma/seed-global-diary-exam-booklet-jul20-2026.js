/**
 * Global products — Diary (₹110) & Exam Booklet (₹130)
 * All classes (Nursery–Class 10), all branches (Darga, Narsingi, Shaikpet).
 *
 * Idempotent: upserts by catalogKey per ACADEMIC kit; skips stock overwrite if already seeded.
 *
 * Dry run:
 *   node prisma/seed-global-diary-exam-booklet-jul20-2026.js
 *
 * Apply:
 *   APPLY_GLOBAL_PRODUCTS=1 node prisma/seed-global-diary-exam-booklet-jul20-2026.js
 *
 * Verify only:
 *   POSTCHECK_ONLY=1 node prisma/seed-global-diary-exam-booklet-jul20-2026.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const APPLY = process.env.APPLY_GLOBAL_PRODUCTS === '1'
const POSTCHECK_ONLY = process.env.POSTCHECK_ONLY === '1'

const GRADES = { gte: -2, lte: 10 }
const BRANCH_CODES = ['NHS_DARGA', 'SVN_NARSINGI', 'NS_SHAIKPET']
const SEED_DATE = '20 Jul 2026'

const PRODUCTS = [
  {
    name: 'Diary',
    catalogKey: 'global_diary',
    label: 'Diary',
    price: 110,
    icon: 'edit_note',
    openingStock: { NHS_DARGA: 45, SVN_NARSINGI: 45, NS_SHAIKPET: 45 },
    logNote: `Initial stock seeding — Diary — global product — ${SEED_DATE}`,
  },
  {
    name: 'Exam Booklet',
    catalogKey: 'global_exam_booklet',
    label: 'Exam Booklet',
    price: 130,
    icon: 'edit_note',
    openingStock: { NHS_DARGA: 800, SVN_NARSINGI: 800, NS_SHAIKPET: 800 },
    logNote: `Initial stock seeding — Exam Booklet — global product — ${SEED_DATE}`,
  },
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function calcTone(qty, threshold = 50) {
  if (qty <= threshold * 0.2) return 'CRITICAL'
  if (qty <= threshold) return 'LOW'
  return 'NORMAL'
}

async function loadActor(client = prisma) {
  const actor = await client.user.findFirst({
    where: { role: 'SUPER_ADMIN', isActive: true },
    orderBy: { createdAt: 'asc' },
  })
  assert(actor, 'Active SUPER_ADMIN user not found for inventory logs')
  return actor
}

async function loadBranches(client = prisma) {
  const branches = await client.branch.findMany({
    where: { code: { in: BRANCH_CODES } },
    orderBy: { code: 'asc' },
  })
  assert(branches.length === BRANCH_CODES.length, `Expected ${BRANCH_CODES.length} branches, found ${branches.length}`)
  const byCode = Object.fromEntries(branches.map((b) => [b.code, b]))
  return { branches, byCode }
}

async function loadTargets(client = prisma) {
  const targets = []
  for (let grade = GRADES.gte; grade <= GRADES.lte; grade++) {
    const classes = await client.academicClass.findMany({
      where: { grade, section: 'A' },
      select: {
        grade: true,
        branchId: true,
        branch: { select: { code: true, name: true } },
        bookKits: { where: { kind: 'ACADEMIC' }, take: 1, select: { id: true } },
      },
      orderBy: { branchId: 'asc' },
    })
    for (const cls of classes) {
      const kitId = cls.bookKits[0]?.id
      if (!kitId) continue
      if (!BRANCH_CODES.includes(cls.branch.code)) continue
      targets.push({
        grade,
        kitId,
        branchId: cls.branchId,
        branchCode: cls.branch.code,
        branchName: cls.branch.name,
      })
    }
  }
  assert(targets.length > 0, 'No ACADEMIC kit targets found')
  return targets
}

async function hasSeedLog(client, bookItemId, branchId, logNote) {
  const count = await client.inventoryLog.count({
    where: {
      branchId,
      bookItemId,
      itemType: 'BOOK',
      changeType: 'ADJUSTMENT',
      notes: { contains: logNote },
    },
  })
  return count > 0
}

async function ensureProduct(product, targets, actor, dryRun) {
  const stats = { created: 0, updated: 0, stockSeeded: 0, logsCreated: 0, skipped: 0 }

  console.log(`\n--- ${product.name} (${product.catalogKey}) ---`)

  for (const target of targets) {
    const openingQty = product.openingStock[target.branchCode] ?? 0

    const existing = await prisma.bookKitItem.findFirst({
      where: { kitId: target.kitId, catalogKey: product.catalogKey },
      include: { bookStocks: { where: { branchId: target.branchId } } },
    })

    if (existing) {
      const stock = existing.bookStocks[0]
      const stockQty = stock?.quantity ?? 0
      console.log(
        `  grade ${target.grade} ${target.branchCode}: EXISTS item ${existing.id.slice(-6)} | stock ${stockQty} | price ₹${existing.price}`,
      )

      if (!dryRun) {
        await prisma.bookKitItem.update({
          where: { id: existing.id },
          data: {
            label: product.label,
            icon: product.icon,
            price: product.price,
            productType: 'VARIANT',
            isArchived: false,
          },
        })
        stats.updated++

        const needsStock = !stock || stockQty === 0
        const hasLog = stock ? await hasSeedLog(prisma, existing.id, target.branchId, product.logNote) : false

        if (needsStock && openingQty > 0) {
          const before = stockQty
          const after = openingQty
          await prisma.bookStock.upsert({
            where: { itemId_branchId: { itemId: existing.id, branchId: target.branchId } },
            create: {
              itemId: existing.id,
              branchId: target.branchId,
              quantity: after,
              tone: calcTone(after),
            },
            update: { quantity: after, tone: calcTone(after) },
          })
          stats.stockSeeded++

          if (!hasLog) {
            await prisma.inventoryLog.create({
              data: {
                branchId: target.branchId,
                itemType: 'BOOK',
                bookItemId: existing.id,
                changeType: 'ADJUSTMENT',
                quantityBefore: before,
                quantityAfter: after,
                quantityDelta: after - before,
                performedById: actor.id,
                notes: product.logNote,
              },
            })
            stats.logsCreated++
          }
        } else {
          stats.skipped++
        }
      } else {
        stats.updated++
        if (!stock || stockQty === 0) stats.stockSeeded++
      }
      continue
    }

    console.log(
      `  grade ${target.grade} ${target.branchCode}: CREATE | stock ${openingQty} | price ₹${product.price}`,
    )

    if (dryRun) {
      stats.created++
      stats.stockSeeded++
      stats.logsCreated++
      continue
    }

    const maxAgg = await prisma.bookKitItem.aggregate({
      where: { kitId: target.kitId },
      _max: { position: true },
    })
    const position = (maxAgg._max.position ?? -1) + 1

    const item = await prisma.bookKitItem.create({
      data: {
        kitId: target.kitId,
        catalogKey: product.catalogKey,
        label: product.label,
        icon: product.icon,
        price: product.price,
        setPrice: null,
        productType: 'VARIANT',
        position,
        isArchived: false,
      },
    })

    await prisma.bookStock.create({
      data: {
        itemId: item.id,
        branchId: target.branchId,
        quantity: openingQty,
        tone: calcTone(openingQty),
      },
    })

    await prisma.inventoryLog.create({
      data: {
        branchId: target.branchId,
        itemType: 'BOOK',
        bookItemId: item.id,
        changeType: 'ADJUSTMENT',
        quantityBefore: 0,
        quantityAfter: openingQty,
        quantityDelta: openingQty,
        performedById: actor.id,
        notes: product.logNote,
      },
    })

    stats.created++
    stats.stockSeeded++
    stats.logsCreated++
  }

  return stats
}

async function verifyProducts(byCode) {
  console.log('\n=== Post-check ===')

  for (const product of PRODUCTS) {
    const items = await prisma.bookKitItem.findMany({
      where: { catalogKey: product.catalogKey, isArchived: false },
      include: {
        kit: { include: { class: true } },
        bookStocks: { include: { branch: true } },
      },
    })

    const grades = new Set(items.map((i) => i.kit.class.grade))
    console.log(`\n${product.name}: ${items.length} active kit rows across ${grades.size} grades`)

    for (const code of BRANCH_CODES) {
      const branchId = byCode[code].id
      const branchItems = items.filter((i) =>
        i.bookStocks.some((s) => s.branchId === branchId),
      )
      const sample = branchItems.find((i) => i.kit.class.grade === 3)
        ?? branchItems.find((i) => i.kit.class.grade === -2)
        ?? branchItems[0]
      const stock = sample?.bookStocks.find((s) => s.branchId === branchId)
      const expected = product.openingStock[code]
      console.log(
        `  ${code}: ${branchItems.length} rows | sample grade ${sample?.kit.class.grade} stock ${stock?.quantity ?? 'N/A'} (expected ${expected}) | price ₹${Number(sample?.price ?? 0)}`,
      )
      assert(branchItems.length >= grades.size || branchItems.length > 0, `${product.name} missing rows at ${code}`)
      if (sample) {
        assert(Number(sample.price) === product.price, `${product.name} price mismatch at ${code}`)
        assert(Number(stock?.quantity ?? 0) === expected, `${product.name} stock mismatch at ${code}`)
      }
    }

    const logCount = await prisma.inventoryLog.count({
      where: {
        bookItemId: { in: items.map((i) => i.id) },
        notes: { contains: product.logNote },
      },
    })
    console.log(`  Seed logs: ${logCount}`)
    assert(logCount >= BRANCH_CODES.length, `${product.name} missing seed logs`)
  }

  // Spot-check order-flow grades: Nursery (-2), Class 3 (3), Class 8 (8)
  for (const grade of [-2, 3, 8]) {
    const dargaClass = await prisma.academicClass.findFirst({
      where: { grade, section: 'A', branch: { code: 'NHS_DARGA' } },
      include: {
        bookKits: {
          where: { kind: 'ACADEMIC' },
          include: {
            items: {
              where: {
                catalogKey: { in: PRODUCTS.map((p) => p.catalogKey) },
                isArchived: false,
              },
              include: { bookStocks: true },
            },
          },
        },
      },
    })
    const found = dargaClass?.bookKits[0]?.items?.map((i) => i.label) ?? []
    console.log(`  Order-flow grade ${grade} (Darga): ${found.join(', ') || 'NONE'}`)
    assert(found.length === PRODUCTS.length, `Grade ${grade} missing global products in ACADEMIC kit`)
  }

  console.log('\nVerification passed.')
}

async function main() {
  const url = process.env.DATABASE_URL || ''
  const target = url.includes('ep-small-art') ? 'PRODUCTION' : url.includes('ep-rough-rain') ? 'DEVELOPMENT' : 'UNKNOWN'
  console.log(`Mode: ${POSTCHECK_ONLY ? 'POSTCHECK' : APPLY ? 'APPLY' : 'DRY RUN'} | DB: ${target}`)

  const actor = await loadActor()
  const { byCode } = await loadBranches()
  const targets = await loadTargets()

  console.log(`Grades: ${GRADES.gte}..${GRADES.lte} | Targets: ${targets.length} kit×branch rows`)
  console.log(`Actor: ${actor.displayName ?? actor.email ?? actor.id}`)

  if (POSTCHECK_ONLY) {
    await verifyProducts(byCode)
    return
  }

  const allStats = {}
  for (const product of PRODUCTS) {
    allStats[product.name] = await ensureProduct(product, targets, actor, !APPLY)
  }

  console.log('\nSummary:')
  for (const [name, stats] of Object.entries(allStats)) {
    console.log(`  ${name}:`, stats)
  }

  if (!APPLY) {
    console.log('\nDry run passed. Re-run with APPLY_GLOBAL_PRODUCTS=1 to commit.')
    return
  }

  await verifyProducts(byCode)
  console.log('\nDone. Global Diary and Exam Booklet seeded.')
}

main()
  .catch((err) => {
    console.error('FAILED:', err.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
