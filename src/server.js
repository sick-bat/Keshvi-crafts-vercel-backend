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

app.get("/api/orders/summary", requireAuth, async (req, res) => {
  const result = await query(`
    SELECT
      COUNT(*)::int AS total_orders,
      COUNT(*) FILTER (WHERE status ILIKE 'pending')::int AS pending_orders,
      COUNT(*) FILTER (WHERE status ILIKE 'paid' OR "payuStatus" ILIKE 'success')::int AS paid_orders,
      COALESCE(SUM("totalAmountPaise"), 0)::int AS total_amount_paise
    FROM "Order";
  `);
  res.json(result.rows[0]);
});

app.get("/api/orders", requireAuth, async (req, res) => {
  const { status = "", q = "", limit = "50", offset = "0" } = req.query;

  const safeLimit = Math.min(Number(limit) || 50, 100);
  const safeOffset = Math.max(Number(offset) || 0, 0);

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
      ($1 = '' OR o.status ILIKE $1)
      AND (
        $2 = ''
        OR o.id ILIKE $2
        OR o."fullName" ILIKE $2
        OR o."phoneNumber" ILIKE $2
        OR COALESCE(o.email, '') ILIKE $2
        OR COALESCE(o."merchantTransactionId", '') ILIKE $2
        OR COALESCE(o."payuTransactionId", '') ILIKE $2
      )
    GROUP BY o.id
    ORDER BY o."createdAt" DESC
    LIMIT $3 OFFSET $4;
  `, [
    status ? `%${status}%` : "",
    q ? `%${q}%` : "",
    safeLimit,
    safeOffset
  ]);

  res.json(result.rows);
});

app.get("/api/orders/:id", requireAuth, async (req, res) => {
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

  res.json({ order: order.rows[0], items: items.rows, payments: payments.rows });
});

app.patch("/api/orders/:id/status", requireAuth, async (req, res) => {
  const { status } = req.body || {};
  const allowed = ["PENDING", "CONFIRMED", "PACKED", "SHIPPED", "DELIVERED", "CANCELLED", "REFUNDED"];

  if (!allowed.includes(String(status).toUpperCase())) {
    return res.status(400).json({ message: `Status must be one of: ${allowed.join(", ")}` });
  }

  const result = await query(`
    UPDATE "Order"
    SET status = $1, "updatedAt" = now()
    WHERE id = $2
    RETURNING id, status, "updatedAt";
  `, [String(status).toUpperCase(), req.params.id]);

  if (result.rowCount === 0) return res.status(404).json({ message: "Order not found" });
  res.json(result.rows[0]);
});

const port = Number(process.env.PORT || 8081);
app.listen(port, () => console.log(`Keshvi team API running on http://localhost:${port}`));
