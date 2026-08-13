const { Router } = require('express')
const { z } = require('zod')
const ctrl = require('./orders.controller')
const editCtrl = require('./orderEdits.controller')
const { authenticate, enforceBranchScope, requirePermission, requireAnyPermission, requireSuperAdmin, currentPermissionValue } = require('../../middleware/auth')
const validate = require('../../middleware/validate')

const router = Router()

router.use(authenticate)

async function requireOrderItemPermissions(req, res, next) {
  try {
    if (req.user?.role === 'SUPER_ADMIN') return next()
    const itemTypes = new Set((req.body?.items ?? []).map((item) => item.itemType))
    if (itemTypes.has('BOOK') && !(await currentPermissionValue(req.user, 'canPlaceOrders'))) {
      return res.status(403).json({ success: false, message: 'Books order permission required' })
    }
    if (itemTypes.has('UNIFORM') && !(await currentPermissionValue(req.user, 'canCreateUniformOrders'))) {
      return res.status(403).json({ success: false, message: 'Uniform order permission required' })
    }
    next()
  } catch (err) {
    next(err)
  }
}

const itemSchema = z.object({
  itemType: z.enum(['BOOK', 'UNIFORM', 'ACCESSORY']),
  itemId: z.string().min(1),
  label: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPrice: z.number().positive(),
})

const BRANCH_UPI_PAYMENT_METHODS = [
  'UPI_RAJANI', 'UPI_VARALAXMI', 'UPI_INDU', 'UPI_BHARATHI',
]

const splitDetailSchema = z.object({
  paymentMethod: z.enum([
    'CASH', 'ONLINE', 'CANARA_UPI', 'BOB_UPI', 'UPI_BHARATH', 'UPI_POORNIMA',
    ...BRANCH_UPI_PAYMENT_METHODS,
    'CARD', 'CHEQUE', 'BANK_TRANSFER', 'GPAY', 'PHONEPE', 'PAYTM', 'CREDIT', 'OTHER',
  ]),
  amount: z.number().min(0),
})

const groupStudentSchema = z.object({
  studentId: z.string().min(1),
  items: z.array(itemSchema).min(1),
  discountAmount: z.number().min(0).optional(),
  totalAmount: z.number().min(0).optional(),
  notes: z.string().optional(),
})

const createGroupSchema = {
  body: z.object({
    branchId: z.string().min(1, 'branchId is required'),
    students: z.array(groupStudentSchema).min(2).max(10),
    payment: z.object({
      splitDetails: z.array(splitDetailSchema).min(1),
    }),
    orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
}

const createSchema = {
  body: z.object({
    studentId: z.string().min(1, 'studentId is required'),
    branchId: z.string().min(1, 'branchId is required'),
    items: z.array(itemSchema).min(1, 'At least one item is required'),
    discountAmount: z.number().min(0).optional(),
    totalAmount: z.number().min(0).optional(),
    notes: z.string().optional(),
    orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
}

const paymentSchema = {
  body: z.object({
    amount: z.number().min(0, 'amount cannot be negative'),
    paymentMethod: z.enum([
      'CASH', 'ONLINE', 'CANARA_UPI', 'BOB_UPI', 'UPI_BHARATH', 'UPI_POORNIMA',
      ...BRANCH_UPI_PAYMENT_METHODS,
      'CARD', 'CHEQUE', 'BANK_TRANSFER', 'GPAY', 'PHONEPE', 'PAYTM', 'CREDIT', 'OTHER',
    ]),
    referenceId: z.string().optional(),
    notes: z.string().optional(),
    discountAmount: z.number().min(0).optional(),
    paidAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  }),
}

const updateSchema = {
  body: z.object({
    status: z.enum(['DRAFT', 'CONFIRMED', 'PROCESSING', 'COMPLETED', 'CANCELLED']).optional(),
    bookStatus: z.enum(['TAKEN', 'PARTIAL', 'NOT_TAKEN']).optional(),
    uniformStatus: z.enum(['COMPLETE', 'PARTIAL', 'PENDING']).optional(),
    notes: z.string().optional(),
  }),
}

async function requireGroupItemPermissions(req, res, next) {
  try {
    if (req.user?.role === 'SUPER_ADMIN') return next()
    const allItems = (req.body?.students ?? []).flatMap((s) => s.items ?? [])
    const itemTypes = new Set(allItems.map((item) => item.itemType))
    if (itemTypes.has('BOOK')) {
      const canBooks = await currentPermissionValue(req.user, 'canPlaceOrders')
      if (!canBooks) return res.status(403).json({ success: false, message: 'Books order permission required' })
    }
    if (itemTypes.has('UNIFORM')) {
      const canUniforms = await currentPermissionValue(req.user, 'canCreateUniformOrders')
      if (!canUniforms) return res.status(403).json({ success: false, message: 'Uniform order permission required' })
    }
    next()
  } catch (err) {
    next(err)
  }
}

router.get('/', requireAnyPermission('canPlaceOrders', 'canViewStudentPurchaseDetails'), enforceBranchScope, ctrl.list)
router.post('/', requireAnyPermission('canPlaceOrders', 'canCreateUniformOrders'), enforceBranchScope, validate(createSchema), requireOrderItemPermissions, ctrl.create)

// Group and student routes must come BEFORE /:id to prevent Express route shadowing
router.post('/group', requireAnyPermission('canPlaceOrders', 'canCreateUniformOrders'), enforceBranchScope, validate(createGroupSchema), requireGroupItemPermissions, ctrl.createGroup)
router.get('/group/:groupId', requireAnyPermission('canPlaceOrders', 'canViewStudentPurchaseDetails'), enforceBranchScope, ctrl.getGroup)
router.get('/students/:studentId', requireAnyPermission('canPlaceOrders', 'canViewStudentPurchaseDetails'), ctrl.getStudentOrders)

// Order edit requests (approval workflow)
const editRequestBodySchema = {
  body: z.object({
    reason: z.string().optional(),
    orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    notes: z.string().nullable().optional(),
    bookStatus: z.enum(['TAKEN', 'PARTIAL', 'NOT_TAKEN']).optional(),
    uniformStatus: z.enum(['COMPLETE', 'PARTIAL', 'PENDING']).optional(),
    total: z.number().min(0).optional(),
    paidAmount: z.number().min(0).optional(),
    status: z.enum(['DRAFT', 'CONFIRMED', 'PROCESSING', 'COMPLETED', 'CANCELLED']).optional(),
    paymentStatus: z.enum(['UNPAID', 'PARTIAL', 'PAID', 'REFUNDED']).optional(),
    paymentMethod: z.enum([
      'CASH', 'ONLINE', 'CANARA_UPI', 'BOB_UPI', 'UPI_BHARATH', 'UPI_POORNIMA',
      ...BRANCH_UPI_PAYMENT_METHODS,
      'CARD', 'CHEQUE', 'BANK_TRANSFER', 'GPAY', 'PHONEPE', 'PAYTM', 'CREDIT', 'OTHER',
    ]).optional().nullable(),
    items: z.array(z.object({
      itemType: z.enum(['BOOK', 'UNIFORM', 'ACCESSORY']),
      itemId: z.string().min(1),
      label: z.string().min(1),
      quantity: z.number().int().positive(),
      unitPrice: z.number().min(0),
    })).min(1).optional(),
    transactions: z.array(z.object({
      amount: z.number(),
      paymentMethod: z.enum([
        'CASH', 'ONLINE', 'CANARA_UPI', 'BOB_UPI', 'UPI_BHARATH', 'UPI_POORNIMA',
        ...BRANCH_UPI_PAYMENT_METHODS,
        'CARD', 'CHEQUE', 'BANK_TRANSFER', 'GPAY', 'PHONEPE', 'PAYTM', 'CREDIT', 'OTHER',
      ]),
      status: z.enum(['UNPAID', 'PARTIAL', 'PAID', 'REFUNDED']).optional(),
      referenceId: z.string().optional().nullable(),
      notes: z.string().optional().nullable(),
      paidAt: z.union([z.string(), z.date()]).optional().nullable(),
    })).optional(),
  }),
}

router.get('/edit-requests', requireAnyPermission('canPlaceOrders', 'canRequestOrderEdits', 'canViewStudentPurchaseDetails'), enforceBranchScope, editCtrl.listEditRequests)
router.get('/edit-requests/:requestId', requireAnyPermission('canPlaceOrders', 'canRequestOrderEdits', 'canViewStudentPurchaseDetails'), enforceBranchScope, editCtrl.getEditRequest)
router.post('/edit-requests/:requestId/approve', requireSuperAdmin, validate({ body: z.object({ reviewNote: z.string().optional() }) }), editCtrl.approveEditRequest)
router.post('/edit-requests/:requestId/reject', requireSuperAdmin, validate({ body: z.object({ reviewNote: z.string().optional() }) }), editCtrl.rejectEditRequest)
router.post('/edit-requests/:requestId/withdraw', requireAnyPermission('canPlaceOrders', 'canRequestOrderEdits'), enforceBranchScope, editCtrl.withdrawEditRequest)
router.post('/:id/edit-requests', requireAnyPermission('canPlaceOrders', 'canRequestOrderEdits', 'canCreateUniformOrders'), enforceBranchScope, validate(editRequestBodySchema), editCtrl.createEditRequest)

router.get('/:id', requireAnyPermission('canPlaceOrders', 'canViewStudentPurchaseDetails'), enforceBranchScope, ctrl.getOne)
router.patch('/:id', requirePermission('canPlaceOrders'), enforceBranchScope, validate(updateSchema), ctrl.update)
router.post('/:id/payment', requireAnyPermission('canPlaceOrders', 'canCreateUniformOrders'), enforceBranchScope, validate(paymentSchema), ctrl.processPayment)
router.delete('/:id', requirePermission('canPlaceOrders'), enforceBranchScope, ctrl.cancel)

module.exports = router
