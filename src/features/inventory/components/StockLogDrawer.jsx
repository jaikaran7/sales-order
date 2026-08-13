import { useCallback, useMemo, useState } from 'react'
import { inventoryApi } from '@/services/api'
import { useApi } from '@/hooks/useApi'

const TYPE_META = {
  INCOMING:      { label: 'Stock Added',       icon: 'add_circle',      color: 'text-green-700 bg-green-50' },
  OUTGOING:      { label: 'Distributed',       icon: 'remove_circle',   color: 'text-error bg-error-container/40' },
  DISTRIBUTION:  { label: 'Distribution',    icon: 'local_shipping',  color: 'text-error bg-error-container/40' },
  ADJUSTMENT:    { label: 'Stock Adjusted',    icon: 'edit_square',     color: 'text-primary bg-primary/10' },
  TRANSFER_IN:   { label: 'Transfer In',       icon: 'move_item',       color: 'text-secondary bg-secondary-container/40' },
  TRANSFER_OUT:  { label: 'Transfer Out',      icon: 'outbox',          color: 'text-outline bg-surface-container-low' },
  PROCUREMENT:   { label: 'Procurement',       icon: 'inventory',       color: 'text-primary bg-primary/10' },
}

function formatDelta(delta, changeType) {
  const sign =
    changeType === 'OUTGOING' || changeType === 'TRANSFER_OUT' || changeType === 'DISTRIBUTION' ? '-' : '+'
  return `${sign}${Math.abs(delta)}`
}

function deltaColor(changeType) {
  return changeType === 'OUTGOING' || changeType === 'TRANSFER_OUT' || changeType === 'DISTRIBUTION'
    ? 'text-error font-bold'
    : 'text-green-700 font-bold'
}

const TYPE_FILTER_KEYS = ['ALL', 'INCOMING', 'OUTGOING', 'DISTRIBUTION', 'ADJUSTMENT', 'TRANSFER_IN', 'TRANSFER_OUT', 'PROCUREMENT']

export default function StockLogDrawer({ branchId, itemType, itemId, catalogKey, classGrade, onClose, panelTabs }) {
  const [typeFilter, setTypeFilter] = useState('ALL')
  const [productFilter, setProductFilter] = useState('ALL')

  const fetchLogs = useCallback(
    () =>
      inventoryApi.getLogs({
        ...(branchId ? { branchId } : {}),
        itemType,
        ...(catalogKey ? { catalogKey } : itemId ? { itemId } : {}),
        classGrade,
        limit: 200,
      }),
    [branchId, itemType, itemId, catalogKey, classGrade],
  )
  const { data: logsData, loading } = useApi(fetchLogs, null, [branchId, itemType, itemId, classGrade])
  const allLogs = Array.isArray(logsData) ? logsData : (logsData?.data ?? [])

  const productOptions = useMemo(() => {
    const map = new Map()
    for (const log of allLogs) {
      const id = log.bookItem?.id ?? log.uniformSize?.id ?? log.accessory?.id
      const label = log.bookItem?.label ?? log.uniformSize?.name ?? log.accessory?.name
      if (id && label && !map.has(id)) map.set(id, label)
    }
    return [{ value: 'ALL', label: 'All Products' }, ...Array.from(map.entries()).map(([value, label]) => ({ value, label }))]
  }, [allLogs])

  const logs = allLogs.filter((l) => {
    if (typeFilter !== 'ALL' && l.changeType !== typeFilter) return false
    if (productFilter !== 'ALL') {
      const id = l.bookItem?.id ?? l.uniformSize?.id ?? l.accessory?.id
      if (id !== productFilter) return false
    }
    return true
  })

  // KPI totals — based on product filter only (independent of type filter)
  const kpis = useMemo(() => {
    const filtered = productFilter === 'ALL'
      ? allLogs
      : allLogs.filter((l) => (l.bookItem?.id ?? l.uniformSize?.id ?? l.accessory?.id) === productFilter)
    let purchased = 0
    let added = 0
    for (const l of filtered) {
      const delta = Math.abs(l.quantityDelta ?? 0)
      if (l.changeType === 'OUTGOING' || l.changeType === 'DISTRIBUTION' || l.changeType === 'TRANSFER_OUT') {
        purchased += delta
      } else if (l.changeType === 'INCOMING' || l.changeType === 'PROCUREMENT' || l.changeType === 'TRANSFER_IN') {
        added += delta
      }
    }
    return { purchased, added, entries: filtered.length }
  }, [allLogs, productFilter])

  const exportCsv = () => {
    const headers = ['Date', 'Type', 'Qty Change', 'Before', 'After', 'Item', 'Performed By', 'Notes']
    const rows = logs.map((l) => [
      new Date(l.eventDate ?? l.createdAt).toLocaleString(),
      TYPE_META[l.changeType]?.label ?? l.changeType,
      formatDelta(l.quantityDelta, l.changeType),
      l.quantityBefore,
      l.quantityAfter,
      l.bookItem?.label ?? l.uniformSize?.name ?? l.accessory?.name ?? '—',
      l.performedBy?.displayName ?? '—',
      l.notes ?? '',
    ])
    const csv = [headers, ...rows].map((r) => r.map((v) => `"${v}"`).join(',')).join('\n')
    const a = document.createElement('a')
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }))
    a.download = `stock_log_${new Date().toISOString().slice(0, 10)}.csv`
    a.click()
  }

  return (
    <div className="fixed inset-0 z-50 flex">
      <div className="flex-1 bg-black/40 backdrop-blur-sm" onClick={onClose} />
      <div className="flex h-full w-full max-w-2xl flex-col bg-white shadow-2xl">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-outline-variant/10 p-6">
          <div>
            <h2 className="font-headline text-xl font-extrabold text-on-surface">Stock Audit Log</h2>
            <p className="mt-0.5 text-sm text-on-surface-variant">Full history of all stock movements</p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={exportCsv}
              className="flex items-center gap-1.5 rounded-xl border border-outline-variant/20 px-3 py-2 text-xs font-bold text-on-surface-variant hover:bg-surface-container-low"
            >
              <span className="material-symbols-outlined text-base" aria-hidden>download</span>
              Export CSV
            </button>
            <button type="button" onClick={onClose} className="rounded-lg p-1.5 hover:bg-surface-container-low">
              <span className="material-symbols-outlined" aria-hidden>close</span>
            </button>
          </div>
        </div>

        {panelTabs && (
          <div className="flex gap-2 border-b border-outline-variant/10 px-6 py-3">
            {panelTabs.tabs.map((tab) => (
              <button
                key={tab.id}
                type="button"
                onClick={() => panelTabs.onTabChange?.(tab.id)}
                disabled={tab.disabled}
                className={`rounded-full px-3 py-1.5 text-xs font-bold transition-colors ${
                  panelTabs.activeTab === tab.id
                    ? 'bg-primary text-white'
                    : 'bg-surface-container-low text-on-surface-variant hover:bg-surface-container'
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {tab.label}
              </button>
            ))}
          </div>
        )}

        {/* Filters */}
        <div className="flex flex-wrap items-center gap-2 border-b border-outline-variant/10 p-4">
          <select
            value={productFilter}
            onChange={(e) => setProductFilter(e.target.value)}
            className="rounded-full border border-outline-variant/30 bg-white px-3 py-1 text-xs font-semibold text-on-surface"
          >
            {productOptions.map((opt) => (
              <option key={opt.value} value={opt.value}>{opt.label}</option>
            ))}
          </select>
          {TYPE_FILTER_KEYS.map((t) => (
            <button
              key={t}
              type="button"
              onClick={() => setTypeFilter(t)}
              className={`rounded-full px-3 py-1 text-xs font-bold transition-colors ${
                typeFilter === t ? 'bg-primary text-on-primary' : 'bg-surface-container text-on-surface-variant hover:bg-surface-container-highest'
              }`}
            >
              {t === 'ALL' ? 'All' : (TYPE_META[t]?.label ?? t)}
            </button>
          ))}
        </div>

        {/* KPI Cards */}
        {!loading && allLogs.length > 0 && (
          <div className="grid grid-cols-3 gap-3 border-b border-outline-variant/10 px-4 py-3">
            <div className="rounded-xl bg-error-container/30 px-3 py-2.5">
              <p className="text-[10px] font-bold uppercase tracking-widest text-error/80">Total Purchased</p>
              <p className="mt-0.5 text-xl font-extrabold text-error">{kpis.purchased}</p>
              <p className="text-[10px] text-on-surface-variant">units distributed</p>
            </div>
            <div className="rounded-xl bg-green-50 px-3 py-2.5">
              <p className="text-[10px] font-bold uppercase tracking-widest text-green-700/80">Total Added</p>
              <p className="mt-0.5 text-xl font-extrabold text-green-700">{kpis.added}</p>
              <p className="text-[10px] text-on-surface-variant">units stocked in</p>
            </div>
            <div className="rounded-xl bg-primary/[0.08] px-3 py-2.5">
              <p className="text-[10px] font-bold uppercase tracking-widest text-primary/80">Log Entries</p>
              <p className="mt-0.5 text-xl font-extrabold text-primary">{kpis.entries}</p>
              <p className="text-[10px] text-on-surface-variant">total movements</p>
            </div>
          </div>
        )}

        {/* Timeline */}
        <div className="flex-1 overflow-y-auto p-6">
          {loading && <p className="text-sm text-on-surface-variant">Loading logs…</p>}
          {!loading && logs.length === 0 && (
            <div className="flex flex-col items-center gap-3 py-16 text-center">
              <span className="material-symbols-outlined text-4xl text-outline" aria-hidden>history</span>
              <p className="text-sm text-on-surface-variant">No log entries found.</p>
            </div>
          )}
          <div className="relative space-y-0">
            {logs.map((log, idx) => {
              const meta = TYPE_META[log.changeType] ?? { label: log.changeType, icon: 'info', color: 'text-outline bg-surface-container-low' }
              const itemLabel = log.bookItem?.label ?? log.uniformSize?.name ?? log.accessory?.name ?? '—'
              return (
                <div key={log.id} className="relative flex gap-4 pb-6">
                  {/* Timeline line */}
                  {idx < logs.length - 1 && (
                    <div className="absolute left-5 top-10 bottom-0 w-0.5 bg-outline-variant/20" />
                  )}
                  {/* Icon */}
                  <div className={`relative z-10 flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${meta.color}`}>
                    <span className="material-symbols-outlined text-lg" aria-hidden>{meta.icon}</span>
                  </div>
                  {/* Content */}
                  <div className="flex-1 min-w-0">
                    <div className="flex items-start justify-between gap-2">
                      <div>
                        <p className="text-sm font-bold text-on-surface">{meta.label}</p>
                        <p className="text-xs text-on-surface-variant">{itemLabel}</p>
                      </div>
                      <div className="text-right shrink-0">
                        <p className={`text-base ${deltaColor(log.changeType)}`}>
                          {formatDelta(log.quantityDelta, log.changeType)}
                        </p>
                        <p className="text-xs text-on-surface-variant">→ {log.quantityAfter} units</p>
                      </div>
                    </div>
                    {log.notes && (
                      <p className="mt-1 text-xs italic text-on-surface-variant">"{log.notes}"</p>
                    )}
                    <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-0.5 text-[10px] text-outline">
                      <span>{new Date(log.eventDate ?? log.createdAt).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })}</span>
                      {log.performedBy?.displayName && <span>by {log.performedBy.displayName}</span>}
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        </div>
      </div>
    </div>
  )
}
