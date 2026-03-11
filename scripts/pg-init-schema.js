require("dotenv").config();

const fs = require("fs");
const path = require("path");
const { Client } = require("pg");

const DATABASE_URL = process.env.DATABASE_URL;
if (!DATABASE_URL) {
  console.error("DATABASE_URL nao definido.");
  process.exit(1);
}

async function run() {
  const schemaPath = path.resolve(process.cwd(), "db", "schema.postgres.sql");
  const sql = fs.readFileSync(schemaPath, "utf8");
  const pg = new Client({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

  try {
    await pg.connect();
    await pg.query(sql);
    console.log("Schema PostgreSQL aplicado com sucesso.");
  } finally {
    await pg.end();
  }
}

run().catch(function (err) {
  console.error("Falha ao aplicar schema PostgreSQL:", err.message);
  process.exit(1);
});
