import express from "express";
import cors from "cors";
import helmet from "helmet";
import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { query } from "./db.js";
import { createToken, requireAuth } from "./auth.js";

dotenv.config();

const app = express();
app.use(helmet());
app.use(express.json({ limit: "1mb" }));
app.use(cors({
  origin: process.env.CORS_ORIGIN?.split(",") || "*",
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

function normalizeStatus(value) {
  return String(value || "").trim().toUpperCase();
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
  const { status = "", paymentStatus = "", orderStatus = "", q = "", limit = "50", offset = "0" } = req.query;

  const safeLimit = Math.min(Number(limit) || 50, 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);
  const statusFilter = normalizeStatus(status);
  const paymentFilter = normalizeStatus(paymentStatus);
  const orderFilter = normalizeStatus(orderStatus || statusFilter);

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
      o.status,
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
      COUNT(oi.id)::int AS item_count
    FROM "Order" o
    LEFT JOIN "OrderItem" oi ON oi."orderId" = o.id
    WHERE
      ($1 = '' OR o."paymentStatus" = $1)
      AND ($2 = '' OR o."orderStatus" = $2)
      AND (
        $3 = ''
        OR o.id ILIKE $3
        OR o."fullName" ILIKE $3
        OR o."phoneNumber" ILIKE $3
        OR COALESCE(o.email, '') ILIKE $3
        OR COALESCE(o."merchantTransactionId", '') ILIKE $3
        OR COALESCE(o."payuTransactionId", '') ILIKE $3
      )
    GROUP BY o.id
    ORDER BY o."createdAt" DESC
    LIMIT $4 OFFSET $5;
  `, [
    PAYMENT_STATUSES.includes(paymentFilter) ? paymentFilter : "",
    ORDER_STATUSES.includes(orderFilter) ? orderFilter : "",
    q ? `%${q}%` : "",
    safeLimit,
    safeOffset
  ]);

  res.json(result.rows);
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

  res.json({ order: order.rows[0], items: items.rows, payments: payments.rows, timeline: timeline.rows });
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
        status = $1,
        "updatedAt" = now()
    WHERE id = $2
    RETURNING id, "paymentStatus", "orderStatus", status, "updatedAt";
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
        status = $1,
        "updatedAt" = now()
    WHERE id = $2
    RETURNING id, "paymentStatus", "orderStatus", status, "updatedAt";
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
app.listen(port, () => console.log(`Keshvi team API running on https://keshvi-crafts-vercel-backend.onrender.com`));
