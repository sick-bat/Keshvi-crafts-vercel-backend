BEGIN;

-- Run only after website, backend, and APK no longer read or write Order.status.
ALTER TABLE "Order"
  DROP COLUMN IF EXISTS status;

COMMIT;
