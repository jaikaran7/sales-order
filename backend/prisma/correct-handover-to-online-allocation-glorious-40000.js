/**
 * Convert Darga cash handover → online allocation:
 * - Glorious publishers (sony A.C), ₹40,000, entry date 25 Jun 2026
 *
 * Dry run:
 *   node prisma/correct-handover-to-online-allocation-glorious-40000.js
 *
 * Apply:
 *   APPLY_EXPENSE_ENTRY_CORRECTION=1 node prisma/correct-handover-to-online-allocation-glorious-40000.js
 */

require('dotenv').config({ path: require('path').join(__dirname, '..', '.env') })
const { PrismaClient } = require('@prisma/client')

const prisma = new PrismaClient()
const APPLY = process.env.APPLY_EXPENSE_ENTRY_CORRECTION === '1'

const ENTRY_ID = 'cmr39144y0001wtk0kdq8o4eu'
const TO_ENTRY_TYPE = 'ONLINE_ALLOCATION'
const TO_PAYMENT_METHOD = 'OTHER'

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

async function loadEntry(client = prisma) {
  const entry = await client.expenseEntry.findUnique({
    where: { id: ENTRY_ID },
    include: {
      branch: true,
      publisher: true,
      createdBy: { select: { displayName: true } },
      approvedBy: { select: { displayName: true } },
    },
  })

  assert(entry, `Expense entry ${ENTRY_ID} not found`)
  assert(entry.branch.code === 'NHS_DARGA', `Branch mismatch: ${entry.branch.code}`)
  assert(entry.entryType === 'HANDOVER', `entryType is ${entry.entryType}, expected HANDOVER`)
  assert(Number(entry.amount) === 40000, `Amount mismatch: ${entry.amount}`)
  assert(entry.paymentMethod === 'CASH', `paymentMethod is ${entry.paymentMethod}, expected CASH`)
  assert(entry.recipient === 'Glorious publishers (sony A.C)', `Recipient mismatch: ${entry.recipient}`)
  assert(entry.status === 'APPROVED', `Status is ${entry.status}`)
  assert(entry.createdBy?.displayName === 'Bharathi', `Created by mismatch: ${entry.createdBy?.displayName}`)

  return entry
}

function printEntry(entry) {
  console.log(`ID: ${entry.id}`)
  console.log(`Branch: ${entry.branch.name}`)
  console.log(`Entry date: ${entry.entryDate.toISOString().slice(0, 10)}`)
  console.log(`Type: ${entry.entryType} | Method: ${entry.paymentMethod} | Amount: ₹${entry.amount}`)
  console.log(`Recipient: ${entry.recipient}`)
  console.log(`Status: ${entry.status} | Created by: ${entry.createdBy?.displayName} | Approved by: ${entry.approvedBy?.displayName}`)
}

async function main() {
  const before = await loadEntry()
  console.log(`Mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`)
  console.log(`Change: HANDOVER/CASH -> ${TO_ENTRY_TYPE}/${TO_PAYMENT_METHOD}`)
  printEntry(before)

  if (!APPLY) {
    console.log('\nDry run passed. Re-run with APPLY_EXPENSE_ENTRY_CORRECTION=1 to commit.')
    return
  }

  await prisma.expenseEntry.update({
    where: { id: ENTRY_ID },
    data: {
      entryType: TO_ENTRY_TYPE,
      paymentMethod: TO_PAYMENT_METHOD,
    },
  })

  const after = await prisma.expenseEntry.findUnique({
    where: { id: ENTRY_ID },
    include: {
      branch: true,
      createdBy: { select: { displayName: true } },
      approvedBy: { select: { displayName: true } },
    },
  })

  assert(after.entryType === TO_ENTRY_TYPE, 'entryType not updated')
  assert(after.paymentMethod === TO_PAYMENT_METHOD, 'paymentMethod not updated')
  assert(Number(after.amount) === 40000, 'amount changed unexpectedly')
  assert(after.recipient === 'Glorious publishers (sony A.C)', 'recipient changed unexpectedly')

  console.log('\nPost-change verification:')
  printEntry(after)
  console.log('\nDone. Expense entry converted to online allocation.')
}

main()
  .catch((err) => {
    console.error('FAILED:', err.message)
    process.exitCode = 1
  })
  .finally(() => prisma.$disconnect())
