import { useCallback, useState } from 'react'
import { adminMgmtApi, branchesApi } from '@/services/api'
import { useApi } from '@/hooks/useApi'
import { useToast } from '@/context/ToastContext'

const PERMISSION_GROUPS = [
  {
    group: 'Screens & navigation',
    items: [
      { key: 'canViewDashboard', label: 'View dashboard (KPIs & summary)' },
      { key: 'canViewReports',   label: 'View reports & analytics hub' },
      { key: 'canViewSettings', label: 'Access settings' },
    ],
  },
  {
    group: 'Stock & Inventory',
    items: [
      { key: 'canUpdateStock',      label: 'View Books stock' },
      { key: 'canAdjustStock',      label: 'Adjust stock via single-item panel' },
      { key: 'canBulkEditStock',    label: 'Bulk edit class stock' },
      { key: 'canCreateProducts',   label: 'Create / edit products' },
      { key: 'canArchiveProducts',  label: 'Archive / delete products' },
      { key: 'canViewStockLogs',    label: 'View stock logs & audit history' },
    ],
  },
  {
    group: 'Uniform Roles',
    items: [
      { key: 'canViewUniformStock',       label: 'Uniform Stock Viewer — view uniform stock only' },
      { key: 'canAdjustUniformStock',     label: 'Uniform Stock Manager — adjust single uniform stock' },
      { key: 'canBulkEditUniformStock',   label: 'Uniform Stock Manager — bulk edit uniform stock' },
      { key: 'canViewUniformStockLogs',   label: 'Uniform Stock Manager — view uniform stock logs' },
      { key: 'canManageUniformCategories', label: 'Uniform Category Manager — create/edit uniform categories' },
      { key: 'canCreateUniformOrders',    label: 'Uniform Order Creator — place uniform orders' },
      { key: 'canViewUniformReports',     label: 'Uniform Reports Viewer — view uniform reports/history' },
    ],
  },
  {
    group: 'Orders & Students',
    items: [
      { key: 'canPlaceOrders',      label: 'Place new orders' },
      { key: 'canRequestOrderEdits', label: 'Request order edits (needs Superadmin approval)' },
      { key: 'canViewStudentList',  label: 'View student list' },
      { key: 'canViewStudentPurchaseDetails', label: 'View student purchase details' },
      { key: 'canManageStudents',   label: 'Add / edit students' },
      { key: 'canBulkImport',       label: 'Access bulk import' },
      { key: 'canResetStudentData', label: 'Reset student data' },
    ],
  },
  {
    group: 'Financials',
    items: [
      { key: 'canViewTransactions7Days',      label: 'View transaction history — last 7 days only' },
      { key: 'canViewTransactionsAllTime',   label: 'View transaction history — all time' },
      { key: 'canViewBooksTransactions',     label: 'View books transactions tab' },
      { key: 'canViewUniformTransactions',   label: 'View uniforms transactions tab' },
      { key: 'canViewRevenue',               label: 'View revenue & collection amounts' },
      { key: 'canViewPublisherFinancials',   label: 'View publisher financials & balances' },
    ],
  },
  {
    group: 'Publishers & Accounts',
    items: [
      { key: 'canManagePublishers', label: 'Manage publishers' },
      { key: 'canManageAccounts',   label: 'Manage accounts & expenses' },
    ],
  },
  {
    group: 'New Admissions',
    items: [
      { key: 'canViewAdmissions',             label: 'View New Admissions module' },
      { key: 'canManageAdmissions',           label: 'Create admissions & record payments' },
      { key: 'canViewAdmissionTransactions',  label: 'View admission transaction history' },
    ],
  },
  {
    group: 'Cash Management',
    items: [
      { key: 'canViewExpenses',           label: 'View cash management dashboard' },
      { key: 'canCreateHandoverEntry',    label: 'Create handover entries (cash to owner)' },
      { key: 'canCreateExpenseEntry',     label: 'Create expense entries (operational costs)' },
      { key: 'canCreateOnlineAllocation', label: 'Create online allocation entries' },
      { key: 'canViewExpenseHistory',     label: 'View expense history & running balance' },
      { key: 'canViewReconciliation',     label: 'View daily reconciliation report' },
      { key: 'canManageRecipients',       label: 'Manage cash recipient list' },
    ],
  },
]

// Flat list for iteration convenience
const PERMISSION_KEYS = PERMISSION_GROUPS.flatMap((g) => g.items)

const DEFAULT_PERMISSIONS = {
  SENIOR_ADMIN: {
    canViewDashboard: true, canViewReports: true, canViewSettings: true,
    canUpdateStock: true, canAdjustStock: false, canBulkEditStock: false,
    canCreateProducts: false, canArchiveProducts: false, canViewStockLogs: false,
    canViewUniformStock: false, canAdjustUniformStock: false, canBulkEditUniformStock: false,
    canManageUniformCategories: false, canViewUniformStockLogs: false, canCreateUniformOrders: false,
    canViewUniformReports: false,
    canPlaceOrders: true, canRequestOrderEdits: true, canViewStudentList: true, canViewStudentPurchaseDetails: false,
    canManageStudents: true, canBulkImport: false, canResetStudentData: false,
    canViewTransactions: false, canViewTransactions7Days: false, canViewTransactionsAllTime: false,
    canViewBooksTransactions: false, canViewUniformTransactions: false,
    canViewRevenue: false, canViewPublisherFinancials: false,
    canManagePublishers: false, canManageAccounts: false,
    canViewAdmissions: false, canManageAdmissions: false, canViewAdmissionTransactions: false,
    canViewExpenses: false, canCreateHandoverEntry: false, canCreateExpenseEntry: false,
    canCreateOnlineAllocation: false, canViewExpenseHistory: false,
    canViewReconciliation: false, canManageRecipients: false,
  },
  ADMIN: {
    canViewDashboard: true, canViewReports: true, canViewSettings: true,
    canUpdateStock: false, canAdjustStock: false, canBulkEditStock: false,
    canCreateProducts: false, canArchiveProducts: false, canViewStockLogs: false,
    canViewUniformStock: false, canAdjustUniformStock: false, canBulkEditUniformStock: false,
    canManageUniformCategories: false, canViewUniformStockLogs: false, canCreateUniformOrders: false,
    canViewUniformReports: false,
    canPlaceOrders: true, canRequestOrderEdits: true, canViewStudentList: true, canViewStudentPurchaseDetails: false,
    canManageStudents: true, canBulkImport: false, canResetStudentData: false,
    canViewTransactions: true, canViewTransactions7Days: false, canViewTransactionsAllTime: true,
    canViewBooksTransactions: true, canViewUniformTransactions: true,
    canViewRevenue: true, canViewPublisherFinancials: false,
    canManagePublishers: false, canManageAccounts: false,
    canViewAdmissions: false, canManageAdmissions: false, canViewAdmissionTransactions: false,
    canViewExpenses: true, canCreateHandoverEntry: true, canCreateExpenseEntry: true,
    canCreateOnlineAllocation: true, canViewExpenseHistory: true,
    canViewReconciliation: false, canManageRecipients: false,
  },
}

function migratePermissionsFromApi(raw, role) {
  const preset = DEFAULT_PERMISSIONS[role] ?? DEFAULT_PERMISSIONS.ADMIN
  const merged = { ...preset, ...(raw && typeof raw === 'object' ? raw : {}) }
  if (typeof merged.canViewSales === 'boolean' && typeof merged.canViewReports === 'undefined') {
    merged.canViewReports = merged.canViewSales
  }
  if (typeof merged.canViewTransactions === 'boolean' && typeof merged.canViewTransactionsAllTime === 'undefined') {
    merged.canViewTransactionsAllTime = merged.canViewTransactions
  }
  if (merged.canViewTransactionsAllTime === true) {
    if (merged.canViewBooksTransactions === undefined) merged.canViewBooksTransactions = true
    if (merged.canViewUniformTransactions === undefined) merged.canViewUniformTransactions = true
  }
  return merged
}

/** Count enabled permissions the same way the edit drawer displays them. */
function countEnabledPermissions(raw, role) {
  const merged = migratePermissionsFromApi(raw, role)
  return PERMISSION_KEYS.filter(({ key }) => Boolean(merged[key])).length
}

function nextPermissions(prev, key) {
  const next = { ...prev, [key]: !prev[key] }
  if (key === 'canViewTransactions7Days' && next.canViewTransactions7Days) {
    next.canViewTransactionsAllTime = false
    next.canViewTransactions = false
  }
  if (key === 'canViewTransactionsAllTime' && next.canViewTransactionsAllTime) {
    next.canViewTransactions7Days = false
    next.canViewTransactions = true
    next.canViewBooksTransactions = true
    next.canViewUniformTransactions = true
  }
  if (key === 'canViewStudentPurchaseDetails' && next.canViewStudentPurchaseDetails) {
    next.canViewStudentList = true
  }
  if (key === 'canViewStudentList' && !next.canViewStudentList) {
    next.canViewStudentPurchaseDetails = false
  }
  if ([
    'canAdjustUniformStock',
    'canBulkEditUniformStock',
    'canManageUniformCategories',
    'canViewUniformStockLogs',
  ].includes(key) && next[key]) {
    next.canViewUniformStock = true
  }
  if (key === 'canViewUniformStock' && !next.canViewUniformStock) {
    next.canAdjustUniformStock = false
    next.canBulkEditUniformStock = false
    next.canManageUniformCategories = false
    next.canViewUniformStockLogs = false
  }
  if (key === 'canViewUniformReports' && next.canViewUniformReports) {
    next.canViewUniformStockLogs = true
    next.canViewUniformStock = true
  }
  // Expense module: enabling any sub-permission auto-enables the dashboard view
  if (
    ['canCreateHandoverEntry', 'canCreateExpenseEntry', 'canCreateOnlineAllocation',
     'canViewExpenseHistory', 'canViewReconciliation'].includes(key) && next[key]
  ) {
    next.canViewExpenses = true
  }
  // Disabling dashboard view disables all sub-permissions
  if (key === 'canViewExpenses' && !next.canViewExpenses) {
    next.canCreateHandoverEntry    = false
    next.canCreateExpenseEntry     = false
    next.canCreateOnlineAllocation = false
    next.canViewExpenseHistory     = false
    next.canViewReconciliation     = false
  }
  return next
}

function RoleBadge({ role }) {
  const cls = role === 'SENIOR_ADMIN'
    ? 'bg-secondary-container text-on-secondary-container'
    : 'bg-primary-fixed text-on-primary-fixed-variant'
  const label = role === 'SENIOR_ADMIN' ? 'Senior Admin' : 'School Admin'
  return <span className={`rounded-full px-3 py-1 text-[11px] font-bold ${cls}`}>{label}</span>
}

function StatusDot({ isActive }) {
  return (
    <span className={`inline-block h-2 w-2 rounded-full ${isActive ? 'bg-green-500' : 'bg-outline-variant'}`} />
  )
}

function SuperPasswordConfirmModal({
  title,
  body,
  confirmLabel,
  destructive = false,
  loading = false,
  error = '',
  onConfirm,
  onCancel,
}) {
  const [password, setPassword] = useState('')
  const [readonly, setReadonly] = useState(true)
  const [inputName] = useState(() => `verify_${Math.random().toString(36).slice(2)}`)

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4">
      <div className="w-full max-w-md rounded-2xl bg-white p-6 shadow-2xl">
        <h3 className="font-headline text-lg font-extrabold">{title}</h3>
        <p className="mt-2 text-sm text-on-surface-variant">{body}</p>
        <input
          type="password"
          value={password}
          readOnly={readonly}
          autoComplete="new-password"
          name={inputName}
          onFocus={() => setReadonly(false)}
          onChange={(e) => onConfirm && setPassword(e.target.value)}
          className={`${inputCls(error)} mt-4`}
        />
        {error && <p className="mt-2 text-xs text-error">{error}</p>}
        <div className="mt-5 flex gap-3">
          <button type="button" onClick={onCancel}
            className="flex-1 rounded-xl border border-outline-variant/30 py-3 text-sm font-semibold hover:bg-surface-container-low">
            Cancel
          </button>
          <button type="button" disabled={loading || !password} onClick={() => onConfirm(password)}
            className={`flex-1 rounded-xl py-3 text-sm font-bold hover:opacity-90 disabled:opacity-50 ${destructive ? 'bg-error text-on-error' : 'bg-primary text-on-primary'}`}>
            {loading ? 'Verifying…' : confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

function CreateAdminDrawer({ branches, onClose, onCreated }) {
  const toast = useToast()
  const [form, setForm] = useState({
    displayName: '', username: '', password: '', role: 'SENIOR_ADMIN', branchId: '',
    permissions: { ...DEFAULT_PERMISSIONS.SENIOR_ADMIN },
  })
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState({})
  const [showCreateConfirm, setShowCreateConfirm] = useState(false)
  const [createConfirmError, setCreateConfirmError] = useState('')

  const set = (key, val) => setForm((f) => ({ ...f, [key]: val }))

  const handleRoleChange = (role) => {
    setForm((f) => ({
      ...f,
      role,
      // Role behaves like a template/preset; permissions remain fully editable afterward.
      permissions: { ...DEFAULT_PERMISSIONS[role] },
    }))
  }

  const togglePerm = (key) => {
    setForm((f) => ({
      ...f,
      permissions: nextPermissions(f.permissions, key),
    }))
  }

  const validate = () => {
    const e = {}
    if (!form.displayName.trim()) e.displayName = 'Name is required'
    if (!form.username.trim()) e.username = 'Username is required'
    if (form.password.length < 8) e.password = 'Password must be at least 8 characters'
    setErrors(e)
    return Object.keys(e).length === 0
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    if (!validate()) return
    setCreateConfirmError('')
    setShowCreateConfirm(true)
  }

  const handleConfirmedCreate = async (superPassword) => {
    setSaving(true)
    try {
      const admin = await adminMgmtApi.create({
        displayName: form.displayName.trim(),
        username: form.username.trim(),
        password: form.password,
        role: form.role,
        branchId: form.branchId || null,
        permissions: form.permissions,
        superPassword,
      })
      toast.success(`Admin "${form.displayName}" created successfully`)
      onCreated(admin?.data?.data ?? admin?.data)
      onClose()
    } catch (err) {
      if (err?.response?.status === 401) setCreateConfirmError('Incorrect Super Admin password')
      else toast.error(err?.response?.data?.message ?? 'Failed to create admin')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="flex h-full w-full max-w-lg flex-col overflow-y-auto bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-outline-variant/10 p-6">
          <h2 className="font-headline text-xl font-extrabold">Create Admin Account</h2>
          <button type="button" onClick={onClose} className="rounded-lg p-1 hover:bg-surface-container-low">
            <span className="material-symbols-outlined" aria-hidden>close</span>
          </button>
        </div>
        <form onSubmit={handleSubmit} className="flex flex-1 flex-col gap-6 p-6">
          <div className="grid grid-cols-1 gap-4">
            <Field label="Full Name" error={errors.displayName}>
              <input type="text" value={form.displayName} onChange={(e) => set('displayName', e.target.value)}
                className={inputCls(errors.displayName)} placeholder="Admin display name" />
            </Field>
            <Field label="Username / Login" error={errors.username}>
              <input type="text" value={form.username} onChange={(e) => set('username', e.target.value)}
                className={inputCls(errors.username)} placeholder="Lowercase, no spaces" />
            </Field>
            <Field label="Password" error={errors.password}>
              <input type="password" value={form.password} onChange={(e) => set('password', e.target.value)}
                className={inputCls(errors.password)} placeholder="Min 8 characters" />
            </Field>
            <Field label="Role">
              <div className="flex gap-3">
                {['SENIOR_ADMIN', 'ADMIN'].map((r) => (
                  <label key={r} className={`flex flex-1 cursor-pointer items-center gap-2 rounded-xl border-2 p-3 transition-colors ${form.role === r ? 'border-primary bg-primary/5' : 'border-outline-variant/20'}`}>
                    <input type="radio" className="sr-only" checked={form.role === r} onChange={() => handleRoleChange(r)} />
                    <div className={`h-4 w-4 rounded-full border-2 ${form.role === r ? 'border-primary bg-primary' : 'border-outline-variant'}`} />
                    <span className="text-sm font-semibold">{r === 'SENIOR_ADMIN' ? 'Senior Admin' : 'School Admin'}</span>
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Branch" error={errors.branchId}>
              <select value={form.branchId} onChange={(e) => set('branchId', e.target.value)} className={inputCls(errors.branchId)}>
                <option value="">All Branches</option>
                {branches.map((b) => (
                  <option key={b.id} value={b.id}>{b.name}</option>
                ))}
              </select>
            </Field>
          </div>

          <div>
            <p className="mb-4 font-label text-xs font-semibold uppercase tracking-wider text-on-surface-variant">Permissions</p>
            <div className="space-y-5">
              {PERMISSION_GROUPS.map((group) => (
                <div key={group.group}>
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-stone-400">{group.group}</p>
                  <div className="space-y-2.5">
                    {group.items.map(({ key, label }) => (
                      <label key={key} className="flex cursor-pointer items-center gap-3">
                        <input type="checkbox" checked={!!form.permissions[key]} onChange={() => togglePerm(key)}
                          className="rounded border-outline-variant text-primary focus:ring-primary" />
                        <span className="text-sm text-on-surface">{label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          <div className="mt-auto flex gap-3">
            <button type="button" onClick={onClose}
              className="flex-1 rounded-xl border border-outline-variant/30 py-3 text-sm font-semibold hover:bg-surface-container-low">
              Cancel
            </button>
            <button type="submit" disabled={saving}
              className="flex-1 rounded-xl bg-primary py-3 text-sm font-bold text-on-primary shadow-sm hover:opacity-90 disabled:opacity-50">
              {saving ? 'Creating…' : 'Create Admin'}
            </button>
          </div>
        </form>
      </div>
      {showCreateConfirm && (
        <SuperPasswordConfirmModal
          title="Confirm Admin Creation"
          body={`Enter your Super Admin password to verify your identity before creating ${form.displayName || 'this admin'}.`}
          confirmLabel="Create Admin"
          loading={saving}
          error={createConfirmError}
          onCancel={() => { setShowCreateConfirm(false); setCreateConfirmError('') }}
          onConfirm={handleConfirmedCreate}
        />
      )}
    </div>
  )
}

function EditPermissionsDrawer({ admin, branches, onClose, onSaved }) {
  const toast = useToast()
  const [perms, setPerms] = useState(
    migratePermissionsFromApi(admin.permissions, admin.role),
  )
  const [branchId, setBranchId] = useState(admin.branch?.id ?? '')
  const [isActive, setIsActive] = useState(admin.isActive)
  const [saving, setSaving] = useState(false)
  const [resetPwd, setResetPwd] = useState('')
  const [confirmError, setConfirmError] = useState('')
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [resetting, setResetting] = useState(false)
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false)
  const [deleteError, setDeleteError] = useState('')
  const [deleting, setDeleting] = useState(false)

  const togglePerm = (key) =>
    setPerms((p) => nextPermissions(p, key))

  const handleSave = async () => {
    setSaving(true)
    try {
      const permissions = { ...perms }
      delete permissions.canViewSales
      await adminMgmtApi.update(admin.id, {
        branchId: branchId || null,
        permissions,
        isActive,
      })
      toast.success('Permissions updated')
      onSaved()
      onClose()
    } catch (err) {
      toast.error(err?.response?.data?.message ?? 'Update failed')
    } finally {
      setSaving(false)
    }
  }

  const handleResetPassword = async (superPassword) => {
    if (resetPwd.length < 8) { toast.error('Password must be at least 8 characters'); return }
    setResetting(true)
    try {
      await adminMgmtApi.verifySuperPassword(superPassword)
      await adminMgmtApi.resetPassword(admin.id, resetPwd)
      toast.success('Password reset — admin must change on next login')
      setResetPwd('')
      setConfirmError('')
      setShowResetConfirm(false)
    } catch (err) {
      const message = err?.response?.data?.message ?? 'Reset failed'
      if (err?.response?.status === 401) setConfirmError('Incorrect Super Admin password')
      else toast.error(message)
    } finally {
      setResetting(false)
    }
  }

  const handleDeleteAdmin = async (superPassword) => {
    setDeleting(true)
    try {
      const res = await adminMgmtApi.delete(admin.id, superPassword)
      const payload = res?.data?.data ?? {}
      toast.success(payload.message ?? 'Admin deleted')
      setDeleteError('')
      setShowDeleteConfirm(false)
      onSaved()
      onClose()
    } catch (err) {
      if (err?.response?.status === 401) setDeleteError('Incorrect Super Admin password')
      else toast.error(err?.response?.data?.message ?? 'Delete failed')
    } finally {
      setDeleting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="flex h-full w-full max-w-lg flex-col overflow-y-auto bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-outline-variant/10 p-6">
          <div>
            <h2 className="font-headline text-xl font-extrabold">{admin.displayName}</h2>
            <p className="text-sm text-on-surface-variant">{admin.username} · {admin.branch?.name}</p>
          </div>
          <button type="button" onClick={onClose} className="rounded-lg p-1 hover:bg-surface-container-low">
            <span className="material-symbols-outlined" aria-hidden>close</span>
          </button>
        </div>
        <div className="flex flex-1 flex-col gap-6 p-6">
          <div>
            <label className="mb-1.5 block font-label text-xs font-semibold uppercase tracking-wider text-on-surface-variant">Branch</label>
            <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className={inputCls()}>
              <option value="">All Branches</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>{b.name}</option>
              ))}
            </select>
          </div>
          <label className="flex cursor-pointer items-center gap-3">
            <input type="checkbox" checked={isActive} onChange={(e) => setIsActive(e.target.checked)}
              className="rounded border-outline-variant text-primary focus:ring-primary" />
            <span className="text-sm font-medium">Account Active</span>
          </label>
          <div>
            <p className="mb-4 font-label text-xs font-semibold uppercase tracking-wider text-on-surface-variant">Permissions</p>
            <div className="space-y-5">
              {PERMISSION_GROUPS.map((group) => (
                <div key={group.group}>
                  <p className="mb-2 text-[10px] font-bold uppercase tracking-widest text-stone-400">{group.group}</p>
                  <div className="space-y-2.5">
                    {group.items.map(({ key, label }) => (
                      <label key={key} className="flex cursor-pointer items-center gap-3">
                        <input type="checkbox" checked={!!perms[key]} onChange={() => togglePerm(key)}
                          className="rounded border-outline-variant text-primary focus:ring-primary" />
                        <span className="text-sm text-on-surface">{label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-outline-variant/20 bg-surface-container-low p-4">
            <p className="mb-3 font-label text-xs font-semibold uppercase tracking-wider text-on-surface-variant">Reset Password</p>
            <div className="flex gap-2">
              <input type="password" value={resetPwd} onChange={(e) => setResetPwd(e.target.value)}
                placeholder="New password (min 8 chars)" className={`flex-1 ${inputCls()}`} />
              <button type="button" disabled={resetting} onClick={() => { setConfirmError(''); setShowResetConfirm(true) }}
                className="rounded-xl bg-error px-4 py-2 text-sm font-bold text-on-error hover:opacity-90 disabled:opacity-50">
                {resetting ? '…' : 'Reset'}
              </button>
            </div>
          </div>
          <div className="rounded-xl border border-error/20 bg-error/5 p-4">
            <p className="mb-2 font-label text-xs font-semibold uppercase tracking-wider text-error">Delete Admin</p>
            <p className="mb-3 text-sm text-on-surface-variant">
              Remove this admin account. If historical records exist, the account will be deactivated instead.
            </p>
            <button type="button" disabled={deleting} onClick={() => { setDeleteError(''); setShowDeleteConfirm(true) }}
              className="rounded-xl bg-error px-4 py-2 text-sm font-bold text-on-error hover:opacity-90 disabled:opacity-50">
              {deleting ? 'Deleting…' : 'Delete Admin'}
            </button>
          </div>
          <div className="mt-auto flex gap-3">
            <button type="button" onClick={onClose}
              className="flex-1 rounded-xl border border-outline-variant/30 py-3 text-sm font-semibold hover:bg-surface-container-low">
              Cancel
            </button>
            <button type="button" disabled={saving} onClick={handleSave}
              className="flex-1 rounded-xl bg-primary py-3 text-sm font-bold text-on-primary shadow-sm hover:opacity-90 disabled:opacity-50">
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </div>
      </div>
      {showResetConfirm && (
        <SuperPasswordConfirmModal
          title="Confirm Password Reset"
          body={`Enter your Super Admin password to verify your identity before resetting ${admin.displayName}'s password.`}
          confirmLabel="Confirm Reset"
          destructive
          loading={resetting}
          error={confirmError}
          onCancel={() => { setShowResetConfirm(false); setConfirmError('') }}
          onConfirm={handleResetPassword}
        />
      )}
      {showDeleteConfirm && (
        <SuperPasswordConfirmModal
          title="Confirm Admin Delete"
          body={`Enter your Super Admin password to verify your identity before deleting ${admin.displayName}.`}
          confirmLabel="Delete Admin"
          destructive
          loading={deleting}
          error={deleteError}
          onCancel={() => { setShowDeleteConfirm(false); setDeleteError('') }}
          onConfirm={handleDeleteAdmin}
        />
      )}
    </div>
  )
}

function Field({ label, error, children }) {
  return (
    <div>
      <label className="mb-1.5 block font-label text-xs font-semibold uppercase tracking-wider text-on-surface-variant">{label}</label>
      {children}
      {error && <p className="mt-1 text-xs text-error">{error}</p>}
    </div>
  )
}

function inputCls(err) {
  return `w-full rounded-xl border ${err ? 'border-error' : 'border-outline-variant/30'} bg-white px-4 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-primary/30`
}

export default function AdminManagement() {
  const toast = useToast()
  const fetchAdmins = useCallback(() => adminMgmtApi.list(), [])
  const { data: adminsData, loading, refetch } = useApi(fetchAdmins, null, [])
  const admins = Array.isArray(adminsData) ? adminsData : (adminsData?.data ?? [])

  const fetchBranches = useCallback(() => branchesApi.list(), [])
  const { data: branchesData } = useApi(fetchBranches, null, [])
  const branches = Array.isArray(branchesData) ? branchesData : (branchesData?.data ?? [])

  const [showCreate, setShowCreate] = useState(false)
  const [editAdmin, setEditAdmin] = useState(null)

  return (
    <div className="w-full">
      <div className="mb-6 flex items-start justify-between gap-3">
        <div>
          <h1 className="headline text-2xl font-extrabold tracking-tight text-on-surface md:text-3xl">Admin Management</h1>
          <p className="mt-1 text-sm text-on-surface-variant">Create and manage School Admin and Senior Admin accounts.</p>
        </div>
        <button
          type="button"
          onClick={() => setShowCreate(true)}
          className="flex flex-shrink-0 items-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-body text-sm font-bold text-on-primary shadow-md hover:opacity-90 md:px-5 md:py-3"
        >
          <span className="material-symbols-outlined text-base" aria-hidden>person_add</span>
          <span className="hidden sm:inline">New Admin</span>
          <span className="sm:hidden">New</span>
        </button>
      </div>

      {/* Mobile card list */}
      <div className="space-y-3 md:hidden">
        {loading && <p className="py-4 text-sm text-on-surface-variant">Loading admins…</p>}
        {!loading && admins.length === 0 && (
          <p className="py-4 text-sm text-on-surface-variant">No admin accounts yet. Create one above.</p>
        )}
        {admins.map((admin) => {
          const permCount = countEnabledPermissions(admin.permissions, admin.role)
          return (
            <div key={admin.id} className="flex items-start justify-between rounded-2xl border border-outline-variant/10 bg-surface-container-lowest p-4 shadow-sm">
              <div className="min-w-0 flex-1">
                <p className="font-semibold text-on-surface">{admin.displayName}</p>
                <p className="text-xs text-on-surface-variant">@{admin.username}</p>
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <RoleBadge role={admin.role} />
                  <span className="text-xs text-on-surface-variant">{admin.branch?.name ?? '—'}</span>
                </div>
                <div className="mt-1.5 flex items-center gap-2">
                  <StatusDot isActive={admin.isActive} />
                  <span className="text-xs text-on-surface-variant">{admin.isActive ? 'Active' : 'Inactive'}</span>
                  <span className="text-xs text-outline-variant">·</span>
                  <span className="text-xs text-on-surface-variant">{permCount}/{PERMISSION_KEYS.length} perms</span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setEditAdmin(admin)}
                className="flex h-11 w-11 flex-shrink-0 items-center justify-center rounded-lg text-primary hover:bg-primary/5"
                aria-label={`Edit ${admin.displayName}`}
              >
                <span className="material-symbols-outlined text-base" aria-hidden>edit</span>
              </button>
            </div>
          )
        })}
      </div>

      {/* Desktop table */}
      <div className="hidden overflow-hidden rounded-2xl border border-outline-variant/10 bg-surface-container-lowest shadow-sm md:block">
        <table className="w-full text-left text-sm" style={{ tableLayout: 'fixed' }}>
          <thead className="bg-surface-container-low">
            <tr>
              {[['Name', '25%'], ['Role', '18%'], ['Branch', '17%'], ['Permissions', '15%'], ['Status', '10%'], ['Last Login', '10%'], ['Actions', '5%']].map(([h, w]) => (
                <th key={h} style={{ width: w }} className="px-6 py-4 font-label text-xs font-semibold uppercase tracking-wider text-on-surface-variant">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-surface-container-highest">
            {loading && (
              <tr><td colSpan={7} className="px-6 py-8 text-sm text-on-surface-variant">Loading admins…</td></tr>
            )}
            {!loading && admins.length === 0 && (
              <tr><td colSpan={7} className="px-6 py-8 text-sm text-on-surface-variant">No admin accounts yet. Create one above.</td></tr>
            )}
            {admins.map((admin) => {
              const permCount = countEnabledPermissions(admin.permissions, admin.role)
              return (
                <tr key={admin.id} className="hover:bg-surface-container-low">
                  <td className="overflow-hidden px-6 py-4">
                    <p className="truncate font-semibold">{admin.displayName}</p>
                    <p className="truncate text-xs text-on-surface-variant">{admin.username}</p>
                  </td>
                  <td className="px-6 py-4"><RoleBadge role={admin.role} /></td>
                  <td className="overflow-hidden px-6 py-4">
                    <span className="block truncate text-on-surface-variant">{admin.branch?.name ?? '—'}</span>
                  </td>
                  <td className="px-6 py-4">
                    <span className="text-xs font-medium text-on-surface-variant">{permCount} / {PERMISSION_KEYS.length} on</span>
                  </td>
                  <td className="px-6 py-4">
                    <div className="flex items-center gap-2">
                      <StatusDot isActive={admin.isActive} />
                      <span className="text-xs">{admin.isActive ? 'Active' : 'Inactive'}</span>
                    </div>
                  </td>
                  <td className="px-6 py-4 text-xs text-on-surface-variant">
                    {admin.lastLoginAt ? new Date(admin.lastLoginAt).toLocaleDateString() : 'Never'}
                  </td>
                  <td className="px-6 py-4">
                    <button
                      type="button"
                      onClick={() => setEditAdmin(admin)}
                      className="rounded-lg p-2 text-primary hover:bg-primary/5"
                      aria-label={`Edit ${admin.displayName}`}
                    >
                      <span className="material-symbols-outlined text-base" aria-hidden>edit</span>
                    </button>
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>

      {showCreate && (
        <CreateAdminDrawer
          branches={branches}
          onClose={() => setShowCreate(false)}
          onCreated={() => refetch()}
        />
      )}
      {editAdmin && (
        <EditPermissionsDrawer
          admin={editAdmin}
          branches={branches}
          onClose={() => setEditAdmin(null)}
          onSaved={() => refetch()}
        />
      )}
    </div>
  )
}
