import { useCallback, useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { useAdminSession } from '@/context/useAdminSession'
import { branchesApi, transactionsApi } from '@/services/api'
import { useApi } from '@/hooks/useApi'
import { usePermission } from '@/hooks/usePermission'
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom'
import { useShellPaths } from '@/hooks/useShellPaths'
import { ROLES } from '@/config/navigation'
import BranchCampusSelect from './components/BranchCampusSelect'
import FiltersBar from './components/FiltersBar'
import TransactionPrintReport from './components/TransactionPrintReport'
import {
  buildTransactionHistoryPdfFilename,
  formatReportDateRange,
  getTransactionDateRange,
  isCustomDateRangeIncomplete,
  periodKpiLabels,
} from './transactionDateRange'
import {
  buildTransactionQueryParams,
  normalizeTransactions,
  validateReportIntegrity,
} from './transactionQuery'
import { branchDisplayName } from '@/utils/branchDisplayName'
import TransactionsTable from './components/TransactionsTable'
import { paymentMethodLabel } from '@/constants/paymentMethods'
import {
  buildTransactionListSearchParams,
  DEFAULT_DUE_FILTERS,
  DEFAULT_FILTERS,
  parseTransactionListState,
  transactionListReturnPath,
} from './transactionFilterSearchParams'
import './transactionsPrint.scss'
import './transactionsLayout.scss'

const ROLE_LABELS = {
  [ROLES.SUPER_ADMIN]: 'Super Admin',
  [ROLES.SENIOR_ADMIN]: 'Senior Admin',
  [ROLES.ADMIN]: 'Admin',
}

const PAGE_SIZE = 100

const LIMITED_DATE_OPTIONS = [
  { value: 'today', label: 'Today' },
  { value: 'yesterday', label: 'Yesterday' },
  { value: '7d', label: 'Last 7 Days' },
  { value: 'custom', label: 'Custom Date' },
]

function formatCurrency(n) {
  return `₹${Number(n).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
}

function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
}

const INITIALS_CLASSES = [
  'bg-primary-fixed text-primary',
  'bg-tertiary-fixed text-tertiary',
  'bg-secondary-container text-on-secondary-container',
  'bg-primary-fixed-dim text-on-primary-fixed',
  'bg-outline-variant text-on-surface',
]

function mapTransactionToRow(tx, idx) {
  // Group transaction row
  if (tx.isGroup) {
    const order = tx.order ?? {}
    const student = order.student ?? {}
    const names = (tx.studentNames ?? []).slice(0, 2).join(', ') + (tx.studentNames?.length > 2 ? ` +${tx.studentNames.length - 2}` : '')
    return {
      id: tx.id,
      serialNo: idx + 1,
      orderPk: tx.groupId,
      orderId: tx.groupId,
      date: formatDate(tx.paidAt ?? tx.createdAt),
      orderedLine: `Group order — ${tx.studentCount ?? tx.studentNames?.length ?? 2} students`,
      studentName: names || 'Multiple Students',
      initials: student.initials ?? 'GRP',
      initialsClass: INITIALS_CLASSES?.[idx % (INITIALS_CLASSES?.length ?? 6)],
      classLabel: `${tx.studentCount ?? tx.studentNames?.length ?? 2} students`,
      kitType: tx.paymentMethod ?? '—',
      amount: Number(tx.groupCategoryAmount ?? tx.amount),
      status: 'Paid',
      remarks: '',
      remarksFull: '',
      orderNotes: '',
      branchName: branchDisplayName?.(order.branch) ?? order.branch?.name ?? '—',
      isGroup: true,
      groupId: tx.groupId,
      studentCount: tx.studentCount,
      studentNames: tx.studentNames,
    }
  }

  const order = tx.order ?? {}
  const student = order.student ?? {}
  const studentClass = student.class?.label
    ? `${student.class.label}${student.class.section ? `-${student.class.section}` : ''}`
    : (student.rollNumber ? `Roll ${student.rollNumber}` : '—')
  const orderNotes = (order.notes && String(order.notes).trim()) || ''
  const txNotes = (tx.notes && String(tx.notes).trim()) || ''
  const remarksFull = orderNotes || txNotes
  const remarks =
    remarksFull.length > 40 ? `${remarksFull.slice(0, 40)}…` : remarksFull
  return {
    id: tx.id,
    serialNo: idx + 1,
    orderPk: order.id ?? null,
    orderId: order.orderId ?? tx.id,
    date: formatDate(tx.paidAt ?? tx.createdAt),
    orderedLine: `Ordered on ${new Date(order.orderDate ?? tx.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
    studentName: student.name ?? 'Unknown',
    initials: student.initials ?? '??',
    initialsClass: INITIALS_CLASSES[idx % INITIALS_CLASSES.length],
    classLabel: studentClass,
    kitType: tx.paymentMethod ?? '—',
    amount: Number(tx.categoryAmount ?? tx.amount),
    isCombined: tx.isCombined ?? false,
    status: tx.paymentMethod === 'CREDIT'
      ? 'Credit'
      : tx.status === 'PAID'
        ? 'Paid'
        : tx.status === 'PARTIAL'
          ? 'Partial'
          : 'Pending',
    remarks,
    remarksFull,
    orderNotes,
    branchName: branchDisplayName(order.branch),
  }
}

function mapStudentTransactionToRow(row, idx) {
  const order = row.order ?? {}
  const student = row.student ?? order.student ?? {}
  const studentClass = student.class?.label
    ? `${student.class.label}${student.class.section ? `-${student.class.section}` : ''}`
    : (student.rollNumber ? `Roll ${student.rollNumber}` : '—')
  const remarksFull = String(row.remarks || row.notes || '').trim()
  const remarks = remarksFull.length > 40 ? `${remarksFull.slice(0, 40)}…` : remarksFull
  const methodLabel = Array.isArray(row.paymentMethods) && row.paymentMethods.length
    ? row.paymentMethods.map(paymentMethodLabel).join(' + ')
    : paymentMethodLabel(row.paymentMethod)

  return {
    id: `student-${row.studentId ?? row.id}`,
    serialNo: idx + 1,
    orderPk: row.orderPk ?? order.id ?? null,
    orderId: row.orderId ?? order.orderId ?? row.id,
    date: formatDate(row.paidAt ?? row.createdAt),
    orderedLine: `Latest payment on ${new Date(row.paidAt ?? row.createdAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`,
    studentName: student.name ?? 'Unknown',
    initials: student.initials ?? '??',
    initialsClass: INITIALS_CLASSES[idx % INITIALS_CLASSES.length],
    classLabel: studentClass,
    kitType: methodLabel || '—',
    amount: Number(row.totalAmount ?? row.amount ?? 0),
    status: row.status === 'FULLY_PAID' ? 'Fully Paid' : 'Partial',
    remarks,
    remarksFull,
    orderNotes: remarksFull,
    branchName: branchDisplayName(row.branch ?? order.branch),
    transactionCount: Number(row.transactionCount ?? 0),
  }
}

export default function Transactions() {
  const { branchId, role, user } = useAdminSession()
  const isSuperAdmin = role === ROLES.SUPER_ADMIN
  const canSwitchBranches = isSuperAdmin || !branchId
  const canViewTransactionsAllTime = usePermission('canViewTransactionsAllTime')
  const canViewBooksTransactions = usePermission('canViewBooksTransactions')
  const canViewUniformTransactions = usePermission('canViewUniformTransactions')
  const limitedDateHistory = !isSuperAdmin && !canViewTransactionsAllTime

  const visibleCategoryTabs = useMemo(() => {
    if (isSuperAdmin || (canViewBooksTransactions && canViewUniformTransactions)) {
      return ['all', 'books', 'uniforms']
    }
    const tabs = []
    if (canViewBooksTransactions) tabs.push('books')
    if (canViewUniformTransactions) tabs.push('uniforms')
    return tabs
  }, [isSuperAdmin, canViewBooksTransactions, canViewUniformTransactions])
  const location = useLocation()
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  const paths = useShellPaths()
  const defaultBranch = branchId || 'all'
  const initialListState = useMemo(
    () => {
      const parsed = parseTransactionListState(searchParams, { defaultBranch })
      // Clamp the initial category to what the account may view so a books-only /
      // uniforms-only admin never even briefly requests the combined dataset.
      if (visibleCategoryTabs.length > 0 && !visibleCategoryTabs.includes(parsed.appliedFilters.category)) {
        const scoped = visibleCategoryTabs[0]
        parsed.filters = { ...parsed.filters, category: scoped }
        parsed.appliedFilters = { ...parsed.appliedFilters, category: scoped }
      }
      return parsed
    },
    // Parse URL only on first mount (e.g. browser back from detail restores filters from query string).
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )
  const [activeTab, setActiveTab] = useState(initialListState.activeTab)
  const [filters, setFilters] = useState(initialListState.filters)
  const [appliedFilters, setAppliedFilters] = useState(initialListState.appliedFilters)
  const [customDateError, setCustomDateError] = useState('')
  const [selectedBranchFilter, setSelectedBranchFilter] = useState(initialListState.selectedBranchFilter)
  const [viewMode, setViewMode] = useState(initialListState.viewMode)
  const [page, setPage] = useState(initialListState.page)

  const listReturnPath = useMemo(
    () => transactionListReturnPath(location.pathname, location.search),
    [location.pathname, location.search],
  )

  useEffect(() => {
    const nextParams = buildTransactionListSearchParams({
      appliedFilters,
      page,
      activeTab,
      viewMode,
      selectedBranchFilter,
      defaultBranch,
      canSwitchBranches,
    })
    const nextSearch = nextParams.toString()
    if (nextSearch !== searchParams.toString()) {
      setSearchParams(nextParams, { replace: true })
    }
  }, [
    appliedFilters,
    page,
    activeTab,
    viewMode,
    selectedBranchFilter,
    defaultBranch,
    canSwitchBranches,
    searchParams,
    setSearchParams,
  ])

  const handleBranchChange = useCallback((branch) => {
    setSelectedBranchFilter(branch)
    setFilters((prev) => ({ ...prev, class: '' }))
    setAppliedFilters((prev) => ({ ...prev, class: '' }))
    setPage(1)
  }, [])

  const updateFilter = (key, val) => {
    if (key === 'date' && val === 'custom') {
      setFilters((prev) => ({ ...prev, date: 'custom', customDateFrom: '', customDateTo: '' }))
      setAppliedFilters((prev) => ({ ...prev, date: 'custom', customDateFrom: '', customDateTo: '' }))
      setCustomDateError('')
      setPage(1)
      return
    }

    if (key === 'date' && val !== 'custom') {
      setFilters((prev) => ({ ...prev, [key]: val, customDateFrom: '', customDateTo: '' }))
      setAppliedFilters((prev) => ({ ...prev, [key]: val, customDateFrom: '', customDateTo: '' }))
      setCustomDateError('')
      setPage(1)
      return
    }

    setFilters((prev) => ({ ...prev, [key]: val }))
    if (key === 'search') return

    // Custom from/to dates apply only via Apply range / Apply Filters.
    if (key === 'customDateFrom' || key === 'customDateTo') return

    setAppliedFilters((prev) => ({ ...prev, [key]: val }))
    setPage(1)
  }

  const handleTabChange = useCallback((nextTab) => {
    if (nextTab === activeTab) return

    setActiveTab(nextTab)
    setPage(1)

    const nextDefaults = nextTab === 'dues' ? DEFAULT_DUE_FILTERS : DEFAULT_FILTERS
    setFilters(nextDefaults)
    setAppliedFilters(nextDefaults)
    setCustomDateError('')
  }, [activeTab])

  const handleCategoryChange = useCallback((nextCategory) => {
    setAppliedFilters((prev) => ({ ...prev, category: nextCategory }))
    setFilters((prev) => ({ ...prev, category: nextCategory }))
    setPage(1)
  }, [])

  useEffect(() => {
    if (visibleCategoryTabs.length === 0) return
    if (!visibleCategoryTabs.includes(appliedFilters.category)) {
      handleCategoryChange(visibleCategoryTabs[0])
    }
  }, [visibleCategoryTabs, appliedFilters.category, handleCategoryChange])

  const clearFilters = () => {
    const nextDefaults = activeTab === 'dues' ? DEFAULT_DUE_FILTERS : DEFAULT_FILTERS
    setFilters(nextDefaults)
    setAppliedFilters(nextDefaults)
    setPage(1)
    if (canSwitchBranches) setSelectedBranchFilter('all')
  }

  const fetchBranches = useCallback(
    () => (canSwitchBranches ? branchesApi.list() : null),
    [canSwitchBranches],
  )
  const { data: branchesData } = useApi(fetchBranches, null, [canSwitchBranches])
  const branches = Array.isArray(branchesData) ? branchesData : (branchesData?.data ?? [])

  const customDateIncomplete = isCustomDateRangeIncomplete(appliedFilters.date, appliedFilters)

  const dateRange = useMemo(() => {
    if (customDateIncomplete) return {}
    return getTransactionDateRange(appliedFilters.date, {
      customDateFrom: appliedFilters.customDateFrom,
      customDateTo: appliedFilters.customDateTo,
    })
  }, [appliedFilters.date, appliedFilters.customDateFrom, appliedFilters.customDateTo, customDateIncomplete])

  const allBranchesSelected = canSwitchBranches && selectedBranchFilter === 'all'
  const effectiveBranchId = allBranchesSelected ? undefined : (canSwitchBranches ? selectedBranchFilter : branchId)

  const queryFilterInput = useMemo(
    () => ({
      effectiveBranchId,
      allBranchesSelected,
      appliedFilters,
      dateRange,
    }),
    [effectiveBranchId, allBranchesSelected, appliedFilters, dateRange],
  )

  const kpiQueryParams = useMemo(() => {
    if (activeTab === 'dues') return { _skipFetch: true }
    if (customDateIncomplete) return { _skipFetch: true }
    return buildTransactionQueryParams({ ...queryFilterInput, limit: PAGE_SIZE })
  }, [activeTab, queryFilterInput, customDateIncomplete])
  const listQueryParams = useMemo(() => {
    if (customDateIncomplete) return { _skipFetch: true }
    return buildTransactionQueryParams({ ...queryFilterInput, limit: PAGE_SIZE, page })
  }, [queryFilterInput, page, customDateIncomplete])
  const dueQueryParams = useMemo(() => {
    if (customDateIncomplete) return { _skipFetch: true }
    return buildTransactionQueryParams({ ...queryFilterInput, forDues: true, limit: PAGE_SIZE, page })
  }, [queryFilterInput, page, customDateIncomplete])
  const kpiDepsKey = JSON.stringify(kpiQueryParams)
  const listDepsKey = JSON.stringify({ viewMode, ...listQueryParams })
  const dueDepsKey = JSON.stringify(dueQueryParams)

  const fetchKpis = useCallback((params) => {
    if (params?._skipFetch) return null
    return transactionsApi.getKpis(params ?? {})
  }, [])
  const { data: kpisData, loading: kpisLoading } = useApi(fetchKpis, kpiQueryParams, [kpiDepsKey])

  const periodLabels = useMemo(
    () => periodKpiLabels(appliedFilters.date),
    [appliedFilters.date],
  )

  const fetchTransactions = useCallback(
    (params) => {
      if (params?._skipFetch) return null
      return viewMode === 'students'
        ? transactionsApi.listByStudent(params ?? {})
        : transactionsApi.list(params ?? {})
    },
    [viewMode],
  )
  const { data: txData, meta: txMeta, loading: txLoading } = useApi(fetchTransactions, listQueryParams, [listDepsKey])

  const fetchDueOrders = useCallback((params) => {
    if (params?._skipFetch) return null
    return transactionsApi.getDues(params ?? {})
  }, [])
  const { data: dueData, meta: dueMeta, loading: dueLoading } = useApi(fetchDueOrders, dueQueryParams, [dueDepsKey])

  const rawRows = customDateIncomplete
    ? []
    : (Array.isArray(txData) ? txData : (txData?.data ?? []))

  const scopedTransactions = useMemo(
    () =>
      normalizeTransactions(rawRows, {
        branchId: effectiveBranchId,
        allBranches: allBranchesSelected,
      }),
    [rawRows, effectiveBranchId, allBranchesSelected],
  )

  const totalCount = customDateIncomplete ? 0 : Number(txMeta?.total ?? 0)
  const totalPages = customDateIncomplete ? 1 : Math.max(1, Number(txMeta?.totalPages ?? 1))
  const hasPrev = customDateIncomplete ? false : Boolean(txMeta?.hasPrev ?? page > 1)
  const hasNext = customDateIncomplete ? false : Boolean(txMeta?.hasNext ?? page < totalPages)

  const cashReceived = customDateIncomplete ? 0 : (kpisData?.cashReceived ?? 0)
  const onlineReceived = customDateIncomplete ? 0 : (kpisData?.onlineReceived ?? 0)
  const creditReceived = customDateIncomplete ? 0 : (kpisData?.creditReceived ?? 0)
  // Revenue = real collections only (never credit). Derive from buckets so stale API cache cannot re-add credit.
  const revenueToday = customDateIncomplete ? 0 : (cashReceived + onlineReceived)
  // Credit KPI = outstanding pure-credit dues in the selected date/filter range.
  const ordersToday = customDateIncomplete ? 0 : (kpisData?.ordersToday ?? 0)
  const uniqueStudents = customDateIncomplete ? 0 : (kpisData?.uniqueStudents ?? kpisData?.studentsToday ?? 0)
  const branchName = useMemo(() => {
    if (!canSwitchBranches) return branchDisplayName(user?.branch) || 'Branch'
    if (selectedBranchFilter === 'all') return 'All Branches'
    const match = branches.find((b) => b.id === selectedBranchFilter)
    return match ? branchDisplayName(match) : 'All Branches'
  }, [canSwitchBranches, user?.branch?.name, selectedBranchFilter, branches])

  const reportDateRangeLabel = useMemo(
    () => formatReportDateRange(appliedFilters.date, {
      customDateFrom: appliedFilters.customDateFrom,
      customDateTo: appliedFilters.customDateTo,
    }),
    [appliedFilters.date, appliedFilters.customDateFrom, appliedFilters.customDateTo],
  )

  const handleApplyFilters = useCallback(() => {
    if (filters.date === 'custom') {
      if (!filters.customDateFrom) {
        setCustomDateError('Start date is required for a custom range.')
        return
      }
      if (filters.customDateTo && filters.customDateTo < filters.customDateFrom) {
        setCustomDateError('End date cannot be before start date.')
        return
      }
      if (limitedDateHistory) {
        const from = new Date(`${filters.customDateFrom}T00:00:00`)
        const to = new Date(`${filters.customDateTo || filters.customDateFrom}T00:00:00`)
        const spanDays = Math.floor((to - from) / (24 * 60 * 60 * 1000)) + 1
        const today = new Date()
        const earliest = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 6)
        if (from < earliest || spanDays > 7) {
          setCustomDateError('This account can only view transaction history from the last 7 days.')
          return
        }
      }
    }
    setCustomDateError('')
    setAppliedFilters(filters)
    setPage(1)
  }, [filters, limitedDateHistory])

  const [printedAt, setPrintedAt] = useState(() => new Date())
  const printedAtLabel = printedAt.toLocaleString('en-IN', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  })

  const transactionsRows = useMemo(
    () => scopedTransactions.map((tx, i) => (
      viewMode === 'students'
        ? mapStudentTransactionToRow(tx, (page - 1) * PAGE_SIZE + i)
        : mapTransactionToRow(tx, (page - 1) * PAGE_SIZE + i)
    )),
    [scopedTransactions, page, viewMode],
  )

  const dueOrders = useMemo(() => (Array.isArray(dueData) ? dueData : (dueData?.data ?? []))
    .map((order) => {
      const total = Number(order.totalAmount ?? order.total ?? 0)
      const paid = Number(order.paidAmount ?? 0)
      const dueFromApi = Number(order.dueAmount)
      const due = Number.isFinite(dueFromApi) && dueFromApi > 0
        ? dueFromApi
        : Math.max(0, total - paid)
      const txs = Array.isArray(order.transactions) ? order.transactions : []
      const hasCredit = txs.some((tx) => tx.paymentMethod === 'CREDIT')
      const isPureCredit = paid <= 0 && (hasCredit || order.paymentStatus === 'UNPAID')
      return {
        id: order.id,
        orderId: order.orderId,
        date: formatDate(order.orderDate ?? order.createdAt),
        studentId: order.student?.id ?? null,
        studentName: order.student?.name ?? 'Unknown',
        studentRoll: order.student?.rollNumber ?? '',
        guardianName: order.student?.guardianName ?? 'N/A',
        guardianPhone: order.student?.guardianPhone ?? '',
        total,
        paid,
        due,
        hasCredit: isPureCredit,
        paymentStatus: order.paymentStatus,
        branchName: branchDisplayName(order.branch) || 'Unknown',
        branchId: order.branch?.id ?? null,
        classId: order.student?.class?.id ?? null,
        classGrade: Number(order.student?.class?.grade ?? 0),
        className: order.student?.class?.label ?? 'Class',
        sectionName: `Section ${order.student?.class?.section ?? ''}`.trim(),
        sectionCode: order.student?.class?.section ?? '',
        classLabel: order.student?.class?.label
          ? `${order.student.class.label}${order.student.class.section ? `-${order.student.class.section}` : ''}`
          : '—',
      }
    })
    .filter((o) => o.due > 0)
    .sort((a, b) => {
      const asc = appliedFilters.dueSort === 'asc'
      return asc ? a.due - b.due : b.due - a.due
    }), [dueData, appliedFilters.dueSort])

  const dueSummary = useMemo(() => {
    if (customDateIncomplete) {
      return { dueStudents: 0, totalPendingDue: 0, totalCreditDue: 0 }
    }
    const dueStudents = Number(dueMeta?.total ?? dueOrders.length ?? 0)
    const hasServerSummary = dueMeta != null
      && Object.prototype.hasOwnProperty.call(dueMeta, 'totalPendingDue')
      && Object.prototype.hasOwnProperty.call(dueMeta, 'totalCreditDue')
    if (hasServerSummary) {
      return {
        dueStudents,
        totalPendingDue: Number(dueMeta.totalPendingDue),
        totalCreditDue: Number(dueMeta.totalCreditDue),
      }
    }
    const allRowsLoaded = dueStudents > 0 && dueOrders.length >= dueStudents
    if (allRowsLoaded) {
      const totalPendingDue = dueOrders.reduce((sum, row) => sum + row.due, 0)
      const totalCreditDue = dueOrders
        .filter((row) => row.paid <= 0 && row.hasCredit)
        .reduce((sum, row) => sum + row.due, 0)
      return { dueStudents, totalPendingDue, totalCreditDue }
    }
    return { dueStudents, totalPendingDue: 0, totalCreditDue: 0 }
  }, [customDateIncomplete, dueMeta, dueOrders])

  const { dueStudents, totalPendingDue, totalCreditDue } = dueSummary

  const printSummary = useMemo(
    () => ({
      totalTransactions: viewMode === 'students' ? uniqueStudents : ordersToday,
      totalRevenue: revenueToday,
      cashReceived,
      onlineReceived,
      creditReceived,
      totalPendingDue,
    }),
    [viewMode, uniqueStudents, ordersToday, revenueToday, cashReceived, onlineReceived, creditReceived, totalPendingDue],
  )

  const handlePrint = useCallback(() => {
    const paginatedList = totalCount > transactionsRows.length
    const integrityErrors = paginatedList || viewMode === 'students'
      ? []
      : validateReportIntegrity({
          reportRows: transactionsRows,
          reportSummary: printSummary,
          uiRowCount: transactionsRows.length,
        })
    if (integrityErrors.length > 0) {
      console.error('[transactions print]', integrityErrors)
      window.alert(
        `Cannot print: report data does not match the filtered list.\n\n${integrityErrors.join('\n')}`,
      )
      return
    }
    setPrintedAt(new Date())
    const previousTitle = document.title
    document.title = buildTransactionHistoryPdfFilename({
      datePreset: appliedFilters.date,
      branchName,
    })
    document.body.classList.add('transactions-print-active')
    const onAfterPrint = () => {
      document.body.classList.remove('transactions-print-active')
      document.title = previousTitle
    }
    window.addEventListener('afterprint', onAfterPrint, { once: true })
    requestAnimationFrame(() => {
      requestAnimationFrame(() => window.print())
    })
  }, [transactionsRows, printSummary, appliedFilters.date, branchName, totalCount, viewMode])

  const downloadDueCsv = useCallback(() => {
    if (!dueOrders.length) return
    const escapeCsv = (value) => `"${String(value ?? '').replaceAll('"', '""')}"`
    const headers = ['Order ID', 'Student Name', 'Class', 'Branch', 'Payment Status', 'Total', 'Paid', 'Due']
    const rows = dueOrders.map((row) => [
      row.orderId,
      row.studentName,
      row.classLabel,
      row.branchName,
      row.paymentStatus,
      row.total.toFixed(2),
      row.paid.toFixed(2),
      row.due.toFixed(2),
    ])
    const csv = [headers, ...rows].map((line) => line.map(escapeCsv).join(',')).join('\n')
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `due-list-${new Date().toISOString().slice(0, 10)}.csv`
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
  }, [dueOrders])

  return (
    <div className="relative pb-28">
      <div className={`transactions-page-header ${activeTab === 'transactions' ? 'transactions-page-header--kpi6' : ''}`}>
        <div className="transactions-page-title-block">
          <h1 className="headline text-2xl font-extrabold tracking-tight text-on-surface md:text-4xl">
            Recent Transactions
          </h1>
          <p className="mt-0.5 max-w-xl font-body text-sm font-medium leading-snug text-on-surface-variant md:text-base">
            Overview of kits distribution and fee collections.
          </p>
          {canSwitchBranches ? (
            <BranchCampusSelect
              branches={branches}
              value={selectedBranchFilter}
              onChange={handleBranchChange}
              className="transactions-page-branch"
            />
          ) : null}
        </div>
        {activeTab === 'transactions' ? (
          <div className="transactions-kpi-grid">
            <div className="transactions-kpi-card">
              <p className="transactions-kpi-label">{periodLabels.revenue}</p>
              <p className="transactions-kpi-value text-primary">
                {kpisLoading ? '…' : formatCurrency(revenueToday)}
              </p>
            </div>
            <div className="transactions-kpi-card">
              <p className="transactions-kpi-label">{periodLabels.transactions}</p>
              <p className="transactions-kpi-value text-tertiary">
                {kpisLoading ? '…' : `${ordersToday} ${ordersToday === 1 ? 'transaction' : 'transactions'}`}
              </p>
            </div>
            <div className="transactions-kpi-card">
              <p className="transactions-kpi-label">{periodLabels.students}</p>
              <p className="transactions-kpi-value text-teal-700">
                {kpisLoading ? '…' : `${uniqueStudents} ${uniqueStudents === 1 ? 'student' : 'students'}`}
              </p>
            </div>
            <div className="transactions-kpi-card">
              <p className="transactions-kpi-label">{periodLabels.cash}</p>
              <p className="transactions-kpi-value text-green-700">
                {kpisLoading ? '…' : formatCurrency(cashReceived)}
              </p>
            </div>
            <div className="transactions-kpi-card">
              <p className="transactions-kpi-label">{periodLabels.online}</p>
              <p className="transactions-kpi-value text-blue-700">
                {kpisLoading ? '…' : formatCurrency(onlineReceived)}
              </p>
            </div>
            <div className="transactions-kpi-card">
              <p className="transactions-kpi-label">{periodLabels.credit}</p>
              <p className="transactions-kpi-value text-amber-700">
                {kpisLoading ? '…' : formatCurrency(creditReceived)}
              </p>
            </div>
          </div>
        ) : (
          <div className="transactions-kpi-grid transactions-kpi-grid--dues">
            <div className="transactions-kpi-card">
              <p className="transactions-kpi-label">DUE STUDENTS</p>
              <p className="transactions-kpi-value text-teal-700">
                {dueLoading ? '…' : `${dueStudents} ${dueStudents === 1 ? 'student' : 'students'}`}
              </p>
            </div>
            <div className="transactions-kpi-card">
              <p className="transactions-kpi-label">{periodLabels.pendingDue}</p>
              <p className="transactions-kpi-value text-error">
                {dueLoading ? '…' : formatCurrency(totalPendingDue)}
              </p>
            </div>
            <div className="transactions-kpi-card">
              <p className="transactions-kpi-label">{periodLabels.creditDue}</p>
              <p className="transactions-kpi-value text-amber-700">
                {dueLoading ? '…' : formatCurrency(totalCreditDue)}
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => handleTabChange('transactions')}
            className={`transactions-tab-btn ${activeTab === 'transactions' ? 'bg-primary text-on-primary' : 'bg-surface-container-low text-on-surface-variant'}`}
          >
            Transactions
          </button>
          <button
            type="button"
            onClick={() => handleTabChange('dues')}
            className={`transactions-tab-btn ${activeTab === 'dues' ? 'bg-primary text-on-primary' : 'bg-surface-container-low text-on-surface-variant'}`}
          >
            Due List
          </button>
        </div>

        {activeTab === 'transactions' && visibleCategoryTabs.length > 1 && (
          <div className="flex items-center gap-1 rounded-xl bg-surface-container-low p-1">
            {visibleCategoryTabs.map((cat) => {
              const CATEGORY_LABELS = { all: 'All', books: 'Books', uniforms: 'Uniforms' }
              const label = CATEGORY_LABELS[cat] ?? cat
              const active = appliedFilters.category === cat
              return (
                <button
                  key={cat}
                  type="button"
                  onClick={() => handleCategoryChange(cat)}
                  className={`rounded-lg px-5 py-2 text-sm font-bold transition-colors ${active ? 'bg-primary text-on-primary shadow-sm' : 'text-on-surface-variant hover:bg-surface-container-high'}`}
                >
                  {label}
                </button>
              )
            })}
          </div>
        )}
      </div>

      <FiltersBar
        mode={activeTab === 'dues' ? 'dues' : 'transactions'}
        catalogBranchId={canSwitchBranches ? (selectedBranchFilter === 'all' ? undefined : selectedBranchFilter) : branchId}
        filters={filters}
        appliedFilters={appliedFilters}
        onChange={updateFilter}
        onApply={handleApplyFilters}
        customDateError={customDateError}
        dateOptions={limitedDateHistory ? LIMITED_DATE_OPTIONS : undefined}
        onClear={clearFilters}
        viewMode={viewMode}
        onViewModeChange={(mode) => {
          setViewMode(mode)
          setPage(1)
        }}
        showPrint={activeTab === 'transactions'}
        onPrint={handlePrint}
        printDisabled={txLoading}
      />

      {activeTab === 'transactions' ? (
        <>
          {customDateIncomplete ? (
            <p className="py-8 text-sm text-on-surface-variant">
              Select a start date for the custom range, then click Apply range.
            </p>
          ) : txLoading ? (
            <p className="py-8 text-sm text-on-surface-variant">Loading transactions…</p>
          ) : (
            <TransactionsTable
              rows={transactionsRows}
              total={totalCount}
              page={page}
              pageSize={PAGE_SIZE}
              totalPages={totalPages}
              hasPrev={hasPrev}
              hasNext={hasNext}
              onPageChange={setPage}
              itemLabel={viewMode === 'students' ? 'students' : 'transactions'}
              listReturnPath={listReturnPath}
            />
          )}
        </>
      ) : (
        <div className="mt-2 rounded-xl border border-outline-variant/10 bg-surface-container-lowest p-5 shadow-sm">
          <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-headline text-lg font-bold text-on-surface">Due Students</h3>
            <button
              type="button"
              onClick={downloadDueCsv}
              disabled={!dueOrders.length}
              className="rounded-full bg-primary px-4 py-2 text-xs font-bold text-on-primary shadow-sm disabled:cursor-not-allowed disabled:opacity-50"
            >
              Export CSV
            </button>
          </div>
          {dueLoading ? (
            <p className="text-sm text-on-surface-variant">Loading due list…</p>
          ) : dueOrders.length === 0 ? (
            <p className="text-sm text-on-surface-variant">No pending dues.</p>
          ) : (
            <>
              {/* Mobile: card layout */}
              <div className="md:hidden space-y-3">
                {dueOrders.map((row) => (
                  <div key={row.id} className="rounded-xl border border-outline-variant/10 bg-white p-4 shadow-sm">
                    <div className="mb-3 flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-semibold text-on-surface truncate">{row.studentName}</p>
                        <p className="text-xs text-on-surface-variant">{row.orderId} · {row.classLabel}</p>
                        <p className="text-xs text-on-surface-variant">{row.date}</p>
                      </div>
                      <span className="shrink-0 rounded-full bg-blue-100 px-2.5 py-1 text-xs font-bold text-blue-700">
                        {row.paid <= 0 ? `Credit Order: ${formatCurrency(row.due)}` : (row.paymentStatus === 'PARTIAL' ? 'Partial / Due' : 'Due')}
                      </span>
                    </div>
                    <div className="mb-3 grid grid-cols-3 gap-2 rounded-xl bg-surface-container-low p-3">
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Total</p>
                        <p className="text-sm font-semibold text-on-surface">{formatCurrency(row.total)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Paid</p>
                        <p className="text-sm font-semibold text-on-surface">{formatCurrency(row.paid)}</p>
                      </div>
                      <div>
                        <p className="text-[10px] font-bold uppercase tracking-widest text-on-surface-variant">Due</p>
                        <p className="text-sm font-bold text-error">{formatCurrency(row.due)}</p>
                      </div>
                    </div>
                    <div className="flex gap-2">
                      <button
                        type="button"
                        onClick={() => navigate(paths.transactionDetail(row.id), { state: { returnTo: listReturnPath } })}
                        className="flex-1 rounded-xl border border-outline-variant/30 py-2.5 text-xs font-semibold hover:bg-surface-container-low"
                      >
                        View
                      </button>
                      <button
                        type="button"
                        onClick={() => navigate(paths.ordersPayment, {
                          state: {
                            selectedStudents: [{ id: row.studentId, name: row.studentName, roll: row.studentRoll, guardian: row.guardianName, parentPhone: row.guardianPhone }],
                            selectedClass: { id: row.classGrade, name: row.className },
                            selectedSection: { id: row.classId, name: row.sectionName, section: row.sectionCode },
                            branchId: row.branchId,
                            existingOrderId: row.id,
                            existingOrderNumber: row.orderId,
                            dueAmount: row.due,
                            totalAmount: row.total,
                            paidAmount: row.paid,
                          },
                        })}
                        className="flex-1 rounded-xl bg-primary py-2.5 text-xs font-bold text-on-primary hover:opacity-90"
                      >
                        Clear Due
                      </button>
                    </div>
                  </div>
                ))}
              </div>

              {/* Desktop: table layout */}
              <div className="hidden md:block overflow-x-auto rounded-xl border border-outline-variant/10">
                <table className="w-full text-left text-sm">
                  <thead className="bg-surface-container-low">
                    <tr>
                      <th className="px-4 py-3 text-xs font-bold uppercase tracking-widest text-on-surface-variant">Student Name</th>
                      <th className="px-4 py-3 text-xs font-bold uppercase tracking-widest text-on-surface-variant">Class & Section</th>
                      <th className="px-4 py-3 text-xs font-bold uppercase tracking-widest text-on-surface-variant">Total Amount</th>
                      <th className="px-4 py-3 text-xs font-bold uppercase tracking-widest text-on-surface-variant">Paid Amount</th>
                      <th className="px-4 py-3 text-xs font-bold uppercase tracking-widest text-on-surface-variant">Due Amount</th>
                      <th className="px-4 py-3 text-xs font-bold uppercase tracking-widest text-on-surface-variant">Payment Status</th>
                      <th className="px-4 py-3 text-xs font-bold uppercase tracking-widest text-on-surface-variant">Date</th>
                      <th className="px-4 py-3 text-xs font-bold uppercase tracking-widest text-on-surface-variant">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-outline-variant/10">
                    {dueOrders.map((row) => (
                      <tr key={row.id} className="hover:bg-surface-container-low/60">
                        <td className="px-4 py-3">
                          <p className="font-semibold text-on-surface">{row.studentName}</p>
                          <p className="text-xs text-on-surface-variant">{row.orderId}</p>
                        </td>
                        <td className="px-4 py-3 text-on-surface-variant">{row.classLabel}</td>
                        <td className="px-4 py-3 font-medium">{formatCurrency(row.total)}</td>
                        <td className="px-4 py-3 font-medium">{formatCurrency(row.paid)}</td>
                        <td className="px-4 py-3 font-bold text-error">{formatCurrency(row.due)}</td>
                        <td className="px-4 py-3">
                          <span className="rounded-full bg-blue-100 px-2.5 py-1 text-xs font-bold text-blue-700">
                            {row.paid <= 0 ? `Credit Order: ${formatCurrency(row.due)}` : (row.paymentStatus === 'PARTIAL' ? 'Partial / Due' : 'Due')}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-on-surface-variant">{row.date}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            <button
                              type="button"
                              onClick={() => navigate(paths.transactionDetail(row.id), { state: { returnTo: listReturnPath } })}
                              className="rounded-lg border border-outline-variant/30 px-2.5 py-1 text-xs font-semibold hover:bg-surface-container-low"
                            >
                              View
                            </button>
                            <button
                              type="button"
                              onClick={() => navigate(paths.ordersPayment, {
                                state: {
                                  selectedStudents: [{ id: row.studentId, name: row.studentName, roll: row.studentRoll, guardian: row.guardianName, parentPhone: row.guardianPhone }],
                                  selectedClass: { id: row.classGrade, name: row.className },
                                  selectedSection: { id: row.classId, name: row.sectionName, section: row.sectionCode },
                                  branchId: row.branchId,
                                  existingOrderId: row.id,
                                  existingOrderNumber: row.orderId,
                                  dueAmount: row.due,
                                  totalAmount: row.total,
                                  paidAmount: row.paid,
                                },
                              })}
                              className="rounded-lg bg-primary px-2.5 py-1 text-xs font-bold text-on-primary hover:opacity-90"
                            >
                              Clear Due
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      )}
      {activeTab === 'transactions'
        ? createPortal(
            <TransactionPrintReport
              branchName={branchName}
              dateRangeLabel={reportDateRangeLabel}
              generatedBy={user?.displayName ?? 'Admin'}
              generatedRole={ROLE_LABELS[role] ?? user?.role ?? 'Admin'}
              printedAt={printedAtLabel}
              summary={printSummary}
              rows={transactionsRows}
            />,
            document.body,
          )
        : null}
    </div>
  )
}
