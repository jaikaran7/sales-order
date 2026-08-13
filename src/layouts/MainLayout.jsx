import { Outlet, useLocation } from 'react-router-dom'
import AdminSidebar from '@/components/AdminSidebar'
import SuperAdminSidebar from '@/components/SuperAdminSidebar'
import SeniorAdminSidebar from '@/components/SeniorAdminSidebar'
import Topbar from '@/components/Topbar'
import { SidebarProvider, useSidebar } from '@/context/SidebarContext'
import { useAuthGuard } from '@/hooks/useAuthGuard'

function LayoutShell() {
  // Secondary auth guard — catches expired tokens mid-session before any API call
  useAuthGuard()
  const { pathname } = useLocation()
  const { isOpen, close, isDesktopCollapsed } = useSidebar()

  const isSuperShell = pathname.startsWith('/super')
  const isSeniorShell = pathname.startsWith('/senior')

  const isInventory =
    pathname.startsWith('/super/stock') ||
    pathname.startsWith('/admin/inventory') ||
    pathname.startsWith('/senior/inventory')
  const isOrdersShell =
    pathname.startsWith('/super/orders/new') ||
    pathname.startsWith('/super/orders/configure') ||
    pathname.startsWith('/super/orders/payment') ||
    (pathname.includes('/orders/') && pathname.endsWith('/edit')) ||
    pathname.startsWith('/super/order-edits') ||
    pathname.startsWith('/admin/orders') ||
    pathname.startsWith('/senior/orders')
  const isTransactionDetail =
    /^\/super\/transactions\/.+/.test(pathname) ||
    /^\/admin\/transactions\/.+/.test(pathname) ||
    /^\/senior\/transactions\/.+/.test(pathname)
  const hideShellTopbar = isInventory || isOrdersShell || isTransactionDetail

  const Sidebar = isSuperShell ? SuperAdminSidebar : isSeniorShell ? SeniorAdminSidebar : AdminSidebar

  // Use padding (not margin) for the desktop sidebar offset. When the sidebar is collapsed on lg+, skip pl-64.
  const lgPad = isDesktopCollapsed ? '' : 'lg:pl-64'
  // For content pages the sidebar offset and the horizontal gap must be on the SAME property (padding-left).
  // Using px-* alongside pl-64 causes a conflict — pl-64 overrides px-*'s left side leaving zero content gap.
  // Instead we use separate pl-* and pr-* so there is no conflict at any breakpoint.
  const lgContentLeft = isDesktopCollapsed ? 'lg:pl-12' : 'lg:pl-[calc(16rem+3rem)]'
  const shellMainClass = hideShellTopbar
    ? isInventory
      ? `flex h-screen min-h-0 w-full min-w-0 flex-col overflow-hidden bg-surface ${lgPad}`
      : `w-full min-w-0 min-h-screen bg-surface ${lgPad}`
    : `w-full min-w-0 min-h-screen bg-surface pb-12 pl-6 pr-6 pt-20 md:pl-10 md:pr-10 lg:pr-12 lg:pt-24 ${lgContentLeft}`

  return (
    <div className="min-h-full w-full bg-surface text-on-surface font-body">
      <Sidebar />
      {!hideShellTopbar ? <Topbar /> : null}
      {/* Mobile backdrop overlay */}
      {isOpen && (
        <div
          className="fixed inset-0 z-40 bg-black/50 lg:hidden"
          onClick={close}
          aria-hidden="true"
        />
      )}
      <main className={shellMainClass}>
        <Outlet />
      </main>
    </div>
  )
}

export default function MainLayout() {
  return (
    <SidebarProvider>
      <LayoutShell />
    </SidebarProvider>
  )
}
