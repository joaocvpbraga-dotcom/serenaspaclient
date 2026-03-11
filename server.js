require("dotenv").config();

const express = require("express");
const cors = require("cors");
const jwt = require("jsonwebtoken");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
const PORT = Number(process.env.PORT || 4000);
const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-this";
const ACCESS_TOKEN_TTL = process.env.ACCESS_TOKEN_TTL || "15m";
const REFRESH_TOKEN_TTL_DAYS = Number(process.env.REFRESH_TOKEN_TTL_DAYS || 7);
const FRONTEND_ORIGIN = process.env.FRONTEND_ORIGIN || "*";
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "admin@espaco-serena.local").toLowerCase();
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "change-me-now";
const PASSWORD_SALT = process.env.PASSWORD_SALT || "espaco-serena-salt-v1";
const ADMIN_2FA_ENABLED = String(process.env.ADMIN_2FA_ENABLED || "true").toLowerCase() === "true";
const ADMIN_2FA_CODE_TTL_MINUTES = Number(process.env.ADMIN_2FA_CODE_TTL_MINUTES || 5);
const ADMIN_2FA_MAX_ATTEMPTS = Number(process.env.ADMIN_2FA_MAX_ATTEMPTS || 5);
const ADMIN_2FA_ALLOW_CONSOLE_FALLBACK = String(process.env.ADMIN_2FA_ALLOW_CONSOLE_FALLBACK || "true").toLowerCase() === "true";
const CLIENT_LOGIN_MAX_ATTEMPTS = Number(process.env.CLIENT_LOGIN_MAX_ATTEMPTS || 3);
const CLIENT_UNLOCK_GENERIC_PASSWORD = process.env.CLIENT_UNLOCK_GENERIC_PASSWORD || "ChangeMeTemp@123!";
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID || "";
const TELEGRAM_BOOKINGS_BOT_TOKEN = process.env.TELEGRAM_BOOKINGS_BOT_TOKEN || "";
const TELEGRAM_BOOKINGS_CHAT_ID = process.env.TELEGRAM_BOOKINGS_CHAT_ID || TELEGRAM_CHAT_ID;
const TELEGRAM_WEBHOOK_SECRET = process.env.TELEGRAM_WEBHOOK_SECRET || "";
const TELEGRAM_POLLING_ENABLED = String(process.env.TELEGRAM_POLLING_ENABLED || "true").toLowerCase() === "true";
const NOTIFY_TEST_WINDOW_SECONDS = Number(process.env.NOTIFY_TEST_WINDOW_SECONDS || 60);
const NOTIFY_TEST_MAX_PER_WINDOW = Number(process.env.NOTIFY_TEST_MAX_PER_WINDOW || 3);
const NOTIFY_RATE_CLEANUP_SECONDS = Number(process.env.NOTIFY_RATE_CLEANUP_SECONDS || 300);
const TRUST_PROXY_ENABLED = String(process.env.TRUST_PROXY_ENABLED || "false").toLowerCase() === "true";
const DB_PATH_RAW = process.env.DB_PATH || "./serena.db";
const DB_PATH = path.isAbsolute(DB_PATH_RAW) ? DB_PATH_RAW : path.resolve(process.cwd(), DB_PATH_RAW);

const notifyTestRateMap = new Map();
const notifyUsageStats = {
  dayKey: "",
  rateLimitHits: 0,
  testsSent: 0
};

if (TRUST_PROXY_ENABLED) {
  app.set("trust proxy", 1);
}

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS bookings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  service TEXT NOT NULL,
  date TEXT NOT NULL,
  time TEXT NOT NULL,
  customer_email TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  message TEXT NOT NULL,
  customer_email TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS customers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_credentials (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  user_role TEXT NOT NULL DEFAULT 'admin',
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS admin_2fa_challenges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  challenge_id TEXT NOT NULL UNIQUE,
  code_hash TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts_left INTEGER NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS password_reset_tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_email TEXT NOT NULL,
  user_role TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  used_at TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS discount_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  code TEXT NOT NULL UNIQUE,
  description TEXT,
  percent_off INTEGER NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS massage_packs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  services_json TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`);

function ensureColumn(tableName, columnName, columnSql) {
  const cols = db.prepare("PRAGMA table_info(" + tableName + ")").all();
  const hasColumn = cols.some(function (col) {
    return col.name === columnName;
  });

  if (!hasColumn) {
    db.exec("ALTER TABLE " + tableName + " ADD COLUMN " + columnSql);
  }
}

ensureColumn("bookings", "customer_email", "customer_email TEXT");
ensureColumn("messages", "customer_email", "customer_email TEXT");
ensureColumn("refresh_tokens", "user_role", "user_role TEXT NOT NULL DEFAULT 'admin'");
ensureColumn("customers", "failed_login_attempts", "failed_login_attempts INTEGER NOT NULL DEFAULT 0");
ensureColumn("customers", "locked_at", "locked_at TEXT");
ensureColumn("customers", "force_password_change", "force_password_change INTEGER NOT NULL DEFAULT 1");
ensureColumn("customers", "first_login_completed_at", "first_login_completed_at TEXT");
ensureColumn("customers", "unlocked_by_admin_at", "unlocked_by_admin_at TEXT");
ensureColumn("customers", "extra_discount_percent", "extra_discount_percent INTEGER NOT NULL DEFAULT 0");
ensureColumn("customers", "extra_discount_note", "extra_discount_note TEXT");
ensureColumn("customers", "extra_discount_updated_at", "extra_discount_updated_at TEXT");

app.use(cors({ origin: FRONTEND_ORIGIN === "*" ? true : FRONTEND_ORIGIN }));
app.use(express.json({ limit: "1mb" }));

function hashPassword(value) {
  return crypto.pbkdf2Sync(value, PASSWORD_SALT, 310000, 32, "sha256").toString("hex");
}

const adminPasswordHash = hashPassword(ADMIN_PASSWORD);

function hashRefreshToken(value) {
  return crypto.createHash("sha256").update(value + PASSWORD_SALT).digest("hex");
}

function hashResetToken(value) {
  return crypto.createHash("sha256").update("reset:" + value + ":" + PASSWORD_SALT).digest("hex");
}
function ensureAdminCredentialSeeded() {
  const row = db.prepare("SELECT id FROM admin_credentials WHERE email = ? LIMIT 1").get(ADMIN_EMAIL);
  if (row) return;
  const now = new Date().toISOString();
  db.prepare("INSERT INTO admin_credentials (email, password_hash, created_at, updated_at) VALUES (?, ?, ?, ?)").run(
    ADMIN_EMAIL,
    hashPassword(ADMIN_PASSWORD),
    now,
    now
  );
}

ensureAdminCredentialSeeded();

function hashOtpCode(value) {
  return crypto.createHash("sha256").update("otp:" + value + ":" + PASSWORD_SALT).digest("hex");
}

function issueTokens(email, role) {
  const accessToken = jwt.sign({ role: role, email: email.toLowerCase() }, JWT_SECRET, {
    expiresIn: ACCESS_TOKEN_TTL
  });

  const refreshToken = crypto.randomBytes(64).toString("hex");
  const refreshTokenHash = hashRefreshToken(refreshToken);

  const expires = new Date();
  expires.setDate(expires.getDate() + REFRESH_TOKEN_TTL_DAYS);

  db.prepare(
    "INSERT INTO refresh_tokens (user_email, user_role, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)"
  ).run(email.toLowerCase(), role, refreshTokenHash, expires.toISOString(), new Date().toISOString());

  return { accessToken, refreshToken };
}

function revokeRefreshToken(rawToken) {
  if (!rawToken || typeof rawToken !== "string") {
    return;
  }
  const tokenHash = hashRefreshToken(rawToken);
  db.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE token_hash = ? AND revoked_at IS NULL").run(
    new Date().toISOString(),
    tokenHash
  );
}

function safeEq(a, b) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  if (aa.length !== bb.length) return false;
  return crypto.timingSafeEqual(aa, bb);
}

function ensureText(value, field, min, max) {
  if (typeof value !== "string") {
    throw new Error(field + " inválido");
  }
  const v = value.trim();
  if (v.length < min || v.length > max) {
    throw new Error(field + " deve ter entre " + min + " e " + max + " caracteres");
  }
  return v;
}

function normalizeDiscountCode(value) {
  return String(value || "")
    .trim()
    .toUpperCase()
    .replace(/\s+/g, "")
    .replace(/[^A-Z0-9_-]/g, "");
}

function generateOtpCode() {
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendTelegramMessage(text) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    const cfgErr = new Error("Telegram não configurado no backend");
    cfgErr.status = 503;
    throw cfgErr;
  }

  const url = "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: TELEGRAM_CHAT_ID,
      text: text
    })
  });

  if (!response.ok) {
    const err = new Error("Falha ao enviar código 2FA para Telegram");
    err.status = 503;
    throw err;
  }
}

async function sendTelegramBookingMessage(text) {
  const bookingToken = TELEGRAM_BOOKINGS_BOT_TOKEN || TELEGRAM_BOT_TOKEN;
  const bookingChatId = TELEGRAM_BOOKINGS_CHAT_ID || TELEGRAM_CHAT_ID;

  if (!bookingToken || !bookingChatId) {
    const cfgErr = new Error("Telegram de marcações não configurado no backend");
    cfgErr.status = 503;
    throw cfgErr;
  }

  const url = "https://api.telegram.org/bot" + bookingToken + "/sendMessage";
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: bookingChatId,
      text: text
    })
  });

  if (!response.ok) {
    const err = new Error("Falha ao enviar notificação Telegram de marcação");
    err.status = 503;
    throw err;
  }
}

async function sendTelegramReply(chatId, text) {
  if (!TELEGRAM_BOT_TOKEN || !chatId) {
    return;
  }

  const url = "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/sendMessage";
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text: text
    })
  });
}

function formatBookingShort(row) {
  return "- " + row.date + " " + row.time + " | " + row.service + " | " + row.name + " (" + row.email + ")";
}

function formatDatePt(dateObj) {
  const dd = String(dateObj.getDate()).padStart(2, "0");
  const mm = String(dateObj.getMonth() + 1).padStart(2, "0");
  const yyyy = String(dateObj.getFullYear());
  return dd + "/" + mm + "/" + yyyy;
}

function parseTelegramCommand(text) {
  const raw = String(text || "").trim();
  if (!raw) return { command: "", args: [] };
  const parts = raw.split(/\s+/g);
  const cmd = parts[0].toLowerCase().split("@")[0];
  return { command: cmd, args: parts.slice(1) };
}

function buildTelegramHelp() {
  return [
    "Comandos disponíveis:",
    "/marcacoes_hoje",
    "/marcacoes_amanha",
    "/marcacoes_email <email>",
    "/ajuda"
  ].join("\n");
}

async function handleTelegramCommandMessage(message) {
  if (!message || !message.chat || typeof message.text !== "string") {
    return;
  }

  const chatId = message.chat.id;
  const parsed = parseTelegramCommand(message.text);
  const cmd = parsed.command;
  const args = parsed.args;

  if (cmd === "/start" || cmd === "/ajuda" || cmd === "/help") {
    await sendTelegramReply(chatId, buildTelegramHelp());
    return;
  }

  if (cmd === "/marcacoes_hoje" || cmd === "/marcacoes_amanha") {
    const base = new Date();
    if (cmd === "/marcacoes_amanha") {
      base.setDate(base.getDate() + 1);
    }

    const targetDate = formatDatePt(base);
    const rows = db
      .prepare("SELECT name, email, service, date, time FROM bookings WHERE date = ? ORDER BY time ASC, id DESC LIMIT 50")
      .all(targetDate);

    if (!rows.length) {
      await sendTelegramReply(chatId, "Sem marcações para " + targetDate + ".");
      return;
    }

    const lines = rows.map(formatBookingShort);
    await sendTelegramReply(chatId, "Marcações para " + targetDate + ":\n" + lines.join("\n"));
    return;
  }

  if (cmd === "/marcacoes_email") {
    const email = String(args[0] || "").trim().toLowerCase();
    if (!email) {
      await sendTelegramReply(chatId, "Use: /marcacoes_email email@exemplo.com");
      return;
    }

    const rows = db
      .prepare("SELECT name, email, service, date, time FROM bookings WHERE lower(email) = ? OR lower(customer_email) = ? ORDER BY id DESC LIMIT 20")
      .all(email, email);

    if (!rows.length) {
      await sendTelegramReply(chatId, "Sem marcações para " + email + ".");
      return;
    }

    const lines = rows.map(formatBookingShort);
    await sendTelegramReply(chatId, "Últimas marcações de " + email + ":\n" + lines.join("\n"));
    return;
  }

  await sendTelegramReply(chatId, "Comando não reconhecido.\n" + buildTelegramHelp());
}

let telegramPollingOffset = 0;
let telegramPollingBusy = false;

async function pollTelegramOnce() {
  if (telegramPollingBusy || !TELEGRAM_BOT_TOKEN) {
    return;
  }

  telegramPollingBusy = true;
  try {
    const url = "https://api.telegram.org/bot" + TELEGRAM_BOT_TOKEN + "/getUpdates";
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ offset: telegramPollingOffset, timeout: 1 })
    });
    const data = await response.json().catch(function () { return {}; });
    const updates = Array.isArray(data.result) ? data.result : [];

    for (let i = 0; i < updates.length; i += 1) {
      const upd = updates[i] || {};
      telegramPollingOffset = Math.max(telegramPollingOffset, Number(upd.update_id || 0) + 1);
      const message = upd.message || upd.edited_message;
      await handleTelegramCommandMessage(message);
    }
  } catch (error) {
    console.warn("[TELEGRAM] Polling erro:", error && error.message ? error.message : error);
  } finally {
    telegramPollingBusy = false;
  }
}

function startTelegramPolling() {
  if (!TELEGRAM_POLLING_ENABLED || !TELEGRAM_BOT_TOKEN) {
    return;
  }

  setInterval(function () {
    pollTelegramOnce().catch(function (_err) {
      // polling failures are logged inside pollTelegramOnce
    });
  }, 3000);
}

function generateResetToken() {
  return crypto.randomBytes(24).toString("hex");
}

function detectRoleFromBody(body) {
  const raw = String((body && (body.role || body.accountType || body.userType)) || "").toLowerCase();
  if (raw === "admin" || raw === "client") return raw;
  return "";
}

async function issuePasswordReset(email, role) {
  const rawToken = generateOtpCode();
  const tokenHash = hashResetToken(rawToken);
  const now = new Date();
  const expiresAt = new Date(now.getTime() + 15 * 60 * 1000);

  db.prepare("INSERT INTO password_reset_tokens (user_email, user_role, token_hash, expires_at, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(email, role, tokenHash, expiresAt.toISOString(), now.toISOString());

  const resetText =
    "Espaço Serena - Repor Palavra-passe\n" +
    "Conta: " + role + "\n" +
    "Email: " + email + "\n" +
    "Código OTP: " + rawToken + "\n" +
    "Validade: 15 minutos";

  let delivery = "console";
  try {
    await sendTelegramMessage(resetText);
    delivery = "telegram";
  } catch (_err) {
    console.warn("[RESET] Telegram indisponível, código OTP no terminal.");
    console.warn(
      "[RESET] Role:",
      role,
      "| Email:",
      email,
      "| Código OTP:",
      rawToken
    );
  }

  return { delivery: delivery };
}

async function createAdmin2faChallenge(email) {
  const challengeId = crypto.randomBytes(16).toString("hex");
  const otpCode = generateOtpCode();
  const now = new Date();
  const expiresAt = new Date(now.getTime() + ADMIN_2FA_CODE_TTL_MINUTES * 60 * 1000);

  db.prepare(
    "INSERT INTO admin_2fa_challenges (user_email, challenge_id, code_hash, expires_at, attempts_left, created_at) VALUES (?, ?, ?, ?, ?, ?)"
  ).run(email, challengeId, hashOtpCode(otpCode), expiresAt.toISOString(), ADMIN_2FA_MAX_ATTEMPTS, now.toISOString());

  const tempToken = jwt.sign(
    { role: "admin", email: email, type: "admin-2fa", challengeId: challengeId },
    JWT_SECRET,
    { expiresIn: "10m" }
  );

  const msg =
    "Espaço Serena - Código 2FA Admin\n" +
    "Email: " + email + "\n" +
    "Código: " + otpCode + "\n" +
    "Validade: " + ADMIN_2FA_CODE_TTL_MINUTES + " minutos";

  let delivery = "telegram";
  let deliveryError = "";
  try {
    await sendTelegramMessage(msg);
  } catch (error) {
    if (!ADMIN_2FA_ALLOW_CONSOLE_FALLBACK) {
      throw error;
    }
    delivery = "console";
    deliveryError = (error && error.message) ? String(error.message) : "Falha no envio Telegram";
    console.warn("[2FA] Telegram indisponível, a usar fallback local.");
    console.warn("[2FA] Motivo:", deliveryError);
    console.warn("[2FA] Email:", email, "| Código:", otpCode, "| Validade(min):", ADMIN_2FA_CODE_TTL_MINUTES);
  }

  return {
    requires2fa: true,
    challengeId: challengeId,
    tempToken: tempToken,
    delivery: delivery,
    deliveryError: deliveryError,
    message: delivery === "telegram"
      ? "Código 2FA enviado para Telegram"
      : "Telegram indisponível (" + (deliveryError || "erro de envio") + "). Código 2FA disponível no terminal do backend"
  };
}

function resolveAdmin2faContext(req) {
  let challengeId = typeof req.body.challengeId === "string" ? req.body.challengeId.trim() : "";
  let email = typeof req.body.email === "string" ? req.body.email.trim().toLowerCase() : "";

  const authHeader = req.headers.authorization || "";
  if (authHeader.startsWith("Bearer ")) {
    const tempToken = authHeader.slice(7);
    try {
      const payload = jwt.verify(tempToken, JWT_SECRET);
      if (payload.type === "admin-2fa") {
        if (!challengeId && payload.challengeId) challengeId = String(payload.challengeId);
        if (!email && payload.email) email = String(payload.email).toLowerCase();
      }
    } catch (_err) {
      // Ignore invalid temporary token and fall back to request body fields.
    }
  }

  return { challengeId, email };
}

function verifyAdmin2faCode(challengeId, email, code) {
  const row = db
    .prepare(
      "SELECT id, user_email, code_hash, expires_at, attempts_left, consumed_at FROM admin_2fa_challenges WHERE challenge_id = ? LIMIT 1"
    )
    .get(challengeId);

  if (!row) {
    return { ok: false, status: 404, message: "Desafio 2FA não encontrado" };
  }

  if (email && row.user_email !== email) {
    return { ok: false, status: 401, message: "Desafio 2FA inválido para este email" };
  }

  if (row.consumed_at) {
    return { ok: false, status: 400, message: "Código 2FA já utilizado" };
  }

  if (new Date(row.expires_at).getTime() <= Date.now()) {
    return { ok: false, status: 401, message: "Código 2FA expirado" };
  }

  if (row.attempts_left <= 0) {
    return { ok: false, status: 429, message: "Número máximo de tentativas excedido" };
  }

  if (!safeEq(hashOtpCode(code), row.code_hash)) {
    db.prepare("UPDATE admin_2fa_challenges SET attempts_left = attempts_left - 1 WHERE id = ?").run(row.id);
    return { ok: false, status: 401, message: "Código 2FA inválido" };
  }

  db.prepare("UPDATE admin_2fa_challenges SET consumed_at = ?, attempts_left = 0 WHERE id = ?").run(
    new Date().toISOString(),
    row.id
  );

  return { ok: true, email: row.user_email };
}

function auth(expectedRole) {
  return function (req, res, next) {
    const header = req.headers.authorization || "";
    const parts = header.split(" ");
    const kind = parts[0];
    const token = parts[1];

    if (kind !== "Bearer" || !token) {
      return res.status(401).json({ message: "Token em falta" });
    }

    try {
      const payload = jwt.verify(token, JWT_SECRET);
      if (expectedRole && payload.role !== expectedRole) {
        return res.status(403).json({ message: "Sem permissão" });
      }
      req.user = payload;
      next();
    } catch (_error) {
      return res.status(401).json({ message: "Token inválido ou expirado" });
    }
  };
}

function createBooking(data) {
  db.prepare(
    "INSERT INTO bookings (name, email, service, date, time, customer_email, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
  ).run(
    data.name,
    data.email,
    data.service,
    data.date,
    data.time,
    data.customerEmail || null,
    new Date().toISOString()
  );
}

function createMessage(data) {
  db.prepare("INSERT INTO messages (name, email, message, customer_email, created_at) VALUES (?, ?, ?, ?, ?)").run(
    data.name,
    data.email,
    data.message,
    data.customerEmail || null,
    new Date().toISOString()
  );
}

function getRequestIp(req) {
  const forwarded = String(req.headers["x-forwarded-for"] || "").split(",")[0].trim();
  if (forwarded) return forwarded;
  const realIp = String(req.headers["x-real-ip"] || "").trim();
  if (realIp) return realIp;
  return String(req.ip || req.socket && req.socket.remoteAddress || "unknown");
}

function getTodayKeyPt() {
  return new Date().toISOString().slice(0, 10);
}

function ensureNotifyStatsDay() {
  const today = getTodayKeyPt();
  if (notifyUsageStats.dayKey !== today) {
    notifyUsageStats.dayKey = today;
    notifyUsageStats.rateLimitHits = 0;
    notifyUsageStats.testsSent = 0;
  }
}

function bumpNotifyUsage(field) {
  ensureNotifyStatsDay();
  if (field === "rateLimitHits") {
    notifyUsageStats.rateLimitHits += 1;
    return;
  }
  if (field === "testsSent") {
    notifyUsageStats.testsSent += 1;
  }
}

function getNotifyUsageSnapshot() {
  ensureNotifyStatsDay();
  return {
    day: notifyUsageStats.dayKey,
    rateLimitHits: notifyUsageStats.rateLimitHits,
    testsSent: notifyUsageStats.testsSent
  };
}

function checkNotifyTestRateLimit(adminEmail) {
  const key = String(adminEmail || "").toLowerCase();
  const now = Date.now();
  const windowMs = Math.max(10, NOTIFY_TEST_WINDOW_SECONDS) * 1000;
  const maxCount = Math.max(1, NOTIFY_TEST_MAX_PER_WINDOW);

  if (!key) {
    return { allowed: false, retryAfterSec: Math.ceil(windowMs / 1000) };
  }

  const existing = notifyTestRateMap.get(key);
  if (!existing || now > existing.resetAt) {
    notifyTestRateMap.set(key, { count: 1, resetAt: now + windowMs });
    return { allowed: true, remaining: maxCount - 1, retryAfterSec: Math.ceil(windowMs / 1000) };
  }

  if (existing.count >= maxCount) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
    };
  }

  existing.count += 1;
  notifyTestRateMap.set(key, existing);
  return {
    allowed: true,
    remaining: Math.max(0, maxCount - existing.count),
    retryAfterSec: Math.max(1, Math.ceil((existing.resetAt - now) / 1000))
  };
}

function cleanupNotifyTestRateMap() {
  const now = Date.now();
  notifyTestRateMap.forEach(function (entry, key) {
    if (!entry || typeof entry.resetAt !== "number" || now > entry.resetAt) {
      notifyTestRateMap.delete(key);
    }
  });
}

function startNotifyRateCleanup() {
  const everyMs = Math.max(30, NOTIFY_RATE_CLEANUP_SECONDS) * 1000;
  const timer = setInterval(cleanupNotifyTestRateMap, everyMs);
  if (typeof timer.unref === "function") {
    timer.unref();
  }
}

app.get("/api/health", function (_req, res) {
  res.json({ ok: true, service: "espaco-serena-backend" });
});

app.post("/api/auth/login", async function (req, res) {
  try {
    const email = ensureText(req.body.email, "Email", 5, 120).toLowerCase();
    const password = ensureText(req.body.password, "Password", 8, 120);

    if (email !== ADMIN_EMAIL) {
      return res.status(401).json({ message: "Credenciais inválidas" });
    }

    const adminCred = db.prepare("SELECT email, password_hash FROM admin_credentials WHERE email = ? LIMIT 1").get(ADMIN_EMAIL);
    if (!adminCred) {
      return res.status(500).json({ message: "Conta de admin não configurada" });
    }

    const receivedHash = hashPassword(password);
    const envPasswordConfigured = ADMIN_PASSWORD && ADMIN_PASSWORD !== "change-me-now";
    const matchesDbPassword = safeEq(receivedHash, adminCred.password_hash);
    const matchesEnvPassword = envPasswordConfigured && safeEq(receivedHash, adminPasswordHash);

    if (!matchesDbPassword && !matchesEnvPassword) {
      return res.status(401).json({ message: "Credenciais inválidas" });
    }

    if (!matchesDbPassword && matchesEnvPassword) {
      db.prepare("UPDATE admin_credentials SET password_hash = ?, updated_at = ? WHERE email = ?").run(
        adminPasswordHash,
        new Date().toISOString(),
        ADMIN_EMAIL
      );
    }

    if (ADMIN_2FA_ENABLED) {
      const challenge = await createAdmin2faChallenge(ADMIN_EMAIL);
      return res.status(202).json(challenge);
    }

    const tokens = issueTokens(ADMIN_EMAIL, "admin");
    return res.json(tokens);
  } catch (error) {
    const status = error && error.status ? Number(error.status) : 400;
    return res.status(status).json({ message: error.message || "Pedido inválido" });
  }
});

async function forgotPasswordHandler(req, res, forcedRole) {
  try {
    const submittedEmail = ensureText(req.body.email, "Email", 5, 120).toLowerCase();
    const requestedRole = forcedRole || detectRoleFromBody(req.body);
    const email = forcedRole === "admin" ? ADMIN_EMAIL : submittedEmail;

    const adminExists = Boolean(db.prepare("SELECT id FROM admin_credentials WHERE email = ? LIMIT 1").get(email));
    const clientExists = Boolean(db.prepare("SELECT id FROM customers WHERE email = ? LIMIT 1").get(email));

    let role = requestedRole;
    if (!role) {
      if (adminExists) role = "admin";
      else if (clientExists) role = "client";
    }

    if (forcedRole === "admin" && !adminExists) {
      return res.status(404).json({ message: "Email de admin não encontrado" });
    }

    const shouldIssue = (role === "admin" && adminExists) || (role === "client" && clientExists);
    if (shouldIssue) {
      await issuePasswordReset(email, role);
    }

    return res.json({ message: "Se o email existir, enviamos instruções de recuperação." });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
}

function resetPasswordHandler(req, res, forcedRole) {
  try {
    const submittedToken =
      (typeof req.body.token === "string" && req.body.token.trim()) ||
      (typeof req.body.code === "string" && req.body.code.trim()) ||
      (typeof req.body.resetToken === "string" && req.body.resetToken.trim()) ||
      "";

    const submittedPassword =
      (typeof req.body.newPassword === "string" && req.body.newPassword) ||
      (typeof req.body.password === "string" && req.body.password) ||
      "";

    const newPassword = ensureText(submittedPassword, "Password", 8, 120);
    if (!submittedToken) {
      return res.status(400).json({ message: "Código OTP ou token de recuperação em falta" });
    }

    const tokenHash = hashResetToken(submittedToken);
    const row = db
      .prepare("SELECT id, user_email, user_role, expires_at, used_at FROM password_reset_tokens WHERE token_hash = ? LIMIT 1")
      .get(tokenHash);

    if (!row) {
      return res.status(401).json({ message: "Código OTP ou token de recuperacao inválido" });
    }
    if (row.used_at) {
      return res.status(400).json({ message: "Código OTP ou token de recuperação já utilizado" });
    }
    if (new Date(row.expires_at).getTime() <= Date.now()) {
      return res.status(401).json({ message: "Código OTP ou token de recuperação expirado" });
    }

    const reqRole = forcedRole || detectRoleFromBody(req.body);
    if (reqRole && reqRole !== row.user_role) {
      return res.status(401).json({ message: "Código OTP/token não corresponde ao tipo de conta" });
    }

    const passwordHash = hashPassword(newPassword);
    const now = new Date().toISOString();

    if (row.user_role === "admin") {
      const updatedAdmin = db.prepare("UPDATE admin_credentials SET password_hash = ?, updated_at = ? WHERE email = ?").run(
        passwordHash,
        now,
        row.user_email
      );
      if (!updatedAdmin.changes) {
        return res.status(404).json({ message: "Conta de admin não encontrada" });
      }
    } else {
      const updatedClient = db
        .prepare(
          "UPDATE customers SET password_hash = ?, failed_login_attempts = 0, locked_at = NULL, force_password_change = 0, first_login_completed_at = COALESCE(first_login_completed_at, ?) WHERE email = ?"
        )
        .run(passwordHash, now, row.user_email);
      if (!updatedClient.changes) {
        return res.status(404).json({ message: "Conta de cliente não encontrada" });
      }
    }

    db.prepare("UPDATE password_reset_tokens SET used_at = ? WHERE id = ?").run(now, row.id);
    db.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE user_email = ? AND user_role = ? AND revoked_at IS NULL").run(
      now,
      row.user_email,
      row.user_role
    );

    const resetSuccessText =
      "Espaco Serena - Password Atualizada\n" +
      "Conta: " + row.user_role + "\n" +
      "Email: " + row.user_email + "\n" +
      "Data: " + new Date(now).toLocaleString("pt-PT");

    // Notification is best-effort and must not block password reset success.
    sendTelegramMessage(resetSuccessText).catch(function (_err) {
      console.warn("[RESET] Falha ao enviar confirmacao para Telegram.");
      console.warn("[RESET] Conta:", row.user_role, "| Email:", row.user_email, "| Data:", now);
    });

    const roleLabel = row.user_role === "admin" ? "admin" : "cliente";
    return res.json({ message: "Password de " + roleLabel + " atualizada com sucesso" });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
}

app.post("/api/auth/forgot-password", function (req, res) {
  return forgotPasswordHandler(req, res, "");
});
app.post("/api/admin/forgot-password", function (req, res) {
  return forgotPasswordHandler(req, res, "admin");
});
app.post("/api/client/forgot-password", function (req, res) {
  return forgotPasswordHandler(req, res, "client");
});
app.post("/api/auth/admin/forgot-password", function (req, res) {
  return forgotPasswordHandler(req, res, "admin");
});
app.post("/api/auth/client/forgot-password", function (req, res) {
  return forgotPasswordHandler(req, res, "client");
});

app.post("/api/auth/reset-password", function (req, res) {
  return resetPasswordHandler(req, res, "");
});
app.post("/api/admin/reset-password", function (req, res) {
  return resetPasswordHandler(req, res, "admin");
});
app.post("/api/client/reset-password", function (req, res) {
  return resetPasswordHandler(req, res, "client");
});
app.post("/api/auth/admin/reset-password", function (req, res) {
  return resetPasswordHandler(req, res, "admin");
});
app.post("/api/auth/client/reset-password", function (req, res) {
  return resetPasswordHandler(req, res, "client");
});

function admin2faVerifyHandler(req, res) {
  try {
    const submittedCode =
      (typeof req.body.token === "string" && req.body.token.trim()) ||
      (typeof req.body.code === "string" && req.body.code.trim()) ||
      (typeof req.body.otp === "string" && req.body.otp.trim()) ||
      "";

    if (!submittedCode) {
      return res.status(400).json({ message: "Código OTP 2FA em falta" });
    }

    const ctx = resolveAdmin2faContext(req);
    if (!ctx.challengeId) {
      return res.status(400).json({ message: "Challenge 2FA em falta" });
    }

    const verified = verifyAdmin2faCode(ctx.challengeId, ctx.email, submittedCode);
    if (!verified.ok) {
      return res.status(verified.status).json({ message: verified.message });
    }

    const tokens = issueTokens(verified.email, "admin");
    return res.json(tokens);
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
}

app.post("/api/admin/2fa/verify", admin2faVerifyHandler);
app.post("/api/auth/admin/2fa/verify", admin2faVerifyHandler);
app.post("/api/auth/2fa/verify", admin2faVerifyHandler);
app.post("/api/admin/login/2fa", admin2faVerifyHandler);
app.post("/api/auth/login/2fa", admin2faVerifyHandler);

app.post("/api/client/register", function (req, res) {
  try {
    const name = ensureText(req.body.name, "Nome", 2, 80);
    const email = ensureText(req.body.email, "Email", 5, 120).toLowerCase();
    const password = ensureText(req.body.password, "Password", 8, 120);

    const existing = db.prepare("SELECT id FROM customers WHERE email = ? LIMIT 1").get(email);
    if (existing) {
      return res.status(409).json({ message: "Este email já está registado" });
    }

    const passwordHash = hashPassword(password);
    db.prepare(
      "INSERT INTO customers (name, email, password_hash, created_at, failed_login_attempts, locked_at, force_password_change) VALUES (?, ?, ?, ?, 0, NULL, 1)"
    ).run(
      name,
      email,
      passwordHash,
      new Date().toISOString()
    );

    const registerText =
      "Espaco Serena - Novo Registo Cliente\n" +
      "Nome: " + name + "\n" +
      "Email: " + email + "\n" +
      "Data: " + new Date().toLocaleString("pt-PT");

    sendTelegramMessage(registerText).catch(function (_err) {
      console.warn("[REGISTER] Falha ao enviar aviso Telegram para novo cliente:", email);
    });

    const tokens = issueTokens(email, "client");
    return res.status(201).json({
      message: "Conta criada",
      name: name,
      email: email,
      requiresPasswordChange: true,
      mustChangeReason: "first-login",
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken
    });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.post("/api/client/login", function (req, res) {
  try {
    const email = ensureText(req.body.email, "Email", 5, 120).toLowerCase();
    const password = ensureText(req.body.password, "Password", 8, 120);

    const user = db
      .prepare(
        "SELECT name, email, password_hash, failed_login_attempts, locked_at, force_password_change, first_login_completed_at FROM customers WHERE email = ? LIMIT 1"
      )
      .get(email);
    if (!user) {
      return res.status(401).json({ message: "Credenciais inválidas" });
    }

    if (user.locked_at) {
      return res.status(423).json({ message: "Conta bloqueada após tentativas erradas. Contacte o admin para desbloqueio." });
    }

    const receivedHash = hashPassword(password);
    if (!safeEq(receivedHash, user.password_hash)) {
      const nextAttempts = Number(user.failed_login_attempts || 0) + 1;
      if (nextAttempts >= CLIENT_LOGIN_MAX_ATTEMPTS) {
        const lockedAt = new Date().toISOString();
        db.prepare("UPDATE customers SET failed_login_attempts = ?, locked_at = ? WHERE email = ?").run(
          CLIENT_LOGIN_MAX_ATTEMPTS,
          lockedAt,
          email
        );

        const lockText =
          "Espaco Serena - Conta Cliente Bloqueada\n" +
          "Email: " + email + "\n" +
          "Motivo: " + CLIENT_LOGIN_MAX_ATTEMPTS + " tentativas erradas\n" +
          "Data: " + new Date(lockedAt).toLocaleString("pt-PT");

        sendTelegramMessage(lockText).catch(function (_err) {
          console.warn("[LOCK] Falha ao enviar aviso Telegram para conta bloqueada:", email);
        });

        return res.status(423).json({ message: "Conta bloqueada após 3 tentativas erradas. Só o admin pode desbloquear." });
      }

      db.prepare("UPDATE customers SET failed_login_attempts = ? WHERE email = ?").run(nextAttempts, email);
      return res.status(401).json({ message: "Credenciais inválidas" });
    }

    db.prepare("UPDATE customers SET failed_login_attempts = 0 WHERE email = ?").run(email);

    const tokens = issueTokens(email, "client");

    if (Number(user.force_password_change || 0) === 1) {
      return res.status(200).json({
        name: user.name,
        email: user.email,
        requiresPasswordChange: true,
        mustChangeReason: user.first_login_completed_at ? "admin-unlock" : "first-login",
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        message: "Para continuar, tem de alterar a palavra-passe no primeiro acesso."
      });
    }

    return res.json({ name: user.name, email: user.email, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.post("/api/client/password/change", auth("client"), function (req, res) {
  try {
    const currentPassword = ensureText(req.body.currentPassword, "Palavra-passe atual", 8, 120);
    const newPassword = ensureText(req.body.newPassword, "Nova palavra-passe", 8, 120);

    const user = db.prepare("SELECT email, password_hash FROM customers WHERE email = ? LIMIT 1").get(req.user.email);
    if (!user) {
      return res.status(404).json({ message: "Conta de cliente não encontrada" });
    }

    if (!safeEq(hashPassword(currentPassword), user.password_hash)) {
      return res.status(401).json({ message: "Palavra-passe atual invalida" });
    }

    const newHash = hashPassword(newPassword);
    if (safeEq(newHash, user.password_hash)) {
      return res.status(400).json({ message: "Nova palavra-passe deve ser diferente da atual" });
    }

    const now = new Date().toISOString();
    db.prepare(
      "UPDATE customers SET password_hash = ?, force_password_change = 0, first_login_completed_at = COALESCE(first_login_completed_at, ?), failed_login_attempts = 0, locked_at = NULL WHERE email = ?"
    ).run(newHash, now, req.user.email);

    db.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE user_email = ? AND user_role = 'client' AND revoked_at IS NULL").run(
      now,
      req.user.email
    );

    const fresh = issueTokens(req.user.email, "client");

    const changedText =
      "Espaço Serena - Palavra-passe de Cliente Alterada\n" +
      "Email: " + req.user.email + "\n" +
      "Data: " + new Date(now).toLocaleString("pt-PT");

    sendTelegramMessage(changedText).catch(function (_err) {
      console.warn("[CLIENT] Falha ao enviar aviso Telegram de alteração de palavra-passe:", req.user.email);
    });

    return res.json({
      message: "Palavra-passe alterada com sucesso",
      accessToken: fresh.accessToken,
      refreshToken: fresh.refreshToken
    });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.post("/api/auth/refresh", function (req, res) {
  try {
    const refreshToken = ensureText(req.body.refreshToken, "Refresh token", 20, 400);
    const tokenHash = hashRefreshToken(refreshToken);
    const row = db.prepare("SELECT * FROM refresh_tokens WHERE token_hash = ? LIMIT 1").get(tokenHash);

    if (!row || row.revoked_at) {
      return res.status(401).json({ message: "Refresh token inválido" });
    }

    if (new Date(row.expires_at).getTime() <= Date.now()) {
      revokeRefreshToken(refreshToken);
      return res.status(401).json({ message: "Refresh token expirado" });
    }

    const tx = db.transaction(function () {
      db.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL").run(
        new Date().toISOString(),
        row.id
      );
      return issueTokens(row.user_email, row.user_role || "client");
    });

    const rotated = tx();
    return res.json(rotated);
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.post("/api/auth/logout", function (req, res) {
  try {
    const refreshToken = ensureText(req.body.refreshToken, "Refresh token", 20, 400);
    revokeRefreshToken(refreshToken);
    return res.json({ message: "Sessão terminada" });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.post("/api/bookings", function (req, res) {
  try {
    const name = ensureText(req.body.name, "Nome", 2, 80);
    const email = ensureText(req.body.email, "Email", 5, 120);
    const service = ensureText(req.body.service, "Serviço", 2, 80);
    const date = ensureText(req.body.date, "Data", 6, 20);
    const time = ensureText(req.body.time, "Hora", 3, 10);

    createBooking({ name: name, email: email, service: service, date: date, time: time });

    const bookingText =
      "Espaço Serena - Nova Marcação\n" +
      "Origem: público\n" +
      "Nome: " + name + "\n" +
      "Email: " + email + "\n" +
      "Serviço: " + service + "\n" +
      "Data/Hora: " + date + " " + time;
    sendTelegramBookingMessage(bookingText).catch(function (_err) {
      console.warn("[BOOKING] Falha ao enviar aviso Telegram (publico):", email);
    });

    return res.status(201).json({ message: "Marcação criada" });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.post("/api/messages", function (req, res) {
  try {
    const name = ensureText(req.body.name, "Nome", 2, 80);
    const email = ensureText(req.body.email, "Email", 5, 120);
    const message = ensureText(req.body.message, "Mensagem", 3, 1000);

    createMessage({ name: name, email: email, message: message });

    const messageText =
      "Espaço Serena - Nova Mensagem\n" +
      "Origem: público\n" +
      "Nome: " + name + "\n" +
      "Email: " + email + "\n" +
      "Mensagem: " + message;
    sendTelegramBookingMessage(messageText).catch(function (_err) {
      console.warn("[MESSAGE] Falha ao enviar aviso Telegram (publico):", email);
    });

    return res.status(201).json({ message: "Mensagem enviada" });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.post("/api/client/bookings", auth("client"), function (req, res) {
  try {
    const name = ensureText(req.body.name, "Nome", 2, 80);
    const service = ensureText(req.body.service, "Serviço", 2, 80);
    const date = ensureText(req.body.date, "Data", 6, 20);
    const time = ensureText(req.body.time, "Hora", 3, 10);

    createBooking({
      name: name,
      email: req.user.email,
      service: service,
      date: date,
      time: time,
      customerEmail: req.user.email
    });

    const bookingText =
      "Espaço Serena - Nova Marcação Cliente\n" +
      "Nome: " + name + "\n" +
      "Email: " + req.user.email + "\n" +
      "Serviço: " + service + "\n" +
      "Data/Hora: " + date + " " + time;
    sendTelegramBookingMessage(bookingText).catch(function (_err) {
      console.warn("[BOOKING] Falha ao enviar aviso Telegram (cliente):", req.user.email);
    });

    return res.status(201).json({ message: "Marcação premium criada" });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.post("/api/client/messages", auth("client"), function (req, res) {
  try {
    const message = ensureText(req.body.message, "Mensagem", 3, 1000);
    const user = db.prepare("SELECT name FROM customers WHERE email = ? LIMIT 1").get(req.user.email);

    createMessage({
      name: (user && user.name) || "Cliente",
      email: req.user.email,
      message: message,
      customerEmail: req.user.email
    });

    const messageText =
      "Espaço Serena - Nova Mensagem Cliente\n" +
      "Nome: " + (((user && user.name) || "Cliente")) + "\n" +
      "Email: " + req.user.email + "\n" +
      "Mensagem: " + message;
    sendTelegramBookingMessage(messageText).catch(function (_err) {
      console.warn("[MESSAGE] Falha ao enviar aviso Telegram (cliente):", req.user.email);
    });

    return res.status(201).json({ message: "Mensagem premium enviada" });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.post("/api/notifications/telegram", auth("admin"), async function (req, res) {
  try {
    const limiter = checkNotifyTestRateLimit(req.user && req.user.email);
    if (!limiter.allowed) {
      bumpNotifyUsage("rateLimitHits");
      console.warn(
        "[ABUSE] Rate limit notificação teste | endpoint=/api/notifications/telegram | admin=",
        (req.user && req.user.email) || "desconhecido",
        "| ip=",
        getRequestIp(req),
        "| retryAfterSec=",
        limiter.retryAfterSec
      );
      return res.status(429).json({
        message: "Limite de testes de notificação atingido. Tente novamente em instantes.",
        retryAfterSec: limiter.retryAfterSec
      });
    }

    const text = ensureText(req.body.text || req.body.message, "Mensagem", 3, 2000);
    await sendTelegramBookingMessage(text);
    bumpNotifyUsage("testsSent");
    return res.json({ message: "Notificação Telegram enviada", remaining: limiter.remaining });
  } catch (error) {
    const status = error && error.status ? Number(error.status) : 400;
    return res.status(status).json({ message: error.message || "Falha ao enviar notificação" });
  }
});

app.post("/api/notifications/message", auth("admin"), async function (req, res) {
  try {
    const limiter = checkNotifyTestRateLimit(req.user && req.user.email);
    if (!limiter.allowed) {
      bumpNotifyUsage("rateLimitHits");
      console.warn(
        "[ABUSE] Rate limit notificação teste | endpoint=/api/notifications/message | admin=",
        (req.user && req.user.email) || "desconhecido",
        "| ip=",
        getRequestIp(req),
        "| retryAfterSec=",
        limiter.retryAfterSec
      );
      return res.status(429).json({
        message: "Limite de testes de notificação atingido. Tente novamente em instantes.",
        retryAfterSec: limiter.retryAfterSec
      });
    }

    const text = ensureText(req.body.text || req.body.message, "Mensagem", 3, 2000);
    await sendTelegramBookingMessage(text);
    bumpNotifyUsage("testsSent");
    return res.json({ message: "Notificação Telegram enviada", remaining: limiter.remaining });
  } catch (error) {
    const status = error && error.status ? Number(error.status) : 400;
    return res.status(status).json({ message: error.message || "Falha ao enviar notificação" });
  }
});

app.post("/api/telegram/webhook", async function (req, res) {
  try {
    if (TELEGRAM_WEBHOOK_SECRET) {
      const headerSecret = String(req.headers["x-telegram-bot-api-secret-token"] || "");
      if (headerSecret !== TELEGRAM_WEBHOOK_SECRET) {
        return res.status(401).json({ message: "Webhook secret inválido" });
      }
    }

    const update = req.body || {};
    const message = update.message || update.edited_message;
    if (!message || !message.chat || typeof message.text !== "string") {
      return res.json({ ok: true, ignored: true });
    }
    await handleTelegramCommandMessage(message);
    return res.json({ ok: true });
  } catch (error) {
    console.warn("[TELEGRAM] Webhook erro:", error && error.message ? error.message : error);
    return res.status(500).json({ message: "Falha no webhook Telegram" });
  }
});

app.get("/api/client/dashboard", auth("client"), function (req, res) {
  const profile = db
    .prepare(
      "SELECT name, email, created_at, extra_discount_percent, extra_discount_note, extra_discount_updated_at FROM customers WHERE email = ? LIMIT 1"
    )
    .get(req.user.email);
  const bookings = db
    .prepare("SELECT * FROM bookings WHERE customer_email = ? ORDER BY id DESC LIMIT 200")
    .all(req.user.email);
  const messages = db
    .prepare("SELECT * FROM messages WHERE customer_email = ? ORDER BY id DESC LIMIT 200")
    .all(req.user.email);

  return res.json({ profile: profile || null, bookings: bookings, messages: messages });
});

app.get("/api/client/premium-services", auth("client"), function (_req, res) {
  return res.json({
    items: [
      {
        id: "premium-1",
        title: "Plano Serenity Plus",
        description: "3 sessões terapêuticas por mês com avaliação personalizada.",
        price: "119 EUR/mes"
      },
      {
        id: "premium-2",
        title: "Aromaterapia Signature",
        description: "Sessão premium com blend exclusivo de óleos essenciais.",
        price: "69 EUR/sessão"
      },
      {
        id: "premium-3",
        title: "Recovery Deep Tissue",
        description: "Protocolo intensivo para recuperação muscular e postura.",
        price: "79 EUR/sessão"
      }
    ]
  });
});

app.get("/api/client/promotions", auth("client"), function (_req, res) {
  return res.json({
    items: [
      {
        code: "SERENA10",
        title: "10% em pacotes trimestrais",
        validUntil: "2026-06-30"
      },
      {
        code: "AROMA2X1",
        title: "2.ª sessão de aromaterapia a 50%",
        validUntil: "2026-05-31"
      }
    ]
  });
});

app.get("/api/client/massage-packs", auth("client"), function (_req, res) {
  const rows = db
    .prepare("SELECT id, name, services_json FROM massage_packs WHERE active = 1 ORDER BY name COLLATE NOCASE ASC")
    .all();

  const items = rows.map(function (row) {
    let services = [];
    try {
      const parsed = JSON.parse(String(row.services_json || "[]"));
      services = Array.isArray(parsed) ? parsed.filter(function (v) { return typeof v === "string" && v.trim(); }) : [];
    } catch (_error) {
      services = [];
    }

    return {
      id: row.id,
      name: row.name,
      services: services
    };
  });

  return res.json({ items: items });
});

app.get("/api/admin/overview", auth("admin"), function (_req, res) {
  const bookings = db.prepare("SELECT * FROM bookings ORDER BY id DESC LIMIT 300").all();
  const messages = db.prepare("SELECT * FROM messages ORDER BY id DESC LIMIT 300").all();
  const notifyUsage = getNotifyUsageSnapshot();
  return res.json({ bookings, messages, notifyUsage });
});

app.get("/api/admin/discount-codes", auth("admin"), function (_req, res) {
  const items = db
    .prepare("SELECT id, code, description, percent_off, active, created_by, created_at, updated_at FROM discount_codes ORDER BY id DESC")
    .all();
  return res.json({ items: items });
});

app.post("/api/admin/discount-codes", auth("admin"), function (req, res) {
  try {
    const rawCode = ensureText(req.body.code, "Código", 3, 40);
    const code = normalizeDiscountCode(rawCode);
    if (code.length < 3 || code.length > 40) {
      return res.status(400).json({ message: "Código inválido" });
    }
    const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 160) : "";
    const percentRaw = Number(req.body.percentOff);
    const percentOff = Number.isFinite(percentRaw) ? Math.floor(percentRaw) : NaN;
    if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 90) {
      return res.status(400).json({ message: "Desconto deve ser inteiro entre 1 e 90" });
    }

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO discount_codes (code, description, percent_off, active, created_by, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)"
    ).run(code, description, percentOff, req.user.email, now, now);

    return res.status(201).json({ message: "Código de desconto criado", code: code, percentOff: percentOff });
  } catch (error) {
    if (String(error && error.message || "").toLowerCase().indexOf("unique") >= 0) {
      return res.status(409).json({ message: "Código de desconto ja existe" });
    }
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.patch("/api/admin/discount-codes/:id", auth("admin"), function (req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const active = req.body.active ? 1 : 0;
    const now = new Date().toISOString();
    const result = db.prepare("UPDATE discount_codes SET active = ?, updated_at = ? WHERE id = ?").run(active, now, id);
    if (!result.changes) {
      return res.status(404).json({ message: "Código de desconto não encontrado" });
    }

    return res.json({ message: active ? "Código ativado" : "Código desativado" });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.get("/api/admin/massage-packs", auth("admin"), function (_req, res) {
  const rows = db
    .prepare("SELECT id, name, services_json, active, created_by, created_at, updated_at FROM massage_packs ORDER BY id DESC")
    .all();

  const items = rows.map(function (row) {
    let services = [];
    try {
      const parsed = JSON.parse(String(row.services_json || "[]"));
      services = Array.isArray(parsed) ? parsed.filter(function (v) { return typeof v === "string" && v.trim(); }) : [];
    } catch (_error) {
      services = [];
    }

    return {
      id: row.id,
      name: row.name,
      services: services,
      active: row.active,
      created_by: row.created_by,
      created_at: row.created_at,
      updated_at: row.updated_at
    };
  });

  return res.json({ items: items });
});

app.post("/api/admin/massage-packs", auth("admin"), function (req, res) {
  try {
    const name = ensureText(req.body.name, "Nome do pack", 3, 80);
    const incomingServices = Array.isArray(req.body.services) ? req.body.services : [];
    const services = incomingServices
      .map(function (item) {
        return typeof item === "string" ? item.trim() : "";
      })
      .filter(function (item) {
        return item.length >= 2;
      });

    const uniqueServices = Array.from(new Set(services));
    if (uniqueServices.length < 2) {
      return res.status(400).json({ message: "Pack deve conter pelo menos 2 tratamentos" });
    }

    const now = new Date().toISOString();
    db.prepare(
      "INSERT INTO massage_packs (name, services_json, active, created_by, created_at, updated_at) VALUES (?, ?, 1, ?, ?, ?)"
    ).run(name, JSON.stringify(uniqueServices), req.user.email, now, now);

    return res.status(201).json({ message: "Pack criado", name: name, services: uniqueServices });
  } catch (error) {
    if (String((error && error.message) || "").toLowerCase().indexOf("unique") >= 0) {
      return res.status(409).json({ message: "Já existe um pack com esse nome" });
    }
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.put("/api/admin/massage-packs/:id", auth("admin"), function (req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const name = ensureText(req.body.name, "Nome do pack", 3, 80);
    const incomingServices = Array.isArray(req.body.services) ? req.body.services : [];
    const services = incomingServices
      .map(function (item) {
        return typeof item === "string" ? item.trim() : "";
      })
      .filter(function (item) {
        return item.length >= 2;
      });

    const uniqueServices = Array.from(new Set(services));
    if (uniqueServices.length < 2) {
      return res.status(400).json({ message: "Pack deve conter pelo menos 2 tratamentos" });
    }

    const now = new Date().toISOString();
    const result = db
      .prepare("UPDATE massage_packs SET name = ?, services_json = ?, updated_at = ? WHERE id = ?")
      .run(name, JSON.stringify(uniqueServices), now, id);

    if (!result.changes) {
      return res.status(404).json({ message: "Pack não encontrado" });
    }

    return res.json({ message: "Pack atualizado", id: id, name: name, services: uniqueServices });
  } catch (error) {
    if (String((error && error.message) || "").toLowerCase().indexOf("unique") >= 0) {
      return res.status(409).json({ message: "Já existe um pack com esse nome" });
    }
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.patch("/api/admin/massage-packs/:id", auth("admin"), function (req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const active = req.body.active ? 1 : 0;
    const now = new Date().toISOString();
    const result = db.prepare("UPDATE massage_packs SET active = ?, updated_at = ? WHERE id = ?").run(active, now, id);

    if (!result.changes) {
      return res.status(404).json({ message: "Pack não encontrado" });
    }

    return res.json({ message: active ? "Pack ativado" : "Pack desativado" });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.delete("/api/admin/massage-packs/:id", auth("admin"), function (req, res) {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({ message: "ID inválido" });
    }

    const result = db.prepare("DELETE FROM massage_packs WHERE id = ?").run(id);
    if (!result.changes) {
      return res.status(404).json({ message: "Pack não encontrado" });
    }

    return res.json({ message: "Pack eliminado" });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.post("/api/client/discount/verify", auth("client"), function (req, res) {
  try {
    const rawCode = ensureText(req.body.code, "Código", 3, 40);
    const code = normalizeDiscountCode(rawCode);
    if (code.length < 3 || code.length > 40) {
      return res.status(400).json({ message: "Código inválido" });
    }

    let item = db
      .prepare("SELECT id, code, description, percent_off, active FROM discount_codes WHERE code = ? LIMIT 1")
      .get(code);

    if (!item) {
      const candidates = db.prepare("SELECT id, code, description, percent_off, active FROM discount_codes WHERE active = 1").all();
      item = candidates.find(function (row) {
        return normalizeDiscountCode(row.code) === code;
      }) || null;
    }
    const customer = db
      .prepare("SELECT extra_discount_percent, extra_discount_note FROM customers WHERE email = ? LIMIT 1")
      .get(req.user.email);

    if (!item || !item.active) {
      return res.status(404).json({ message: "Código inválido ou inativo" });
    }

    const codePercent = Number(item.percent_off || 0);
    const extraPercent = Number((customer && customer.extra_discount_percent) || 0);
    const totalPercent = Math.min(90, Math.max(0, codePercent + extraPercent));

    return res.json({
      valid: true,
      code: item.code,
      description: item.description || "",
      percentOff: codePercent,
      extraPercentOff: extraPercent,
      totalPercentOff: totalPercent,
      extraDiscountNote: (customer && customer.extra_discount_note) || "",
      message: "Código validado pelo admin"
    });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.get("/api/admin/clients/locked", auth("admin"), function (_req, res) {
  const items = db
    .prepare(
      "SELECT name, email, failed_login_attempts, locked_at, unlocked_by_admin_at FROM customers WHERE locked_at IS NOT NULL ORDER BY locked_at DESC LIMIT 200"
    )
    .all();
  return res.json({ items: items });
});

app.get("/api/admin/clients", auth("admin"), function (_req, res) {
  const items = db
    .prepare(
      "SELECT name, email, created_at, failed_login_attempts, locked_at, force_password_change, extra_discount_percent, extra_discount_note, extra_discount_updated_at FROM customers ORDER BY name COLLATE NOCASE ASC"
    )
    .all();
  return res.json({ items: items });
});

app.post("/api/admin/clients/discount-extra", auth("admin"), function (req, res) {
  try {
    const emails = Array.isArray(req.body.emails) ? req.body.emails : [];
    const percentRaw = Number(req.body.percentOff);
    const percentOff = Number.isFinite(percentRaw) ? Math.floor(percentRaw) : NaN;
    const description = typeof req.body.description === "string" ? req.body.description.trim().slice(0, 160) : "";

    if (!Number.isInteger(percentOff) || percentOff < 1 || percentOff > 90) {
      return res.status(400).json({ message: "Desconto extra deve ser inteiro entre 1 e 90" });
    }

    const normalizedEmails = emails
      .map(function (item) {
        return typeof item === "string" ? item.trim().toLowerCase() : "";
      })
      .filter(function (item) {
        return item.length >= 5;
      });

    const uniqueEmails = Array.from(new Set(normalizedEmails));
    if (!uniqueEmails.length) {
      return res.status(400).json({ message: "Selecione pelo menos um cliente" });
    }

    const now = new Date().toISOString();
    const updateStmt = db.prepare(
      "UPDATE customers SET extra_discount_percent = ?, extra_discount_note = ?, extra_discount_updated_at = ? WHERE email = ?"
    );

    const tx = db.transaction(function () {
      let changes = 0;
      uniqueEmails.forEach(function (email) {
        const result = updateStmt.run(percentOff, description, now, email);
        changes += Number(result.changes || 0);
      });
      return changes;
    });

    const updated = tx();
    if (!updated) {
      return res.status(404).json({ message: "Nenhum cliente atualizado" });
    }

    const discountText =
      "Espaco Serena - Desconto Extra em Lote\n" +
      "Admin: " + req.user.email + "\n" +
      "Clientes atualizados: " + String(updated) + "\n" +
      "Desconto: " + String(percentOff) + "%\n" +
      "Data: " + new Date(now).toLocaleString("pt-PT");

    sendTelegramMessage(discountText).catch(function (_err) {
      console.warn("[ADMIN] Falha ao enviar aviso Telegram de desconto extra em lote");
    });

    return res.json({ message: "Desconto extra aplicado", updated: updated, percentOff: percentOff });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.post("/api/admin/clients/password/reset-bulk", auth("admin"), function (req, res) {
  try {
    const applyToAll = Boolean(req.body.applyToAll);
    const providedGenericPassword = typeof req.body.genericPassword === "string" ? req.body.genericPassword.trim() : "";
    const genericPassword = providedGenericPassword || CLIENT_UNLOCK_GENERIC_PASSWORD;
    const emails = Array.isArray(req.body.emails) ? req.body.emails : [];

    if (providedGenericPassword && genericPassword !== CLIENT_UNLOCK_GENERIC_PASSWORD) {
      return res.status(401).json({ message: "Palavra-passe genérica invalida" });
    }

    let selectedEmails = [];
    if (applyToAll) {
      selectedEmails = db.prepare("SELECT email FROM customers").all().map(function (row) {
        return String(row.email || "").toLowerCase();
      });
    } else {
      selectedEmails = emails
        .map(function (item) {
          return typeof item === "string" ? item.trim().toLowerCase() : "";
        })
        .filter(function (item) {
          return item.length >= 5;
        });
    }

    const uniqueEmails = Array.from(new Set(selectedEmails));
    if (!uniqueEmails.length) {
      return res.status(400).json({ message: "Sem clientes selecionados para redefinição" });
    }

    const now = new Date().toISOString();
    const resetStmt = db.prepare(
      "UPDATE customers SET password_hash = ?, failed_login_attempts = 0, locked_at = NULL, force_password_change = 1, unlocked_by_admin_at = ? WHERE email = ?"
    );
    const revokeStmt = db.prepare(
      "UPDATE refresh_tokens SET revoked_at = ? WHERE user_email = ? AND user_role = 'client' AND revoked_at IS NULL"
    );
    const newHash = hashPassword(genericPassword);

    const tx = db.transaction(function () {
      let changes = 0;
      uniqueEmails.forEach(function (email) {
        const result = resetStmt.run(newHash, now, email);
        if (result.changes) {
          changes += Number(result.changes);
          revokeStmt.run(now, email);
        }
      });
      return changes;
    });

    const updated = tx();
    if (!updated) {
      return res.status(404).json({ message: "Nenhuma conta cliente atualizada" });
    }

    const bulkResetText =
      "Espaço Serena - Repor Palavra-passe em Lote\n" +
      "Admin: " + req.user.email + "\n" +
      "Contas atualizadas: " + String(updated) + "\n" +
      "Modo: " + (applyToAll ? "todos os clientes" : "selecionados") + "\n" +
      "Data: " + new Date(now).toLocaleString("pt-PT");

    sendTelegramMessage(bulkResetText).catch(function (_err) {
      console.warn("[ADMIN] Falha ao enviar aviso Telegram de reset em lote");
    });

    return res.json({
      message: applyToAll
        ? "Palavras-passe redefinidas para todos os clientes"
        : "Palavras-passe redefinidas para clientes selecionados",
      updated: updated,
      recoveryPassword: CLIENT_UNLOCK_GENERIC_PASSWORD,
      revealAfterAction: true
    });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.post("/api/admin/clients/unlock", auth("admin"), function (req, res) {
  try {
    const email = ensureText(req.body.email, "Email", 5, 120).toLowerCase();
    const providedGenericPassword = typeof req.body.genericPassword === "string" ? req.body.genericPassword.trim() : "";
    const genericPassword = providedGenericPassword || CLIENT_UNLOCK_GENERIC_PASSWORD;

    if (providedGenericPassword && genericPassword !== CLIENT_UNLOCK_GENERIC_PASSWORD) {
      return res.status(401).json({ message: "Palavra-passe genérica invalida" });
    }

    const customer = db.prepare("SELECT name, email FROM customers WHERE email = ? LIMIT 1").get(email);
    if (!customer) {
      return res.status(404).json({ message: "Conta de cliente não encontrada" });
    }

    const now = new Date().toISOString();
    db.prepare(
      "UPDATE customers SET password_hash = ?, failed_login_attempts = 0, locked_at = NULL, force_password_change = 1, unlocked_by_admin_at = ? WHERE email = ?"
    ).run(hashPassword(genericPassword), now, email);

    db.prepare("UPDATE refresh_tokens SET revoked_at = ? WHERE user_email = ? AND user_role = 'client' AND revoked_at IS NULL").run(now, email);

    const unlockText =
      "Espaço Serena - Conta de Cliente Desbloqueada\n" +
      "Nome: " + (customer.name || "Cliente") + "\n" +
      "Email: " + email + "\n" +
      "Data: " + new Date(now).toLocaleString("pt-PT") + "\n" +
      "Palavra-passe genérica aplicada. Troca obrigatoria no primeiro acesso.";

    sendTelegramMessage(unlockText).catch(function (_err) {
      console.warn("[ADMIN] Falha ao enviar aviso Telegram de desbloqueio:", email);
    });

    return res.json({
      message: "Conta desbloqueada e palavra-passe genérica aplicada",
      recoveryPassword: CLIENT_UNLOCK_GENERIC_PASSWORD,
      revealAfterAction: true,
      email: email
    });
  } catch (error) {
    return res.status(400).json({ message: error.message || "Pedido inválido" });
  }
});

app.delete("/api/admin/data", auth("admin"), function (_req, res) {
  const tx = db.transaction(function () {
    db.prepare("DELETE FROM bookings").run();
    db.prepare("DELETE FROM messages").run();
  });
  tx();
  return res.json({ message: "Dados removidos" });
});

app.use(function (_req, res) {
  res.status(404).json({ message: "Endpoint não encontrado" });
});

app.listen(PORT, function () {
  console.log("Backend ativo em http://localhost:" + PORT);
  startNotifyRateCleanup();
  startTelegramPolling();
});

