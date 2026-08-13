-- AlterTable Order: business order date
ALTER TABLE "Order" ADD COLUMN IF NOT EXISTS "orderDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "Order" SET "orderDate" = COALESCE("paidAt", "createdAt");

CREATE INDEX IF NOT EXISTS "Order_orderDate_idx" ON "Order"("orderDate");
CREATE INDEX IF NOT EXISTS "Order_branchId_orderDate_idx" ON "Order"("branchId", "orderDate");

-- AlterTable InventoryLog: business event date
ALTER TABLE "InventoryLog" ADD COLUMN IF NOT EXISTS "eventDate" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
UPDATE "InventoryLog" SET "eventDate" = "createdAt";

CREATE INDEX IF NOT EXISTS "InventoryLog_eventDate_idx" ON "InventoryLog"("eventDate");
CREATE INDEX IF NOT EXISTS "InventoryLog_branchId_eventDate_idx" ON "InventoryLog"("branchId", "eventDate");

-- CreateEnum OrderEditStatus
DO $$ BEGIN
  CREATE TYPE "OrderEditStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN');
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

-- CreateTable OrderEditRequest
CREATE TABLE IF NOT EXISTS "OrderEditRequest" (
    "id" TEXT NOT NULL,
    "orderId" TEXT NOT NULL,
    "branchId" TEXT NOT NULL,
    "status" "OrderEditStatus" NOT NULL DEFAULT 'PENDING',
    "reason" TEXT,
    "beforeSnapshot" JSONB NOT NULL,
    "afterSnapshot" JSONB NOT NULL,
    "diffSummary" JSONB,
    "requestedById" TEXT NOT NULL,
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OrderEditRequest_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "OrderEditRequest_orderId_idx" ON "OrderEditRequest"("orderId");
CREATE INDEX IF NOT EXISTS "OrderEditRequest_branchId_idx" ON "OrderEditRequest"("branchId");
CREATE INDEX IF NOT EXISTS "OrderEditRequest_status_idx" ON "OrderEditRequest"("status");
CREATE INDEX IF NOT EXISTS "OrderEditRequest_status_createdAt_idx" ON "OrderEditRequest"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "OrderEditRequest_branchId_status_idx" ON "OrderEditRequest"("branchId", "status");

DO $$ BEGIN
  ALTER TABLE "OrderEditRequest" ADD CONSTRAINT "OrderEditRequest_orderId_fkey"
    FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "OrderEditRequest" ADD CONSTRAINT "OrderEditRequest_branchId_fkey"
    FOREIGN KEY ("branchId") REFERENCES "Branch"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "OrderEditRequest" ADD CONSTRAINT "OrderEditRequest_requestedById_fkey"
    FOREIGN KEY ("requestedById") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;

DO $$ BEGIN
  ALTER TABLE "OrderEditRequest" ADD CONSTRAINT "OrderEditRequest_reviewedById_fkey"
    FOREIGN KEY ("reviewedById") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN null; END $$;
