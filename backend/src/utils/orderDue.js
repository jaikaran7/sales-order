const DISCOUNT_NOTE_RE = /Discount [Aa]pplied:\s*₹?([\d,]+(?:\.\d+)?)/g

function parseDiscountFromText(text) {
  if (!text) return 0
  let total = 0
  for (const match of String(text).matchAll(DISCOUNT_NOTE_RE)) {
    total += Number(String(match[1]).replace(/,/g, ''))
  }
  return total
}

function sumOrderDiscount(order) {
  let discount = parseDiscountFromText(order.notes)
  for (const tx of order.transactions ?? []) {
    discount += parseDiscountFromText(tx.notes)
  }
  return discount
}

function computeOrderDue(order) {
  const totalAmount = Number(order.total ?? 0)
  const paidAmount = Number(order.paidAmount ?? 0)
  const discountAmount = sumOrderDiscount(order)
  const effectiveTotal = Math.max(0, totalAmount - discountAmount)
  const dueAmount = Math.max(0, effectiveTotal - paidAmount)
  return { totalAmount, paidAmount, discountAmount, effectiveTotal, dueAmount }
}

function isOrderFullySettled(order) {
  return computeOrderDue(order).dueAmount <= 0.009
}

/** Pure credit due: nothing collected yet, and credit was taken or checkout never completed. */
function isPureCreditDueOrder(order) {
  const paidAmount = Number(order.paidAmount ?? 0)
  if (paidAmount > 0.009) return false

  const txs = order.transactions ?? []
  if (txs.some((tx) => tx.paymentMethod === 'CREDIT')) return true

  // DRAFT orders with books issued but no payment row recorded at checkout.
  return txs.length === 0 && order.paymentStatus === 'UNPAID'
}

function creditOrderMatchesDateRange(order, dateFrom, dateTo) {
  if (!dateFrom && !dateTo) return true

  const from = dateFrom ? new Date(dateFrom) : null
  const to = dateTo ? new Date(dateTo) : null
  const creditTxn = (order.transactions ?? []).find((tx) => tx.paymentMethod === 'CREDIT')
  const anchor = creditTxn
    ? new Date(creditTxn.paidAt ?? creditTxn.createdAt)
    : new Date(order.orderDate ?? order.createdAt)

  if (from && anchor < from) return false
  if (to && anchor > to) return false
  return true
}

module.exports = {
  computeOrderDue,
  isOrderFullySettled,
  isPureCreditDueOrder,
  creditOrderMatchesDateRange,
  sumOrderDiscount,
  parseDiscountFromText,
}
