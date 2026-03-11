require("dotenv").config();

const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const { Client } = require("pg");

const DB_PATH_RAW = process.env.DB_PATH || "./serena.db";
const SQLITE_PATH = path.isAbsolute(DB_PATH_RAW) ? DB_PATH_RAW : path.resolve(process.cwd(), DB_PATH_RAW);
const DATABASE_URL = process.env.DATABASE_URL;

if (!DATABASE_URL) {
  console.error("DATABASE_URL nao definido. Exemplo: postgres://user:pass@host:5432/db");
  process.exit(1);
}

const schemaPath = path.resolve(process.cwd(), "db", "schema.postgres.sql");
if (!fs.existsSync(schemaPath)) {
  console.error("Schema Postgres nao encontrado em db/schema.postgres.sql");
  process.exit(1);
}

const TABLES = [
  { name: "bookings", cols: ["id", "name", "email", "service", "date", "time", "customer_email", "created_at"] },
  { name: "messages", cols: ["id", "name", "email", "message", "customer_email", "created_at"] },
  { name: "customers", cols: ["id", "name", "email", "password_hash", "created_at", "failed_login_attempts", "locked_at", "force_password_change", "first_login_completed_at", "unlocked_by_admin_at", "extra_discount_percent", "extra_discount_note", "extra_discount_updated_at"] },
  { name: "admin_credentials", cols: ["id", "email", "password_hash", "created_at", "updated_at"] },
  { name: "refresh_tokens", cols: ["id", "user_email", "user_role", "token_hash", "expires_at", "revoked_at", "created_at"] },
  { name: "admin_2fa_challenges", cols: ["id", "user_email", "challenge_id", "code_hash", "expires_at", "attempts_left", "consumed_at", "created_at"] },
  { name: "password_reset_tokens", cols: ["id", "user_email", "user_role", "token_hash", "expires_at", "used_at", "created_at"] },
  { name: "discount_codes", cols: ["id", "code", "description", "percent_off", "active", "created_by", "created_at", "updated_at"] },
  { name: "massage_packs", cols: ["id", "name", "services_json", "active", "created_by", "created_at", "updated_at"] }
];

function buildInsertSql(table) {
  const cols = table.cols;
  const placeholders = cols.map(function (_, i) { return "$" + (i + 1); }).join(", ");
  return "INSERT INTO " + table.name + " (" + cols.join(", ") + ") VALUES (" + placeholders + ") ON CONFLICT DO NOTHING";
}

async function run() {
  if (!fs.existsSync(SQLITE_PATH)) {
    console.error("Base SQLite nao encontrada em " + SQLITE_PATH);
    process.exit(1);
  }

  const sqlite = new Database(SQLITE_PATH, { readonly: true });
  const pg = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try {
    await pg.connect();
    const schema = fs.readFileSync(schemaPath, "utf8");
    await pg.query(schema);

    for (const table of TABLES) {
      const rows = sqlite.prepare("SELECT " + table.cols.join(", ") + " FROM " + table.name).all();
      if (!rows.length) {
        console.log(table.name + ": 0 registos");
        continue;
      }

      const insertSql = buildInsertSql(table);
      await pg.query("BEGIN");
      try {
        for (const row of rows) {
          const values = table.cols.map(function (c) { return row[c]; });
          await pg.query(insertSql, values);
        }
        await pg.query("COMMIT");
        console.log(table.name + ": " + rows.length + " registos migrados");
      } catch (e) {
        await pg.query("ROLLBACK");
        throw e;
      }
    }

    console.log("Migracao concluida com sucesso.");
  } finally {
    sqlite.close();
    await pg.end();
  }
}

run().catch(function (err) {
  console.error("Falha na migracao:", err.message);
  process.exit(1);
});
