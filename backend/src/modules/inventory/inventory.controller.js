const prisma = require('../../services/prisma')
const { OPERATIONAL_BRANCH_FILTER } = require('../../utils/operationalBranch')
const cache = require('../../services/cache')
const { ok, created, notFound, serverError, badRequest, forbidden } = require('../../utils/response')
const { isTransientConnectionError, withDbRetry } = require('../../utils/dbRetry')
const { parseRupeePrice } = require('../../utils/money')
const { randomUUID } = require('crypto')

function branchFilter(query) {
  return query.branchId ? { branchId: query.branchId } : {}
}

function calcTone(qty, threshold = 50) {
  if (qty <= threshold * 0.2) return 'CRITICAL'
  if (qty <= threshold) return 'LOW'
  return 'NORMAL'
}

const SUPPORTED_CLASS_GRADE = { gte: -2, lte: 10 }
const OPENING_NOTES = 'Opening Entry'
const INVENTORY_TX_OPTS = { timeout: 30_000, maxWait: 10_000 }

function kitItemsInclude(bf) {
  return {
    include: {
      subItems: { where: { isActive: true }, orderBy: { position: 'asc' } },
      bookStocks: {
        where: bf.branchId ? { branchId: bf.branchId } : {},
        select: { quantity: true, tone: true, branchId: true },
      },
    },
    orderBy: { position: 'asc' },
  }
}

/** API keeps `bookKit` = ACADEMIC only; notebook bundles live on `notebookBookKit`. */
function mapClassBooksResponse(cls) {
  const kits = cls.bookKits ?? []
  const academic = kits.find((k) => k.kind === 'ACADEMIC') ?? null
  const notebooks = kits.find((k) => k.kind === 'NOTEBOOKS') ?? null
  const { bookKits, ...rest } = cls
  return { ...rest, bookKit: academic, notebookBookKit: notebooks }
}

function toDbProductType(productType) {
  if (productType === 'BUNDLE') return 'SET'
  if (productType === 'VARIANT') return 'VARIANT'
  if (productType === 'SET') return 'SET'
  if (productType === 'INDIVIDUAL') return 'SET'
  return 'SET'
}

function sanitizeSubItems(subItems = []) {
  return subItems
    .filter((s) => String(s?.label ?? '').trim())
    .map((s, i) => ({
      label: String(s.label).trim(),
      price: Number(s.price ?? 0),
      quantity: Number(s.quantity ?? 0),
      position: i,
    }))
}

function canArchiveOrRestoreProduct(user) {
  if (!user) return false
  if (user.role === 'SUPER_ADMIN') return true
  return true
}

async function getKpis(req, res) {
  try {
    const bf = branchFilter(req.query)
    const cacheKey = `inventory:kpis:${req.query.branchId || 'all'}`
    const cached = cache.get(cacheKey)
    if (cached) return ok(res, cached)

    const [booksTotal, uniformsTotal] = await Promise.all([
      prisma.bookStock.aggregate({
        _sum: { quantity: true },
        where: {
          ...bf,
          item: { kit: { class: { grade: SUPPORTED_CLASS_GRADE } } },
        },
      }),
      prisma.uniformStock.aggregate({ _sum: { quantity: true }, where: bf }),
    ])

    const data = {
      booksStock: Number(booksTotal._sum.quantity || 0),
      uniformsStock: Number(uniformsTotal._sum.quantity || 0),
    }
    cache.set(cacheKey, data, cache.TTL.KPI)
    return ok(res, data)
  } catch {
    return serverError(res)
  }
}

async function listBooks(req, res) {
  try {
    const bf = branchFilter(req.query)
    const cacheKey = `inventory:books:${req.query.branchId || 'all'}`
    const cached = cache.get(cacheKey)
    if (cached) return ok(res, cached)

    const classesRaw = await prisma.academicClass.findMany({
      where: {
        ...(bf.branchId ? { branchId: bf.branchId } : {}),
        grade: { gte: -2, lte: 10 },
      },
      orderBy: [{ grade: 'asc' }, { section: 'asc' }],
      include: {
        bookKits: {
          include: {
            items: kitItemsInclude(bf),
          },
          orderBy: { kind: 'asc' },
        },
      },
    })
    const classes = classesRaw.map(mapClassBooksResponse)
    cache.set(cacheKey, classes, cache.TTL.SHORT)
    return ok(res, classes)
  } catch {
    return serverError(res)
  }
}

async function getBookKit(req, res) {
  try {
    const bf = branchFilter(req.query)
    const kit = await prisma.bookKit.findUnique({
      where: { id: req.params.kitId },
      include: {
        class: true,
        items: {
          include: {
            subItems: { where: { isActive: true }, orderBy: { position: 'asc' } },
            bookStocks: {
              where: bf.branchId ? { branchId: bf.branchId } : {},
            },
          },
          orderBy: { position: 'asc' },
        },
      },
    })
    if (!kit) return notFound(res, 'Kit not found')
    return ok(res, kit)
  } catch {
    return serverError(res)
  }
}

async function updateBookStock(req, res) {
  try {
    const { branchId, quantity, notes, changeType = 'ADJUSTMENT' } = req.body
    if (!branchId || quantity === undefined) return badRequest(res, 'branchId and quantity are required')

    const existing = await prisma.bookStock.findUnique({
      where: { itemId_branchId: { itemId: req.params.kitId, branchId } },
    })

    const tone = calcTone(quantity)

    let stock
    if (existing) {
      const before = existing.quantity
      stock = await prisma.bookStock.update({
        where: { itemId_branchId: { itemId: req.params.kitId, branchId } },
        data: { quantity, tone },
      })
      await prisma.inventoryLog.create({
        data: {
          branchId,
          itemType: 'BOOK',
          bookItemId: req.params.kitId,
          changeType,
          quantityBefore: before,
          quantityAfter: quantity,
          quantityDelta: quantity - before,
          performedById: req.user.id,
          notes,
        },
      })
    } else {
      stock = await prisma.bookStock.create({
        data: { itemId: req.params.kitId, branchId, quantity, tone },
      })
    }

    cache.delByPrefix(`inventory:kpis`)
    cache.delByPrefix(`inventory:books`)
    cache.delByPrefix(`branch:${branchId}`)
    return ok(res, stock)
  } catch {
    return serverError(res)
  }
}

// Bulk adjust multiple book items in one class at once — Super Admin only
async function bulkAdjustBookStock(req, res) {
  try {
    const { branchId, mode, reason, items } = req.body
    // items: [{ bookItemId, delta }]
    if (!branchId || !mode || !Array.isArray(items) || items.length === 0) {
      return badRequest(res, 'branchId, mode, and items[] are required')
    }
    if ((mode === 'deduct' || mode === 'override') && !reason) {
      return badRequest(res, 'Reason is required for deduct and override modes')
    }

    const changeType = mode === 'override' ? 'ADJUSTMENT' : mode === 'deduct' ? 'OUTGOING' : 'INCOMING'

    const results = await prisma.$transaction(
      items.map(({ bookItemId, delta }) => {
        // We need current qty first — done outside transaction per item
        return prisma.bookStock.upsert({
          where: { itemId_branchId: { itemId: bookItemId, branchId } },
          create: { itemId: bookItemId, branchId, quantity: Math.max(delta, 0), tone: calcTone(Math.max(delta, 0)) },
          update: {},
        })
      }),
    )

    // Fetch current stocks then apply deltas
    const stockMap = {}
    const existing = await prisma.bookStock.findMany({
      where: { branchId, itemId: { in: items.map((i) => i.bookItemId) } },
    })
    existing.forEach((s) => { stockMap[s.itemId] = s.quantity })

    const updates = await Promise.all(
      items.map(async ({ bookItemId, delta }) => {
        const before = stockMap[bookItemId] ?? 0
        const after =
          mode === 'add' ? before + delta :
          mode === 'deduct' ? Math.max(before - delta, 0) :
          delta // override

        const tone = calcTone(after)

        const stock = await prisma.bookStock.upsert({
          where: { itemId_branchId: { itemId: bookItemId, branchId } },
          create: { itemId: bookItemId, branchId, quantity: after, tone },
          update: { quantity: after, tone },
        })

        await prisma.inventoryLog.create({
          data: {
            branchId,
            itemType: 'BOOK',
            bookItemId,
            changeType,
            quantityBefore: before,
            quantityAfter: after,
            quantityDelta: after - before,
            performedById: req.user.id,
            notes: reason || null,
          },
        })

        return { bookItemId, before, after, stock }
      }),
    )

    cache.delByPrefix('inventory:kpis')
    cache.delByPrefix('inventory:books')
    cache.delByPrefix(`branch:${branchId}`)
    return ok(res, updates)
  } catch (err) {
    console.error(err)
    return serverError(res)
  }
}

// ─── Product (BookKitItem) CRUD ───────────────────────────────────────────────

async function createProduct(req, res) {
  try {
    const {
      kitId,
      classGrade,
      label,
      icon,
      price,
      setPrice,
      productType,
      position,
      subItems,
      openingStocks = {},
      catalogKey: requestCatalogKey,
    } = req.body
    if (!label || price === undefined) return badRequest(res, 'label and price are required')

    let targetKits = []
    if (classGrade !== undefined && classGrade !== null) {
      const grade = Number(classGrade)
      if (!Number.isFinite(grade)) return badRequest(res, 'classGrade must be a number')
      const classes = await prisma.academicClass.findMany({
        where: { grade, section: 'A' },
        select: {
          id: true,
          branchId: true,
          bookKits: { where: { kind: 'ACADEMIC' }, take: 1, select: { id: true } },
        },
        orderBy: { branchId: 'asc' },
      })
      targetKits = classes
        .filter((cls) => cls.bookKits[0]?.id)
        .map((cls) => ({ kitId: cls.bookKits[0].id, branchId: cls.branchId }))
    } else if (kitId) {
      const kit = await prisma.bookKit.findUnique({
        where: { id: kitId },
        include: { class: { select: { grade: true } } },
      })
      if (!kit) return notFound(res, 'Kit not found')
      const classes = await prisma.academicClass.findMany({
        where: { grade: kit.class.grade, section: 'A' },
        select: {
          id: true,
          branchId: true,
          bookKits: { where: { kind: 'ACADEMIC' }, take: 1, select: { id: true } },
        },
      })
      targetKits = classes
        .filter((cls) => cls.bookKits[0]?.id)
        .map((cls) => ({ kitId: cls.bookKits[0].id, branchId: cls.branchId }))
    }
    if (!targetKits.length) return badRequest(res, 'No class kits found for this class')

    const rows = await withDbRetry(() => prisma.$transaction(async (tx) => {
      const catalogKey = requestCatalogKey || randomUUID()
      const payloadSubItems = sanitizeSubItems(subItems)
      const createdRows = []

      for (const target of targetKits) {
        // If caller provides a catalogKey, treat create as an upsert per-kit to avoid duplicates.
        const existing = requestCatalogKey
          ? await tx.bookKitItem.findFirst({ where: { kitId: target.kitId, catalogKey } })
          : null

        const data = {
          kitId: target.kitId,
          catalogKey,
          label: String(label).trim(),
          icon: icon ?? 'menu_book',
          price: Number(price),
          setPrice: setPrice != null && setPrice !== '' ? Number(setPrice) : null,
          productType: toDbProductType(productType),
          position: position ?? 0,
          isArchived: false,
        }

        let item
        if (existing) {
          if (payloadSubItems) {
            await tx.bookKitSubItem.deleteMany({ where: { kitItemId: existing.id } })
            if (payloadSubItems.length) {
              await tx.bookKitSubItem.createMany({
                data: payloadSubItems.map((s) => ({ ...s, kitItemId: existing.id })),
              })
            }
          }
          item = await tx.bookKitItem.update({
            where: { id: existing.id },
            data,
            include: { subItems: true },
          })
        } else {
          item = await tx.bookKitItem.create({
            data: {
              ...data,
              subItems: payloadSubItems.length ? { create: payloadSubItems } : undefined,
            },
            include: { subItems: true },
          })
        }

        const openingQty = Math.max(0, Number(openingStocks[target.branchId] ?? 0))
        // Ensure a stock row exists; if it exists, keep its current reserved but overwrite quantity only when creating.
        await tx.bookStock.upsert({
          where: { itemId_branchId: { itemId: item.id, branchId: target.branchId } },
          create: { itemId: item.id, branchId: target.branchId, quantity: openingQty, tone: calcTone(openingQty) },
          update: {},
        })

        createdRows.push(item)
      }
      return createdRows
    }, INVENTORY_TX_OPTS))
    cache.delByPrefix('inventory:books')
    cache.delByPrefix('inventory:kpis')
    return created(res, rows[0])
  } catch (err) {
    console.error('[createProduct]', err)
    if (isTransientConnectionError(err)) {
      return serverError(res, 'Database is temporarily busy. Please try again in a few seconds.')
    }
    return serverError(res)
  }
}

async function updateProduct(req, res) {
  try {
    const { label, icon, price, setPrice, productType, position, subItems } = req.body
    const item = await prisma.bookKitItem.findUnique({ where: { id: req.params.itemId } })
    if (!item) return notFound(res, 'Product not found')

    const updated = await withDbRetry(() => prisma.$transaction(async (tx) => {
      const targetIds = item.catalogKey
        ? (await tx.bookKitItem.findMany({ where: { catalogKey: item.catalogKey }, select: { id: true } })).map((r) => r.id)
        : [req.params.itemId]

      const payloadSubItems = subItems !== undefined ? sanitizeSubItems(subItems) : null
      for (const targetId of targetIds) {
        if (payloadSubItems !== null) {
          await tx.bookKitSubItem.deleteMany({ where: { kitItemId: targetId } })
          if (payloadSubItems.length) {
            await tx.bookKitSubItem.createMany({
              data: payloadSubItems.map((s) => ({ ...s, kitItemId: targetId })),
            })
          }
        }
        await tx.bookKitItem.update({
          where: { id: targetId },
          data: {
            ...(label !== undefined && { label }),
            ...(icon !== undefined && { icon }),
            ...(price !== undefined && { price: Number(price) }),
            ...(setPrice !== undefined && { setPrice: setPrice == null || setPrice === '' ? null : Number(setPrice) }),
            ...(productType !== undefined && { productType: toDbProductType(productType) }),
            ...(position !== undefined && { position }),
          },
        })
      }
      return tx.bookKitItem.findUnique({
        where: { id: req.params.itemId },
        include: { subItems: { where: { isActive: true }, orderBy: { position: 'asc' } } },
      })
    }, INVENTORY_TX_OPTS))

    cache.delByPrefix('inventory:books')
    return ok(res, updated)
  } catch (err) {
    console.error('[updateProduct]', err)
    if (isTransientConnectionError(err)) {
      return serverError(res, 'Database is temporarily busy. Please try again in a few seconds.')
    }
    return serverError(res)
  }
}

async function archiveProduct(req, res) {
  try {
    if (!canArchiveOrRestoreProduct(req.user)) {
      return forbidden(res, 'Only Super Admin or permitted Senior Admin can archive products')
    }

    const item = await prisma.bookKitItem.findUnique({ where: { id: req.params.itemId } })
    if (!item) return notFound(res, 'Product not found')
    if (item.catalogKey) {
      await prisma.bookKitItem.updateMany({ where: { catalogKey: item.catalogKey }, data: { isArchived: true } })
    } else {
      await prisma.bookKitItem.update({ where: { id: req.params.itemId }, data: { isArchived: true } })
    }
    cache.delByPrefix('inventory:books')
    return ok(res, { archived: true })
  } catch {
    return serverError(res)
  }
}

async function restoreProduct(req, res) {
  try {
    if (!canArchiveOrRestoreProduct(req.user)) {
      return forbidden(res, 'Only Super Admin or permitted Senior Admin can restore products')
    }

    const item = await prisma.bookKitItem.findUnique({ where: { id: req.params.itemId } })
    if (!item) return notFound(res, 'Product not found')
    if (item.catalogKey) {
      await prisma.bookKitItem.updateMany({ where: { catalogKey: item.catalogKey }, data: { isArchived: false } })
    } else {
      await prisma.bookKitItem.update({ where: { id: req.params.itemId }, data: { isArchived: false } })
    }
    cache.delByPrefix('inventory:books')
    return ok(res, { restored: true })
  } catch {
    return serverError(res)
  }
}

async function listUniformCategories(req, res) {
  try {
    const cacheKey = 'uniform:categories'
    const cached = cache.get(cacheKey)
    if (cached) return ok(res, cached)

    const cats = await prisma.uniformCategory.findMany({
      where: { isActive: true },
      orderBy: { position: 'asc' },
    })
    cache.set(cacheKey, cats, cache.TTL.LONG)
    return ok(res, cats)
  } catch {
    return serverError(res)
  }
}

async function listUniforms(req, res) {
  try {
    const { categoryId, branchId } = req.query
    const where = {}
    if (categoryId) where.categoryId = categoryId

    const sizes = await prisma.uniformSize.findMany({
      where: {
        ...where,
        category: { isActive: true },
      },
      orderBy: { position: 'asc' },
      include: {
        category: { select: { id: true, name: true, label: true, icon: true, position: true } },
        uniformStocks: {
          where: branchId ? { branchId } : {},
          select: { quantity: true, tone: true, branchId: true },
        },
      },
    })
    return ok(res, sizes)
  } catch {
    return serverError(res)
  }
}

function toUniformCategoryName(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
}

function sanitizeUniformSizes(sizes = []) {
  return sizes
    .filter((s) => String(s?.label ?? s?.name ?? '').trim())
    .map((s, idx) => {
      const label = String(s.label ?? s.name).trim()
      return {
        id: s.id,
        code: String(s.code ?? label).trim(),
        name: label,
        price: parseRupeePrice(s.price),
        reorderThreshold: Number(s.reorderThreshold ?? 50),
        position: Number(s.position ?? idx),
        openingStocks: s.openingStocks ?? {},
      }
    })
}

async function createUniformProduct(req, res) {
  try {
    const { label, icon = 'apparel', sizes = [] } = req.body
    if (!label) return badRequest(res, 'label is required')
    const payloadSizes = sanitizeUniformSizes(sizes)
    if (!payloadSizes.length) return badRequest(res, 'At least one size variant is required')

    const existing = await prisma.uniformCategory.findFirst({
      where: {
        OR: [{ label: String(label).trim() }, { name: toUniformCategoryName(label) }],
      },
      select: { id: true },
    })
    if (existing) return badRequest(res, 'Uniform product already exists')

    const branches = await prisma.branch.findMany({
      where: OPERATIONAL_BRANCH_FILTER,
      select: { id: true },
    })

    const created = await prisma.$transaction(async (tx) => {
      const category = await tx.uniformCategory.create({
        data: {
          name: toUniformCategoryName(label) || randomUUID(),
          label: String(label).trim(),
          icon,
          position: 0,
        },
      })

      for (const size of payloadSizes) {
        const createdSize = await tx.uniformSize.create({
          data: {
            categoryId: category.id,
            code: size.code,
            name: size.name,
            price: size.price,
            reorderThreshold: size.reorderThreshold,
            position: size.position,
          },
        })
        for (const branch of branches) {
          const openingQty = Math.max(0, Number(size.openingStocks?.[branch.id] ?? 0))
          await tx.uniformStock.create({
            data: {
              sizeId: createdSize.id,
              branchId: branch.id,
              quantity: openingQty,
              tone: calcTone(openingQty, size.reorderThreshold),
            },
          })
          await tx.inventoryLog.create({
            data: {
              branchId: branch.id,
              itemType: 'UNIFORM',
              uniformSizeId: createdSize.id,
              changeType: 'ADJUSTMENT',
              quantityBefore: 0,
              quantityAfter: openingQty,
              quantityDelta: openingQty,
              performedById: req.user.id,
              notes: OPENING_NOTES,
            },
          })
        }
      }
      return category
    })

    cache.delByPrefix('uniform:categories')
    cache.delByPrefix('inventory:kpis')
    return ok(res, created, 201)
  } catch {
    return serverError(res)
  }
}

async function updateUniformProduct(req, res) {
  try {
    const category = await prisma.uniformCategory.findUnique({ where: { id: req.params.categoryId } })
    if (!category) return notFound(res, 'Uniform product not found')

    const { label, icon = category.icon, sizes = [] } = req.body
    const payloadSizes = sanitizeUniformSizes(sizes)
    if (!payloadSizes.length) return badRequest(res, 'At least one size variant is required')

    await prisma.$transaction(async (tx) => {
      await tx.uniformCategory.update({
        where: { id: category.id },
        data: {
          label: String(label ?? category.label).trim(),
          icon,
          name: toUniformCategoryName(String(label ?? category.label).trim()) || category.name,
        },
      })

      const existingSizes = await tx.uniformSize.findMany({
        where: { categoryId: category.id },
        select: { id: true, reorderThreshold: true },
      })
      const existingIds = new Set(existingSizes.map((s) => s.id))
      const payloadIds = new Set(payloadSizes.filter((s) => s.id).map((s) => s.id))
      const removeIds = existingSizes.filter((s) => !payloadIds.has(s.id)).map((s) => s.id)

      if (removeIds.length) {
        await tx.uniformStock.deleteMany({ where: { sizeId: { in: removeIds } } })
        await tx.uniformSize.deleteMany({ where: { id: { in: removeIds } } })
      }

      const branches = await tx.branch.findMany({
        where: OPERATIONAL_BRANCH_FILTER,
        select: { id: true },
      })

      for (let idx = 0; idx < payloadSizes.length; idx += 1) {
        const size = payloadSizes[idx]
        if (size.id && existingIds.has(size.id)) {
          await tx.uniformSize.update({
            where: { id: size.id },
            data: {
              code: size.code,
              name: size.name,
              price: size.price,
              reorderThreshold: size.reorderThreshold,
              position: idx,
            },
          })
        } else {
          const createdSize = await tx.uniformSize.create({
            data: {
              categoryId: category.id,
              code: size.code,
              name: size.name,
              price: size.price,
              reorderThreshold: size.reorderThreshold,
              position: idx,
            },
          })
          for (const branch of branches) {
            const openingQty = Math.max(0, Number(size.openingStocks?.[branch.id] ?? 0))
            await tx.uniformStock.create({
              data: {
                sizeId: createdSize.id,
                branchId: branch.id,
                quantity: openingQty,
                tone: calcTone(openingQty, size.reorderThreshold),
              },
            })
            await tx.inventoryLog.create({
              data: {
                branchId: branch.id,
                itemType: 'UNIFORM',
                uniformSizeId: createdSize.id,
                changeType: 'ADJUSTMENT',
                quantityBefore: 0,
                quantityAfter: openingQty,
                quantityDelta: openingQty,
                performedById: req.user.id,
                notes: OPENING_NOTES,
              },
            })
          }
        }
      }
    })

    cache.delByPrefix('uniform:categories')
    cache.delByPrefix('inventory:kpis')
    return ok(res, { updated: true })
  } catch {
    return serverError(res)
  }
}

async function bulkAdjustUniformStock(req, res) {
  try {
    const { branchId, mode, reason, items } = req.body
    if (!branchId || !mode || !Array.isArray(items) || items.length === 0) {
      return badRequest(res, 'branchId, mode, and items[] are required')
    }
    if ((mode === 'deduct' || mode === 'override') && !reason) {
      return badRequest(res, 'Reason is required for deduct and override modes')
    }
    const changeType = mode === 'override' ? 'ADJUSTMENT' : mode === 'deduct' ? 'OUTGOING' : 'INCOMING'

    const updates = await Promise.all(
      items.map(async ({ sizeId, delta }) => {
        const val = Number(delta ?? 0)
        if (!Number.isFinite(val) || val <= 0) {
          throw new Error('INVALID_UNIFORM_STOCK_QUANTITY')
        }
        const current = await prisma.uniformStock.findUnique({
          where: { sizeId_branchId: { sizeId, branchId } },
        })
        const before = current?.quantity ?? 0
        if (mode === 'deduct' && val > before) {
          throw new Error('INSUFFICIENT_UNIFORM_STOCK')
        }
        const after =
          mode === 'add' ? before + val :
          mode === 'deduct' ? before - val :
          val

        const size = await prisma.uniformSize.findUnique({ where: { id: sizeId }, select: { reorderThreshold: true } })
        const tone = calcTone(after, size?.reorderThreshold ?? 50)
        await prisma.uniformStock.upsert({
          where: { sizeId_branchId: { sizeId, branchId } },
          create: { sizeId, branchId, quantity: after, tone },
          update: { quantity: after, tone },
        })
        await prisma.inventoryLog.create({
          data: {
            branchId,
            itemType: 'UNIFORM',
            uniformSizeId: sizeId,
            changeType,
            quantityBefore: before,
            quantityAfter: after,
            quantityDelta: after - before,
            performedById: req.user.id,
            notes: reason || null,
          },
        })
        return { sizeId, before, after }
      }),
    )
    cache.delByPrefix('inventory:kpis')
    cache.delByPrefix(`branch:${branchId}`)
    return ok(res, updates)
  } catch (err) {
    if (err?.message === 'INVALID_UNIFORM_STOCK_QUANTITY') {
      return badRequest(res, 'Quantity must be greater than 0')
    }
    if (err?.message === 'INSUFFICIENT_UNIFORM_STOCK') {
      return badRequest(res, 'Insufficient stock for deduction')
    }
    return serverError(res)
  }
}

async function updateUniformStock(req, res) {
  try {
    const { branchId, quantity, notes, changeType = 'ADJUSTMENT' } = req.body
    if (!branchId || quantity === undefined) return badRequest(res, 'branchId and quantity are required')
    const requestedQty = Number(quantity)
    if (!Number.isFinite(requestedQty) || requestedQty < 0) {
      return badRequest(res, 'Quantity cannot be negative')
    }

    const size = await prisma.uniformSize.findUnique({ where: { id: req.params.sizeId } })
    if (!size) return notFound(res, 'Uniform size not found')

    const tone = calcTone(requestedQty, size.reorderThreshold)

    const existing = await prisma.uniformStock.findUnique({
      where: { sizeId_branchId: { sizeId: req.params.sizeId, branchId } },
    })

    let stock
    if (existing) {
      const before = existing.quantity
      if (changeType === 'INCOMING' && requestedQty <= before) {
        return badRequest(res, 'Add stock must increase the current stock')
      }
      if (changeType === 'OUTGOING' && requestedQty >= before) {
        return badRequest(res, 'Manual deduction must reduce the current stock')
      }
      stock = await prisma.uniformStock.update({
        where: { sizeId_branchId: { sizeId: req.params.sizeId, branchId } },
        data: { quantity: requestedQty, tone },
      })
      await prisma.inventoryLog.create({
        data: {
          branchId,
          itemType: 'UNIFORM',
          uniformSizeId: req.params.sizeId,
          changeType,
          quantityBefore: before,
          quantityAfter: requestedQty,
          quantityDelta: requestedQty - before,
          performedById: req.user.id,
          notes,
        },
      })
    } else {
      stock = await prisma.uniformStock.create({
        data: { sizeId: req.params.sizeId, branchId, quantity: requestedQty, tone },
      })
    }

    cache.delByPrefix('inventory:kpis')
    cache.delByPrefix(`branch:${branchId}`)
    return ok(res, stock)
  } catch {
    return serverError(res)
  }
}

async function listAccessoryGroups(req, res) {
  try {
    const { branchId } = req.query
    const cacheKey = `accessories:groups:${branchId || 'all'}`
    const cached = cache.get(cacheKey)
    if (cached) return ok(res, cached)

    const groups = await prisma.accessoryGroup.findMany({
      orderBy: { position: 'asc' },
      include: {
        accessories: {
          where: { isActive: true },
          orderBy: { name: 'asc' },
          include: {
            accessoryStocks: {
              where: branchId ? { branchId } : {},
              select: { quantity: true, tone: true, branchId: true },
            },
          },
        },
      },
    })
    cache.set(cacheKey, groups, cache.TTL.LONG)
    return ok(res, groups)
  } catch {
    return serverError(res)
  }
}

async function updateAccessoryStock(req, res) {
  try {
    const { branchId, quantity, notes, changeType = 'ADJUSTMENT' } = req.body
    if (!branchId || quantity === undefined) return badRequest(res, 'branchId and quantity are required')

    const accessory = await prisma.accessory.findUnique({ where: { id: req.params.accessoryId } })
    if (!accessory) return notFound(res, 'Accessory not found')

    const tone = calcTone(quantity, 20)

    const existing = await prisma.accessoryStock.findUnique({
      where: { accessoryId_branchId: { accessoryId: req.params.accessoryId, branchId } },
    })

    let stock
    if (existing) {
      const before = existing.quantity
      stock = await prisma.accessoryStock.update({
        where: { accessoryId_branchId: { accessoryId: req.params.accessoryId, branchId } },
        data: { quantity, tone },
      })
      await prisma.inventoryLog.create({
        data: {
          branchId,
          itemType: 'ACCESSORY',
          accessoryId: req.params.accessoryId,
          changeType,
          quantityBefore: before,
          quantityAfter: quantity,
          quantityDelta: quantity - before,
          performedById: req.user.id,
          notes,
        },
      })
    } else {
      stock = await prisma.accessoryStock.create({
        data: { accessoryId: req.params.accessoryId, branchId, quantity, tone },
      })
    }

    cache.delByPrefix('accessories:groups')
    return ok(res, stock)
  } catch {
    return serverError(res)
  }
}

async function getLogs(req, res) {
  try {
    const { branchId, itemType, itemId, catalogKey, classGrade, limit = 50, changeType } = req.query
    const where = {}
    if (branchId) where.branchId = branchId
    if (itemType) where.itemType = itemType
    if (changeType) where.changeType = changeType
    if (itemType === 'BOOK' && catalogKey) {
      const linked = await prisma.bookKitItem.findMany({
        where: { catalogKey: String(catalogKey) },
        select: { id: true },
      })
      const ids = linked.map((r) => r.id)
      if (!ids.length) return ok(res, [])
      where.bookItemId = { in: ids }
    } else if (itemType === 'BOOK' && itemId) {
      where.bookItemId = itemId
    }
    if (itemType === 'UNIFORM' && itemId) where.uniformSizeId = itemId
    if (itemType === 'ACCESSORY' && itemId) where.accessoryId = itemId
    if (itemType === 'BOOK' && classGrade !== undefined) {
      where.bookItem = { kit: { class: { grade: Number(classGrade) } } }
    }

    const logs = await prisma.inventoryLog.findMany({
      where,
      orderBy: [{ eventDate: 'desc' }, { createdAt: 'desc' }],
      take: parseInt(limit),
      include: {
        bookItem: { select: { id: true, label: true } },
        uniformSize: { select: { id: true, name: true } },
        accessory: { select: { id: true, name: true } },
        performedBy: { select: { displayName: true, username: true } },
        branch: { select: { name: true, code: true } },
      },
    })
    return ok(res, logs)
  } catch {
    return serverError(res)
  }
}

module.exports = {
  getKpis,
  listBooks,
  getBookKit,
  updateBookStock,
  bulkAdjustBookStock,
  createProduct,
  updateProduct,
  archiveProduct,
  restoreProduct,
  listUniformCategories,
  listUniforms,
  createUniformProduct,
  updateUniformProduct,
  bulkAdjustUniformStock,
  updateUniformStock,
  listAccessoryGroups,
  updateAccessoryStock,
  getLogs,
}
