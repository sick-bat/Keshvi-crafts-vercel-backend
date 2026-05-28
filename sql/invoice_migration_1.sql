BEGIN;

CREATE TABLE IF NOT EXISTS "Invoice" (
  id TEXT PRIMARY KEY,
  "orderId" TEXT NOT NULL UNIQUE REFERENCES "Order"(id) ON DELETE CASCADE,
  "invoiceNumber" TEXT NOT NULL UNIQUE,
  "downloadTokenHash" TEXT NOT NULL,
  "emailLinkedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_orderId_key" ON "Invoice"("orderId");
CREATE UNIQUE INDEX IF NOT EXISTS "Invoice_invoiceNumber_key" ON "Invoice"("invoiceNumber");
CREATE INDEX IF NOT EXISTS "Invoice_invoiceNumber_idx" ON "Invoice"("invoiceNumber");
CREATE INDEX IF NOT EXISTS "Invoice_createdAt_idx" ON "Invoice"("createdAt");

COMMIT;
