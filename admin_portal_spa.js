/* پنل اختصاصی مدیران — دکمهٔ «کپی لینک پنل» در صفحهٔ «مدیران».
 *
 * این اسکریپت فقط روی صفحهٔ مدیران فعال می‌شود: برای هر ردیف، یک دکمهٔ کوچک
 * کنار دکمهٔ ویرایش اضافه می‌کند که آدرس پنل اختصاصی همان مدیر را کپی می‌کند.
 * آدرس‌ها از /api/managed/admin-panels گرفته می‌شوند (همان منبعی که سرور
 * استفاده می‌کند)، بنابراین با تغییر پسورد یا ساختن مدیر تازه همیشه هم‌گام است.
 */
(function () {
  'use strict';
  if (window.__pgAdminPanels) return;
  window.__pgAdminPanels = true;

  var CACHE = { at: 0, map: null };

  function token() {
    try { return localStorage.getItem('token') || ''; } catch (e) { return ''; }
  }

  function panels() {
    var now = Date.now();
    if (CACHE.map && now - CACHE.at < 15000) return Promise.resolve(CACHE.map);
    var t = token();
    if (!t) return Promise.resolve({});
    return fetch('/api/managed/admin-panels', { headers: { Authorization: 'Bearer ' + t, Accept: 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : []; })
      .then(function (list) {
        var map = {};
        (list || []).forEach(function (row) { if (row && row.username) map[String(row.username)] = row.url; });
        CACHE = { at: Date.now(), map: map };
        return map;
      })
      .catch(function () { return {}; });
  }

  function toast(message) {
    var el = document.getElementById('__pgPassToast');
    if (!el) {
      el = document.createElement('div');
      el.id = '__pgPassToast';
      el.style.cssText = 'position:fixed;z-index:2147483000;inset-inline:0;bottom:26px;margin:auto;width:max-content;' +
        'max-width:82vw;padding:10px 16px;border-radius:12px;font:800 12.5px system-ui,Tahoma;color:#042114;' +
        'background:linear-gradient(140deg,#a3e635,#34d399);box-shadow:0 18px 40px -18px rgba(52,211,153,.9);' +
        'opacity:0;transform:translateY(12px);transition:.22s ease;pointer-events:none';
      document.body.appendChild(el);
    }
    el.textContent = message;
    requestAnimationFrame(function () { el.style.opacity = '1'; el.style.transform = 'none'; });
    clearTimeout(el.__h);
    el.__h = setTimeout(function () { el.style.opacity = '0'; el.style.transform = 'translateY(12px)'; }, 1800);
  }

  // Plain HTTP has no secure-context clipboard, so try the async API first and
  // fall back to a selected textarea; never claim success without checking.
  function copyText(text) {
    var ok = false;
    function done() { ok = true; toast('لینک پنل کپی شد ✓'); }
    function legacy() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.top = '0';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var copied = false;
      try { copied = document.execCommand('copy'); } catch (e) { copied = false; }
      document.body.removeChild(ta);
      if (copied) { done(); return; }
      window.prompt('لینک پنل را کپی کنید:', text);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, legacy);
    } else {
      legacy();
    }
    return ok;
  }

  function makeButton(url, username) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pg-panel-link', username);
    btn.title = 'کپی لینک پنل اختصاصی ' + username;
    btn.className = 'inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md ' +
      'text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground';
    btn.style.cursor = 'pointer';
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="15" height="15" viewBox="0 0 24 24" ' +
      'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
      '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/>' +
      '<path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!url) { toast('ساخت لینک پنل برای این مدیر ممکن نشد'); return; }
      copyText(url);
    });
    return btn;
  }

  var CHROME = '[data-sidebar], aside, nav, header, [role="navigation"]';

  // Exact-text leaf inside a node (so «GUCCi» is not matched inside «GUCCi2»).
  function exactLeaf(root, text) {
    var nodes = root.querySelectorAll('td,th,span,div,p,a,strong,b,h3,h4');
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (el.children && el.children.length) continue;
      if (String(el.textContent || '').trim() !== text) continue;
      return el;
    }
    return null;
  }

  // The row's action cluster (the flex box that holds the edit pencil), so the
  // copy button sits right next to ✏️ instead of dropping to a new line.
  function actionHost(row) {
    var cells = row.querySelectorAll('td');
    var fallback = null;
    for (var i = 0; i < cells.length; i++) {
      var cell = cells[i];
      if (cell.querySelector('.chevron, [class*="chevron"]')) continue;
      var btn = cell.querySelector('button');
      if (!btn) continue;
      var wrap = btn.closest('div') || cell;
      var cs = null;
      try { cs = getComputedStyle(wrap); } catch (e) {}
      if (cs && cs.display === 'flex' && /center/.test(cs.justifyContent)) return wrap;
      if (!fallback) fallback = wrap;
    }
    return fallback;
  }

  function injectFor(username, url) {
    var rows = document.querySelectorAll('tr');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      if (row.closest(CHROME)) continue;
      if (row.querySelector('[data-pg-panel-link]')) return;
      if (!exactLeaf(row, username)) continue;
      var host = actionHost(row);
      if (!host) continue;
      host.insertBefore(makeButton(url, username), host.firstChild);
      return;
    }
    // card-style layouts (mobile): next to the nearest action button
    var leaves = document.querySelectorAll('td,span,div,p,strong,b');
    for (var j = 0; j < leaves.length; j++) {
      var el = leaves[j];
      if (el.children && el.children.length) continue;
      if (String(el.textContent || '').trim() !== username) continue;
      if (el.closest(CHROME)) continue;
      var node = el;
      for (var depth = 0; depth < 7 && node && node !== document.body; depth++) {
        if (node.querySelector('[data-pg-panel-link]')) return;
        var action = node.querySelector('button, a[role="button"]');
        if (action && action.parentElement) {
          action.parentElement.insertBefore(makeButton(url, username), action);
          return;
        }
        node = node.parentElement;
      }
    }
  }

  function isAdminsPage() {
    var hash = String(location.hash || '');
    return /^#\/admins?(\/|\?|$)/.test(hash) || /#\/admins/.test(hash);
  }

  var running = false;
  function inject() {
    if (running || !isAdminsPage()) return;
    running = true;
    panels().then(function (map) {
      Object.keys(map).forEach(function (username) { injectFor(username, map[username]); });
      running = false;
    }).catch(function () { running = false; });
  }

  var pending = null;
  function schedule() {
    clearTimeout(pending);
    pending = setTimeout(inject, 200);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', schedule);
  } else {
    schedule();
  }
  window.addEventListener('hashchange', schedule);
  try {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
  setInterval(inject, 2500);
})();
