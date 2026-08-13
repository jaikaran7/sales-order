import { Navigate, Route } from 'react-router-dom'
import Inventory from '@/features/inventory'
import NewOrderSelection from '@/features/orders/new-order'
import OrderConfiguration from '@/features/orders/config'
import OrderPayment from '@/features/orders/payment'
import AdmissionsList from '@/features/admissions/list'
import AdmissionPayment from '@/features/admissions/payment'
import AdmissionTransactions from '@/features/admissions/transactions'
import Transactions from '@/features/transactions'
import TransactionDetail from '@/features/transactions/detail'
import OrderEditFormPage from '@/features/orders/edit-order'
import AccountsModule from '@/features/super-admin/accounts'
import BulkImport from '@/features/super-admin/bulk-import'
import SalesOverview from '@/features/sales/dashboard/SalesOverview'
import Settings from '@/features/admin/settings'
import { useAnyPermission, usePermission } from '@/hooks/usePermission'
import { useAdminSession } from '@/context/AdminSessionProvider'
import { SeniorAdminShellGuard, SessionLoadingScreen } from '@/routing/ShellGuards'
import AdminDashboard from '@/features/admin/dashboard'
import BranchShellSmartRedirect from '@/routing/BranchShellSmartRedirect'
import ExpensesModule from '@/features/expenses'

function GuardedModule({ flag, children }) {
  const { permissionsReady } = useAdminSession()
  const allowed = usePermission(flag)
  if (!permissionsReady) return <SessionLoadingScreen />
  if (!allowed) return <BranchShellSmartRedirect segment="senior" />
  return children
}

function GuardedAnyModule({ flags, children }) {
  const { permissionsReady } = useAdminSession()
  const allowed = useAnyPermission(flags)
  if (!permissionsReady) return <SessionLoadingScreen />
  if (!allowed) return <BranchShellSmartRedirect segment="senior" />
  return children
}

function GuardedAccounts({ children }) {
  const { permissionsReady } = useAdminSession()
  const canManageAccounts = usePermission('canManageAccounts')
  const canManagePublishers = usePermission('canManagePublishers')
  const canViewPublisherFinancials = usePermission('canViewPublisherFinancials')
  if (!permissionsReady) return <SessionLoadingScreen />
  if (!(canManageAccounts || canManagePublishers || canViewPublisherFinancials)) {
    return <BranchShellSmartRedirect segment="senior" />
  }
  return children
}

export const seniorAdminShellRouteTree = (
  <Route path="senior" element={<SeniorAdminShellGuard />}>
    <Route index element={<BranchShellSmartRedirect segment="senior" />} />
    <Route path="dashboard" element={<GuardedModule flag="canViewDashboard"><AdminDashboard /></GuardedModule>} />
    <Route path="inventory" element={<GuardedAnyModule flags={['canUpdateStock', 'canViewUniformStock']}><Inventory /></GuardedAnyModule>} />
    <Route path="orders/new" element={<GuardedAnyModule flags={['canPlaceOrders', 'canCreateUniformOrders', 'canViewStudentList']}><NewOrderSelection /></GuardedAnyModule>} />
    <Route path="orders/configure" element={<GuardedAnyModule flags={['canPlaceOrders', 'canCreateUniformOrders']}><OrderConfiguration /></GuardedAnyModule>} />
    <Route path="orders/payment" element={<GuardedAnyModule flags={['canPlaceOrders', 'canCreateUniformOrders']}><OrderPayment /></GuardedAnyModule>} />
    <Route path="orders/:id/edit" element={<GuardedAnyModule flags={['canPlaceOrders', 'canRequestOrderEdits', 'canCreateUniformOrders']}><OrderEditFormPage /></GuardedAnyModule>} />
    <Route path="admissions" element={<GuardedModule flag="canViewAdmissions"><AdmissionsList /></GuardedModule>} />
    <Route path="admissions/payment" element={<GuardedModule flag="canManageAdmissions"><AdmissionPayment /></GuardedModule>} />
    <Route path="admissions/transactions" element={<GuardedModule flag="canViewAdmissionTransactions"><AdmissionTransactions /></GuardedModule>} />
    <Route path="reports" element={<GuardedModule flag="canViewReports"><SalesOverview /></GuardedModule>} />
    <Route path="expenses" element={<GuardedModule flag="canViewExpenses"><ExpensesModule /></GuardedModule>} />
    <Route path="sales" element={<Navigate to="/senior/reports" replace />} />
    <Route path="accounts" element={<GuardedAccounts><AccountsModule /></GuardedAccounts>} />
    <Route path="settings" element={<GuardedModule flag="canViewSettings"><Settings /></GuardedModule>} />
    <Route path="bulk-import" element={<GuardedModule flag="canBulkImport"><BulkImport /></GuardedModule>} />
    <Route path="transactions/:id" element={<GuardedAnyModule flags={['canViewStudentPurchaseDetails', 'canViewTransactions7Days', 'canViewTransactionsAllTime']}><TransactionDetail /></GuardedAnyModule>} />
    <Route path="transactions" element={<GuardedAnyModule flags={['canViewTransactions7Days', 'canViewTransactionsAllTime']}><Transactions /></GuardedAnyModule>} />
    <Route path="*" element={<BranchShellSmartRedirect segment="senior" />} />
  </Route>
)
