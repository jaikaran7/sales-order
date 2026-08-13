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
import OrderEditRequestsPage from '@/features/orders/edit-requests'
import SuperAdminDashboard from '@/features/super-admin/dashboard'
import SuperAdminSalesOverview from '@/features/super-admin/sales-overview'
import BulkImport from '@/features/super-admin/bulk-import'
import AdminManagement from '@/features/super-admin/admin-management'
import AccountsModule from '@/features/super-admin/accounts'
import ExpensesModule from '@/features/expenses'
import { SuperAdminShellGuard } from '@/routing/ShellGuards'

/** Route element tree (not a component) so parent `<Routes>` registers nested routes. */
export const superAdminShellRouteTree = (
  <Route path="super" element={<SuperAdminShellGuard />}>
    <Route index element={<Navigate to="dashboard" replace relative="path" />} />
    <Route path="dashboard" element={<SuperAdminDashboard />} />
    <Route path="stock" element={<Inventory />} />
    <Route path="reports" element={<SuperAdminSalesOverview />} />
    <Route path="orders/new" element={<NewOrderSelection />} />
    <Route path="orders/configure" element={<OrderConfiguration />} />
    <Route path="orders/payment" element={<OrderPayment />} />
    <Route path="orders/:id/edit" element={<OrderEditFormPage />} />
    <Route path="order-edits" element={<OrderEditRequestsPage />} />
    <Route path="admissions" element={<AdmissionsList />} />
    <Route path="admissions/payment" element={<AdmissionPayment />} />
    <Route path="admissions/transactions" element={<AdmissionTransactions />} />
    <Route path="sales/orders/new" element={<Navigate to="/super/orders/new" replace />} />
    <Route path="sales/orders/configure" element={<Navigate to="/super/orders/configure" replace />} />
    <Route path="sales/orders/payment" element={<Navigate to="/super/orders/payment" replace />} />
    <Route path="sales" element={<Navigate to="/super/reports" replace />} />
    <Route path="transactions/:id" element={<TransactionDetail />} />
    <Route path="transactions" element={<Transactions />} />
    <Route path="bulk-import" element={<BulkImport />} />
    <Route path="admin-management" element={<AdminManagement />} />
    <Route path="accounts" element={<AccountsModule />} />
    <Route path="expenses" element={<ExpensesModule />} />
  </Route>
)
