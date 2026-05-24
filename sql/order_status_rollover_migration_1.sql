BEGIN;

ALTER TABLE "Order"
  ADD COLUMN IF NOT EXISTS "paymentStatus" TEXT NOT NULL DEFAULT 'PENDING',
  ADD COLUMN IF NOT EXISTS "orderStatus" TEXT NOT NULL DEFAULT 'PENDING';

UPDATE "Order"
SET
  "paymentStatus" = CASE
    WHEN status = 'PENDING' THEN 'PENDING'
    WHEN status = 'PAID' THEN 'PAID'
    WHEN status = 'PACKED' THEN 'PAID'
    WHEN status = 'FAILED' THEN 'FAILED'
    ELSE 'PENDING'
  END,
  "orderStatus" = CASE
    WHEN status = 'PENDING' THEN 'PENDING'
    WHEN status = 'PAID' THEN 'CONFIRMED'
    WHEN status = 'PACKED' THEN 'PACKED'
    WHEN status = 'FAILED' THEN 'PENDING'
    ELSE 'PENDING'
  END;

CREATE TABLE IF NOT EXISTS "OrderTimelineEvent" (
  id TEXT PRIMARY KEY,
  "orderId" TEXT NOT NULL REFERENCES "Order"(id) ON DELETE CASCADE,
  "eventType" TEXT NOT NULL,
  "fromValue" TEXT,
  "toValue" TEXT,
  "actorType" TEXT NOT NULL,
  "actorId" TEXT,
  note TEXT,
  metadata JSONB,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS "Order_paymentStatus_idx" ON "Order"("paymentStatus");
CREATE INDEX IF NOT EXISTS "Order_orderStatus_idx" ON "Order"("orderStatus");
CREATE INDEX IF NOT EXISTS "Order_createdAt_idx" ON "Order"("createdAt");
CREATE INDEX IF NOT EXISTS "OrderTimelineEvent_orderId_idx" ON "OrderTimelineEvent"("orderId");
CREATE INDEX IF NOT EXISTS "OrderTimelineEvent_eventType_idx" ON "OrderTimelineEvent"("eventType");
CREATE INDEX IF NOT EXISTS "OrderTimelineEvent_createdAt_idx" ON "OrderTimelineEvent"("createdAt");

INSERT INTO "OrderTimelineEvent" (
  id,
  "orderId",
  "eventType",
  "fromValue",
  "toValue",
  "actorType",
  note,
  metadata
)
SELECT
  'evt_' || replace(gen_random_uuid()::text, '-', ''),
  id,
  'STATUS_ROLLOVER',
  status,
  "paymentStatus" || '/' || "orderStatus",
  'SYSTEM',
  'Backfilled paymentStatus and orderStatus from legacy status',
  jsonb_build_object('legacyStatus', status)
FROM "Order"
WHERE NOT EXISTS (
  SELECT 1
  FROM "OrderTimelineEvent" e
  WHERE e."orderId" = "Order".id
    AND e."eventType" = 'STATUS_ROLLOVER'
);

COMMIT;

-- Manual review after running:
-- SELECT id, status FROM "Order" WHERE status NOT IN ('PENDING', 'PAID', 'PACKED', 'FAILED');
