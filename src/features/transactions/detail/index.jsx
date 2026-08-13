import { useCallback, useMemo } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { useApi } from '@/hooks/useApi'
import { transactionsApi } from '@/services/api'
import { useShellPaths } from '@/hooks/useShellPaths'
import { useAnyPermission } from '@/hooks/usePermission'
import FinancialSummary from './components/FinancialSummary'
import OrderSummary from './components/OrderSummary'
import StudentInfo from './components/StudentInfo'
import Timeline from './components/Timeline'
import { buildTransactionDetailFromOrder, buildGroupTransactionDetail } from './buildDetail'
import { useSidebar } from '@/context/SidebarContext'
import './styles.scss'

function statusBadgeClass(status) {
  if (status === 'Paid') return 'bg-secondary-container text-on-secondary-container'
  if (status === 'Partial') return 'bg-blue-100 text-blue-700'
  if (status === 'Credit') return 'bg-blue-100 text-blue-700'
  if (status === 'Pending') return 'bg-amber-100 text-amber-800'
  return 'bg-surface-container-high text-on-surface-variant'
}

function AssistanceCard() {
  return (
    <div className="relative overflow-hidden rounded-xl bg-tertiary-fixed p-6 text-on-tertiary-fixed">
      <div className="relative z-10">
        <h4 className="mb-2 flex items-center gap-2 font-bold">
          <span className="material-symbols-outlined" data-icon="help" aria-hidden>
            help
          </span>
          Need Assistance?
        </h4>
        <p className="mb-4 text-xs leading-relaxed opacity-80">
          Having trouble with this transaction or need to raise a dispute regarding the kit items?
        </p>
        <a className="inline-block font-label text-xs font-black underline decoration-2 underline-offset-4" href="#">
          CONTACT FINANCE DEPT
        </a>
      </div>
      <span
        className="material-symbols-outlined absolute -bottom-4 -right-4 rotate-12 text-8xl opacity-10"
        data-icon="support_agent"
        aria-hidden
      >
        support_agent
      </span>
    </div>
  )
}

export default function TransactionDetail() {
  const { id } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const paths = useShellPaths()
  const { toggle: toggleSidebar, isDesktopCollapsed } = useSidebar()
  const incomingReorderState = location.state?.reorderState
  const returnTo = location.state?.returnTo
  const isGroup = Boolean(location.state?.isGroup)

  const handleBack = () => {
    if (typeof returnTo === 'string' && returnTo.startsWith('/')) {
      navigate(returnTo)
      return
    }
    navigate(paths.transactions)
  }

  const resolvedId = useMemo(() => decodeURIComponent(String(id ?? '')), [id])
  const fetchDetail = useCallback(
    () => isGroup ? transactionsApi.getGroup(resolvedId) : transactionsApi.getOne(resolvedId),
    [resolvedId, isGroup],
  )
  const { data: rawData, loading } = useApi(fetchDetail, null, [resolvedId, isGroup])

  const groupDetail = useMemo(
    () => isGroup ? buildGroupTransactionDetail(rawData ?? {}) : null,
    [isGroup, rawData],
  )

  const detail = useMemo(
    () => isGroup ? { orderId: rawData?.groupRef ?? '—', status: 'Paid', orderedLine: '', financial: {}, student: {}, timeline: [], bookLines: [], uniformItems: [] } : buildTransactionDetailFromOrder(rawData ?? {}),
    [isGroup, rawData],
  )
  const canClearDue = Number(detail?.financial?.dueAmount ?? 0) > 0
  const canEditOrder = useAnyPermission(['canPlaceOrders', 'canRequestOrderEdits', 'canCreateUniformOrders'])
  const reorderState = incomingReorderState ?? detail.reorderState
  const canReorder = Boolean(reorderState?.selectedStudents?.[0]?.id && reorderState?.selectedClass && reorderState?.selectedSection && reorderState?.branchId)
  const orderPk = detail?.id || rawData?.id
  const canOpenEdit = canEditOrder && !isGroup && Boolean(orderPk)

  return (
    <div className="min-h-screen bg-surface font-body text-on-surface">
      <header
        className={`tonal-layering fixed left-0 right-0 top-0 z-50 flex h-16 items-center justify-between border-b border-outline-variant/10 px-3 backdrop-blur-xl md:px-8 ${
          isDesktopCollapsed ? '' : 'lg:left-64'
        }`}
      >
        <div className="flex items-center gap-2 md:gap-4 min-w-0">
          <button
            type="button"
            onClick={toggleSidebar}
            className="shrink-0 rounded-xl p-2 hover:bg-surface-container-highest/50"
            aria-label="Toggle navigation menu"
          >
            <span className="material-symbols-outlined text-on-surface-variant" aria-hidden>menu</span>
          </button>
          <nav className="flex items-center gap-3 md:gap-6 font-headline text-sm font-medium overflow-x-auto no-scrollbar">
            <span className="border-b-2 border-primary py-5 font-bold text-primary whitespace-nowrap">History</span>
            {canReorder && (
              <button
                type="button"
                onClick={() => navigate(paths.ordersConfigure, { state: reorderState })}
                className="rounded-lg px-2 py-1 font-semibold text-primary transition-colors hover:bg-primary/5 whitespace-nowrap"
              >
                Place New Order
              </button>
            )}
          </nav>
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <div className="group relative hidden md:block">
            <span className="absolute inset-y-0 left-3 flex items-center text-on-surface-variant/50">
              <span className="material-symbols-outlined text-[20px]" data-icon="search" aria-hidden>
                search
              </span>
            </span>
            <input
              className="w-48 lg:w-64 rounded-full border-none bg-surface-container-highest/50 py-2 pl-10 pr-4 text-sm transition-all focus:ring-2 focus:ring-primary/20"
              placeholder="Search transactions..."
              type="search"
              autoComplete="off"
            />
          </div>
          <button
            type="button"
            className="rounded-full p-2 text-on-surface-variant transition-colors hover:bg-surface-container-highest/50"
            aria-label="Notifications"
          >
            <span className="material-symbols-outlined" data-icon="notifications" aria-hidden>
              notifications
            </span>
          </button>
        </div>
      </header>

      <div className="mx-auto max-w-7xl px-4 md:px-8 pb-12 pt-20 md:pt-24">
        <div className="mb-10 flex flex-col items-start justify-between gap-6 md:flex-row md:items-center">
          <div>
            <div className="mb-2 flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={handleBack}
                className="rounded-full p-2 text-on-surface-variant transition-colors hover:bg-surface-container-high"
                aria-label="Back"
              >
                <span className="material-symbols-outlined" data-icon="arrow_back" aria-hidden>
                  arrow_back
                </span>
              </button>
              <h2 className="font-headline text-3xl font-extrabold tracking-tight text-on-surface">
                {detail.orderId}
              </h2>
              <span
                className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-wider ${statusBadgeClass(detail.status)}`}
              >
                {detail.status}
              </span>
            </div>
            <p className="ml-12 flex items-center gap-2 text-on-surface-variant">
              <span className="material-symbols-outlined text-sm" data-icon="calendar_today" aria-hidden>
                calendar_today
              </span>
              {detail.orderedLine}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-3">
            {canClearDue && detail.clearDueState?.existingOrderId && (
              <button
                type="button"
                onClick={() => navigate(paths.ordersPayment, { state: detail.clearDueState })}
                className="flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 font-semibold text-on-primary shadow-sm transition-opacity hover:opacity-90"
              >
                <span className="material-symbols-outlined text-[20px]" data-icon="payments" aria-hidden>
                  payments
                </span>
                Clear Due
              </button>
            )}
            {canOpenEdit && (
              <button
                type="button"
                onClick={() => navigate(paths.orderEdit(orderPk), {
                  state: { returnTo: returnTo || paths.transactionDetail(orderPk) },
                })}
                className="flex items-center gap-2 rounded-xl bg-surface-container-lowest px-5 py-2.5 font-semibold text-on-surface shadow-sm transition-colors hover:bg-surface-container-high"
              >
                <span className="material-symbols-outlined text-[20px]" data-icon="edit" aria-hidden>
                  edit
                </span>
                Edit Order
              </button>
            )}
            <button
              type="button"
              className="flex items-center gap-2 rounded-xl bg-surface-container-lowest px-5 py-2.5 font-semibold text-on-surface shadow-sm transition-colors hover:bg-surface-container-high"
            >
              <span className="material-symbols-outlined text-[20px]" data-icon="print" aria-hidden>
                print
              </span>
              Print Receipt
            </button>
            <button
              type="button"
              className="flex items-center gap-2 rounded-xl bg-surface-container-lowest px-5 py-2.5 font-semibold text-on-surface shadow-sm transition-colors hover:bg-surface-container-high"
            >
              <span className="material-symbols-outlined text-[20px]" data-icon="download" aria-hidden>
                download
              </span>
              Download PDF
            </button>
            <button
              type="button"
              className="flex items-center gap-2 rounded-xl bg-error-container px-5 py-2.5 font-semibold text-on-error-container transition-opacity hover:opacity-90"
            >
              <span className="material-symbols-outlined text-[20px]" data-icon="undo" aria-hidden>
                undo
              </span>
              Refund Order
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-6 lg:grid lg:grid-cols-3">
          {loading ? (
            <div className="lg:col-span-3">
              <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
                <div className="flex animate-pulse flex-col gap-6 lg:col-span-2">
                  <div className="h-64 rounded-xl bg-surface-container-low" />
                  <div className="h-56 rounded-xl bg-surface-container-low" />
                </div>
                <div className="flex animate-pulse flex-col gap-6">
                  <div className="h-44 rounded-xl bg-surface-container-low" />
                  <div className="h-44 rounded-xl bg-surface-container-low" />
                  <div className="h-40 rounded-xl bg-surface-container-low" />
                </div>
              </div>
            </div>
          ) : isGroup && groupDetail ? (
            <div className="lg:col-span-3 space-y-4">
              {/* Group payment summary */}
              <div className="rounded-xl border border-outline-variant/10 bg-surface-container-lowest p-5 shadow-sm">
                <p className="mb-1 text-xs font-bold uppercase tracking-widest text-on-surface-variant">Group Payment</p>
                <p className="font-headline text-lg font-bold text-on-surface">{groupDetail.groupRef}</p>
                <p className="text-sm text-on-surface-variant">
                  {groupDetail.paidAt
                    ? new Date(groupDetail.paidAt).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' })
                    : '—'}
                  {' · '}{groupDetail.branchName}
                </p>
                <p className="mt-3 text-2xl font-extrabold text-on-surface">
                  ₹{groupDetail.totalAmount.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </p>
                {groupDetail.paymentSummary && (
                  <p className="text-sm text-on-surface-variant">{groupDetail.paymentSummary}</p>
                )}
                <p className="mt-2 text-xs text-on-surface-variant">Staff: {groupDetail.createdBy}</p>
              </div>

              {/* Per-student order cards */}
              {(groupDetail.orders ?? []).map((order, i) => (
                <div key={i} className="rounded-xl border border-outline-variant/10 bg-surface-container-lowest shadow-sm overflow-hidden">
                  <div className="border-b border-outline-variant/10 bg-surface-container-low px-5 py-3">
                    <p className="font-semibold text-on-surface">{order.student?.name ?? '—'}</p>
                    <p className="text-xs text-on-surface-variant">
                      {order.student?.classShort ?? '—'} · {order.orderId ?? '—'}
                    </p>
                  </div>
                  <div className="p-5">
                    <div className="space-y-1 mb-4">
                      {(order.bookLines ?? []).map((item, j) => (
                        <div key={j} className="flex justify-between text-sm">
                          <span className="text-on-surface-variant truncate pr-2">{item.title}</span>
                          <span className="text-on-surface font-medium shrink-0">₹{Number(item.price).toLocaleString('en-IN')}</span>
                        </div>
                      ))}
                      {(order.uniformItems ?? []).map((item, j) => (
                        <div key={`u${j}`} className="flex justify-between text-sm">
                          <span className="text-on-surface-variant truncate pr-2">{item.title}</span>
                          <span className="text-on-surface font-medium shrink-0">{item.detail}</span>
                        </div>
                      ))}
                    </div>
                    <div className="flex justify-between font-bold text-on-surface border-t border-outline-variant/10 pt-3">
                      <span>Total</span>
                      <span>₹{Number(order.financial?.total ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <>
              <StudentInfo student={detail.student} className="order-1 lg:hidden" />
              <div className="order-2 flex flex-col gap-6 lg:order-none lg:col-span-2">
                <OrderSummary detail={detail} />
                <Timeline entries={detail.timeline ?? []} />
              </div>
              <div className="order-3 flex flex-col gap-6 lg:hidden">
                <FinancialSummary financial={detail.financial} />
                <AssistanceCard />
              </div>
              <aside className="hidden flex-col gap-6 lg:col-span-1 lg:flex">
                <StudentInfo student={detail.student} />
                <FinancialSummary financial={detail.financial} />
                <AssistanceCard />
              </aside>
            </>
          )}
        </div>
      </div>
    </div>
  )
}
