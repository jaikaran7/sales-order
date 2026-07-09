/**
 * Darga branch corrections — 8 Jul 2026
 *
 * 1. G.Hariharan (#SKM-2026-10801): Pant Waist 34 → Waist 36 (+₹30), stock revert/deduct
 * 2. Syed Huzaif (#SKM-2026-10810): Chest 20→22, Shorts 11→12 (+₹40 total), stock revert/deduct
 * 3. B.Joshna Sree + B.Teja Sree (#GRP-2026-10059): payment date 7 Jul → 1 Jul 2026 (same time)
 *
 * Dry run:
 *   node prisma/correct-darga-uniform-exchange-and-date-jul8-2026.js
 *
 * Apply (dev first):
 *   APPLY_DARGA_JUL8_CORRECTION=1 node prisma/correct-darga-uniform-exchange-and-date-jul8-2026.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const APPLY = process.env.APPLY_DARGA_JUL8_CORRECTION === '1'

const BRANCH_CODE = 'NHS_DARGA'
const DAY_MS = 6 * 24 * 60 * 60 * 1000 // 7 Jul → 1 Jul

const HARIHARAN_ORDER = '#SKM-2026-10801'
const HARIHARAN_GROUP = '#GRP-2026-10055'
const HARIHARAN_OLD_TOTAL = 890
const HARIHARAN_NEW_TOTAL = 920
const HARIHARAN_GROUP_OLD = 970
const HARIHARAN_GROUP_NEW = 1000

const HUZAIF_ORDER = '#SKM-2026-10810'
const HUZAIF_OLD_TOTAL = 590
const HUZAIF_NEW_TOTAL = 630

const DATE_GROUP = '#GRP-2026-10059'
const DATE_ORDER_IDS = ['#SKM-2026-10838', '#SKM-2026-10839']
const TARGET_IST_DATE = '2026-07-01'

function money(value) {
  return Number(value ?? 0)
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function fmt(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium',
    hour12: true,
  })
}

function istDateOnly(value) {
  return new Date(value).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
}

function shiftSixDaysEarlier(value) {
  if (!value) return null
  return new Date(new Date(value).getTime() - DAY_MS)
}

function toneFor(quantity, threshold = 50) {
  if (quantity <= threshold * 0.2) return 'CRITICAL'
  if (quantity <= threshold) return 'LOW'
  return 'NORMAL'
}

async function findDargaBranch(client = prisma) {
  const branch = await client.branch.findFirst({
    where: { code: BRANCH_CODE, isActive: true, deletedAt: null, type: 'BRANCH' },
  })
  assert(branch, 'Darga branch not found')
  return branch
}

async function findSize(categoryName, code) {
  const category = await prisma.uniformCategory.findFirst({ where: { name: categoryName } })
  assert(category, `Category not found: ${categoryName}`)
  const size = await prisma.uniformSize.findFirst({
    where: { categoryId: category.id, code },
  })
  assert(size, `Size not found: ${categoryName} / ${code}`)
  return size
}

async function getStock(sizeId, branchId, client = prisma) {
  const stock = await client.uniformStock.findUnique({
    where: { sizeId_branchId: { sizeId, branchId } },
    include: { size: true },
  })
  assert(stock, `Stock row not found for size ${sizeId}`)
  return stock
}

async function loadContext() {
  const branch = await findDargaBranch()
  const superAdmin = await prisma.user.findFirst({
    where: { role: 'SUPER_ADMIN', isActive: true },
    orderBy: { createdAt: 'asc' },
  })
  assert(superAdmin, 'Active SUPER_ADMIN not found')

  const hariharan = await prisma.order.findUnique({
    where: { orderId: HARIHARAN_ORDER },
    include: {
      student: { include: { class: true } },
      items: { include: { uniformSize: true } },
      transactions: true,
      transactionGroup: { include: { orders: { include: { student: true } } } },
    },
  })
  assert(hariharan, `${HARIHARAN_ORDER} not found`)
  assert(hariharan.student?.name === 'G.Hariharan', `Student mismatch: ${hariharan.student?.name}`)

  const huzaif = await prisma.order.findUnique({
    where: { orderId: HUZAIF_ORDER },
    include: {
      student: true,
      items: { include: { uniformSize: true } },
      transactions: true,
    },
  })
  assert(huzaif, `${HUZAIF_ORDER} not found`)
  assert(huzaif.student?.name === 'Syed Huzaif', `Student mismatch: ${huzaif.student?.name}`)

  const dateOrders = await prisma.order.findMany({
    where: { orderId: { in: DATE_ORDER_IDS } },
    include: {
      student: { include: { class: true } },
      transactions: true,
      items: true,
      transactionGroup: true,
    },
    orderBy: { orderId: 'asc' },
  })
  assert(dateOrders.length === 2, `Expected 2 date-change orders, found ${dateOrders.length}`)

  const pant34 = await findSize('pant', 'Waist 34')
  const pant36 = await findSize('pant', 'Waist 36')
  const chest20 = await findSize('t_shirt', 'Chest 20')
  const chest22 = await findSize('t_shirt', 'Chest 22')
  const shorts11 = await findSize('shorts', '11')
  const shorts12 = await findSize('shorts', '12')

  const hariharanPantItem = hariharan.items.find(
    (i) => i.uniformSizeId === pant34.id || i.uniformSizeId === pant36.id || /pant/i.test(i.label),
  )
  assert(hariharanPantItem, 'Hariharan pant item not found')

  const huzaifShirtItem = huzaif.items.find(
    (i) => i.uniformSizeId === chest20.id || i.uniformSizeId === chest22.id || /t-shirt/i.test(i.label),
  )
  const huzaifShortsItem = huzaif.items.find(
    (i) => i.uniformSizeId === shorts11.id || i.uniformSizeId === shorts12.id || /shorts/i.test(i.label),
  )
  assert(huzaifShirtItem, 'Huzaif T-Shirt item not found')
  assert(huzaifShortsItem, 'Huzaif Shorts item not found')

  const stockPant34 = await getStock(pant34.id, branch.id)
  const stockPant36 = await getStock(pant36.id, branch.id)
  const stockChest20 = await getStock(chest20.id, branch.id)
  const stockChest22 = await getStock(chest22.id, branch.id)
  const stockShorts11 = await getStock(shorts11.id, branch.id)
  const stockShorts12 = await getStock(shorts12.id, branch.id)

  const dateGroup = dateOrders[0].transactionGroup
  assert(dateGroup?.groupRef === DATE_GROUP, `Group mismatch: ${dateGroup?.groupRef}`)

  const dateOrderDbIds = dateOrders.map((o) => o.id)
  const dateTransactions = await prisma.transaction.findMany({
    where: { orderId: { in: dateOrderDbIds } },
    orderBy: { createdAt: 'asc' },
  })
  const dateOrderItems = await prisma.orderItem.findMany({
    where: { orderId: { in: dateOrderDbIds } },
    orderBy: { createdAt: 'asc' },
  })

  const logWindowStart = new Date(dateOrders[0].createdAt.getTime() - 60_000)
  const logWindowEnd = new Date(dateOrders[1].createdAt.getTime() + 120_000)
  const dateInventoryLogs = await prisma.inventoryLog.findMany({
    where: {
      branchId: branch.id,
      createdAt: { gte: logWindowStart, lte: logWindowEnd },
      changeType: 'OUTGOING',
    },
    orderBy: { createdAt: 'asc' },
  })

  return {
    branch,
    superAdmin,
    hariharan,
    huzaif,
    dateOrders,
    dateGroup,
    dateTransactions,
    dateOrderItems,
    dateInventoryLogs,
    pant34,
    pant36,
    chest20,
    chest22,
    shorts11,
    shorts12,
    hariharanPantItem,
    huzaifShirtItem,
    huzaifShortsItem,
    stockPant34,
    stockPant36,
    stockChest20,
    stockChest22,
    stockShorts11,
    stockShorts12,
  }
}

function verifyContext(ctx) {
  const { hariharan, huzaif, dateOrders, pant34, pant36, chest20, chest22, shorts11, shorts12 } = ctx

  assert(money(hariharan.total) === HARIHARAN_OLD_TOTAL, `Hariharan total: ${hariharan.total}`)
  assert(money(hariharan.transactionGroup?.totalAmount) === HARIHARAN_GROUP_OLD, `Group total: ${hariharan.transactionGroup?.totalAmount}`)
  assert(ctx.hariharanPantItem.uniformSizeId === pant34.id, 'Hariharan pant not on Waist 34 yet')
  assert(money(ctx.hariharanPantItem.unitPrice) === money(pant34.price), 'Hariharan pant price mismatch')
  assert(money(pant36.price) - money(pant34.price) === 30, `Pant price delta not ₹30: ${pant36.price} - ${pant34.price}`)

  assert(money(huzaif.total) === HUZAIF_OLD_TOTAL, `Huzaif total: ${huzaif.total}`)
  assert(ctx.huzaifShirtItem.uniformSizeId === chest20.id, 'Huzaif shirt not on Chest 20 yet')
  assert(ctx.huzaifShortsItem.uniformSizeId === shorts11.id, 'Huzaif shorts not on 11 yet')
  assert(money(chest22.price) - money(chest20.price) === 20, 'Chest price delta not ₹20')
  assert(money(shorts12.price) - money(shorts11.price) === 20, 'Shorts price delta not ₹20')

  for (const order of dateOrders) {
    assert(istDateOnly(order.createdAt) === '2026-07-07', `${order.orderId} not on 7 Jul`)
  }
}

function hariharanPantPrice(ctx) {
  return ctx.hariharanPantItem.unitPrice
}

function printPrecheck(ctx) {
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log(`Branch: ${ctx.branch.name} (${ctx.branch.code})`)
  console.log('')

  console.log('── 1. G.Hariharan — Pant 34 → 36 ──')
  console.log(`Order: ${ctx.hariharan.orderId} | total ${ctx.hariharan.total} → ${HARIHARAN_NEW_TOTAL}`)
  console.log(`Group: ${ctx.hariharan.transactionGroup?.groupRef} | ${HARIHARAN_GROUP_OLD} → ${HARIHARAN_GROUP_NEW}`)
  console.log(`Pant item: ${ctx.hariharanPantItem.label} | ₹${ctx.hariharanPantItem.unitPrice} → ₹${ctx.pant36.price}`)
  console.log(`Stock Pant 34: ${ctx.stockPant34.quantity} → ${ctx.stockPant34.quantity + 1}`)
  console.log(`Stock Pant 36: ${ctx.stockPant36.quantity} → ${ctx.stockPant36.quantity - 1}`)

  console.log('\n── 2. Syed Huzaif — Chest 20→22, Shorts 11→12 ──')
  console.log(`Order: ${ctx.huzaif.orderId} | total ${ctx.huzaif.total} → ${HUZAIF_NEW_TOTAL}`)
  console.log(`Shirt: ${ctx.huzaifShirtItem.label} | ₹${ctx.huzaifShirtItem.unitPrice} → ₹${ctx.chest22.price}`)
  console.log(`Shorts: ${ctx.huzaifShortsItem.label} | ₹${ctx.huzaifShortsItem.unitPrice} → ₹${ctx.shorts12.price}`)
  console.log(`Stock Chest 20: ${ctx.stockChest20.quantity} → ${ctx.stockChest20.quantity + 1}`)
  console.log(`Stock Chest 22: ${ctx.stockChest22.quantity} → ${ctx.stockChest22.quantity - 1}`)
  console.log(`Stock Shorts 11: ${ctx.stockShorts11.quantity} → ${ctx.stockShorts11.quantity + 1}`)
  console.log(`Stock Shorts 12: ${ctx.stockShorts12.quantity} → ${ctx.stockShorts12.quantity - 1}`)

  console.log('\n── 3. Date change 7 Jul → 1 Jul (Joshna + Teja) ──')
  console.log(`Group: ${ctx.dateGroup.groupRef}`)
  for (const order of ctx.dateOrders) {
    console.log(`  ${order.orderId} | ${order.student?.name} | ${fmt(order.createdAt)} → ${fmt(shiftSixDaysEarlier(order.createdAt))}`)
  }
  console.log(`  Transactions: ${ctx.dateTransactions.length}`)
  console.log(`  Order items: ${ctx.dateOrderItems.length}`)
  console.log(`  Inventory logs: ${ctx.dateInventoryLogs.length}`)
}

async function adjustStock(tx, { branchId, sizeId, delta, superAdminId, notes }) {
  const stock = await tx.uniformStock.findUnique({
    where: { sizeId_branchId: { sizeId, branchId } },
    include: { size: true },
  })
  assert(stock, `Stock not found for adjustment: ${sizeId}`)
  const before = stock.quantity
  const after = before + delta
  assert(after >= 0, `Stock would go negative for ${stock.size.code}: ${before} + ${delta}`)

  await tx.uniformStock.update({
    where: { sizeId_branchId: { sizeId, branchId } },
    data: {
      quantity: after,
      tone: toneFor(after, stock.size.reorderThreshold ?? 50),
    },
  })

  await tx.inventoryLog.create({
    data: {
      branchId,
      itemType: 'UNIFORM',
      uniformSizeId: sizeId,
      changeType: 'ADJUSTMENT',
      quantityBefore: before,
      quantityAfter: after,
      quantityDelta: delta,
      performedById: superAdminId,
      notes,
    },
  })

  return { before, after }
}

async function applyCorrections(ctx) {
  const {
    branch,
    superAdmin,
    hariharan,
    huzaif,
    dateOrders,
    dateGroup,
    dateTransactions,
    dateOrderItems,
    dateInventoryLogs,
    pant36,
    pant34,
    chest22,
    chest20,
    shorts12,
    shorts11,
    hariharanPantItem,
    huzaifShirtItem,
    huzaifShortsItem,
  } = ctx

  await prisma.$transaction(async (tx) => {
    // ── 1. Hariharan pant exchange ──
    await tx.orderItem.update({
      where: { id: hariharanPantItem.id },
      data: {
        uniformSizeId: pant36.id,
        label: `Pant (${pant36.code})`,
        unitPrice: pant36.price,
        totalPrice: pant36.price,
      },
    })

    await tx.order.update({
      where: { id: hariharan.id },
      data: {
        subtotal: HARIHARAN_NEW_TOTAL,
        total: HARIHARAN_NEW_TOTAL,
        paidAmount: HARIHARAN_NEW_TOTAL,
        updatedAt: new Date(),
      },
    })

    await tx.transaction.update({
      where: { id: hariharan.transactions[0].id },
      data: {
        amount: HARIHARAN_NEW_TOTAL,
        notes: [
          hariharan.transactions[0].notes,
          `Size exchange: Pant Waist 34 → Waist 36. Order total ₹${HARIHARAN_OLD_TOTAL} → ₹${HARIHARAN_NEW_TOTAL}.`,
        ].filter(Boolean).join('\n'),
      },
    })

    const groupSplit = Array.isArray(hariharan.transactionGroup?.splitDetails)
      ? hariharan.transactionGroup.splitDetails
      : []
    const updatedSplit = groupSplit.map((row) => ({
      ...row,
      amount: HARIHARAN_GROUP_NEW,
    }))

    await tx.transactionGroup.update({
      where: { id: hariharan.transactionGroupId },
      data: {
        totalAmount: HARIHARAN_GROUP_NEW,
        splitDetails: updatedSplit.length ? updatedSplit : undefined,
      },
    })

    await adjustStock(tx, {
      branchId: branch.id,
      sizeId: pant34.id,
      delta: 1,
      superAdminId: superAdmin.id,
      notes: [
        'Order correction — size exchange',
        `Order: ${HARIHARAN_ORDER}`,
        'Student: G.Hariharan',
        'Pant Waist 34 returned to stock (+1)',
      ].join('\n'),
    })

    await adjustStock(tx, {
      branchId: branch.id,
      sizeId: pant36.id,
      delta: -1,
      superAdminId: superAdmin.id,
      notes: [
        'Order correction — size exchange',
        `Order: ${HARIHARAN_ORDER}`,
        'Student: G.Hariharan',
        'Pant Waist 36 issued (-1)',
      ].join('\n'),
    })

    // ── 2. Huzaif shirt + shorts exchange ──
    await tx.orderItem.update({
      where: { id: huzaifShirtItem.id },
      data: {
        uniformSizeId: chest22.id,
        label: `T-Shirt (${chest22.code})`,
        unitPrice: chest22.price,
        totalPrice: chest22.price,
      },
    })

    await tx.orderItem.update({
      where: { id: huzaifShortsItem.id },
      data: {
        uniformSizeId: shorts12.id,
        label: `Shorts (${shorts12.code})`,
        unitPrice: shorts12.price,
        totalPrice: shorts12.price,
      },
    })

    await tx.order.update({
      where: { id: huzaif.id },
      data: {
        subtotal: HUZAIF_NEW_TOTAL,
        total: HUZAIF_NEW_TOTAL,
        paidAmount: HUZAIF_NEW_TOTAL,
        updatedAt: new Date(),
      },
    })

    await tx.transaction.update({
      where: { id: huzaif.transactions[0].id },
      data: {
        amount: HUZAIF_NEW_TOTAL,
        notes: [
          huzaif.transactions[0].notes,
          `Size exchange: Chest 20→22, Shorts 11→12. Order total ₹${HUZAIF_OLD_TOTAL} → ₹${HUZAIF_NEW_TOTAL}.`,
        ].filter(Boolean).join('\n'),
      },
    })

    for (const { sizeId, delta, label } of [
      { sizeId: chest20.id, delta: 1, label: 'T-Shirt Chest 20 returned (+1)' },
      { sizeId: chest22.id, delta: -1, label: 'T-Shirt Chest 22 issued (-1)' },
      { sizeId: shorts11.id, delta: 1, label: 'Shorts 11 returned (+1)' },
      { sizeId: shorts12.id, delta: -1, label: 'Shorts 12 issued (-1)' },
    ]) {
      await adjustStock(tx, {
        branchId: branch.id,
        sizeId,
        delta,
        superAdminId: superAdmin.id,
        notes: [
          'Order correction — size exchange',
          `Order: ${HUZAIF_ORDER}`,
          'Student: Syed Huzaif',
          label,
        ].join('\n'),
      })
    }

    // ── 3. Date backdate Joshna + Teja group ──
    for (const order of dateOrders) {
      await tx.order.update({
        where: { id: order.id },
        data: {
          createdAt: shiftSixDaysEarlier(order.createdAt),
          paidAt: shiftSixDaysEarlier(order.paidAt),
          updatedAt: shiftSixDaysEarlier(order.updatedAt),
        },
      })
    }

    for (const row of dateTransactions) {
      await tx.transaction.update({
        where: { id: row.id },
        data: {
          createdAt: shiftSixDaysEarlier(row.createdAt),
          paidAt: shiftSixDaysEarlier(row.paidAt),
        },
      })
    }

    await tx.transactionGroup.update({
      where: { id: dateGroup.id },
      data: {
        createdAt: shiftSixDaysEarlier(dateGroup.createdAt),
        paidAt: shiftSixDaysEarlier(dateGroup.paidAt),
      },
    })

    for (const item of dateOrderItems) {
      await tx.orderItem.update({
        where: { id: item.id },
        data: { createdAt: shiftSixDaysEarlier(item.createdAt) },
      })
    }

    for (const log of dateInventoryLogs) {
      await tx.inventoryLog.update({
        where: { id: log.id },
        data: { createdAt: shiftSixDaysEarlier(log.createdAt) },
      })
    }

    const touchedSizeIds = [...new Set(dateInventoryLogs.map((l) => l.uniformSizeId).filter(Boolean))]
    for (const sizeId of touchedSizeIds) {
      const stock = await tx.uniformStock.findUnique({
        where: { sizeId_branchId: { sizeId, branchId: branch.id } },
      })
      if (stock) {
        await tx.uniformStock.update({
          where: { id: stock.id },
          data: { updatedAt: shiftSixDaysEarlier(stock.updatedAt) },
        })
      }
    }
  }, { maxWait: 15_000, timeout: 120_000 })
}

async function verifyPostChange(ctx) {
  const fresh = await loadContext()

  assert(money(fresh.hariharan.total) === HARIHARAN_NEW_TOTAL, `Hariharan total: ${fresh.hariharan.total}`)
  assert(money(fresh.hariharan.transactionGroup?.totalAmount) === HARIHARAN_GROUP_NEW, `Group total: ${fresh.hariharan.transactionGroup?.totalAmount}`)
  assert(fresh.hariharanPantItem.uniformSizeId === fresh.pant36.id, 'Hariharan pant still old size')
  assert(money(fresh.hariharanPantItem.unitPrice) === money(fresh.pant36.price), 'Hariharan pant price wrong')

  assert(money(fresh.huzaif.total) === HUZAIF_NEW_TOTAL, `Huzaif total: ${fresh.huzaif.total}`)
  assert(fresh.huzaifShirtItem.uniformSizeId === fresh.chest22.id, 'Huzaif shirt still old size')
  assert(fresh.huzaifShortsItem.uniformSizeId === fresh.shorts12.id, 'Huzaif shorts still old size')

  for (const order of fresh.dateOrders) {
    assert(istDateOnly(order.createdAt) === TARGET_IST_DATE, `${order.orderId} date: ${istDateOnly(order.createdAt)}`)
  }

  console.log('\nPost-change verification:')
  console.log(`  OK ${HARIHARAN_ORDER} total ₹${fresh.hariharan.total}, pant → ${fresh.pant36.code}`)
  console.log(`  OK ${HARIHARAN_GROUP} total ₹${fresh.hariharan.transactionGroup?.totalAmount}`)
  console.log(`  OK ${HUZAIF_ORDER} total ₹${fresh.huzaif.total}, shirt → ${fresh.chest22.code}, shorts → ${fresh.shorts12.code}`)
  for (const order of fresh.dateOrders) {
    console.log(`  OK ${order.orderId} | ${order.student?.name} | ${fmt(order.createdAt)}`)
  }
  console.log(`  OK Pant 34 stock: ${fresh.stockPant34.quantity}, Pant 36 stock: ${fresh.stockPant36.quantity}`)
  console.log(`  OK Chest 20 stock: ${fresh.stockChest20.quantity}, Chest 22 stock: ${fresh.stockChest22.quantity}`)
  console.log(`  OK Shorts 11 stock: ${fresh.stockShorts11.quantity}, Shorts 12 stock: ${fresh.stockShorts12.quantity}`)
}

async function main() {
  const ctx = await loadContext()
  verifyContext(ctx)
  printPrecheck(ctx)

  if (!APPLY) {
    console.log('\nDry run passed. Re-run with APPLY_DARGA_JUL8_CORRECTION=1 to commit.')
    return
  }

  await applyCorrections(ctx)
  await verifyPostChange(ctx)
  console.log('\nDone. All Darga corrections committed.')
}

main()
  .catch((err) => {
    console.error('FAILED:', err.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
