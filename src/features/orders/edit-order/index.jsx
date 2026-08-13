import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate, useParams } from 'react-router-dom'
import { ordersApi, transactionsApi } from '@/services/api'
import { useApi } from '@/hooks/useApi'
import { useToast } from '@/context/ToastContext'
import { useShellPaths } from '@/hooks/useShellPaths'
import { useSidebar } from '@/context/SidebarContext'
import { useAdminSession } from '@/context/useAdminSession'
import { ROLES } from '@/config/navigation'

function todayIstDateString() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date())
}

function toDateInput(value) {
  if (!value) return todayIstDateString()
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(value))
  } catch {
    return todayIstDateString()
  }
}

function money(n) {
  return Number(n ?? 0)
}

/** Keep a single non-credit payment matched to items total when the order was previously settled. */
function syncPaymentsToItemsTotal(txs, itemsTotal) {
  if (!Array.isArray(txs) || !txs.length) return txs
  const nonCreditIdx = txs.findIndex((t) => t.paymentMethod !== 'CREDIT')
  if (nonCreditIdx < 0) return txs
  const paidNonCredit = txs
    .filter((t) => t.paymentMethod !== 'CREDIT')
    .reduce((s, t) => s + money(t.amount), 0)
  // Only auto-sync when there is exactly one cash-like payment row
  const cashLikeCount = txs.filter((t) => t.paymentMethod !== 'CREDIT').length
  if (cashLikeCount !== 1) return txs

  const next = txs.map((row, i) => {
    if (i !== nonCreditIdx) return row
    const amount = Math.max(0, Number(itemsTotal) || 0)
    const status = amount <= 0.009 ? 'UNPAID' : 'PAID'
    return { ...row, amount, status }
  })
  // Preserve prior paidNonCredit intent: if they were unpaid/credit-only, don't invent cash
  if (paidNonCredit <= 0.009 && itemsTotal > 0.009) return txs
  return next
}

export default function OrderEditFormPage() {
  const { id } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const paths = useShellPaths()
  const toast = useToast()
  const { toggle: toggleSidebar } = useSidebar()
  const { role } = useAdminSession()
  const isSuper = role === ROLES.SUPER_ADMIN

  const fetchOrder = useCallback(() => transactionsApi.getOne(id), [id])
  const { data: order, loading, error } = useApi(fetchOrder, null, [id])

  const [orderDate, setOrderDate] = useState(todayIstDateString())
  const [notes, setNotes] = useState('')
  const [reason, setReason] = useState('')
  const [items, setItems] = useState([])
  const [transactions, setTransactions] = useState([])
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    if (!order) return
    setOrderDate(toDateInput(order.orderDate ?? order.createdAt))
    setNotes(order.notes ?? '')
    setItems(
      (order.items ?? []).map((i) => ({
        itemType: i.itemType,
        itemId: i.bookItemId || i.uniformSizeId || i.accessoryId,
        label: i.label,
        quantity: i.quantity,
        unitPrice: Number(i.unitPrice),
      })),
    )
    setTransactions(
      (order.transactions ?? []).map((t) => ({
        amount: Number(t.amount),
        paymentMethod: t.paymentMethod,
        status: t.status,
        notes: t.notes,
        paidAt: toDateInput(t.paidAt),
      })),
    )
  }, [order])

  const itemsTotal = useMemo(
    () => items.reduce((s, i) => s + money(i.unitPrice) * Math.max(1, Number(i.quantity) || 1), 0),
    [items],
  )
  const paidTotal = useMemo(
    () => transactions.filter((t) => t.paymentMethod !== 'CREDIT').reduce((s, t) => s + money(t.amount), 0),
    [transactions],
  )
  const dueTotal = Math.max(0, itemsTotal - paidTotal)

  const updateItem = (idx, patch) => {
    setItems((prev) => {
      const nextItems = prev.map((row, i) => (i === idx ? { ...row, ...patch } : row))
      const nextTotal = nextItems.reduce(
        (s, i) => s + money(i.unitPrice) * Math.max(1, Number(i.quantity) || 1),
        0,
      )
      setTransactions((prevTx) => syncPaymentsToItemsTotal(prevTx, nextTotal))
      return nextItems
    })
  }

  const updateTx = (idx, patch) => {
    setTransactions((prev) => prev.map((row, i) => (i === idx ? { ...row, ...patch } : row)))
  }

  const handleSubmit = async () => {
    if (!order?.id) return
    if (dueTotal > 0.009) {
      const ok = window.confirm(
        `Items total ₹${itemsTotal.toFixed(2)} exceeds paid ₹${paidTotal.toFixed(2)} (due ₹${dueTotal.toFixed(2)}). Continue and mark as partial?`,
      )
      if (!ok) return
    }
    setSubmitting(true)
    try {
      await ordersApi.createEditRequest(order.id, {
        reason: reason || undefined,
        orderDate,
        notes,
        bookStatus: order.bookStatus,
        uniformStatus: order.uniformStatus,
        items,
        transactions,
        total: itemsTotal,
        paidAmount: paidTotal,
      })
      toast.success(isSuper ? 'Edit applied' : 'Edit submitted for Superadmin approval')
      navigate(location.state?.returnTo || paths.transactions)
    } catch (err) {
      toast.error(err?.response?.data?.message ?? 'Failed to submit edit')
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="min-h-screen bg-surface text-on-surface">
      <header className="sticky top-0 z-30 flex items-center justify-between border-b border-outline-variant/10 bg-white/80 px-4 py-3 backdrop-blur md:px-8">
        <div className="flex items-center gap-3">
          <button type="button" onClick={toggleSidebar} className="rounded-xl p-2 hover:bg-surface-container-low" aria-label="Menu">
            <span className="material-symbols-outlined">menu</span>
          </button>
          <div>
            <h1 className="font-headline text-lg font-semibold">Edit order</h1>
            <p className="text-xs text-on-surface-variant">{order?.orderId ?? '…'}</p>
          </div>
        </div>
        <button type="button" onClick={() => navigate(-1)} className="rounded-xl border border-outline-variant/20 px-3 py-1.5 text-xs font-bold">
          Back
        </button>
      </header>

      <main className="mx-auto max-w-3xl space-y-6 px-4 py-6 md:px-8">
        {loading && <p className="text-sm text-on-surface-variant">Loading order…</p>}
        {error && <p className="text-sm text-error">Could not load order</p>}
        {order && (
          <>
            <p className="text-sm text-on-surface-variant">
              {isSuper
                ? 'As Superadmin, your edit will apply immediately and be logged.'
                : 'Changes stay pending until a Superadmin approves them. Live order is unchanged until then.'}
            </p>

            <label className="block">
              <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-on-surface-variant">Order date</span>
              <input
                type="date"
                value={orderDate}
                max={todayIstDateString()}
                onChange={(e) => setOrderDate(e.target.value)}
                className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2.5 text-sm"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-on-surface-variant">Reason for edit</span>
              <input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="e.g. Wrong notebook qty / date correction"
                className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2.5 text-sm"
              />
            </label>

            <label className="block">
              <span className="mb-1 block text-xs font-bold uppercase tracking-wide text-on-surface-variant">Notes</span>
              <textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                className="w-full rounded-xl border border-outline-variant/20 bg-surface-container-lowest px-3 py-2.5 text-sm"
              />
            </label>

            <section className="rounded-xl border border-outline-variant/10 bg-surface-container-lowest p-4">
              <h2 className="mb-3 font-headline text-sm font-bold">Items</h2>
              <div className="space-y-3">
                {items.map((item, idx) => (
                  <div key={`${item.itemId}-${idx}`} className="grid grid-cols-12 gap-2 rounded-lg bg-surface-container-low p-3">
                    <p className="col-span-12 text-sm font-semibold md:col-span-6">{item.label}</p>
                    <label className="col-span-4 text-xs md:col-span-2">
                      Qty
                      <input
                        type="number"
                        min={1}
                        value={item.quantity}
                        onChange={(e) => updateItem(idx, { quantity: Math.max(1, Number(e.target.value) || 1) })}
                        className="mt-1 w-full rounded-lg border border-outline-variant/20 px-2 py-1.5"
                      />
                    </label>
                    <label className="col-span-8 text-xs md:col-span-4">
                      Unit price
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        value={item.unitPrice}
                        onChange={(e) => updateItem(idx, { unitPrice: Number(e.target.value) || 0 })}
                        className="mt-1 w-full rounded-lg border border-outline-variant/20 px-2 py-1.5"
                      />
                    </label>
                  </div>
                ))}
              </div>
              <div className="mt-3 flex flex-wrap gap-4 border-t border-outline-variant/10 pt-3 text-xs font-semibold">
                <span>Items total: ₹{itemsTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                <span>Paid: ₹{paidTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                <span className={dueTotal > 0.009 ? 'text-error' : 'text-on-surface-variant'}>
                  Due: ₹{dueTotal.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                </span>
              </div>
              <p className="mt-2 text-[11px] text-on-surface-variant">
                Changing qty/price updates the single cash payment amount automatically so the order stays fully paid when possible.
              </p>
            </section>

            <section className="rounded-xl border border-outline-variant/10 bg-surface-container-lowest p-4">
              <h2 className="mb-3 font-headline text-sm font-bold">Payments</h2>
              <div className="space-y-3">
                {transactions.map((tx, idx) => (
                  <div key={`${tx.paymentMethod}-${idx}`} className="grid grid-cols-12 gap-2 rounded-lg bg-surface-container-low p-3">
                    <label className="col-span-6 text-xs md:col-span-3">
                      Amount
                      <input
                        type="number"
                        step="0.01"
                        value={tx.amount}
                        onChange={(e) => updateTx(idx, { amount: Number(e.target.value) || 0 })}
                        className="mt-1 w-full rounded-lg border border-outline-variant/20 px-2 py-1.5"
                      />
                    </label>
                    <label className="col-span-6 text-xs md:col-span-3">
                      Method
                      <select
                        value={tx.paymentMethod}
                        onChange={(e) => updateTx(idx, { paymentMethod: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-outline-variant/20 px-2 py-1.5"
                      >
                        {['CASH', 'OTHER', 'ONLINE', 'CREDIT', 'UPI_BHARATHI', 'BOB_UPI', 'CANARA_UPI', 'GPAY', 'PHONEPE'].map((m) => (
                          <option key={m} value={m}>{m}</option>
                        ))}
                      </select>
                    </label>
                    <label className="col-span-12 text-xs md:col-span-3">
                      Paid date
                      <input
                        type="date"
                        value={tx.paidAt}
                        max={todayIstDateString()}
                        onChange={(e) => updateTx(idx, { paidAt: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-outline-variant/20 px-2 py-1.5"
                      />
                    </label>
                    <label className="col-span-12 text-xs md:col-span-3">
                      Status
                      <select
                        value={tx.status}
                        onChange={(e) => updateTx(idx, { status: e.target.value })}
                        className="mt-1 w-full rounded-lg border border-outline-variant/20 px-2 py-1.5"
                      >
                        {['PAID', 'PARTIAL', 'UNPAID'].map((s) => (
                          <option key={s} value={s}>{s}</option>
                        ))}
                      </select>
                    </label>
                  </div>
                ))}
                {!transactions.length && (
                  <p className="text-xs text-on-surface-variant">No payment rows — leave empty for unpaid or use Clear Due.</p>
                )}
              </div>
            </section>

            <button
              type="button"
              disabled={submitting || !items.length}
              onClick={handleSubmit}
              className="w-full rounded-xl bg-primary px-4 py-3 text-sm font-bold text-on-primary disabled:opacity-50"
            >
              {submitting ? 'Submitting…' : isSuper ? 'Apply edit now' : 'Submit for approval'}
            </button>
          </>
        )}
      </main>
    </div>
  )
}
