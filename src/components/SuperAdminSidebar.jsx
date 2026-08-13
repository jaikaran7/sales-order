import { NavLink, useLocation, useNavigate } from 'react-router-dom'
import { useAdminSession } from '@/context/useAdminSession'
import { useSidebar } from '@/context/SidebarContext'

const baseLinkClass =
  'flex items-center gap-3 px-4 py-3 rounded-xl transition-colors font-medium group'

function navClassName({ isActive }) {
  if (isActive) {
    return `${baseLinkClass} bg-white/50 text-primary dark:text-primary-container font-bold`
  }
  return `${baseLinkClass} hover:bg-[#fbf9f8] dark:hover:bg-slate-800 text-[#1b1c1c]/60 dark:text-slate-400`
}

const items = [
  { id: 'dashboard', label: 'Dashboard', to: '/super/dashboard', icon: 'dashboard', end: true },
  { id: 'stock', label: 'Stock', to: '/super/stock', icon: 'inventory_2' },
  {
    id: 'reports',
    label: 'Reports',
    to: '/super/reports',
    icon: 'insert_chart',
    activeIconFill: true,
    activePrefix: '/super/reports',
  },
  { id: 'new-order', label: 'New Order', to: '/super/orders/new', icon: 'add_shopping_cart', activePrefix: '/super/orders' },
  { id: 'admissions', label: 'New Admissions', to: '/super/admissions', icon: 'person_add', activePrefix: '/super/admissions' },
  { id: 'expenses', label: 'Finance', to: '/super/expenses', icon: 'payments', activePrefix: '/super/expenses' },
  { id: 'order-edits', label: 'Order Edits', to: '/super/order-edits', icon: 'rate_review', activePrefix: '/super/order-edits' },
  { id: 'bulk-import', label: 'Bulk Import', to: '/super/bulk-import', icon: 'upload_file' },
  { id: 'accounts', label: 'Accounts', to: '/super/accounts', icon: 'account_balance' },
  { id: 'admin-management', label: 'Admin Mgmt', to: '/super/admin-management', icon: 'manage_accounts' },
  {
    id: 'transactions',
    label: 'Transactions',
    to: '/super/transactions',
    activePrefix: '/super/transactions',
    icon: 'receipt_long',
  },
]

export default function SuperAdminSidebar() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const { user, logout } = useAdminSession()
  const { isOpen, close, dismiss, isDesktopCollapsed } = useSidebar()

  async function handleLogout() {
    await logout()
    navigate('/login', { replace: true })
  }

  return (
    <aside
      className={`fixed left-0 top-0 z-50 flex h-full w-64 flex-col bg-[#f6f3f2] p-6 dark:bg-slate-900 transition-transform duration-300 ease-in-out ${
        isOpen ? 'translate-x-0' : '-translate-x-full'
      } ${isDesktopCollapsed ? 'lg:-translate-x-full' : 'lg:translate-x-0'}`}
    >
      <div className="mb-10 flex items-start justify-between">
        <div>
          <h1 className="text-lg font-bold tracking-tight text-[#1b1c1c] dark:text-slate-100">
            School Kit Manager
          </h1>
          <p className="text-xs font-medium text-[#1b1c1c]/60 dark:text-slate-400">Super Admin</p>
        </div>
        <button
          type="button"
          onClick={dismiss}
          className="rounded-lg p-1.5 hover:bg-black/5"
          aria-label="Close sidebar"
        >
          <span className="material-symbols-outlined text-xl text-[#1b1c1c]/60" aria-hidden>close</span>
        </button>
      </div>
      <nav className="flex flex-grow flex-col gap-2 overflow-y-auto" aria-label="Super admin">
        {items.map((item) => (
          <NavLink
            key={item.id}
            to={item.to}
            onClick={close}
            className={({ isActive }) =>
              navClassName({
                isActive: item.activePrefix ? pathname.startsWith(item.activePrefix) : isActive,
              })
            }
            end={Boolean(item.end)}
          >
            {({ isActive: navIsActive }) => {
              const isActive = item.activePrefix ? pathname.startsWith(item.activePrefix) : navIsActive
              return (
                <>
                  <span
                    className={`material-symbols-outlined${
                      isActive && item.activeIconFill ? ' material-symbols-outlined--fill' : ''
                    }`}
                    data-icon={item.icon}
                    aria-hidden
                  >
                    {item.icon}
                  </span>
                  <span className="font-label">{item.label}</span>
                </>
              )
            }}
          </NavLink>
        ))}
      </nav>
      <div className="mt-auto border-t border-outline-variant/20 pt-6">
        <div className="mb-3 flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-primary text-on-primary font-bold text-sm">
            {user?.displayName?.[0] ?? 'S'}
          </div>
          <div className="flex flex-col min-w-0">
            <span className="text-sm font-bold truncate">{user?.displayName ?? 'Super Admin'}</span>
            <span className="text-xs opacity-60">Super Admin</span>
          </div>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-sm text-error transition-colors hover:bg-error/5"
        >
          <span className="material-symbols-outlined text-base" aria-hidden>logout</span>
          Sign out
        </button>
      </div>
    </aside>
  )
}
