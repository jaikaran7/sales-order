import { useMemo } from 'react'
import { ROLES } from '@/config/navigation'
import { useAdminSession } from '@/context/AdminSessionProvider'

export function useShellPaths() {
  const { role } = useAdminSession()

  return useMemo(() => {
    if (role === ROLES.SUPER_ADMIN) {
      return {
        dashboard: '/super/dashboard',
        stock: '/super/stock',
        reports: '/super/reports',
        transactions: '/super/transactions',
        transactionDetail: (id) => `/super/transactions/${id}`,
        ordersNew: '/super/orders/new',
        ordersConfigure: '/super/orders/configure',
        ordersPayment: '/super/orders/payment',
        orderEdit: (id) => `/super/orders/${id}/edit`,
        orderEdits: '/super/order-edits',
        admissions: '/super/admissions',
        admissionsPayment: '/super/admissions/payment',
        admissionsTransactions: '/super/admissions/transactions',
      }
    }
    if (role === ROLES.SENIOR_ADMIN) {
      return {
        dashboard: '/senior/dashboard',
        stock: '/senior/inventory',
        reports: '/senior/reports',
        transactions: '/senior/transactions',
        transactionDetail: (id) => `/senior/transactions/${id}`,
        ordersNew: '/senior/orders/new',
        ordersConfigure: '/senior/orders/configure',
        ordersPayment: '/senior/orders/payment',
        orderEdit: (id) => `/senior/orders/${id}/edit`,
        ordersHub: '/senior/orders/new',
        admissions: '/senior/admissions',
        admissionsPayment: '/senior/admissions/payment',
        admissionsTransactions: '/senior/admissions/transactions',
      }
    }
    return {
      dashboard: '/admin/dashboard',
      stock: '/admin/inventory',
      reports: '/admin/reports',
      settings: '/admin/settings',
      transactions: '/admin/transactions',
      transactionDetail: (id) => `/admin/transactions/${id}`,
      ordersNew: '/admin/orders/new',
      ordersConfigure: '/admin/orders/configure',
      ordersPayment: '/admin/orders/payment',
      orderEdit: (id) => `/admin/orders/${id}/edit`,
      ordersHub: '/admin/orders',
      admissions: '/admin/admissions',
      admissionsPayment: '/admin/admissions/payment',
      admissionsTransactions: '/admin/admissions/transactions',
    }
  }, [role])
}
