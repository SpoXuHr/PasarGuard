'use strict';
/**
 * پنل اختصاصی هر مدیر — لبهٔ HTTP.
 *
 * هر مدیر یک آدرس کوتاه و اختصاصی دارد:
 *    https://host:port/<pass>/         ← صفحهٔ اختصاصی (طراحی‌شده)
 *    https://host:port/<pass>/panel/   ← خودِ پنل کامل با ورود خودکار
 *
 * توکن نشست از بک‌اند (POST /api/managed/admin-session) و فقط با هدر مشترک
 * X-PG-Edge ساخته می‌شود؛ هیچ پسوردی داخل مرورگر ذخیره نمی‌شود.
 */
const fs = require('fs');
const http = require('http');

const TEMPLATE_FILE = '/home/container/admin_portal.html';
const CONSOLE_SCRIPT_FILE = '/home/container/pg_console.js';
const PANELS_FILE = '/home/container/pasarguard-native/data/admin_panels.json';
const SECRET_FILE = '/home/container/pasarguard-native/data/edge_secret.txt';
const TOKEN_TTL_MS = 5 * 60 * 1000;

function createPortal(ctx) {
  const dashRoot = ctx.dashRoot;
  const nativePort = ctx.nativePort;
  const log = ctx.log || function () {};

  let panelsCache = { at: 0, map: {} };
  let secretCache = { at: 0, value: '' };
  let templateCache = { at: 0, text: '' };
  let consoleScriptCache = { at: 0, text: '' };
  const tokenCache = new Map(); // pass -> { token, username, at }

  function readPanels() {
    const now = Date.now();
    if (now - panelsCache.at < 1000) return panelsCache.map;
    const map = {};
    try {
      const raw = JSON.parse(fs.readFileSync(PANELS_FILE, 'utf8'));
      const panels = (raw && raw.panels) || {};
      for (const key of Object.keys(panels)) {
        const entry = panels[key];
        if (!entry || !entry.pass) continue;
        map[String(entry.pass)] = {
          adminId: Number(key),
          username: String(entry.username || ''),
          expireAt: entry.expire_at ? Date.parse(entry.expire_at) : 0,
        };
      }
    } catch (e) {}
    panelsCache = { at: now, map };
    return map;
  }

  function secret() {
    const now = Date.now();
    if (now - secretCache.at < 60000 && secretCache.value) return secretCache.value;
    let value = '';
    try { value = String(fs.readFileSync(SECRET_FILE, 'utf8')).trim(); } catch (e) {}
    secretCache = { at: now, value };
    return value;
  }

  function readCached(file, cache, fallback) {
    let stat = null;
    try { stat = fs.statSync(file); } catch (e) { return fallback; }
    if (cache.at === stat.mtimeMs) return cache.text;
    try {
      const text = fs.readFileSync(file, 'utf8');
      cache.at = stat.mtimeMs;
      cache.text = text;
      return text;
    } catch (e) {
      return fallback;
    }
  }

  function template() { return readCached(TEMPLATE_FILE, templateCache, ''); }
  function consoleScript() { return readCached(CONSOLE_SCRIPT_FILE, consoleScriptCache, ''); }

  function mint(pass, cb, attempt) {
    attempt = attempt || 0;
    const now = Date.now();
    const hit = tokenCache.get(pass);
    if (hit && now - hit.at < TOKEN_TTL_MS) { cb(null, hit); return; }
    if (!secret() && attempt < 3) { secretCache = { at: 0, value: '' }; setTimeout(() => mint(pass, cb, attempt + 1), 350); return; }
    const body = JSON.stringify({ pass });
    const req = http.request({
      host: '127.0.0.1',
      port: nativePort,
      path: '/api/managed/admin-session',
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
        'x-pg-edge': secret(),
      },
      timeout: 8000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        // A fresh backend may create the shared secret on its first request; retry
        // once after re-reading it instead of failing the whole page.
        if (res.statusCode === 403) {
          cb(Object.assign(new Error('expired'), { expired: true }));
          return;
        }
        if (res.statusCode !== 200 && attempt < 2) {
          secretCache = { at: 0, value: '' };
          setTimeout(() => mint(pass, cb, attempt + 1), 300);
          return;
        }
        try {
          const json = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          if (json && json.access_token) {
            const value = { token: json.access_token, username: json.username, status: json.status, at: Date.now() };
            tokenCache.set(pass, value);
            cb(null, value);
            return;
          }
        } catch (e) {}
        cb(new Error('session failed'));
      });
      res.on('error', () => cb(new Error('session error')));
    });
    req.on('timeout', () => { req.destroy(); cb(new Error('session timeout')); });
    req.on('error', (e) => cb(e));
    req.end(body);
  }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  const SCHEME = String(ctx.scheme || 'https');

  function publicOrigin(socket, raw) {
    const host = String(ctx.requestHeader ? (ctx.requestHeader(raw)['host'] || '') : '').trim();
    if (host) return SCHEME + '://' + host;
    const hostFile = '/home/container/vpn/data/public-host.txt';
    let h = '';
    try { h = String(fs.readFileSync(hostFile, 'utf8')).trim(); } catch (e) {}
    return SCHEME + '://' + (h || '127.0.0.1') + ':' + (ctx.publicPort || 20250);
  }

  function send(socket, status, type, body, extra) {
    const headers = [
      'HTTP/1.1 ' + status,
      'Content-Type: ' + type,
      'Content-Length: ' + Buffer.byteLength(body),
      'Cache-Control: no-store, no-cache, must-revalidate, max-age=0',
      'X-PG-Portal: 1',
      'Referrer-Policy: no-referrer',
      'Connection: close',
    ].concat(extra || []);
    try {
      socket.write(headers.join('\r\n') + '\r\n\r\n');
      socket.end(body);
    } catch (e) {}
  }

  function errorPage(socket, message) {
    const html = '<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8">' +
      '<title>خطا</title><body style="font-family:system-ui,Tahoma;background:#04140e;color:#eafff3;display:grid;place-items:center;height:100vh;margin:0">' +
      '<div style="text-align:center;max-width:340px"><div style="font-size:34px">⚠️</div><h3>پنل در دسترس نیست</h3><p style="color:#9dbdac;font-size:13px">' +
      escapeHtml(message) + '</p></div></body></html>';
    send(socket, '503 Service Unavailable', 'text/html; charset=utf-8', html);
  }

  function expiredPage(socket, entry) {
    const html = '<!doctype html><html lang="fa" dir="rtl"><meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width,initial-scale=1"><title>پایان مهلت پنل</title>' +
      '<body style="margin:0;font-family:system-ui,Tahoma;background:radial-gradient(900px 600px at 70% 0%,#0b4a2c,transparent 60%),#04120c;color:#eafff3;display:grid;place-items:center;min-height:100dvh">' +
      '<div style="text-align:center;max-width:380px;padding:28px;border-radius:24px;border:1px solid rgba(134,239,172,.22);' +
      'background:rgba(255,255,255,.06);box-shadow:0 24px 60px -24px rgba(0,0,0,.8)">' +
      '<div style="font-size:40px">⏳</div><h2 style="margin:12px 0 8px;font-size:19px">مهلت این پنل به پایان رسیده</h2>' +
      '<p style="color:#9dbdac;font-size:13px;line-height:2;margin:0">مدیر <b style="color:#eafff3">' +
      escapeHtml(entry.username || '') + '</b> برای تمدید با مالک پنل تماس بگیرید.</p>' +
      '</div></body></html>';
    send(socket, '403 Forbidden', 'text/html; charset=utf-8', html);
  }

  function portalPage(socket, pass, entry, raw) {
    const origin = publicOrigin(socket, raw);
    const panelUrl = origin + '/' + pass + '/';
    mint(pass, (err, session) => {
      if (err && err.expired) { expiredPage(socket, entry); return; }
      if (err || !session) { errorPage(socket, 'ساخت نشست مدیر ناموفق بود؛ چند لحظه بعد دوباره تلاش کنید.'); return; }
      let html = template();
      if (!html) { errorPage(socket, 'قالب پنل پیدا نشد.'); return; }
      html = html
        .split('__TOKEN__').join(String(session.token))
        .split('__PASS__').join(escapeHtml(pass))
        .split('__USER__').join(escapeHtml(session.username || entry.username))
        .split('__PANELURL__').join(escapeHtml(panelUrl))
        .split('__PANELROOT__').join(escapeHtml(panelUrl + 'panel/'));
      send(socket, '200 OK', 'text/html; charset=utf-8', html);
    });
  }

  function spaPage(socket, pass, entry) {
    mint(pass, (err, session) => {
      if (err || !session) { errorPage(socket, 'ساخت نشست مدیر ناموفق بود.'); return; }
      let html = '';
      try { html = fs.readFileSync(dashRoot + '/index.html', 'utf8'); } catch (e) { errorPage(socket, 'پنل کامل نصب نشده است.'); return; }
      const token = String(session.token).replace(/[^A-Za-z0-9._-]/g, '');
      // فقط توکن نشست تزریق می‌شود؛ هیچ اسکریپت اضافه‌ای به پنل تزریق نمی‌شود.
      const boot = '<script>try{localStorage.setItem("token","' + token + '");localStorage.setItem("lang","fa");' +
        'localStorage.setItem("i18nextLng","fa");localStorage.setItem("dir","rtl");}catch(e){}</script>';
      html = html.replace('</head>', boot + '</head>');
      send(socket, '200 OK', 'text/html; charset=utf-8', html);
    });
  }

  /**
   * @returns {boolean} true when the request was handled here
   */
  function handle(socket, raw, pathname) {
    let p = String(pathname || '');
    if (p.length < 2) return false;
    const match = p.match(/^\/([A-Za-z0-9]{8,24})(?:\/(.*))?$/);
    if (!match) return false;
    const pass = match[1];
    const rest = String(match[2] || '').replace(/\/+$/, '');
    const entry = readPanels()[pass];
    if (!entry) return false;
    if (entry.expireAt && Date.now() > entry.expireAt) {
      tokenCache.delete(pass);
      expiredPage(socket, entry);
      return true;
    }
    if (!rest) { portalPage(socket, pass, entry, raw); return true; }
    if (rest === 'panel') { spaPage(socket, pass, entry); return true; }
    return false;
  }

  return { handle, readPanels };
}

module.exports = { createPortal };
