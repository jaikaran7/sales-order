import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ROLES } from '@/config/navigation'
import { authApi } from '@/services/api'
import { AdminSessionContext } from './adminSessionContext'
import { decodeJWTPayload } from '@/lib/auth'

const INACTIVITY_MS = {
  [ROLES.SUPER_ADMIN]: 5 * 60 * 1000,
  [ROLES.SENIOR_ADMIN]: 10 * 60 * 1000,
  [ROLES.ADMIN]: 10 * 60 * 1000,
}

const TOKEN_KEY = 'skm_token'
const REFRESH_KEY = 'skm_refresh'
const ROLE_KEY = 'skm_role'
const USER_KEY = 'skm_user'
const KNOWN_PERMISSION_KEYS = [
  'canViewDashboard',
  'canViewReports',
  'canViewSettings',
  'canUpdateStock',
  'canAdjustStock',
  'canBulkEditStock',
  'canCreateProducts',
  'canArchiveProducts',
  'canViewStockLogs',
  'canViewUniformStock',
  'canAdjustUniformStock',
  'canBulkEditUniformStock',
  'canManageUniformCategories',
  'canViewUniformStockLogs',
  'canCreateUniformOrders',
  'canViewUniformReports',
  'canPlaceOrders',
  'canRequestOrderEdits',
  'canManageStudents',
  'canBulkImport',
  'canViewStudentList',
  'canViewStudentPurchaseDetails',
  'canResetStudentData',
  'canViewTransactions',
  'canViewTransactions7Days',
  'canViewTransactionsAllTime',
  'canViewBooksTransactions',
  'canViewUniformTransactions',
  'canViewRevenue',
  'canViewPublisherFinancials',
  'canManagePublishers',
  'canManageAccounts',
  'canViewAdmissions',
  'canManageAdmissions',
  'canViewAdmissionTransactions',
  'canViewExpenses',
  'canCreateHandoverEntry',
  'canCreateExpenseEntry',
  'canCreateOnlineAllocation',
  'canViewExpenseHistory',
  'canViewReconciliation',
  'canManageRecipients',
]

const ROLE_DEFAULT_PERMISSIONS = {
  [ROLES.SENIOR_ADMIN]: {
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
    canViewPublisherFinancials: false,
    canManagePublishers: false,
    canManageAccounts: false,
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
  [ROLES.ADMIN]: {
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
    canViewPublisherFinancials: false,
    canManagePublishers: false,
    canManageAccounts: false,
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

function readStorage(key) {
  if (typeof window === 'undefined') return null
  try { return window.localStorage.getItem(key) } catch { return null }
}

function writeStorage(key, value) {
  try { window.localStorage.setItem(key, value) } catch { /* ignore */ }
}

function clearStorage() {
  try {
    [TOKEN_KEY, REFRESH_KEY, ROLE_KEY, USER_KEY].forEach((k) => window.localStorage.removeItem(k))
  } catch { /* ignore */ }
}

function isTokenExpiredLocally() {
  try {
    const token = window.localStorage.getItem(TOKEN_KEY)
    if (!token) return true
    const payload = decodeJWTPayload(token)
    if (!payload?.exp) return true
    return (Date.now() / 1000) >= (payload.exp - 30)
  } catch {
    return true
  }
}

function readStoredRole() {
  if (typeof window === 'undefined') return null
  try {
    if (isTokenExpiredLocally()) {
      [TOKEN_KEY, REFRESH_KEY, ROLE_KEY, USER_KEY].forEach((k) => window.localStorage.removeItem(k))
      return null
    }
    const raw = window.localStorage.getItem(ROLE_KEY)
    if (raw === ROLES.SUPER_ADMIN || raw === ROLES.SENIOR_ADMIN || raw === ROLES.ADMIN) return raw
  } catch { /* ignore */ }
  return null
}

function readStoredUser() {
  try {
    const raw = readStorage(USER_KEY)
    return raw ? JSON.parse(raw) : null
  } catch { return null }
}

/**
 * Legacy accounts with full transaction access inherit both category views when
 * the granular keys were never explicitly set (matches backend auth behaviour).
 */
function inheritTransactionCategoryPermissions(source) {
  const hasFullTransactionAccess =
    source.canViewTransactionsAllTime === true || source.canViewTransactions === true
  if (!hasFullTransactionAccess) return
  if (source.canViewBooksTransactions === undefined) source.canViewBooksTransactions = true
  if (source.canViewUniformTransactions === undefined) source.canViewUniformTransactions = true
}

function normalizePermissions(raw, role) {
  const defaults = ROLE_DEFAULT_PERMISSIONS[role] ?? {}
  let source = raw
  if (typeof source === 'string') {
    try {
      source = JSON.parse(source)
    } catch {
      source = null
    }
  }
  if (!source || typeof source !== 'object') return defaults
  const mergedSource = { ...source }
  if (
    typeof mergedSource.canViewSales === 'boolean' &&
    typeof mergedSource.canViewReports === 'undefined'
  ) {
    mergedSource.canViewReports = mergedSource.canViewSales
  }
  if (
    typeof mergedSource.canViewTransactions === 'boolean' &&
    typeof mergedSource.canViewTransactionsAllTime === 'undefined'
  ) {
    mergedSource.canViewTransactionsAllTime = mergedSource.canViewTransactions
  }
  inheritTransactionCategoryPermissions(mergedSource)
  const normalized = { ...defaults }
  for (const key of KNOWN_PERMISSION_KEYS) {
    if (typeof mergedSource[key] !== 'undefined') normalized[key] = Boolean(mergedSource[key])
  }
  return normalized
}

/**
 * True if there is a token in storage — we need to wait for me() to return fresh
 * DB permissions before any route guard can evaluate. Avoids the race where the
 * guard redirects before the async me() resolves with updated permissions.
 */
function hasStoredToken() {
  try { return Boolean(window.localStorage.getItem(TOKEN_KEY)) } catch { return false }
}

export default function AdminSessionProviderRoot({ children }) {
  const [role, setRole] = useState(readStoredRole)
  const [user, setUser] = useState(readStoredUser)
  // permissionsReady: false while the initial me() call is in-flight
  const [permissionsReady, setPermissionsReady] = useState(!hasStoredToken())

  const login = useCallback(async (username, password) => {
    const { data } = await authApi.login(username, password)
    const { token, refreshToken, user: u } = data.data

    const mappedRole =
      u.role === 'SUPER_ADMIN' ? ROLES.SUPER_ADMIN :
      u.role === 'SENIOR_ADMIN' ? ROLES.SENIOR_ADMIN :
      ROLES.ADMIN
    writeStorage(TOKEN_KEY, token)
    writeStorage(REFRESH_KEY, refreshToken)
    writeStorage(ROLE_KEY, mappedRole)
    writeStorage(USER_KEY, JSON.stringify(u))

    setRole(mappedRole)
    setUser(u)
    return mappedRole
  }, [])

  const logout = useCallback(async () => {
    const refreshToken = readStorage(REFRESH_KEY)
    try { await authApi.logout(refreshToken) } catch { /* ignore */ }
    clearStorage()
    setRole(null)
    setUser(null)
  }, [])

  const inactivityTimer = useRef(null)

  useEffect(() => {
    if (!role) return
    const timeout = INACTIVITY_MS[role]
    if (!timeout) return

    const reset = () => {
      clearTimeout(inactivityTimer.current)
      inactivityTimer.current = setTimeout(() => logout(), timeout)
    }

    const events = ['mousemove', 'keypress', 'click', 'touchstart', 'scroll']
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }))
    reset()

    return () => {
      clearTimeout(inactivityTimer.current)
      events.forEach((e) => window.removeEventListener(e, reset))
    }
  }, [role, logout])

  useEffect(() => {
    const token = readStorage(TOKEN_KEY)
    if (!token) {
      setPermissionsReady(true)
      return
    }
    let cancelled = false
    authApi.me()
      .then(({ data }) => {
        const u = data?.data
        if (cancelled) return
        if (u) {
          writeStorage(USER_KEY, JSON.stringify(u))
          setUser(u)
        }
      })
      .catch(() => {
        // If me() fails (expired token, network), clear stale session so the user
        // is redirected to login rather than seeing a broken half-authenticated state.
        clearStorage()
        setRole(null)
        setUser(null)
      })
      .finally(() => {
        if (!cancelled) setPermissionsReady(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  const normalizedPermissions = useMemo(
    () => normalizePermissions(user?.permissions ?? null, role),
    [user?.permissions, role],
  )

  const value = useMemo(
    () => ({
      role,
      user,
      branchId: user?.branch?.id,
      permissions: normalizedPermissions,
      permissionsReady,
      login,
      logout,
    }),
    [role, user, normalizedPermissions, permissionsReady, login, logout],
  )

  return <AdminSessionContext.Provider value={value}>{children}</AdminSessionContext.Provider>
}
