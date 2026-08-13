import { paymentMethodLabel } from '@/constants/paymentMethods'

function money(n) {
  return Number(n ?? 0)
}

function mapStatus(status) {
  if (status === 'COMPLETED' || status === 'PAID') return 'Paid'
  if (status === 'PARTIAL') return 'Partial'
  if (status === 'UNPAID') return 'Credit'
  return 'Pending'
}

function formatDateTime(value) {
  if (!value) return '—'
  const dt = new Date(value)
  return dt.toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' })
}

function summarizeMethods(transactions = []) {
  const totals = new Map()
  for (const tx of transactions) {
    const method = paymentMethodLabel(tx?.paymentMethod)
    const amount = money(tx?.paymentMethod === 'CREDIT' ? 0 : tx?.amount)
    totals.set(method, (totals.get(method) ?? 0) + amount)
  }
  return Array.from(totals.entries()).map(([method, amount]) => ({ method, amount }))
}

export function buildTransactionDetailFromOrder(order) {
  const items = Array.isArray(order?.items) ? order.items : []
  const bookItems = items.filter((i) => i.itemType === 'BOOK')
  const uniformItemsRaw = items.filter((i) => i.itemType === 'UNIFORM')
  const accessoryItems = items.filter((i) => i.itemType === 'ACCESSORY')
  const transactions = Array.isArray(order?.transactions) ? order.transactions : []
  const latestPayment = [...transactions].sort((a, b) => new Date(b.paidAt ?? b.createdAt) - new Date(a.paidAt ?? a.createdAt))[0]
  const totalAmount = money(order?.total)
  const paidAmount = money(order?.paidAmount)
  const dueAmount = Math.max(0, totalAmount - paidAmount)
  const methodBreakdown = summarizeMethods(transactions)
  const paymentMode = methodBreakdown.length
    ? methodBreakdown.map((m) => `${m.method} ₹${m.amount.toFixed(2)}`).join(', ')
    : paymentMethodLabel(order?.paymentMethod ?? latestPayment?.paymentMethod)

  const booksReceivedStatus =
    order?.bookStatus === 'TAKEN' ? 'Full' :
    order?.bookStatus === 'PARTIAL' ? 'Partial' :
    'Not Taken'

  const reorderState =
    order?.student?.id && order?.branchId && order?.student?.class
      ? {
          selectedStudents: [{
            id: order.student.id,
            name: order.student.name,
            roll: order.student.rollNumber ?? '',
            initials: order.student.initials ?? String(order.student.name ?? '?').slice(0, 2).toUpperCase(),
            guardian: order.student.guardianName ?? 'N/A',
            parentPhone: order.student.guardianPhone ?? '',
            books: booksReceivedStatus === 'Full' ? 'Taken' : booksReceivedStatus === 'Partial' ? 'Partial' : 'Not Taken',
            payment: mapStatus(order.paymentStatus),
            latestOrderId: order.orderId,
          }],
          selectedClass: {
            id: Number(order.student.class.grade),
            name: order.student.class.label ?? `Class ${order.student.class.grade}`,
          },
          selectedSection: {
            id: order.student.class.id,
            name: `Section ${order.student.class.section ?? ''}`.trim(),
            section: order.student.class.section ?? '',
          },
          classId: order.student.class.id,
          branchId: order.branchId,
        }
      : null

  const clearDueState = reorderState
    ? {
        ...reorderState,
        existingOrderId: order?.id ?? null,
        existingOrderNumber: order?.orderId ?? null,
        dueAmount,
        totalAmount,
        paidAmount,
      }
    : null

  const businessDate = order?.orderDate ?? order?.createdAt

  const timeline = [
    {
      key: 'created',
      title: 'Order Created',
      description: 'Order has been placed',
      time: formatDateTime(businessDate),
      status: 'done',
      icon: 'check',
    },
  ]
  if (order?.bookStatus === 'TAKEN' || order?.bookStatus === 'PARTIAL') {
    timeline.push({
      key: 'books-received',
      title: 'Books Received',
      description: order?.bookStatus === 'TAKEN' ? 'Books fully issued to student' : 'Books partially issued to student',
      time: formatDateTime(order?.updatedAt ?? order?.createdAt),
      status: 'done',
      icon: 'menu_book',
    })
  }
  timeline.push(
    ...transactions.map((tx) => ({
      key: tx.id,
      title: `Payment ${paymentMethodLabel(tx.paymentMethod)}`,
      description: `₹${money(tx.amount).toFixed(2)} • ${mapStatus(tx.status)}`,
      time: formatDateTime(tx.paidAt ?? tx.createdAt),
      status: tx.status === 'PAID' ? 'done' : 'pending',
      icon: tx.status === 'PAID' ? 'payments' : 'schedule',
    })),
  )

  return {
    id: String(order?.id ?? ''),
    orderId: order?.orderId ?? '—',
    status: mapStatus(order?.paymentStatus ?? order?.status),
    orderedLine: `Ordered on ${formatDateTime(businessDate)}`,
    orderNotes: order?.notes ?? '',
    bookBadge: `Books: ${bookItems.length} item${bookItems.length === 1 ? '' : 's'}`,
    uniformBadge: `Uniform: ${uniformItemsRaw.length} item${uniformItemsRaw.length === 1 ? '' : 's'}`,
    bookLines: bookItems.map((line) => ({
      icon: 'menu_book',
      iconBg: 'bg-primary-fixed text-primary',
      title: line.label,
      subtitle: `Qty ${line.quantity}`,
      price: money(line.totalPrice ?? money(line.unitPrice) * money(line.quantity)),
    })),
    uniformItems: [
      ...uniformItemsRaw.map((line) => ({ title: line.label, detail: `Qty ${line.quantity} • ₹${money(line.totalPrice).toFixed(2)}` })),
      ...accessoryItems.map((line) => ({ title: line.label, detail: `Qty ${line.quantity} • ₹${money(line.totalPrice).toFixed(2)}` })),
    ],
    student: {
      name: order?.student?.name ?? 'Unknown',
      studentId: order?.student?.rollNumber ?? '—',
      photo: '',
      classShort: order?.student?.class?.label ?? '—',
      section: order?.student?.class?.section ?? '—',
      phone: order?.student?.guardianPhone ?? '—',
    },
    financial: {
      subtotal: money(order?.subtotal),
      total: totalAmount,
      paidAmount,
      dueAmount,
      paymentMode,
      referenceId: latestPayment?.referenceId ?? '—',
      paidTimestamp: formatDateTime(latestPayment?.paidAt ?? latestPayment?.createdAt),
      paymentStatus: order?.paymentStatus ?? 'UNPAID',
    },
    timeline,
    reorderState,
    clearDueState,
  }
}

export function buildGroupTransactionDetail(group) {
  if (!group?.id) return null
  const splitDetails = Array.isArray(group.splitDetails) ? group.splitDetails : []
  const paymentSummary = splitDetails
    .map((s) => `${paymentMethodLabel(s.paymentMethod)} ₹${Number(s.amount).toLocaleString('en-IN')}`)
    .join(' + ')

  return {
    groupId: group.id,
    groupRef: group.groupRef,
    branchName: group.branch?.name ?? '—',
    createdBy: group.createdBy?.displayName ?? '—',
    paidAt: group.paidAt,
    totalAmount: Number(group.totalAmount ?? 0),
    splitDetails,
    paymentSummary,
    orders: (group.orders ?? []).map((order) => buildTransactionDetailFromOrder(order)),
  }
}
