import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { branchesApi, ordersApi } from '@/services/api'
import { useToast } from '@/context/ToastContext'
import { useShellPaths } from '@/hooks/useShellPaths'
import { useApi } from '@/hooks/useApi'
import Receipt from '../receipt/Receipt'
import OrderSummary from './components/OrderSummary'
import PaymentMethod from './components/PaymentMethod'
import ReceiptOptions from './components/ReceiptOptions'
import SuccessModal from './components/SuccessModal'
import { fallbackPaymentContext } from './data'
import { useSidebar } from '@/context/SidebarContext'
import { CHECKOUT_TO_API_PAYMENT_METHOD, paymentMethodLabel } from '@/constants/paymentMethods'
import './styles.scss'

function formatReceiptDate(d) {
  return d.toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' })
}

function formatReceiptTime(d) {
  return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
}

function parseDueFromOrder(order) {
  if (!order) return 0
  const total = Number(order.total ?? 0)
  const paid = Number(order.paidAmount ?? 0)
  let discount = 0
  const noteMatch = String(order.notes ?? '').match(/Discount [Aa]pplied:\s*₹?([\d,]+(?:\.\d+)?)/)
  if (noteMatch) discount += Number(String(noteMatch[1]).replace(/,/g, ''))
  for (const tx of order.transactions ?? []) {
    const txMatch = String(tx.notes ?? '').match(/Discount [Aa]pplied:\s*₹?([\d,]+(?:\.\d+)?)/)
    if (txMatch) discount += Number(String(txMatch[1]).replace(/,/g, ''))
  }
  const effective = Math.max(0, total - discount)
  return Math.max(0, effective - paid)
}

function buildOrderDetails(orderItems, totals) {
  if (!orderItems?.length) return fallbackPaymentContext.orderDetails

  const bookKit = orderItems
    .filter((i) => i.itemType === 'BOOK')
    .map((i) => ({ label: i.label, price: Number(i.unitPrice) * Number(i.quantity ?? 1) }))

  const uniformKit = orderItems
    .filter((i) => i.itemType === 'UNIFORM')
    .map((i) => ({ label: i.label, price: Number(i.unitPrice) * Number(i.quantity ?? 1) }))

  const subtotal = totals?.total ?? orderItems.reduce((s, i) => s + (Number(i.unitPrice) * Number(i.quantity ?? 1)), 0)
  return {
    bookKit: bookKit.length ? bookKit : [{ label: 'Academic Kit', price: subtotal }],
    uniformKit,
    subtotal,
    administrativeFee: 0,
    total: totals?.total ?? subtotal,
  }
}

const PAYMENT_METHOD_MAP = CHECKOUT_TO_API_PAYMENT_METHOD

export default function OrderPayment() {
  const toast = useToast()
  const location = useLocation()
  const navigate = useNavigate()
  const paths = useShellPaths()
  const { toggle: toggleSidebar } = useSidebar()
  const {
    selectedStudents = [],
    selectedClass: stClass,
    selectedSection: stSection,
    orderItems,
    totals,
    branchId,
    existingOrderId = null,
    existingOrderNumber = null,
    dueAmount: incomingDueAmount = null,
    totalAmount: incomingTotalAmount = null,
    paidAmount: incomingPaidAmount = null,
  } = location.state ?? {}

  const { multiStudentOrder } = location.state ?? {}
  const isGroupOrder = Boolean(
    multiStudentOrder?.completedStudents?.length >= 2
  )
  const groupStudents = isGroupOrder ? multiStudentOrder.completedStudents : []
  const groupGrandTotal = isGroupOrder
    ? groupStudents.reduce((sum, s) => sum + Number(s.totals?.total ?? 0), 0)
    : null

  const fb = fallbackPaymentContext
  const selectedClass = stClass ?? fb.selectedClass
  const selectedSection = stSection ?? fb.selectedSection
  const student = selectedStudents[0] ?? fb.student
  const fetchBranch = useCallback(() => (branchId ? branchesApi.getOne(branchId) : null), [branchId])
  const { data: branchData } = useApi(fetchBranch, null, [branchId])
  const branchName = branchData?.name ?? ''
  const fetchExistingOrder = useCallback(
    () => (existingOrderId ? ordersApi.getOne(existingOrderId) : null),
    [existingOrderId],
  )
  const { data: existingOrderPayload } = useApi(fetchExistingOrder, null, [existingOrderId])
  const existingOrder = existingOrderPayload?.data?.data
    ?? existingOrderPayload?.data
    ?? existingOrderPayload
    ?? null
  const isDueSettlement = Boolean(existingOrderId)
  const resolvedDueAmount = Math.max(
    0,
    Number(incomingDueAmount ?? 0) > 0
      ? Number(incomingDueAmount)
      : parseDueFromOrder(existingOrder),
  )
  const orderDetails = useMemo(() => {
    if (!isDueSettlement) return buildOrderDetails(orderItems, totals)
    if (existingOrder?.items?.length) {
      const details = buildOrderDetails(existingOrder.items, { total: Number(existingOrder.total ?? 0) })
      return {
        ...details,
        subtotal: resolvedDueAmount,
        total: resolvedDueAmount,
        totalAmount: Number(incomingTotalAmount ?? existingOrder.total ?? 0),
        paidAmount: Number(incomingPaidAmount ?? existingOrder.paidAmount ?? 0),
      }
    }
    return {
      bookKit: [
        {
          label: `Pending due for order ${existingOrderNumber ?? existingOrder?.orderId ?? '—'}`,
          price: resolvedDueAmount,
        },
      ],
      uniformKit: [],
      subtotal: resolvedDueAmount,
      administrativeFee: 0,
      total: resolvedDueAmount,
      totalAmount: Number(incomingTotalAmount ?? 0),
      paidAmount: Number(incomingPaidAmount ?? 0),
    }
  }, [
    isDueSettlement,
    orderItems,
    totals,
    existingOrder,
    resolvedDueAmount,
    existingOrderNumber,
    incomingTotalAmount,
    incomingPaidAmount,
  ])
  const [discountAmount, setDiscountAmount] = useState('0')
  const [paymentSplit, setPaymentSplit] = useState({
    firstMethod: 'cash',
    firstAmount: String(isGroupOrder ? (groupGrandTotal ?? 0) : (orderDetails.total ?? 0)),
    enableSplit: false,
    secondMethod: '',
  })
  const [showQuickNoteTemplates, setShowQuickNoteTemplates] = useState(false)
  const [remarks, setRemarks] = useState('')
  const [orderNotes, setOrderNotes] = useState('')
  const [receiptOrderNotes, setReceiptOrderNotes] = useState('')
  const [showSuccess, setShowSuccess] = useState(false)
  const [orderCompleted, setOrderCompleted] = useState(false)
  const [receiptFinancials, setReceiptFinancials] = useState({
    totalAmount: Number(orderDetails.total ?? 0),
    paidAmount: 0,
    dueAmount: Number(orderDetails.total ?? 0),
    paymentStatus: 'UNPAID',
    paymentEntries: [],
  })
  const [duplicateInfo, setDuplicateInfo] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState('')
  const printAreaRef = useRef(null)

  useEffect(() => { window.scrollTo({ top: 0, behavior: 'instant' }) }, [])

  useEffect(() => {
    if (!isDueSettlement || resolvedDueAmount <= 0) return
    setPaymentSplit((prev) => ({
      ...prev,
      firstAmount: String(resolvedDueAmount),
    }))
  }, [isDueSettlement, resolvedDueAmount])
  const submitInFlightRef = useRef(false)
  const autoDiscountRemarkRef = useRef('')

  const baseTotal = isGroupOrder ? (groupGrandTotal ?? 0) : Number(orderDetails.total || 0)
  const discountValue = Math.min(Math.max(0, Number(discountAmount || 0)), baseTotal)
  const finalPayable = Math.max(0, baseTotal - discountValue)

  useEffect(() => {
    const newAuto = discountValue > 0 ? `Discount applied: ₹${discountValue.toFixed(2)}` : ''
    setRemarks((prev) => {
      if (prev === autoDiscountRemarkRef.current) {
        autoDiscountRemarkRef.current = newAuto
        return newAuto
      }
      autoDiscountRemarkRef.current = newAuto
      return prev
    })
  }, [discountValue])

  const firstAmount = Math.min(Math.max(Number(paymentSplit.firstAmount || 0), 0), finalPayable)
  const remainingAmount = Math.max(0, finalPayable - firstAmount)
  const paymentEntries = (paymentSplit.enableSplit && paymentSplit.secondMethod)
    ? [
        { method: paymentSplit.firstMethod, amount: firstAmount },
        { method: paymentSplit.secondMethod, amount: remainingAmount },
      ].filter((row) => row.amount > 0)
    : [{ method: paymentSplit.firstMethod, amount: finalPayable }]
  const paidNow = paymentEntries.reduce(
    (sum, row) => sum + (String(row.method).toLowerCase() === 'credit' ? 0 : Number(row.amount || 0)),
    0,
  )
  const remainingDue = Math.max(0, Number(finalPayable) - paidNow)

  const bookLabels = (orderDetails.bookKit ?? []).map((row) => row.label).slice(0, 8)
  const noteTemplateGroups = [
    {
      group: 'Missing from bundle',
      items: bookLabels.map((label) => `Missing from bundle: ${label}.`),
    },
    {
      group: 'Out of stock',
      items: bookLabels.map((label) => `Out of stock: ${label}. Will be provided later.`),
    },
    {
      group: 'Will deliver later',
      items: bookLabels.map((label) => `Delayed delivery: ${label}. Scheduled for later issue.`),
    },
    {
      group: 'Parent requested skip',
      items: bookLabels.map((label) => `Parent requested skip for: ${label}.`),
    },
  ]

  const [receiptInfo, setReceiptInfo] = useState(() => {
    const d = new Date()
    const y = d.getFullYear()
    const n = Math.floor(1000 + Math.random() * 9000)
    return {
      issuedAt: d,
      orderId: `#SKM-${y}-${n}`,
    }
  })

  const receiptDate = formatReceiptDate(receiptInfo.issuedAt)
  const receiptTime = formatReceiptTime(receiptInfo.issuedAt)

  const handlePrint = useCallback(() => window.print(), [])

  const scrollToReceipt = useCallback(() => {
    printAreaRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }, [])

  const dismissSuccess = useCallback(() => setShowSuccess(false), [])

  const handleViewReceipt = useCallback(() => {
    setShowSuccess(false)
    scrollToReceipt()
  }, [scrollToReceipt])

  const handleNewOrder = useCallback(() => {
    setShowSuccess(false)
    navigate(paths.ordersNew, { replace: true })
  }, [navigate, paths.ordersNew])

  const buildReceiptFinancials = useCallback((order, payments) => {
    const total = Number(order?.total ?? finalPayable)
    const paid = Number(order?.paidAmount ?? paidNow)
    const due = Math.max(0, total - paid)
    const receiptPayments =
      finalPayable === 0 ? [{ method: 'other', amount: 0 }] : (payments ?? paymentEntries)
    return {
      totalAmount: total,
      paidAmount: paid,
      dueAmount: due,
      paymentStatus:
        order?.paymentStatus ?? (due > 0 ? (paid > 0 ? 'PARTIAL' : 'UNPAID') : 'PAID'),
      paymentEntries: receiptPayments,
    }
  }, [finalPayable, paidNow, paymentEntries])

  const handleComplete = useCallback(async () => {
    if (submitting || orderCompleted || submitInFlightRef.current) return
    setSubmitError('')
    setDuplicateInfo(null)
    submitInFlightRef.current = true
    setSubmitting(true)

    const releaseSubmitLock = () => {
      setSubmitting(false)
      submitInFlightRef.current = false
    }

    const showCheckoutSuccess = (financials) => {
      setReceiptFinancials(financials)
      setOrderCompleted(true)
      window.dispatchEvent(new CustomEvent('skm-order-confirmed', { detail: { studentId: student.id } }))
      setShowSuccess(true)
      releaseSubmitLock()
    }

    // ── Group order path ───────────────────────────────────────────────────────
    if (isGroupOrder && groupStudents.length >= 2) {
      try {
        const groupPayload = {
          branchId,
          students: groupStudents.map((s) => ({
            studentId: s.student.id,
            items: (s.orderItems ?? []).map((item) => ({
              itemType: item.itemType,
              itemId:
                item.itemType === 'BOOK'
                  ? item.bookItemId ?? item.itemId
                  : item.itemType === 'UNIFORM'
                  ? item.uniformSizeId ?? item.itemId
                  : item.accessoryId ?? item.itemId,
              label: item.label,
              quantity: item.quantity ?? 1,
              unitPrice: item.unitPrice,
            })),
            notes: s.notes ?? '',
            discountAmount: s.discountAmount ?? 0,
            totalAmount: s.totals?.total,
          })),
          payment: {
            splitDetails: paymentEntries
              .map((entry) => ({
                paymentMethod:
                  PAYMENT_METHOD_MAP?.[entry.method] ?? entry.method ?? 'CASH',
                amount: Number(entry.amount),
              }))
              .filter((p) => p.amount > 0),
          },
        }
        const groupResult = await ordersApi.createGroup(groupPayload)
        const groupData = groupResult?.data?.data ?? groupResult?.data
        showCheckoutSuccess({
          totalAmount: groupGrandTotal,
          paidAmount: groupGrandTotal,
          dueAmount: 0,
          paymentStatus: 'PAID',
          paymentEntries,
        })
        const groupRef = groupData?.groupRef ?? groupData?.orders?.[0]?.orderId
        if (groupRef) {
          setReceiptInfo((prev) => ({ ...prev, orderId: groupRef }))
        }
      } catch (err) {
        const msg =
          err?.response?.data?.message ??
          "Group order failed. Please try again or place each student's order individually."
        setSubmitError(msg)
        releaseSubmitLock()
      }
      return
    }
    // ── Single student: existing code continues below ──────────────────────────

    const refreshOrderInBackground = (orderPk, fallbackOrder, payments) => {
      void (async () => {
        try {
          const refreshedOrderRes = await ordersApi.getOne(orderPk)
          const refreshedOrder =
            refreshedOrderRes?.data?.data ?? refreshedOrderRes?.data ?? fallbackOrder
          setReceiptFinancials(buildReceiptFinancials(refreshedOrder, payments))
        } catch (err) {
          console.error('[checkout.complete] background refresh failed', err?.message ?? err)
          toast.error('Order saved. If the receipt looks wrong, check Transactions.')
        }
      })()
    }

    const runPaymentsInBackground = (orderPk, paymentsToRun, fallbackOrder, paymentsForReceipt) => {
      void (async () => {
        try {
          let latest = fallbackOrder
          for (const [idx, entry] of paymentsToRun.entries()) {
            if (Number(entry.amount) <= 0) continue
            const apiMethod = PAYMENT_METHOD_MAP[entry.method] ?? 'CASH'
            const payResult = await ordersApi.processPayment(orderPk, {
              amount: entry.amount,
              paymentMethod: apiMethod,
              notes:
                idx === 0
                  ? (remarks || undefined)
                  : `Split payment via ${paymentMethodLabel(entry.method)}`,
            })
            const realOrderId =
              payResult?.data?.data?.order?.orderId ?? payResult?.data?.order?.orderId
            if (realOrderId) {
              setReceiptInfo((prev) => ({ ...prev, orderId: realOrderId }))
            }
            latest = payResult?.data?.data?.order ?? payResult?.data?.order ?? latest
          }
          refreshOrderInBackground(orderPk, latest, paymentsForReceipt)
        } catch (err) {
          console.error('[checkout.complete] background payment failed', err?.message ?? err)
          toast.error(err?.response?.data?.message ?? 'Payment could not be completed. Check Transactions.')
        }
      })()
    }

    try {
      let persistedOrderId = existingOrderId
      if (existingOrderId) {
        if (resolvedDueAmount <= 0.009 && finalPayable <= 0.009) {
          setSubmitError('This order has no balance due.')
          releaseSubmitLock()
          return
        }
        setReceiptOrderNotes(orderNotes.trim())
        let latestOrderPayload = null
        for (const [idx, entry] of paymentEntries.entries()) {
          const apiMethod = PAYMENT_METHOD_MAP[entry.method] ?? 'CASH'
          const payResult = await ordersApi.processPayment(existingOrderId, {
            amount: entry.amount,
            paymentMethod: apiMethod,
            discountAmount: idx === 0 ? discountValue : 0,
            notes:
              idx === 0
                ? (remarks || orderNotes || undefined)
                : `Split payment via ${paymentMethodLabel(entry.method)}`,
          })
          const realOrderId =
            payResult?.data?.data?.order?.orderId ?? payResult?.data?.order?.orderId
          if (realOrderId) {
            setReceiptInfo((prev) => ({ ...prev, orderId: realOrderId }))
          } else if (existingOrderNumber) {
            setReceiptInfo((prev) => ({ ...prev, orderId: existingOrderNumber }))
          }
          latestOrderPayload = payResult?.data?.data?.order ?? payResult?.data?.order ?? latestOrderPayload
        }
        showCheckoutSuccess(buildReceiptFinancials(latestOrderPayload, paymentEntries))
        refreshOrderInBackground(existingOrderId, latestOrderPayload, paymentEntries)
        return
      }

      if (student.id && branchId && orderItems?.length) {
        const trimmedNotes = orderNotes.trim()
        const createRes = await ordersApi.create({
          studentId: student.id,
          branchId,
          items: orderItems,
          totalAmount: Number(orderDetails.total ?? 0),
          discountAmount: discountValue,
          notes: trimmedNotes || undefined,
        })
        const payload = createRes?.data?.data ?? createRes?.data
        const createdOrder = payload?.order ?? payload
        const orderId = createdOrder?.id
        persistedOrderId = orderId
        const stockWarnings = Array.isArray(payload?.stockWarnings) ? payload.stockWarnings : []
        setReceiptOrderNotes(trimmedNotes)
        for (const w of stockWarnings) {
          toast.info(w, 7000)
        }
        if (createdOrder?.orderId) {
          setReceiptInfo((prev) => ({ ...prev, orderId: createdOrder.orderId }))
        }

        showCheckoutSuccess(buildReceiptFinancials(createdOrder, paymentEntries))

        if (orderId && finalPayable > 0) {
          const entries = paymentEntries.filter((e) => Number(e.amount) > 0)
          runPaymentsInBackground(orderId, entries, createdOrder, paymentEntries)
        } else if (orderId) {
          refreshOrderInBackground(orderId, createdOrder, paymentEntries)
        }
        return
      }

      releaseSubmitLock()
    } catch (err) {
      const duplicateError = err?.response?.data?.errors?.find((e) => e?.code === 'DUPLICATE_ORDER')
      if (duplicateError?.existingOrderId) {
        setDuplicateInfo({
          studentName: student.name,
          orderId: duplicateError.existingOrderId,
        })
      } else {
        setSubmitError(err?.response?.data?.message ?? 'Payment failed. Please try again.')
      }
      releaseSubmitLock()
    }
  }, [
    submitting,
    orderCompleted,
    student,
    branchId,
    orderItems,
    existingOrderId,
    existingOrderNumber,
    resolvedDueAmount,
    isDueSettlement,
    remarks,
    orderNotes,
    discountValue,
    paymentEntries,
    finalPayable,
    paidNow,
    buildReceiptFinancials,
    toast,
  ])

  const handleEdit = useCallback(() => {
    navigate(-1)
  }, [navigate])

  return (
    <div className="min-h-screen bg-surface text-on-surface">
      <header className="sticky top-0 z-40 flex h-auto min-h-[64px] w-full items-center justify-between border-b border-outline-variant/10 bg-white/80 px-3 md:px-8 py-3 shadow-sm backdrop-blur-xl dark:bg-stone-900/80 dark:shadow-none">
        <div className="flex items-center gap-2 md:gap-3">
          <button
            type="button"
            onClick={toggleSidebar}
            className="shrink-0 rounded-xl p-2 hover:bg-surface-container-low"
            aria-label="Toggle navigation menu"
          >
            <span className="material-symbols-outlined text-on-surface" aria-hidden>menu</span>
          </button>
          <div className="flex flex-col">
            <h1 className="font-headline text-lg font-semibold text-on-surface">Order Payment</h1>
            <nav className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-on-surface-variant">
              <span>{selectedClass.name}</span>
              <span className="material-symbols-outlined text-[10px]" aria-hidden>chevron_right</span>
              <span className="text-primary">{selectedSection.name}</span>
            </nav>
            {isDueSettlement && (
              <p className="mt-0.5 text-xs font-semibold text-primary">
                Clearing pending due for {existingOrderNumber ?? 'existing order'}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isDueSettlement && (
            <button
              type="button"
              onClick={() => navigate(paths.transactions, { state: { activeTab: 'dues' } })}
              className="flex items-center gap-1 rounded-lg border border-secondary/25 bg-secondary/10 px-3 py-1.5 text-xs font-bold text-secondary hover:bg-secondary/15"
            >
              <span className="material-symbols-outlined text-sm" aria-hidden>list_alt</span>
              Back to Due List
            </button>
          )}
          <button
            type="button"
            onClick={() => navigate(-1)}
            className="flex items-center gap-1 rounded-lg border border-tertiary/25 bg-tertiary/10 px-3 py-1.5 text-xs font-bold text-tertiary hover:bg-tertiary/15"
          >
            <span className="material-symbols-outlined text-sm" aria-hidden>arrow_back</span>
            Back
          </button>
        </div>
      </header>
      <main className="w-full px-4 pb-12 pt-6 md:px-8 lg:px-12">
        <div className="grid grid-cols-1 items-start gap-8 lg:grid-cols-12">
          <section className="space-y-10 lg:col-span-7">
            <PaymentMethod
              payment={paymentSplit}
              onPaymentChange={setPaymentSplit}
              finalPayable={finalPayable}
              branchName={branchName}
              remarks={remarks}
              onRemarksChange={setRemarks}
            />
            {orderCompleted && <ReceiptOptions onPrint={handlePrint} />}
            {submitError && (
              <p className="rounded-xl bg-error-container px-4 py-3 text-sm font-medium text-on-error-container">
                {submitError}
              </p>
            )}
          </section>
          {isGroupOrder ? (
            <aside className="lg:col-span-5">
              <div className="sticky top-28 space-y-4">
                {/* All students in this group */}
                <div className="rounded-xl border border-outline-variant/10 bg-surface-container-lowest p-5 shadow-sm">
                  <h2 className="mb-4 flex items-center gap-2 font-headline text-lg font-extrabold tracking-tight text-on-surface">
                    <span className="material-symbols-outlined text-primary" aria-hidden>group</span>
                    Group Order — {groupStudents.length} students
                  </h2>
                  <div className="space-y-3">
                    {groupStudents.map((s) => (
                      <div key={s.student.id} className="rounded-xl border border-outline-variant/10 bg-surface-container-low p-3">
                        <div className="mb-2 flex items-center gap-3">
                          <span className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-primary text-on-primary text-xs font-bold">
                            {s.student.initials}
                          </span>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-sm font-semibold text-on-surface">{s.student.name}</p>
                            <p className="text-xs text-on-surface-variant">
                              {s.selectedClass?.name ?? s.selectedClass?.label ?? '—'} · {s.selectedSection?.name ?? s.selectedSection?.section ?? '—'}
                            </p>
                          </div>
                          <p className="shrink-0 font-bold text-sm text-primary">
                            ₹{Number(s.totals?.total ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                          </p>
                        </div>
                        <div className="space-y-0.5">
                          {(s.orderItems ?? []).map((item) => (
                            <div key={item.label} className="flex justify-between text-xs text-on-surface-variant">
                              <span className="truncate pr-2">{item.label}</span>
                              <span className="shrink-0">₹{(Number(item.unitPrice) * Number(item.quantity ?? 1)).toLocaleString('en-IN')}</span>
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                  <div className="mt-4 flex items-center justify-between rounded-xl bg-primary/10 px-4 py-3">
                    <span className="font-bold text-on-surface">Grand Total ({groupStudents.length} students)</span>
                    <span className="text-lg font-extrabold text-primary">
                      ₹{Number(groupGrandTotal).toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                    </span>
                  </div>
                </div>

                {/* Discount + payment summary + Complete button */}
                <div className="rounded-xl border border-outline-variant/10 bg-surface-container-lowest p-5 shadow-sm">
                  <div className="space-y-3 text-sm">
                    <div className="flex items-center justify-between">
                      <span className="text-on-surface-variant">Discount</span>
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={discountAmount}
                        onChange={(e) => setDiscountAmount(e.target.value)}
                        placeholder="0.00"
                        title="Discount amount in rupees"
                        className="w-28 rounded-lg border border-outline-variant/30 bg-white px-2 py-1 text-right text-sm font-semibold placeholder:text-on-surface-variant/50"
                      />
                    </div>
                    <div className="flex items-center justify-between border-t border-surface-container-high pt-2">
                      <span className="font-bold text-on-surface text-base">Final Payable</span>
                      <span className="text-2xl font-extrabold text-primary">₹{Number(finalPayable).toFixed(2)}</span>
                    </div>
                    <div className="rounded-xl bg-surface-container-low p-3 text-xs">
                      <p className="mb-1 font-bold uppercase tracking-wide text-on-surface-variant">Payment Summary</p>
                      <div className="flex justify-between">
                        <span>Paid Now</span>
                        <span className="font-semibold">₹{Number(paidNow).toFixed(2)}</span>
                      </div>
                      <div className="mt-1 flex justify-between">
                        <span>Remaining Due</span>
                        <span className="font-semibold text-error">₹{Number(remainingDue).toFixed(2)}</span>
                      </div>
                    </div>
                    {paymentEntries.length > 0 && (
                      <div className="rounded-xl bg-surface-container-low p-3 text-xs">
                        <p className="mb-1 font-bold uppercase tracking-wide text-on-surface-variant">Payment Split</p>
                        {paymentEntries.map((entry) => (
                          <div key={`${entry.method}-${entry.amount}`} className="flex items-center justify-between gap-3">
                            <span>{paymentMethodLabel(entry.method)}</span>
                            <span className="font-semibold">₹{Number(entry.amount).toFixed(2)}</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={handleComplete}
                    disabled={submitting || orderCompleted}
                    className="mt-5 w-full rounded-xl bg-gradient-to-br from-primary to-primary-container px-8 py-4 text-base font-extrabold text-white shadow-xl shadow-primary/20 transition-transform active:scale-[0.98] disabled:cursor-not-allowed disabled:opacity-60"
                  >
                    {submitting ? 'Processing…' : orderCompleted ? 'Order Submitted' : 'Complete Payment'}
                  </button>
                </div>
              </div>
            </aside>
          ) : (
            <OrderSummary
              student={student}
              selectedClass={selectedClass}
              selectedSection={selectedSection}
              orderDetails={orderDetails}
              orderNotes={orderNotes}
              onOrderNotesChange={setOrderNotes}
              noteTemplateGroups={noteTemplateGroups}
              showQuickNoteTemplates={showQuickNoteTemplates}
              onToggleQuickNoteTemplates={setShowQuickNoteTemplates}
              discountAmount={discountAmount}
              onDiscountAmountChange={setDiscountAmount}
              finalPayable={finalPayable}
              paidNow={paidNow}
              remainingDue={remainingDue}
              paymentEntries={paymentEntries}
              onComplete={handleComplete}
              onEdit={isDueSettlement ? undefined : handleEdit}
              submitting={submitting}
              orderCompleted={orderCompleted}
              isDueSettlement={isDueSettlement}
            />
          )}
        </div>
      </main>
      {orderCompleted && (
        <div ref={printAreaRef} className="print-area">
          <Receipt
            student={student}
            selectedClass={selectedClass}
            selectedSection={selectedSection}
            orderDetails={orderDetails}
            orderNotes={receiptOrderNotes}
            paymentEntries={receiptFinancials.paymentEntries}
            paymentStatus={receiptFinancials.paymentStatus}
            totalAmount={receiptFinancials.totalAmount}
            paidAmount={receiptFinancials.paidAmount}
            dueAmount={receiptFinancials.dueAmount}
            orderId={receiptInfo.orderId}
            receiptDate={receiptDate}
            receiptTime={receiptTime}
            onPrint={handlePrint}
            groupStudents={isGroupOrder ? groupStudents : []}
          />
        </div>
      )}
      <SuccessModal
        open={showSuccess}
        onClose={dismissSuccess}
        onViewReceipt={handleViewReceipt}
        onNewOrder={handleNewOrder}
      />
      {duplicateInfo && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm">
          <div className="w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
            <h3 className="text-lg font-extrabold text-on-surface">Duplicate Order Detected</h3>
            <p className="mt-2 text-sm text-on-surface-variant">
              An order for {duplicateInfo.studentName} with the same items already exists today ({duplicateInfo.orderId}).
            </p>
            <div className="mt-6 flex justify-end gap-3">
              <button
                type="button"
                onClick={() => setDuplicateInfo(null)}
                className="rounded-xl border border-outline-variant/30 px-4 py-2 text-sm font-semibold hover:bg-surface-container-low"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => navigate(paths.transactionDetail(encodeURIComponent(duplicateInfo.orderId)))}
                className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-on-primary hover:opacity-90"
              >
                View Order
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
