const jwt = require('jsonwebtoken')
const { jwtSecret } = require('../config')
const prisma = require('../services/prisma')
const { unauthorized, forbidden } = require('../utils/response')

const BRANCH_SCOPED_ROLES = ['ADMIN', 'SENIOR_ADMIN']

function authenticate(req, res, next) {
  const header = req.headers.authorization
  if (!header || !header.startsWith('Bearer ')) {
    return unauthorized(res, 'Authentication token required')
  }
  const token = header.slice(7)
  try {
    const payload = jwt.verify(token, jwtSecret)
    req.user = payload
    next()
  } catch {
    return unauthorized(res, 'Invalid or expired token')
  }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user) return unauthorized(res)
    if (!roles.includes(req.user.role)) {
      return forbidden(res, 'Insufficient permissions')
    }
    next()
  }
}

function requireSuperAdmin(req, res, next) {
  return requireRole('SUPER_ADMIN')(req, res, next)
}

// SUPER_ADMIN can access any branch; ADMIN and SENIOR_ADMIN are branch-scoped
function enforceBranchScope(req, res, next) {
  if (!req.user) return unauthorized(res)
  if (req.user.role === 'SUPER_ADMIN') return next()

  const tokenBranchId = req.user.branchId
  if (!tokenBranchId) {
    return next()
  }

  const pathBranchId = req.params.branchId
  if (pathBranchId && pathBranchId !== tokenBranchId) {
    return forbidden(res, 'Access to this branch is not allowed')
  }

  const bodyBranchId = req.body?.branchId
  if (bodyBranchId && bodyBranchId !== tokenBranchId) {
    return forbidden(res, 'Access to this branch is not allowed')
  }

  // Ignore client query.branchId — always trust token (avoids drift vs /auth/me or stale UI state)
  req.query.branchId = tokenBranchId
  next()
}

/** Resolve explicit permission from JWT JSON (handles renames and backward compat). */
function explicitPermission(perms, permKey) {
  if (!perms || typeof perms !== 'object') return undefined
  if (permKey === 'canViewReports') {
    if (typeof perms.canViewReports !== 'undefined') return perms.canViewReports
    if (typeof perms.canViewSales !== 'undefined') return perms.canViewSales
    return undefined
  }
  if (permKey === 'canViewTransactionsAllTime' && typeof perms.canViewTransactions !== 'undefined') {
    return perms.canViewTransactions
  }
  // Backward compat: users with full transaction access inherit category view permissions
  if (permKey === 'canViewBooksTransactions' || permKey === 'canViewUniformTransactions') {
    if (typeof perms[permKey] !== 'undefined') return perms[permKey]
    // Inherit from full transaction access if the new key was never explicitly set
    if (perms.canViewTransactionsAllTime === true || perms.canViewTransactions === true) return true
    return undefined
  }
  return perms[permKey]
}

// Default permissions by role when DB `permissions` is null (no overrides)
const ROLE_DEFAULT_PERMISSIONS = {
  SENIOR_ADMIN: {
    canViewDashboard: true,
    canViewReports: true,
    canViewSettings: true,
    canUpdateStock: true,
    canAdjustStock: false,
    canBulkEditStock: false,
    canCreateProducts: false,
    canArchiveProducts: false,
    canViewStockLogs: false,
    canViewUniformStock: false,
    canAdjustUniformStock: false,
    canBulkEditUniformStock: false,
    canManageUniformCategories: false,
    canViewUniformStockLogs: false,
    canCreateUniformOrders: false,
    canViewUniformReports: false,
    canManagePublishers: false,
    canManageAccounts: false,
    canViewPublisherFinancials: false,
    canPlaceOrders: true,
    canRequestOrderEdits: true,
    canManageStudents: true,
    canBulkImport: false,
    canViewStudentList: true,
    canViewStudentPurchaseDetails: false,
    canResetStudentData: false,
    canViewTransactions: false,
    canViewTransactions7Days: false,
    canViewTransactionsAllTime: false,
    canViewBooksTransactions: false,
    canViewUniformTransactions: false,
    canViewRevenue: false,
    canViewAdmissions: false,
    canManageAdmissions: false,
    canViewAdmissionTransactions: false,
    canViewExpenses: false,
    canCreateHandoverEntry: false,
    canCreateExpenseEntry: false,
    canCreateOnlineAllocation: false,
    canViewExpenseHistory: false,
    canViewReconciliation: false,
    canManageRecipients: false,
  },
  ADMIN: {
    canViewDashboard: true,
    canViewReports: true,
    canViewSettings: true,
    canUpdateStock: false,
    canAdjustStock: false,
    canBulkEditStock: false,
    canCreateProducts: false,
    canArchiveProducts: false,
    canViewStockLogs: false,
    canViewUniformStock: false,
    canAdjustUniformStock: false,
    canBulkEditUniformStock: false,
    canManageUniformCategories: false,
    canViewUniformStockLogs: false,
    canCreateUniformOrders: false,
    canViewUniformReports: false,
    canManagePublishers: false,
    canManageAccounts: false,
    canViewPublisherFinancials: false,
    canPlaceOrders: true,
    canRequestOrderEdits: true,
    canManageStudents: true,
    canBulkImport: false,
    canViewStudentList: true,
    canViewStudentPurchaseDetails: false,
    canResetStudentData: false,
    canViewTransactions: true,
    canViewTransactions7Days: false,
    canViewTransactionsAllTime: true,
    canViewBooksTransactions: true,
    canViewUniformTransactions: true,
    canViewRevenue: true,
    canViewAdmissions: false,
    canManageAdmissions: false,
    canViewAdmissionTransactions: false,
    canViewExpenses: true,
    canCreateHandoverEntry: true,
    canCreateExpenseEntry: true,
    canCreateOnlineAllocation: true,
    canViewExpenseHistory: true,
    canViewReconciliation: false,
    canManageRecipients: false,
  },
}

/**
 * Authorize using **current** DB permissions so grants/revokes apply without forcing re-login.
 * When `User.permissions` is null, use role defaults only (ignore stale JWT permission flags).
 */
function requirePermission(permKey) {
  return async (req, res, next) => {
    try {
      if (!req.user) return unauthorized(res)
      if (req.user.role === 'SUPER_ADMIN') return next()

      const row = await prisma.user.findUnique({
        where: { id: req.user.id },
        select: { permissions: true, isActive: true },
      })

      if (!row?.isActive) {
        return unauthorized(res, 'Account inactive or no longer available')
      }

      let perms = null
      if (row.permissions != null && typeof row.permissions === 'object') {
        perms = row.permissions
      }

      const explicit = explicitPermission(perms, permKey)
      if (typeof explicit !== 'undefined') {
        if (!explicit) return forbidden(res, 'Permission denied')
        return next()
      }

      const defaults = ROLE_DEFAULT_PERMISSIONS[req.user.role] ?? {}
      if (defaults[permKey] === false) return forbidden(res, 'Permission denied')
      next()
    } catch (err) {
      next(err)
    }
  }
}

async function currentPermissionValue(user, permKey) {
  if (user.role === 'SUPER_ADMIN') return true
  const row = await prisma.user.findUnique({
    where: { id: user.id },
    select: { permissions: true, isActive: true },
  })
  if (!row?.isActive) return false

  const perms = row.permissions != null && typeof row.permissions === 'object' ? row.permissions : null
  const explicit = explicitPermission(perms, permKey)
  if (typeof explicit !== 'undefined') return Boolean(explicit)
  const defaults = ROLE_DEFAULT_PERMISSIONS[user.role] ?? {}
  return defaults[permKey] === true
}

function requireAnyPermission(...permKeys) {
  return async (req, res, next) => {
    try {
      if (!req.user) return unauthorized(res)
      if (req.user.role === 'SUPER_ADMIN') return next()
      for (const permKey of permKeys) {
        if (await currentPermissionValue(req.user, permKey)) return next()
      }
      return forbidden(res, 'Permission denied')
    } catch (err) {
      next(err)
    }
  }
}

function requireTransactionHistoryAccess(req, res, next) {
  return requireAnyPermission('canViewTransactions7Days', 'canViewTransactionsAllTime')(req, res, next)
}

function enforceTransactionDateRange(req, res, next) {
  return (async () => {
    if (!req.user) return unauthorized(res)
    if (req.user.role === 'SUPER_ADMIN') return next()

    const hasAllTime = await currentPermissionValue(req.user, 'canViewTransactionsAllTime')
    if (hasAllTime) return next()

    const has7Days = await currentPermissionValue(req.user, 'canViewTransactions7Days')
    if (!has7Days) return forbidden(res, 'Permission denied')

    const now = new Date()
    const todayEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999)
    const earliest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6, 0, 0, 0, 0)
    const requestedFrom = req.query.dateFrom ? new Date(req.query.dateFrom) : earliest
    const requestedTo = req.query.dateTo ? new Date(req.query.dateTo) : todayEnd

    if (Number.isNaN(requestedFrom.getTime()) || Number.isNaN(requestedTo.getTime())) {
      return forbidden(res, 'Invalid transaction date range')
    }
    if (requestedFrom < earliest || requestedTo > todayEnd) {
      return forbidden(res, 'Transaction history is limited to the last 7 days')
    }
    next()
  })().catch(next)
}

module.exports = {
  authenticate,
  requireRole,
  requireSuperAdmin,
  enforceBranchScope,
  requirePermission,
  requireAnyPermission,
  currentPermissionValue,
  requireTransactionHistoryAccess,
  enforceTransactionDateRange,
}
