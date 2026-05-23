import bcrypt from "bcryptjs";
import dotenv from "dotenv";
import { query, pool } from "./db.js";

dotenv.config();

const email = process.env.ADMIN_EMAIL;
const password = process.env.ADMIN_PASSWORD;

if (!email || !password) {
  console.error("ADMIN_EMAIL and ADMIN_PASSWORD are required in .env");
  process.exit(1);
}

await query(`
  CREATE TABLE IF NOT EXISTS staff_users (
    id TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
    email TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'staff',
    active BOOLEAN NOT NULL DEFAULT true,
    created_at TIMESTAMP NOT NULL DEFAULT now()
  );
`);

const passwordHash = await bcrypt.hash(password, 12);

await query(`
  INSERT INTO staff_users (email, password_hash, role, active)
  VALUES ($1, $2, 'admin', true)
  ON CONFLICT (email)
  DO UPDATE SET password_hash = EXCLUDED.password_hash, active = true, role = 'admin';
`, [email.toLowerCase(), passwordHash]);

console.log(`Admin user ready: ${email}`);
await pool.end();
