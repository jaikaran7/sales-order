import { useCallback, useMemo, useState } from 'react'
import { ordersApi } from '@/services/api'
import { useApi } from '@/hooks/useApi'
import { useToast } from '@/context/ToastContext'
import { useSidebar } from '@/context/SidebarContext'

function money(n) {
  return Number(n ?? 0)
}

function formatWhen(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
}

export default function OrderEditRequestsPage() {
  const toast = useToast()
  const { toggle: toggleSidebar } = useSidebar()
  const [statusFilter, setStatusFilter] = useState('PENDING')
  const [busyId, setBusyId] = useState(null)
  const [notesById, setNotesById] = useState({})

  const fetchList = useCallback(
    () => ordersApi.listEditRequests({ status: statusFilter || undefined, limit: 50 }),
    [statusFilter],
  )
  const { data, loading, error, refetch } = useApi(fetchList, null, [statusFilter])
  const rows = useMemo(() => (Array.isArray(data) ? data : []), [data])

  const setNote = (id, value) => {
    setNotesById((prev) => ({ ...prev, [id]: value }))
  }

  const review = async (id, action) => {
    const note = (notesById[id] || '').trim()
    setBusyId(id)
    try {
      if (action === 'approve') await ordersApi.approveEditRequest(id, { reviewNote: note || undefined })
      else await ordersApi.rejectEditRequest(id, { reviewNote: note || undefined })
      toast.success(action === 'approve' ? 'Edit approved and applied' : 'Edit rejected')
      setNotesById((prev) => {
        const next = { ...prev }
        delete next[id]
        return next
      })
      refetch()
    } catch (err) {
      toast.error(err?.response?.data?.message ?? 'Action failed')
    } finally {
      setBusyId(null)
    }
  }

  return (
    <div className="min-h-screen bg-surface text-on-surface">
      <header className="sticky top-0 z-30 flex items-center gap-3 border-b border-outline-variant/10 bg-white/80 px-4 py-3 backdrop-blur md:px-8">
        <button type="button" onClick={toggleSidebar} className="rounded-xl p-2 hover:bg-surface-container-low" aria-label="Menu">
          <span className="material-symbols-outlined">menu</span>
        </button>
        <div>
          <h1 className="font-headline text-lg font-semibold">Order edit approvals</h1>
          <p className="text-xs text-on-surface-variant">Approve or reject pending order corrections</p>
        </div>
      </header>

      <main className="mx-auto max-w-5xl px-4 py-6 md:px-8">
        <div className="mb-4 flex flex-wrap gap-2">
          {['PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN', ''].map((s) => (
            <button
              key={s || 'ALL'}
              type="button"
              onClick={() => setStatusFilter(s)}
              className={`rounded-full px-3 py-1.5 text-xs font-bold ${
                statusFilter === s ? 'bg-primary text-on-primary' : 'bg-surface-container-low text-on-surface-variant'
              }`}
            >
              {s || 'ALL'}
            </button>
          ))}
        </div>

        {loading && <p className="text-sm text-on-surface-variant">Loading…</p>}
        {error && <p className="text-sm text-error">Failed to load edit requests</p>}
        {!loading && rows.length === 0 && (
          <p className="rounded-xl border border-outline-variant/10 bg-surface-container-lowest p-6 text-sm text-on-surface-variant">
            No {statusFilter ? statusFilter.toLowerCase() : ''} edit requests.
          </p>
        )}

        <div className="space-y-4">
          {rows.map((row) => {
            const diffs = Array.isArray(row.diffSummary) ? row.diffSummary : []
            return (
              <article key={row.id} className="rounded-xl border border-outline-variant/10 bg-surface-container-lowest p-5 shadow-sm">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="font-headline text-base font-bold">{row.order?.orderId ?? '—'}</p>
                    <p className="text-sm text-on-surface-variant">
                      {row.order?.student?.name ?? '—'} · {row.branch?.name ?? '—'}
                    </p>
                    <p className="mt-1 text-xs text-on-surface-variant">
                      Requested by {row.requestedBy?.displayName ?? '—'} · {formatWhen(row.createdAt)}
                    </p>
                    {row.reason && <p className="mt-2 text-sm">Reason: {row.reason}</p>}
                  </div>
                  <span className="rounded-full bg-surface-container-high px-3 py-1 text-xs font-bold">{row.status}</span>
                </div>

                <ul className="mt-4 space-y-1 text-sm">
                  {diffs.slice(0, 8).map((d, i) => (
                    <li key={`${row.id}-${d.field}-${i}`} className="rounded-lg bg-surface-container-low px-3 py-2">
                      <span className="font-semibold">{d.field}</span>
                      {d.field !== 'items' && d.field !== 'transactions' ? (
                        <span className="text-on-surface-variant">: {String(d.from ?? '—')} → {String(d.to ?? '—')}</span>
                      ) : (
                        <span className="text-on-surface-variant"> changed</span>
                      )}
                    </li>
                  ))}
                  {diffs.length > 8 && <li className="text-xs text-on-surface-variant">+{diffs.length - 8} more changes</li>}
                </ul>

                {row.status === 'PENDING' && (
                  <div className="mt-4 space-y-3">
                    <label className="block text-xs font-bold uppercase tracking-wide text-on-surface-variant">
                      Review note (optional)
                      <input
                        value={notesById[row.id] ?? ''}
                        onChange={(e) => setNote(row.id, e.target.value)}
                        placeholder={row.status === 'PENDING' ? 'e.g. Verified with cashier' : ''}
                        className="mt-1 w-full rounded-xl border border-outline-variant/20 bg-surface px-3 py-2 text-sm font-normal normal-case tracking-normal"
                      />
                    </label>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => review(row.id, 'approve')}
                        className="rounded-xl bg-primary px-4 py-2 text-sm font-bold text-on-primary disabled:opacity-50"
                      >
                        Approve
                      </button>
                      <button
                        type="button"
                        disabled={busyId === row.id}
                        onClick={() => review(row.id, 'reject')}
                        className="rounded-xl bg-error-container px-4 py-2 text-sm font-bold text-on-error-container disabled:opacity-50"
                      >
                        Reject
                      </button>
                    </div>
                  </div>
                )}

                {row.reviewedAt && (
                  <p className="mt-3 text-xs text-on-surface-variant">
                    Reviewed by {row.reviewedBy?.displayName ?? '—'} · {formatWhen(row.reviewedAt)}
                    {row.reviewNote ? ` · ${row.reviewNote}` : ''}
                  </p>
                )}

                <p className="mt-2 text-xs text-on-surface-variant">
                  Order total ₹{money(row.order?.total).toLocaleString('en-IN')} · {row.order?.paymentStatus}
                </p>
              </article>
            )
          })}
        </div>
      </main>
    </div>
  )
}
