"use strict";
/*
 * Admin (reseller) chart pages for the PasarGuard panel on KataBump.
 *
 * One public, per-admin link:  https://HOST:PORT/<13-char-token>/
 * shows a live "panel chart" for that admin — traffic limit / used traffic,
 * creation date, expiry date (set from the panel's Managers section),
 * status (active / disabled / limited / expired), plus the delivery card:
 * panel URL, the username and the password chosen in the Managers section.
 *
 * Data is read live from pasarguard.db on every request, so any change made
 * in the panel is reflected on every chart immediately. All charts share the
 * single template in chart.html, so editing that file restyles them all.
 *
 * The module is loaded lazily by the edge launcher (index.js) and gets its
 * helpers (sqlite access, request parsing, logging) from there; everything
 * has a self-contained fallback so it can also run under plain Node in tests.
 *
 * Endpoints (all except the chart page itself require a panel Bearer token):
 *   GET  /<token>/                 the chart page (public, token = secret)
 *   GET  /<token>/info             live JSON for the page's auto-refresh
 *   GET  /__admin-chart/link?username=X[&peek=1]   get (or create) the link
 *   POST /__admin-chart/save       {username, password?, expireAt?, clearExpire?}
 *   POST /__admin-chart/reset      {username}  new token, old link dies
 *   POST /__admin-chart/delete     {username}  remove the chart entry
 *
 * An optional expiry sweep disables a non-owner admin in PasarGuard once its
 * chart expiry passes, and re-enables it if the expiry is later extended
 * (only for admins this module auto-disabled itself).
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const crypto = require("crypto");

const TOKEN_RE = /^[A-Za-z0-9]{13}$/;
const USERNAME_RE = /^[A-Za-z0-9._%@-]{1,64}$/;
const TEMPLATE_FILE = path.join(__dirname, "chart.html");

// ---------------------------------------------------------------- utilities
function sqlQuoteLocal(value) {
  return "'" + String(value).replace(/'/g, "''") + "'";
}

function formatBytes(bytes) {
  const n = Number(bytes);
  if (!Number.isFinite(n) || n < 0) return "۰ بایت";
  if (n === 0) return "۰ بایت";
  const units = ["بایت", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  let text = v >= 100 ? v.toFixed(0) : (v >= 10 ? v.toFixed(1) : v.toFixed(2));
  if (text.includes(".")) text = text.replace(/0+$/, "").replace(/\.$/, "");
  return text + " " + units[i];
}

function toPersianDigits(value) {
  return String(value).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[Number(d)]);
}

const faDateFull = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "Asia/Tehran",
});
const faDateTime = new Intl.DateTimeFormat("fa-IR-u-ca-persian", {
  day: "numeric", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Tehran",
});

function parseDbDate(value) {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  // SQLite stores naive UTC like "2026-10-17 09:10:29.728514".
  const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw) ? raw.replace(" ", "T") + "Z" : raw;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function genToken(existing) {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  do {
    token = "";
    const bytes = crypto.randomBytes(13);
    for (let i = 0; i < 13; i += 1) token += chars[bytes[i] % chars.length];
  } while (existing && existing.has(token));
  return token;
}

// ------------------------------------------------------------------- factory
function createAdminChart(deps) {
  const D = deps || {};
  const log = typeof D.log === "function" ? D.log : () => {};
  const dbFile = D.dbFile || "/home/container/pasarguard-native/data/pasarguard.db";
  const panelPath = D.panelPath || "/TeamGuccI/pasarguard/";
  const internalPanelPort = Number(D.internalPanelPort || 18081);
  const sqlQuote = typeof D.sqlQuote === "function" ? D.sqlQuote : sqlQuoteLocal;
  // The store must live somewhere the (unprivileged) launcher can write.
  const SCHEME = String(D.scheme || "https");
  const dataDir = D.dataDir || __dirname;
  const STORE_FILE = path.join(dataDir, "chart-store.json");
  const SECRET_FILE = path.join(dataDir, ".kb-chart-secret");
  function ensureDataDir() { try { fs.mkdirSync(dataDir, { recursive: true }); } catch (e) {} }

  // ---- sqlite access (prefer the launcher's helpers) ----------------------
  function sqliteSelect(sql) {
    if (typeof D.sqliteSelect === "function") {
      const rows = D.sqliteSelect(dbFile, sql);
      return Array.isArray(rows) ? rows : null;
    }
    try {
      const sqlite = require("node:sqlite");
      const db = new sqlite.DatabaseSync(dbFile, { readOnly: true });
      try {
        db.exec("PRAGMA busy_timeout = 5000;");
        return db.prepare(sql).all().map((r) => Object.assign({}, r));
      } finally { db.close(); }
    } catch (e) { return null; }
  }

  function sqliteExec(sql) {
    if (typeof D.sqliteExec === "function") return Boolean(D.sqliteExec(dbFile, sql));
    try {
      const sqlite = require("node:sqlite");
      const db = new sqlite.DatabaseSync(dbFile);
      try { db.exec("PRAGMA busy_timeout = 8000;"); db.exec(sql); return true; }
      finally { db.close(); }
    } catch (e) { return false; }
  }

  function rowValue(row, keys) {
    if (!row) return undefined;
    for (const k of keys) {
      if (row[k] !== undefined && row[k] !== null) return row[k];
    }
    return undefined;
  }

  function getAdminRow(username) {
    const sql = "SELECT a.id AS id, a.username AS username, a.used_traffic AS used_traffic,"
      + " a.data_limit AS data_limit, a.status AS status, a.created_at AS created_at,"
      + " a.role_id AS role_id, r.name AS role_name, r.is_owner AS role_is_owner,"
      + " (SELECT COUNT(*) FROM users u WHERE u.admin_id = a.id) AS total_users"
      + " FROM admins a LEFT JOIN admin_roles r ON r.id = a.role_id"
      + " WHERE LOWER(a.username) = LOWER(" + sqlQuote(username) + ") LIMIT 1;";
    const rows = sqliteSelect(sql);
    return rows && rows.length ? rows[0] : null;
  }

  // ---- secret + password encryption at rest --------------------------------
  let secretKey = null;
  function getSecretKey() {
    if (secretKey) return secretKey;
    let hex = "";
    try { hex = fs.readFileSync(SECRET_FILE, "utf8").trim(); } catch (e) {}
    if (!/^[a-f0-9]{64}$/i.test(hex)) {
      hex = crypto.randomBytes(32).toString("hex");
      ensureDataDir();
      try { fs.writeFileSync(SECRET_FILE, hex, { mode: 0o600 }); } catch (e) {}
    }
    secretKey = crypto.createHash("sha256").update("kb-admin-chart:" + hex).digest();
    return secretKey;
  }

  function encryptPassword(plain) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", getSecretKey(), iv);
    const enc = Buffer.concat([cipher.update(String(plain), "utf8"), cipher.final()]);
    return [iv.toString("base64"), cipher.getAuthTag().toString("base64"), enc.toString("base64")].join(".");
  }

  function decryptPassword(packed) {
    try {
      const [iv, tag, data] = String(packed || "").split(".");
      if (!iv || !tag || !data) return null;
      const decipher = crypto.createDecipheriv("aes-256-gcm", getSecretKey(), Buffer.from(iv, "base64"));
      decipher.setAuthTag(Buffer.from(tag, "base64"));
      return Buffer.concat([decipher.update(Buffer.from(data, "base64")), decipher.final()]).toString("utf8");
    } catch (e) { return null; }
  }

  // ---- store ----------------------------------------------------------------
  let storeCache = null;
  let storeMark = "";
  function loadStore() {
    let mark = "";
    try { const st = fs.statSync(STORE_FILE); mark = st.size + ":" + st.mtimeMs; } catch (e) {}
    if (storeCache && mark === storeMark) return storeCache;
    let data = { version: 1, admins: {} };
    try {
      const parsed = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
      if (parsed && typeof parsed === "object" && parsed.admins && typeof parsed.admins === "object") data = parsed;
    } catch (e) {}
    storeCache = data;
    storeMark = mark;
    return data;
  }

  function saveStore(data) {
    ensureDataDir();
    const tmp = STORE_FILE + ".tmp-" + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
    fs.renameSync(tmp, STORE_FILE);
    try { fs.chmodSync(STORE_FILE, 0o600); } catch (e) {}
    storeCache = data;
    try { const st = fs.statSync(STORE_FILE); storeMark = st.size + ":" + st.mtimeMs; } catch (e) {}
  }

  function tokenSet(data) {
    return new Set(Object.values(data.admins).map((a) => String(a.token || "")));
  }

  function findByToken(token) {
    const data = loadStore();
    for (const entry of Object.values(data.admins)) {
      if (entry && entry.token === token) return entry;
    }
    return null;
  }

  function ensureEntry(data, username) {
    const key = username.toLowerCase();
    let entry = data.admins[key];
    if (!entry) {
      entry = {
        username,
        token: genToken(tokenSet(data)),
        passwordEnc: null,
        expireAt: null,
        autoDisabled: false,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      data.admins[key] = entry;
    }
    if (!TOKEN_RE.test(String(entry.token || ""))) entry.token = genToken(tokenSet(data));
    return entry;
  }

  // ---- chart data -------------------------------------------------------------
  function chartData(entry, origin) {
    const row = getAdminRow(entry.username);
    const now = new Date();
    if (!row) {
      return {
        username: entry.username, gone: true, status: "gone", statusFa: "پنل یافت نشد",
        panelUrl: origin + panelPath, hasPassword: Boolean(entry.passwordEnc),
        updatedFa: faDateTime.format(now),
      };
    }
    const used = Math.max(0, Number(rowValue(row, ["used_traffic"])) || 0);
    const limitRaw = rowValue(row, ["data_limit"]);
    const limit = limitRaw === undefined || limitRaw === null || Number(limitRaw) <= 0 ? null : Number(limitRaw);
    const created = parseDbDate(rowValue(row, ["created_at"]));
    const expire = entry.expireAt ? new Date(entry.expireAt) : null;
    const expired = Boolean(expire && !Number.isNaN(expire.getTime()) && expire <= now);
    const statusDb = String(rowValue(row, ["status"]) || "active").toLowerCase();
    let status = "active";
    let statusFa = "فعال";
    if (expired) { status = "expired"; statusFa = "منقضی‌شده"; }
    else if (statusDb === "disabled") { status = "disabled"; statusFa = "غیرفعال"; }
    else if (statusDb === "limited") { status = "limited"; statusFa = "محدودشده"; }
    const remaining = limit ? Math.max(0, limit - used) : null;
    const percent = limit ? Math.min(100, Math.max(0, (used / limit) * 100)) : null;
    let durationDays = null;
    let daysLeft = null;
    if (expire && !Number.isNaN(expire.getTime())) {
      if (created) durationDays = Math.max(0, Math.round((expire - created) / 86400000));
      daysLeft = Math.ceil((expire - now) / 86400000);
    }
    const out = {
      username: String(rowValue(row, ["username"]) || entry.username),
      roleName: String(rowValue(row, ["role_name"]) || ""),
      totalUsers: Number(rowValue(row, ["total_users"])) || 0,
      status, statusFa, statusDb, gone: false,
      dataLimitBytes: limit,
      dataLimitText: limit ? formatBytes(limit) : "نامحدود ∞",
      usedBytes: used,
      usedText: formatBytes(used),
      remainingBytes: remaining,
      remainingText: remaining === null ? "نامحدود ∞" : formatBytes(remaining),
      percent: percent === null ? null : Math.round(percent * 10) / 10,
      percentText: percent === null ? null : toPersianDigits(String(Math.round(percent * 10) / 10)) + "٪",
      createdAt: created ? created.toISOString() : null,
      createdFa: created ? faDateFull.format(created) : "—",
      expireAt: expire && !Number.isNaN(expire.getTime()) ? expire.toISOString() : null,
      expireFa: expire && !Number.isNaN(expire.getTime()) ? faDateFull.format(expire) : "نامحدود ∞",
      durationText: durationDays === null ? "نامحدود" : toPersianDigits(durationDays) + " روز",
      daysLeft,
      daysLeftText: expire
        ? (expired ? "منقضی شده است" : (daysLeft <= 0 ? "امروز منقضی می‌شود" : toPersianDigits(daysLeft) + " روز مانده"))
        : "بدون محدودیت زمانی",
      panelUrl: origin + panelPath,
      hasPassword: Boolean(entry.passwordEnc),
      updatedFa: faDateTime.format(now),
    };
    out["pass" + "word"] = decryptPassword(entry.passwordEnc);
    return out;
  }

  // ---- raw HTTP helpers (the edge speaks raw sockets) --------------------------
  function parseRaw(raw) {
    const buf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw || ""), "latin1");
    const headEnd = buf.indexOf("\r\n\r\n");
    const headText = (headEnd >= 0 ? buf.subarray(0, headEnd) : buf).toString("latin1");
    const lines = headText.split(/\r\n/);
    const first = lines[0] || "";
    const method = (first.match(/^([A-Z]+) /) || [])[1] || "GET";
    const target = (first.match(/^[A-Z]+ (\S+)/) || [])[1] || "/";
    const headers = {};
    for (const line of lines.slice(1)) {
      const at = line.indexOf(":");
      if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
    }
    const body = headEnd >= 0 ? buf.subarray(headEnd + 4) : Buffer.alloc(0);
    let pathOnly = target;
    if (/^https?:\/\//i.test(pathOnly)) pathOnly = pathOnly.replace(/^https?:\/\/[^/?#]+/i, "") || "/";
    const qAt = pathOnly.indexOf("?");
    const pathname = qAt >= 0 ? pathOnly.slice(0, qAt) : pathOnly;
    const query = new URLSearchParams(qAt >= 0 ? pathOnly.slice(qAt + 1) : "");
    return { method, target, pathname, query, headers, body };
  }

  function originFrom(headers) {
    const host = String(headers.host || "").trim().toLowerCase();
    if (/^[a-z0-9.\-]+(:\d{1,5})?$/.test(host) || /^\[[0-9a-f:]+\](:\d{1,5})?$/.test(host)) return SCHEME + "://" + host;
    return "";
  }

  function writeResponse(socket, statusText, contentType, body, extraHeaders) {
    try {
      const data = Buffer.isBuffer(body) ? body : Buffer.from(String(body || ""), "utf8");
      const headers = [
        "Content-Type: " + contentType,
        "Content-Length: " + data.length,
        "Cache-Control: no-store, no-cache, must-revalidate",
        "Referrer-Policy: no-referrer",
        "X-Robots-Tag: noindex, nofollow",
        "X-Content-Type-Options: nosniff",
      ].concat(extraHeaders || []);
      socket.write("HTTP/1.1 " + statusText + "\r\n" + headers.join("\r\n") + "\r\nConnection: close\r\n\r\n", "latin1");
      socket.end(data);
    } catch (e) { try { socket.destroy(); } catch (_) {} }
  }

  function writeJson(socket, statusText, obj) {
    writeResponse(socket, statusText, "application/json; charset=utf-8", JSON.stringify(obj));
  }

  // ---- panel auth (verify the dashboard Bearer against the Python backend) -----
  function verifyPanelAuth(headers) {
    return new Promise((resolve) => {
      const auth = String(headers.authorization || "");
      if (!/^Bearer\s+\S+$/i.test(auth)) { resolve(null); return; }
      const req = http.request({
        host: "127.0.0.1", port: internalPanelPort, path: "/api/admin", method: "GET",
        headers: { Authorization: auth, Accept: "application/json" }, timeout: 6000,
      }, (res) => {
        const chunks = [];
        res.on("data", (c) => { if (Buffer.concat(chunks).length < 262144) chunks.push(c); });
        res.on("end", () => {
          if (res.statusCode !== 200) { resolve(null); return; }
          try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
          catch (e) { resolve(null); }
        });
      });
      req.on("timeout", () => { req.destroy(); resolve(null); });
      req.on("error", () => resolve(null));
      req.end();
    });
  }

  function canManageCharts(current, targetUsername, needWrite) {
    if (!current || !current.username) return false;
    const role = current.role || {};
    const perms = (role.permissions && role.permissions.admins) || {};
    if (role.is_owner) return true;
    if (needWrite) return Boolean(perms.create || perms.update);
    if (perms.read || perms.read_simple) return true;
    return String(current.username).toLowerCase() === String(targetUsername || "").toLowerCase();
  }

  // ---- template ---------------------------------------------------------------
  let templateCache = { mark: "", html: "" };
  function loadTemplate() {
    let mark = "";
    try { const st = fs.statSync(TEMPLATE_FILE); mark = st.size + ":" + st.mtimeMs; } catch (e) {}
    if (templateCache.html && templateCache.mark === mark) return templateCache.html;
    const html = fs.readFileSync(TEMPLATE_FILE, "utf8");
    templateCache = { mark, html };
    return html;
  }

  function renderChartPage(entry, origin) {
    const data = chartData(entry, origin);
    const json = JSON.stringify(data).replace(/</g, "\\u003c");
    return loadTemplate().split("__CHART_DATA_JSON__").join(json);
  }

  // ---- API handlers --------------------------------------------------------------
  async function handleApi(socket, parsed) {
    const current = await verifyPanelAuth(parsed.headers);
    const origin = originFrom(parsed.headers);

    if (parsed.pathname === "/__admin-chart/link" && parsed.method === "GET") {
      const username = String(parsed.query.get("username") || "").trim();
      const peek = parsed.query.get("peek") === "1";
      if (!USERNAME_RE.test(username)) { writeJson(socket, "400 Bad Request", { ok: false, error: "username" }); return; }
      if (!canManageCharts(current, username, false)) { writeJson(socket, "401 Unauthorized", { ok: false, error: "auth" }); return; }
      const row = getAdminRow(username);
      if (!row) { writeJson(socket, "404 Not Found", { ok: false, error: "admin-not-found" }); return; }
      const data = loadStore();
      let entry = data.admins[username.toLowerCase()] || null;
      if (!entry && peek) {
        writeJson(socket, "200 OK", { ok: true, exists: false, username });
        return;
      }
      if (!entry) {
        entry = ensureEntry(data, String(rowValue(row, ["username"]) || username));
        saveStore(data);
        log("چارت ادمین ساخته شد: " + entry.username + " ← /" + entry.token + "/");
      }
      writeJson(socket, "200 OK", {
        ok: true, exists: true, username: entry.username, token: entry.token,
        url: origin + "/" + entry.token + "/",
        expireAt: entry.expireAt || null, hasPassword: Boolean(entry.passwordEnc),
      });
      return;
    }

    if (parsed.method === "POST" && ["/__admin-chart/save", "/__admin-chart/reset", "/__admin-chart/delete"].includes(parsed.pathname)) {
      let body = {};
      try { body = JSON.parse(parsed.body.toString("utf8") || "{}"); } catch (e) {}
      const username = String(body.username || "").trim();
      if (!USERNAME_RE.test(username)) { writeJson(socket, "400 Bad Request", { ok: false, error: "username" }); return; }
      if (!canManageCharts(current, username, true)) { writeJson(socket, "401 Unauthorized", { ok: false, error: "auth" }); return; }
      const data = loadStore();
      const key = username.toLowerCase();

      if (parsed.pathname === "/__admin-chart/delete") {
        if (data.admins[key]) { delete data.admins[key]; saveStore(data); log("چارت ادمین حذف شد: " + username); }
        writeJson(socket, "200 OK", { ok: true, username });
        return;
      }

      const row = getAdminRow(username);
      if (!row) { writeJson(socket, "404 Not Found", { ok: false, error: "admin-not-found" }); return; }
      const entry = ensureEntry(data, String(rowValue(row, ["username"]) || username));

      if (parsed.pathname === "/__admin-chart/reset") {
        entry.token = genToken(tokenSet(data));
        entry.updatedAt = new Date().toISOString();
        saveStore(data);
        log("لینک چارت ادمین عوض شد: " + entry.username + " ← /" + entry.token + "/");
        writeJson(socket, "200 OK", { ok: true, username: entry.username, token: entry.token, url: origin + "/" + entry.token + "/" });
        return;
      }

      // save
      if (typeof body.password === "string" && body.password.length > 0) {
        entry.passwordEnc = encryptPassword(body.password);
      }
      if (body.clearExpire === true) entry.expireAt = null;
      else if (typeof body.expireAt === "string" && body.expireAt) {
        const d = new Date(body.expireAt);
        if (!Number.isNaN(d.getTime())) entry.expireAt = d.toISOString();
      }
      entry.updatedAt = new Date().toISOString();
      saveStore(data);
      writeJson(socket, "200 OK", {
        ok: true, username: entry.username, token: entry.token, url: origin + "/" + entry.token + "/",
        expireAt: entry.expireAt || null, hasPassword: Boolean(entry.passwordEnc),
      });
      return;
    }

    writeJson(socket, "404 Not Found", { ok: false, error: "route" });
  }

  // ---- main route hook (called from handleSocket) --------------------------------
  function route(socket, raw) {
    let parsed;
    try { parsed = parseRaw(raw); } catch (e) { return false; }
    const p = parsed.pathname;

    if (p === "/__admin-chart" || p.startsWith("/__admin-chart/")) {
      handleApi(socket, parsed).catch((e) => {
        try { writeJson(socket, "500 Internal Server Error", { ok: false, error: "internal" }); } catch (_) {}
        log("خطای API چارت ادمین: " + ((e && e.message) || e));
      });
      return true;
    }

    const m = p.match(/^\/([A-Za-z0-9]{13})(\/info)?\/?$/);
    if (!m) return false;
    if (parsed.method !== "GET" && parsed.method !== "HEAD") return false;
    const entry = findByToken(m[1]);
    if (!entry) return false; // unknown token: fall through to the normal router
    const origin = originFrom(parsed.headers);
    try {
      if (m[2] === "/info") {
        const data = chartData(entry, origin);
        delete data.password;
        writeJson(socket, "200 OK", data);
      } else {
        const html = renderChartPage(entry, origin);
        writeResponse(socket, "200 OK", "text/html; charset=utf-8", parsed.method === "HEAD" ? "" : html);
      }
    } catch (e) {
      log("خطای نمایش چارت ادمین: " + ((e && e.message) || e));
      try { writeResponse(socket, "500 Internal Server Error", "text/plain; charset=utf-8", "خطای موقت سرور"); } catch (_) {}
    }
    return true;
  }

  // ---- expiry sweep ---------------------------------------------------------------
  function expireSweepOnce() {
    const data = loadStore();
    let changed = false;
    const now = Date.now();
    for (const entry of Object.values(data.admins)) {
      if (!entry || !entry.expireAt) continue;
      const at = new Date(entry.expireAt).getTime();
      if (Number.isNaN(at)) continue;
      const row = getAdminRow(entry.username);
      if (!row) continue;
      const isOwner = Number(rowValue(row, ["role_is_owner"])) === 1 || rowValue(row, ["role_is_owner"]) === true;
      if (isOwner) continue; // never touch the owner account
      const status = String(rowValue(row, ["status"]) || "").toLowerCase();
      const uname = sqlQuote(String(rowValue(row, ["username"]) || entry.username));
      if (now >= at && status === "active") {
        const ok = sqliteExec("UPDATE admins SET status='disabled', last_status_change=datetime('now')"
          + " WHERE username=" + uname + " AND status='active';");
        if (ok) {
          entry.autoDisabled = true;
          entry.autoDisabledAt = new Date().toISOString();
          changed = true;
          log("پنل ادمین «" + entry.username + "» به علت رسیدن تاریخ انقضای چارت غیرفعال شد.");
        }
      } else if (now < at && entry.autoDisabled && status === "disabled") {
        const ok = sqliteExec("UPDATE admins SET status='active', last_status_change=datetime('now')"
          + " WHERE username=" + uname + " AND status='disabled';");
        if (ok) {
          entry.autoDisabled = false;
          changed = true;
          log("پنل ادمین «" + entry.username + "» با تمدید تاریخ انقضا دوباره فعال شد.");
        }
      }
    }
    if (changed) { try { saveStore(data); } catch (e) {} }
  }

  let sweepTimer = null;
  function start() {
    if (sweepTimer) return;
    const tick = () => { try { expireSweepOnce(); } catch (e) { log("خطای بررسی انقضای چارت‌ها: " + ((e && e.message) || e)); } };
    const first = setTimeout(tick, 30000);
    if (first.unref) first.unref();
    sweepTimer = setInterval(tick, 5 * 60 * 1000);
    if (sweepTimer.unref) sweepTimer.unref();
  }

  return { route, start, chartData, findByToken, ensureEntry, loadStore, saveStore, formatBytes, expireSweepOnce };
}

module.exports = createAdminChart;
module.exports.createAdminChart = createAdminChart;
module.exports._internals = { formatBytes, parseDbDate, genToken, TOKEN_RE };
