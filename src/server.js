import express from "express";
import cors from "cors";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { query } from "./db.js";
import { createToken, requireAuth } from "./auth.js";
import { renderInvoicePdf } from "./invoicePdf.js";

dotenv.config();

const app = express();
const allowedOrigins = (process.env.CORS_ORIGIN || "*")
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean);

app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(cors({
  origin(origin, callback) {
    if (!origin || allowedOrigins.includes("*") || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    return callback(new Error(`CORS blocked for origin: ${origin}`));
  },
  credentials: false
}));

app.get("/health", (req, res) => {
  res.json({ status: "UP", service: "keshvi-team-api" });
});

app.post("/api/auth/login", async (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ message: "Email and password required" });

  const result = await query(
    `SELECT id, email, password_hash, role, active
     FROM staff_users
     WHERE lower(email) = lower($1)
     LIMIT 1`,
    [email]
  );

  const user = result.rows[0];
  if (!user || !user.active) return res.status(401).json({ message: "Invalid login" });

  const ok = await bcrypt.compare(password, user.password_hash);
  if (!ok) return res.status(401).json({ message: "Invalid login" });

  const token = createToken(user);
  res.json({ token, user: { email: user.email, role: user.role } });
});

const PAYMENT_STATUSES = ["PENDING", "PAID", "FAILED", "REFUNDED"];
const ORDER_STATUSES = ["PENDING", "CONFIRMED", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED"];
const FULFILLMENT_REQUIRES_PAID = new Set(["PACKED", "SHIPPED", "DELIVERED"]);
const ORDER_TRANSITIONS = {
  PENDING: ["CONFIRMED", "CANCELLED"],
  CONFIRMED: ["PACKED", "CANCELLED"],
  PACKED: ["SHIPPED", "CANCELLED"],
  SHIPPED: ["DELIVERED"],
  DELIVERED: [],
  CANCELLED: []
};

async function ensureAdminTables() {
  await query(`
    CREATE TABLE IF NOT EXISTS admin_order_notes (
      id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      order_id TEXT NOT NULL REFERENCES "Order"(id) ON DELETE CASCADE,
      note TEXT NOT NULL,
      created_by TEXT,
      created_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS admin_archived_orders (
      order_id TEXT PRIMARY KEY REFERENCES "Order"(id) ON DELETE CASCADE,
      reason TEXT,
      archived_by TEXT,
      archived_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);

  await query(`
    CREATE TABLE IF NOT EXISTS admin_order_priorities (
      order_id TEXT PRIMARY KEY REFERENCES "Order"(id) ON DELETE CASCADE,
      priority TEXT NOT NULL,
      updated_by TEXT,
      updated_at TIMESTAMP NOT NULL DEFAULT now()
    );
  `);
}

function normalizeStatus(value) {
  return String(value || "").trim().toUpperCase();
}

function cleanDate(value) {
  const text = String(value || "").trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : "";
}

function csvCell(value) {
  const text = String(value ?? "");
  return `"${text.replaceAll('"', '""')}"`;
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") {
    return res.status(403).json({ message: "Admin access required" });
  }
  next();
}

async function createTimelineEvent({
  orderId,
  eventType,
  fromValue = null,
  toValue = null,
  actorType = "ADMIN",
  actorId = null,
  note = null,
  metadata = {}
}) {
  await query(`
    INSERT INTO "OrderTimelineEvent" (
      id, "orderId", "eventType", "fromValue", "toValue",
      "actorType", "actorId", note, metadata
    )
    VALUES ('evt_' || replace(gen_random_uuid()::text, '-', ''), $1, $2, $3, $4, $5, $6, $7, $8::jsonb)
  `, [
    orderId,
    eventType,
    fromValue,
    toValue,
    actorType,
    actorId,
    note,
    JSON.stringify(metadata)
  ]);
}

function registerOrderRoutes(prefix = "/api/orders") {
app.get(`${prefix}/summary`, requireAuth, async (req, res) => {
  const result = await query(`
    SELECT
      COUNT(*)::int AS total_orders,
      COUNT(*) FILTER (WHERE "paymentStatus" = 'PENDING')::int AS pending_payment_orders,
      COUNT(*) FILTER (WHERE "paymentStatus" = 'PAID')::int AS paid_orders,
      COUNT(*) FILTER (WHERE "paymentStatus" = 'FAILED')::int AS failed_payment_orders,
      COALESCE(SUM("totalAmountPaise") FILTER (WHERE "paymentStatus" = 'PENDING'), 0)::int AS pending_payment_amount_paise,
      COALESCE(SUM("totalAmountPaise") FILTER (WHERE "paymentStatus" = 'PAID'), 0)::int AS paid_amount_paise,
      COUNT(*) FILTER (WHERE "paymentStatus" = 'PAID' AND ("createdAt" + interval '5 hours 30 minutes')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS today_paid_orders,
      COALESCE(SUM("totalAmountPaise") FILTER (WHERE "paymentStatus" = 'PAID' AND ("createdAt" + interval '5 hours 30 minutes')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date), 0)::int AS today_paid_amount_paise,
      COUNT(*) FILTER (WHERE "paymentStatus" = 'PAID' AND "orderStatus" IN ('PENDING', 'CONFIRMED'))::int AS to_pack_orders,
      COUNT(*) FILTER (WHERE "orderStatus" = 'PACKED')::int AS to_ship_orders,
      COUNT(*) FILTER (WHERE "orderStatus" = 'DELIVERED' AND ("updatedAt" + interval '5 hours 30 minutes')::date = (now() AT TIME ZONE 'Asia/Kolkata')::date)::int AS delivered_today_orders,
      COUNT(*) FILTER (WHERE "orderStatus" = 'PENDING')::int AS pending_orders,
      COUNT(*) FILTER (WHERE "orderStatus" = 'CONFIRMED')::int AS confirmed_orders,
      COUNT(*) FILTER (WHERE "orderStatus" = 'PACKED')::int AS packed_orders,
      COUNT(*) FILTER (WHERE "orderStatus" = 'SHIPPED')::int AS shipped_orders,
      COUNT(*) FILTER (WHERE "orderStatus" = 'DELIVERED')::int AS delivered_orders,
      COALESCE(SUM("totalAmountPaise"), 0)::int AS total_amount_paise
    FROM "Order";
  `);
  res.json(result.rows[0]);
});

app.get(prefix, requireAuth, async (req, res) => {
  const {
    status = "",
    paymentStatus = "",
    orderStatus = "",
    q = "",
    dateFrom = "",
    dateTo = "",
    quickFilter = "",
    showArchived = "",
    limit = "50",
    offset = "0"
  } = req.query;

  const safeLimit = Math.min(Number(limit) || 50, 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const statusFilter = normalizeStatus(status);
  const paymentFilter = normalizeStatus(paymentStatus);
  const orderFilter = normalizeStatus(orderStatus || statusFilter);
  const fromFilter = cleanDate(dateFrom);
  const toFilter = cleanDate(dateTo);
  const quick = String(quickFilter || "").trim();
  const includeArchived = String(showArchived || "").toLowerCase() === "true";

  const result = await query(`
    SELECT
      o.id,
      o."fullName",
      o."phoneNumber",
      o.email,
      o.city,
      o.pincode,
      o."totalAmountPaise",
      o."paymentMethod",
      o."paymentStatus",
      o."orderStatus",
      o."merchantTransactionId",
      o."payuTransactionId",
      o."payuStatus",
      o."disputeStatus",
      o."refundStatus",
      o."refundAmount",
      o."createdAt",
      o."updatedAt",
      ao."archived_at" AS "archivedAt",
      ap.priority,
      COUNT(oi.id)::int AS item_count
    FROM "Order" o
    LEFT JOIN "OrderItem" oi ON oi."orderId" = o.id
    LEFT JOIN admin_archived_orders ao ON ao.order_id = o.id
    LEFT JOIN admin_order_priorities ap ON ap.order_id = o.id
    WHERE
      ($1 = '' OR o."paymentStatus" = $1)
      AND ($2 = '' OR o."orderStatus" = $2)
      AND ($6 = '' OR o."createdAt" >= $6::date)
      AND ($7 = '' OR o."createdAt" < ($7::date + interval '1 day'))
      AND ($8 = true OR ao.order_id IS NULL)
      AND (
        $9 = ''
        OR ($9 = 'PAID_NOT_PACKED' AND o."paymentStatus" = 'PAID' AND o."orderStatus" IN ('PENDING', 'CONFIRMED'))
        OR ($9 = 'SHIPPED_NOT_DELIVERED' AND o."orderStatus" = 'SHIPPED')
        OR ($9 = 'OLD_PENDING' AND o."paymentStatus" = 'PENDING' AND o."createdAt" < now() - interval '24 hours')
      )
      AND (
        $3 = ''
        OR o.id ILIKE $3
        OR o."fullName" ILIKE $3
        OR o."phoneNumber" ILIKE $3
        OR COALESCE(o.email, '') ILIKE $3
        OR COALESCE(o.city, '') ILIKE $3
        OR COALESCE(o.pincode, '') ILIKE $3
        OR COALESCE(o."merchantTransactionId", '') ILIKE $3
        OR COALESCE(o."payuTransactionId", '') ILIKE $3
        OR EXISTS (
          SELECT 1 FROM "OrderItem" search_oi
          WHERE search_oi."orderId" = o.id
            AND search_oi."productTitle" ILIKE $3
        )
      )
    GROUP BY o.id, ao."archived_at", ap.priority
    ORDER BY o."createdAt" DESC
    LIMIT $4 OFFSET $5;
  `, [
    PAYMENT_STATUSES.includes(paymentFilter) ? paymentFilter : "",
    ORDER_STATUSES.includes(orderFilter) ? orderFilter : "",
    q ? `%${q}%` : "",
    safeLimit,
    safeOffset,
    fromFilter,
    toFilter,
    includeArchived,
    quick
  ]);

  res.json(result.rows);
});

app.get(`${prefix}/export.csv`, requireAuth, async (req, res) => {
  const {
    status = "",
    paymentStatus = "",
    orderStatus = "",
    q = "",
    dateFrom = "",
    dateTo = "",
    quickFilter = "",
    showArchived = ""
  } = req.query;

  const statusFilter = normalizeStatus(status);
  const paymentFilter = normalizeStatus(paymentStatus);
  const orderFilter = normalizeStatus(orderStatus || statusFilter);
  const fromFilter = cleanDate(dateFrom);
  const toFilter = cleanDate(dateTo);
  const quick = String(quickFilter || "").trim();
  const includeArchived = String(showArchived || "").toLowerCase() === "true";

  const result = await query(`
    SELECT
      o.id,
      o."merchantTransactionId",
      o."fullName",
      o."phoneNumber",
      o.email,
      o.city,
      o.pincode,
      o."paymentStatus",
      o."orderStatus",
      o."totalAmountPaise",
      o."payuTransactionId",
      o."payuStatus",
      o."createdAt",
      COALESCE(ap.priority, '') AS priority,
      string_agg(oi."productTitle" || ' x' || oi.quantity, '; ' ORDER BY oi.id) AS items
    FROM "Order" o
    LEFT JOIN "OrderItem" oi ON oi."orderId" = o.id
    LEFT JOIN admin_archived_orders ao ON ao.order_id = o.id
    LEFT JOIN admin_order_priorities ap ON ap.order_id = o.id
    WHERE
      ($1 = '' OR o."paymentStatus" = $1)
      AND ($2 = '' OR o."orderStatus" = $2)
      AND ($3 = '' OR o."createdAt" >= $3::date)
      AND ($4 = '' OR o."createdAt" < ($4::date + interval '1 day'))
      AND ($5 = true OR ao.order_id IS NULL)
      AND (
        $6 = ''
        OR ($6 = 'PAID_NOT_PACKED' AND o."paymentStatus" = 'PAID' AND o."orderStatus" IN ('PENDING', 'CONFIRMED'))
        OR ($6 = 'SHIPPED_NOT_DELIVERED' AND o."orderStatus" = 'SHIPPED')
        OR ($6 = 'OLD_PENDING' AND o."paymentStatus" = 'PENDING' AND o."createdAt" < now() - interval '24 hours')
      )
      AND (
        $7 = ''
        OR o.id ILIKE $7
        OR o."fullName" ILIKE $7
        OR o."phoneNumber" ILIKE $7
        OR COALESCE(o.email, '') ILIKE $7
        OR COALESCE(o.city, '') ILIKE $7
        OR COALESCE(o.pincode, '') ILIKE $7
        OR COALESCE(o."merchantTransactionId", '') ILIKE $7
        OR COALESCE(o."payuTransactionId", '') ILIKE $7
        OR EXISTS (
          SELECT 1 FROM "OrderItem" search_oi
          WHERE search_oi."orderId" = o.id
            AND search_oi."productTitle" ILIKE $7
        )
      )
    GROUP BY o.id, ap.priority
    ORDER BY o."createdAt" DESC
    LIMIT 1000;
  `, [
    PAYMENT_STATUSES.includes(paymentFilter) ? paymentFilter : "",
    ORDER_STATUSES.includes(orderFilter) ? orderFilter : "",
    fromFilter,
    toFilter,
    includeArchived,
    quick,
    q ? `%${q}%` : ""
  ]);

  const header = [
    "Order ID",
    "Merchant TXN ID",
    "Customer",
    "Phone",
    "Email",
    "City",
    "Pincode",
    "Payment Status",
    "Order Status",
    "Priority",
    "Amount",
    "PayU TXN ID",
    "PayU Status",
    "Created At",
    "Items"
  ];
  const rows = result.rows.map((order) => [
    order.id,
    order.merchantTransactionId,
    order.fullName,
    order.phoneNumber,
    order.email,
    order.city,
    order.pincode,
    order.paymentStatus,
    order.orderStatus,
    order.priority,
    Number(order.totalAmountPaise || 0) / 100,
    order.payuTransactionId,
    order.payuStatus,
    new Date(order.createdAt).toISOString(),
    order.items
  ]);
  const csv = [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n");

  res.setHeader("Content-Type", "text/csv; charset=utf-8");
  res.setHeader("Content-Disposition", `attachment; filename="keshvi-orders-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(csv);
});

app.get(`${prefix}/:id`, requireAuth, async (req, res) => {
  const order = await query(`SELECT * FROM "Order" WHERE id = $1`, [req.params.id]);
  if (order.rowCount === 0) return res.status(404).json({ message: "Order not found" });

  const items = await query(`
    SELECT id, "productId", "productTitle", quantity, "priceAtPurchasePaise"
    FROM "OrderItem"
    WHERE "orderId" = $1
    ORDER BY id
  `, [req.params.id]);

  const payments = await query(`
    SELECT id, "eventType", "txnId", mihpayid, status, amount, source, "processedAt"
    FROM "PaymentEvent"
    WHERE "txnId" = $1 OR mihpayid = $2
    ORDER BY "processedAt" DESC
  `, [
    order.rows[0].merchantTransactionId || "",
    order.rows[0].payuTransactionId || ""
  ]);

  const timeline = await query(`
    SELECT id, "eventType", "fromValue", "toValue", "actorType", "actorId", note, metadata, "createdAt"
    FROM "OrderTimelineEvent"
    WHERE "orderId" = $1
    ORDER BY "createdAt" DESC
  `, [req.params.id]);

  const invoice = await query(`
    SELECT id, "invoiceNumber", "emailLinkedAt", "createdAt", "updatedAt"
    FROM "Invoice"
    WHERE "orderId" = $1
    LIMIT 1
  `, [req.params.id]);

  const notes = await query(`
    SELECT id, note, created_by AS "createdBy", created_at AS "createdAt"
    FROM admin_order_notes
    WHERE order_id = $1
    ORDER BY created_at DESC
  `, [req.params.id]);

  const priority = await query(`
    SELECT priority, updated_by AS "updatedBy", updated_at AS "updatedAt"
    FROM admin_order_priorities
    WHERE order_id = $1
    LIMIT 1
  `, [req.params.id]);

  res.json({
    order: order.rows[0],
    items: items.rows,
    payments: payments.rows,
    timeline: timeline.rows,
    invoice: invoice.rows[0] || null,
    notes: notes.rows,
    priority: priority.rows[0] || null
  });
});

app.get(`${prefix}/:id/invoice`, requireAuth, async (req, res) => {
  const order = await query(`SELECT * FROM "Order" WHERE id = $1`, [req.params.id]);
  if (order.rowCount === 0) return res.status(404).json({ message: "Order not found" });
  if (order.rows[0].paymentStatus !== "PAID") {
    return res.status(400).json({ message: "Invoice is available only for paid orders" });
  }

  const invoice = await query(`
    SELECT id, "invoiceNumber", "createdAt"
    FROM "Invoice"
    WHERE "orderId" = $1
    LIMIT 1
  `, [req.params.id]);
  if (invoice.rowCount === 0) return res.status(404).json({ message: "Invoice not found" });

  const items = await query(`
    SELECT "productTitle", quantity, "priceAtPurchasePaise"
    FROM "OrderItem"
    WHERE "orderId" = $1
    ORDER BY id
  `, [req.params.id]);

  const pdf = await renderInvoicePdf({
    ...invoice.rows[0],
    order: {
      ...order.rows[0],
      items: items.rows
    }
  });
  const filename = `${invoice.rows[0].invoiceNumber}.pdf`;

  res.setHeader("Content-Type", "application/pdf");
  res.setHeader("Content-Disposition", `inline; filename="${filename}"`);
  res.send(pdf);
});

app.post(`${prefix}/:id/notes`, requireAuth, async (req, res) => {
  const note = String(req.body?.note || "").trim().slice(0, 1000);
  if (!note) return res.status(400).json({ message: "Note is required" });

  const order = await query(`SELECT id FROM "Order" WHERE id = $1`, [req.params.id]);
  if (order.rowCount === 0) return res.status(404).json({ message: "Order not found" });

  const result = await query(`
    INSERT INTO admin_order_notes (order_id, note, created_by)
    VALUES ($1, $2, $3)
    RETURNING id, note, created_by AS "createdBy", created_at AS "createdAt"
  `, [req.params.id, note, req.user?.email || req.user?.sub || "admin"]);

  res.status(201).json(result.rows[0]);
});

app.patch(`${prefix}/:id/priority`, requireAuth, async (req, res) => {
  const priority = normalizeStatus(req.body?.priority);
  const allowed = ["", "URGENT", "GIFT", "CUSTOM", "CALL_BEFORE_DELIVERY"];

  if (!allowed.includes(priority)) {
    return res.status(400).json({ message: `Priority must be one of: ${allowed.filter(Boolean).join(", ")}` });
  }

  const order = await query(`SELECT id FROM "Order" WHERE id = $1`, [req.params.id]);
  if (order.rowCount === 0) return res.status(404).json({ message: "Order not found" });

  if (!priority) {
    await query(`DELETE FROM admin_order_priorities WHERE order_id = $1`, [req.params.id]);
    return res.json({ priority: null });
  }

  const result = await query(`
    INSERT INTO admin_order_priorities (order_id, priority, updated_by)
    VALUES ($1, $2, $3)
    ON CONFLICT (order_id)
    DO UPDATE SET priority = EXCLUDED.priority,
                  updated_by = EXCLUDED.updated_by,
                  updated_at = now()
    RETURNING priority, updated_by AS "updatedBy", updated_at AS "updatedAt"
  `, [req.params.id, priority, req.user?.email || req.user?.sub || "admin"]);

  res.json(result.rows[0]);
});

app.post(`${prefix}/bulk/archive-pending`, requireAuth, async (req, res) => {
  const olderThanDate = cleanDate(req.body?.olderThanDate);
  const reason = String(req.body?.reason || "Archived old unpaid pending orders").trim().slice(0, 300);

  if (!olderThanDate) return res.status(400).json({ message: "olderThanDate must be YYYY-MM-DD" });

  const result = await query(`
    INSERT INTO admin_archived_orders (order_id, reason, archived_by)
    SELECT o.id, $2, $3
    FROM "Order" o
    LEFT JOIN admin_archived_orders ao ON ao.order_id = o.id
    WHERE o."paymentStatus" = 'PENDING'
      AND o."orderStatus" = 'PENDING'
      AND o."createdAt" < $1::date
      AND ao.order_id IS NULL
    ON CONFLICT (order_id) DO NOTHING
    RETURNING order_id
  `, [olderThanDate, reason, req.user?.email || req.user?.sub || "admin"]);

  res.json({ archived: result.rowCount });
});

app.patch(`${prefix}/:id/order-status`, requireAuth, async (req, res) => {
  const nextStatus = normalizeStatus(req.body?.orderStatus || req.body?.status);
  const note = String(req.body?.note || "").trim().slice(0, 500) || null;

  if (!ORDER_STATUSES.includes(nextStatus)) {
    return res.status(400).json({ message: `Order status must be one of: ${ORDER_STATUSES.join(", ")}` });
  }

  const current = await query(`SELECT id, "paymentStatus", "orderStatus" FROM "Order" WHERE id = $1`, [req.params.id]);
  if (current.rowCount === 0) return res.status(404).json({ message: "Order not found" });

  const order = current.rows[0];
  if (order.orderStatus === nextStatus) {
    return res.json({ id: order.id, paymentStatus: order.paymentStatus, orderStatus: order.orderStatus, unchanged: true });
  }

  const allowedNext = ORDER_TRANSITIONS[order.orderStatus] || [];
  if (!allowedNext.includes(nextStatus)) {
    return res.status(400).json({ message: `Cannot move order from ${order.orderStatus} to ${nextStatus}` });
  }

  if (FULFILLMENT_REQUIRES_PAID.has(nextStatus) && order.paymentStatus !== "PAID") {
    return res.status(400).json({ message: "Cannot move fulfillment forward unless paymentStatus is PAID" });
  }

  const result = await query(`
    UPDATE "Order"
    SET "orderStatus" = $1,
        "updatedAt" = now()
    WHERE id = $2
    RETURNING id, "paymentStatus", "orderStatus", "updatedAt";
  `, [nextStatus, req.params.id]);

  await createTimelineEvent({
    orderId: req.params.id,
    eventType: "ORDER_STATUS_CHANGED",
    fromValue: order.orderStatus,
    toValue: nextStatus,
    actorType: "ADMIN",
    actorId: req.user?.sub || req.user?.email || null,
    note,
    metadata: { route: `${prefix}/:id/order-status` }
  });

  res.json(result.rows[0]);
});

app.patch(`${prefix}/:id/payment-status`, requireAuth, requireAdmin, async (req, res) => {
  const nextStatus = normalizeStatus(req.body?.paymentStatus);
  const note = String(req.body?.note || "").trim().slice(0, 500);

  if (!PAYMENT_STATUSES.includes(nextStatus)) {
    return res.status(400).json({ message: `Payment status must be one of: ${PAYMENT_STATUSES.join(", ")}` });
  }

  if (!note) {
    return res.status(400).json({ message: "A note is required for payment corrections" });
  }

  const current = await query(`SELECT id, "paymentStatus", "orderStatus" FROM "Order" WHERE id = $1`, [req.params.id]);
  if (current.rowCount === 0) return res.status(404).json({ message: "Order not found" });

  const order = current.rows[0];
  if (order.paymentStatus === nextStatus) {
    return res.json({ id: order.id, paymentStatus: order.paymentStatus, orderStatus: order.orderStatus, unchanged: true });
  }

  const result = await query(`
    UPDATE "Order"
    SET "paymentStatus" = $1,
        "updatedAt" = now()
    WHERE id = $2
    RETURNING id, "paymentStatus", "orderStatus", "updatedAt";
  `, [nextStatus, req.params.id]);

  await createTimelineEvent({
    orderId: req.params.id,
    eventType: "PAYMENT_STATUS_CORRECTED",
    fromValue: order.paymentStatus,
    toValue: nextStatus,
    actorType: "ADMIN",
    actorId: req.user?.sub || req.user?.email || null,
    note,
    metadata: { route: `${prefix}/:id/payment-status` }
  });

  res.json(result.rows[0]);
});

app.patch(`${prefix}/:id/status`, requireAuth, async (req, res) => {
  req.url = `${prefix}/${req.params.id}/order-status`;
  return res.status(410).json({ message: "Use PATCH /api/admin/orders/:id/order-status with orderStatus" });
});
}

registerOrderRoutes("/api/orders");
registerOrderRoutes("/api/admin/orders");

const port = Number(process.env.PORT || 8081);
await ensureAdminTables();
app.listen(port, () => console.log(`Keshvi team API running on http://localhost:${port}`));
