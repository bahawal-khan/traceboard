// Waits until the database answers a query through the Neon driver (CI: the local proxy + Postgres).
//   ADMIN_DATABASE_URL=... node scripts/wait-for-db.mjs
import { neon } from "@neondatabase/serverless";
import { configureLocalNeon } from "../db/neon-local.mjs";

const url = process.env.ADMIN_DATABASE_URL;
if (!url) {
  console.error("Missing environment variable: ADMIN_DATABASE_URL");
  process.exit(1);
}
configureLocalNeon(url);
const sql = neon(url);
const deadline = Date.now() + 90_000;
let last;
while (Date.now() < deadline) {
  try {
    await sql`select 1`;
    console.log("database is ready");
    process.exit(0);
  } catch (err) {
    last = err;
    await new Promise((r) => setTimeout(r, 2_000));
  }
}
console.error(`database not ready after 90 s: ${String(last).slice(0, 200)}`);
process.exit(1);
