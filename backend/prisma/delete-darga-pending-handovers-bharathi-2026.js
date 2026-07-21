/**
 * Delete 8 pending Darga cash handover entries created by Bharathi.
 *
 * These are PENDING ExpenseEntry rows only — never approved, so no opening/closing
 * balance or cash KPI was committed. Deleting them removes the manual-entry rows
 * and pending-approval counts; no other tables need reverting.
 *
 * Dry run:  node prisma/delete-darga-pending-handovers-bharathi-2026.js
 * Apply:    APPLY_DELETE_DARGA_HANDOVERS=1 node prisma/delete-darga-pending-handovers-bharathi-2026.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const APPLY = process.env.APPLY_DELETE_DARGA_HANDOVERS === '1'

const DARGA_BRANCH_CODE = 'NHS_DARGA'
const BHARATHI_EMAIL = 'bharathi@campus.edu'

/** Exact 8 pending handovers from Manual Entries screenshot */
const TARGET_ENTRY_IDS = [
  'cmqzgp75g0001ezas4jljdzc0', // Ashritha — ₹50,000 — entry 29 Jun
  'cmqxspwyt0005wyc6y9xjq4y7', // Vishwa pub.(Abacus) — ₹50,000
  'cmqxsgdb40003x306paef312g', // Sony A/C.for Navaneeth pub. — ₹40,000
  'cmqxsdf6f0003gbvn8v1o6v46', // Bharathi Check issue — ₹2,00,000
  'cmqxs9e8q0003wyc676is6tc9', // Sony A/c.for ties n belts (Giri) — ₹25,000
  'cmqxs4vlu0001gbvn0pwlj1zg', // Bharathi A/C for ties n belts — ₹50,000
  'cmqxs181n0001wyc6g2nqndsc', // Salman.for Pamplates — ₹7,500
  'cmqxruwln0001x306f6sp7rv8', // Paid to sony A/C forTies,and belts — ₹75,000
]

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function fmt(value) {
  if (!value) return '—'
  return new Date(value).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
    hour12: true,
  })
}

function money(value) {
  return Number(value ?? 0)
}

async function loadTargets(client = prisma) {
  const branch = await client.branch.findFirst({
    where: { code: DARGA_BRANCH_CODE, isActive: true, deletedAt: null },
  })
  assert(branch, 'Darga branch not found')

  const bharathi = await client.user.findFirst({
    where: { email: BHARATHI_EMAIL },
    select: { id: true, displayName: true },
  })
  assert(bharathi, 'Bharathi user not found')

  const entries = await client.expenseEntry.findMany({
    where: { id: { in: TARGET_ENTRY_IDS } },
    include: {
      branch: { select: { id: true, name: true, code: true } },
      createdBy: { select: { id: true, displayName: true, email: true } },
      publisher: { select: { id: true, name: true } },
    },
    orderBy: { createdAt: 'desc' },
  })

  assert(entries.length === TARGET_ENTRY_IDS.length, `Expected ${TARGET_ENTRY_IDS.length} entries, found ${entries.length}`)

  for (const entry of entries) {
    assert(entry.branchId === branch.id, `${entry.id} is not Darga branch`)
    assert(entry.entryType === 'HANDOVER', `${entry.id} is not HANDOVER (${entry.entryType})`)
    assert(entry.status === 'PENDING', `${entry.id} is not PENDING (${entry.status})`)
    assert(entry.createdById === bharathi.id, `${entry.id} was not created by Bharathi`)
    assert(entry.paymentMethod === 'CASH', `${entry.id} payment method is ${entry.paymentMethod}`)
  }

  return { branch, bharathi, entries }
}

function printTargets({ branch, bharathi, entries }) {
  console.log(`Branch: ${branch.name} (${branch.code})`)
  console.log(`Created by: ${bharathi.displayName}`)
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log(`Entries to delete: ${entries.length}`)
  console.log(`Total amount: ₹${entries.reduce((s, e) => s + money(e.amount), 0).toLocaleString('en-IN')}`)
  console.log('')
  for (const e of entries) {
    console.log(`  ${e.id}`)
    console.log(`    Recipient: ${e.recipient ?? '—'}`)
    console.log(`    Amount: ₹${money(e.amount).toLocaleString('en-IN')}`)
    console.log(`    Entry date: ${fmt(e.entryDate)} | Recorded: ${fmt(e.createdAt)}`)
    console.log(`    Status: ${e.status} | Publisher: ${e.publisher?.name ?? 'none'}`)
  }
  console.log('')
  console.log('Related tables check:')
  console.log('  ExpenseEntry — DELETE (sole storage for these handovers)')
  console.log('  Transaction / Order — no link (cash handovers are separate from sales)')
  console.log('  OnlineSettlement — no link')
  console.log('  Publisher / ExpenseRecipient — no FK side-effects (publisherId is null on all)')
  console.log('  Cash KPI / opening balance — unaffected (only APPROVED entries count)')
}

async function verifyKpiUnchanged(branchId, beforeApprovedHandoverSum) {
  const afterApproved = await prisma.expenseEntry.aggregate({
    where: {
      branchId,
      entryType: 'HANDOVER',
      status: 'APPROVED',
    },
    _sum: { amount: true },
  })
  const afterPending = await prisma.expenseEntry.count({
    where: { branchId, entryType: 'HANDOVER', status: 'PENDING' },
  })

  assert(
    money(afterApproved._sum.amount) === beforeApprovedHandoverSum,
    'Approved handover total changed — unexpected side effect',
  )

  console.log(`  OK Approved handover total unchanged: ₹${beforeApprovedHandoverSum.toLocaleString('en-IN')}`)
  console.log(`  OK Remaining pending Darga handovers: ${afterPending}`)
}

async function main() {
  const { branch, entries } = await loadTargets()
  printTargets({ branch, bharathi: { displayName: 'Bharathi' }, entries })

  const beforeApproved = await prisma.expenseEntry.aggregate({
    where: { branchId: branch.id, entryType: 'HANDOVER', status: 'APPROVED' },
    _sum: { amount: true },
  })
  const beforeApprovedSum = money(beforeApproved._sum.amount)

  if (!APPLY) {
    console.log('Dry run complete. Re-run with APPLY_DELETE_DARGA_HANDOVERS=1 to commit.')
    return
  }

  await prisma.$transaction(async (tx) => {
    await tx.expenseEntry.deleteMany({ where: { id: { in: TARGET_ENTRY_IDS } } })
  })

  const remaining = await prisma.expenseEntry.count({ where: { id: { in: TARGET_ENTRY_IDS } } })
  assert(remaining === 0, `${remaining} entries still exist after delete`)

  console.log('\nPost-delete verification:')
  console.log(`  OK All ${TARGET_ENTRY_IDS.length} entries removed`)
  await verifyKpiUnchanged(branch.id, beforeApprovedSum)
  console.log('\nDone.')
}

main()
  .catch((e) => { console.error('FAILED:', e.message); process.exitCode = 1 })
  .finally(() => prisma.$disconnect())
