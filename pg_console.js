/* pg-console.js — پنل مدیران: همهٔ بهبودهای سمت پنل در یک فایل.
 *
 * ۱) دکمهٔ 🔗 کنار ✏️ هر مدیر در صفحهٔ «مدیران» → کپی لینک پنل اختصاصی همان مدیر
 * ۲) در فرم «ایجاد/ویرایش مدیر»:
 *      • رمز عبور قوی و تصادفی خودکار پر می‌شود (قابل بازتولید/ویرایش/کپی)
 *      • «محدودیت زمان مدیر» عیناً مثل «محدودیت داده مدیر» بلافاصله زیر آن
 *      • با ذخیرهٔ فرم، تاریخ انقضا روی همان مدیر ثبت می‌شود
 * ۳) اصلاح چیدمان موبایل: دکمه‌های «لغو/ایجاد» همیشه پایین دیالوگ دیده می‌شوند
 * ۴) پاک‌سازی کش/سرویس‌ورکر قدیمی تا نسخهٔ تازهٔ پنل روی گوشی هم اجرا شود
 *
 * بدون build، بدون تغییر در فایل‌های هش‌دار داشبورد؛ فقط DOM + API موجود.
 */
(function () {
  'use strict';
  if (window.__pgConsole) return;
  window.__pgConsole = 1;

  var API_PANELS = '/api/managed/admin-panels';
  var CACHE = { at: 0, list: null };

  /* ------------------------------------------------------------------ utils */
  function token() {
    try { return localStorage.getItem('token') || ''; } catch (e) { return ''; }
  }

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({
      Authorization: 'Bearer ' + token(),
      Accept: 'application/json'
    }, opts.headers || {});
    return fetch(path, opts).then(function (r) {
      return r.text().then(function (t) {
        var body = null;
        try { body = t ? JSON.parse(t) : null; } catch (e) {}
        if (!r.ok) {
          var msg = (body && (body.detail || body.message)) || ('HTTP ' + r.status);
          throw new Error(typeof msg === 'string' ? msg : JSON.stringify(msg));
        }
        return body;
      });
    });
  }

  function panels(force) {
    var now = Date.now();
    if (!force && CACHE.list && now - CACHE.at < 8000) return Promise.resolve(CACHE.list);
    return api(API_PANELS).then(function (list) {
      CACHE = { at: Date.now(), list: list || [] };
      return CACHE.list;
    }).catch(function () { return CACHE.list || []; });
  }

  function toast(text, action) {
    var el = document.getElementById('__pgToast');
    if (!el) {
      el = document.createElement('div');
      el.id = '__pgToast';
      document.body.appendChild(el);
    }
    el.textContent = '';
    var label = document.createElement('span');
    label.textContent = text;
    el.appendChild(label);
    if (action) {
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'pg-toast-action';
      btn.textContent = action.label;
      btn.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        el.className = 'pg-toast';
        action.fn();
      });
      el.appendChild(btn);
    }
    el.className = 'pg-toast show';
    clearTimeout(el.__h);
    el.__h = setTimeout(function () { el.className = 'pg-toast'; }, action ? 7000 : 2400);
  }

  function copyText(text, after) {
    function done(ok) {
      if (after) after(ok); else toast(ok ? 'کپی شد ✓' : 'کپی نشد');
    }
    function legacy() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0;';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      setTimeout(function () { try { document.body.removeChild(ta); } catch (e) {} }, 400);
      return ok;
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () { done(legacy()); });
    } else {
      done(legacy());
    }
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }

  function faDate(value) {
    if (!value) return '';
    var d = value instanceof Date ? value : new Date(value);
    if (isNaN(d.getTime())) return '';
    try {
      return new Intl.DateTimeFormat('fa-IR', {
        dateStyle: 'full', timeStyle: 'short'
      }).format(d);
    } catch (e) {
      return d.getFullYear() + '/' + pad2(d.getMonth() + 1) + '/' + pad2(d.getDate()) +
        ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    }
  }

  /* ------------------------------------------------------------------ styles */
  function ensureStyles() {
    if (document.getElementById('__pgStyle')) return;
    var css = ''
      + '.pg-toast{position:fixed;inset-inline:0;bottom:24px;margin:auto;width:max-content;max-width:84vw;'
      + 'z-index:2147483000;padding:10px 16px;border-radius:12px;font:800 12.5px system-ui,Tahoma;'
      + 'color:#042114;background:linear-gradient(140deg,#a3e635,#34d399);'
      + 'box-shadow:0 18px 40px -18px rgba(52,211,153,.9);opacity:0;transform:translateY(12px);'
      + 'transition:.22s ease;pointer-events:none}'
      + '.pg-toast.show{opacity:1;transform:none}'
      + '.pg-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;cursor:pointer;'
      + 'border:1px solid hsl(var(--border));background:hsl(var(--secondary));color:hsl(var(--secondary-foreground));'
      + 'border-radius:.5rem;padding:.3rem .6rem;font-size:11.5px;font-weight:700;line-height:1.6}'
      + '.pg-btn:hover{filter:brightness(1.08)}'
      + '.pg-btn.primary{background:linear-gradient(140deg,#34d399,#10b981);color:#04230f;border-color:transparent}'
      + '.pg-wrap{margin-top:.25rem;display:flex;flex-wrap:wrap;gap:.4rem;align-items:center}'
      + '.pg-chips{display:flex;flex-wrap:wrap;gap:.3rem;margin-top:.35rem}'
      + '.pg-chip{cursor:pointer;border-radius:999px;padding:.15rem .55rem;font-size:11px;font-weight:700;'
      + 'border:1px solid hsl(var(--border));background:transparent;color:hsl(var(--muted-foreground))}'
      + '.pg-chip.on,.pg-chip:hover{color:#052e16;background:linear-gradient(140deg,#a3e635,#34d399);border-color:transparent}'
      + '.pg-hint{margin-top:.35rem;font-size:11px;font-weight:600;color:hsl(var(--muted-foreground))}'
      + '.pg-hint b{color:hsl(var(--foreground))}'
      + '.pg-copy-link{display:inline-flex;align-items:center;justify-content:center;width:32px;height:32px;'
      + 'border-radius:.375rem;cursor:pointer;color:hsl(var(--muted-foreground));background:transparent;border:0}'
      + '.pg-copy-link:hover{background:hsl(var(--accent));color:hsl(var(--accent-foreground))}'
      + '.pg-copy-link-inline{width:26px;height:26px;vertical-align:middle;border-radius:.35rem}'
      + '@media (max-width:640px){.pg-copy-link-inline{display:inline-flex!important;margin-inline-start:.25rem}}'
      + '.pg-chart-btn{display:inline-flex;align-items:center;justify-content:center;gap:.3rem;cursor:pointer;'
      + 'height:32px;padding:0 .5rem;border-radius:.5rem;border:1px solid hsl(var(--border));'
      + 'background:hsl(var(--secondary));color:hsl(var(--secondary-foreground));font-size:11px;font-weight:700;'
      + 'white-space:nowrap;transition:.15s ease}'
      + '.pg-chart-btn:hover{background:hsl(var(--accent));color:hsl(var(--accent-foreground))}'
      + '.pg-chart-btn svg{flex:0 0 auto}'
      + '.pg-chart-btn-inline{height:26px;padding:0 .45rem;margin-inline-start:.4rem;font-size:10.5px;vertical-align:middle}'
      // در موبایل فقط دکمهٔ کنار نام نمایش داده می‌شود (ستون اکشن‌ها تا باز شدن ردیف پنهان است)
      + '@media (max-width:640px){[data-pg-panel-link].pg-chart-btn:not(.pg-chart-btn-inline){display:none!important}}'
      // …و در دسکتاپ دکمهٔ کنار نام لازم نیست، چون دکمهٔ کامل در ستون اکشن‌ها هست
      + '@media (min-width:641px){[data-pg-panel-link].pg-chart-btn-inline{display:none!important}}'
      + '.pg-toast{display:inline-flex;align-items:center;gap:.6rem}'
      + '.pg-toast-action{cursor:pointer;border:0;border-radius:.45rem;padding:.25rem .55rem;font:inherit;font-size:11.5px;'
      + 'font-weight:800;color:#042114;background:rgba(255,255,255,.55);pointer-events:auto}'
      + '.pg-toast.show{pointer-events:auto}'
      + '.pg-toast{pointer-events:none}'
      /* ---- موبایل: دکمه‌های ذخیره همیشه دیده شوند ---- */
      + '@media (max-width:640px){'
      + '[role="dialog"] > div{max-height:94dvh}'
      + '[role="dialog"] [class*="max-h-[75dvh]"]{max-height:calc(100dvh - 220px)!important}'
      + '[role="dialog"] [class*="max-h-[70dvh]"]{max-height:calc(100dvh - 220px)!important}'
      + '}';
    var st = document.createElement('style');
    st.id = '__pgStyle';
    st.textContent = css;
    document.head.appendChild(st);
  }

  /* --------------------------------------------------- 1) copy panel link row */
  function makeLinkButton(url, username, inline) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.setAttribute('data-pg-panel-link', username);
    btn.className = 'pg-chart-btn' + (inline ? ' pg-chart-btn-inline' : '');
    btn.title = 'کپی لینک چارت پنل اختصاصی ' + username;
    btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" '
      + 'fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">'
      + '<path d="M10 13a5 5 0 0 0 7.5.5l3-3a5 5 0 0 0-7-7l-1.7 1.7"/>'
      + '<path d="M14 11a5 5 0 0 0-7.5-.5l-3 3a5 5 0 0 0 7 7l1.7-1.7"/></svg>'
      + '<span class="pg-chart-btn-txt">لینک چارت</span>';
    btn.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (!url) { toast('ساخت لینک چارت ممکن نشد'); return; }
      copyText(url, function (ok) {
        toast(ok ? ('لینک چارت ' + username + ' کپی شد ✓') : 'کپی نشد — دستی بردارید', {
          label: 'مشاهده چارت',
          fn: function () { window.open(url, '_blank', 'noopener'); }
        });
      });
    });
    // کلیک راست = باز کردن چارت بدون کپی
    btn.addEventListener('contextmenu', function (e) {
      e.preventDefault();
      if (url) window.open(url, '_blank', 'noopener');
    });
    return btn;
  }

  var CHROME = '[data-sidebar], aside, nav, header, [role="navigation"]';

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

  function isVisible(el) {
    if (!el) return false;
    var r = el.getBoundingClientRect();
    if (r.width <= 0 || r.height <= 0) return false;
    var cs = null;
    try { cs = getComputedStyle(el); } catch (e) {}
    if (cs && (cs.visibility === 'hidden' || cs.display === 'none' || cs.opacity === '0')) return false;
    var node = el;
    for (var i = 0; i < 8 && node; i++) {
      var st = null;
      try { st = getComputedStyle(node); } catch (e) {}
      if (st && st.display === 'none') return false;
      node = node.parentElement;
    }
    return true;
  }

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

  function isAdminsPage() {
    var hash = String(location.hash || '');
    return /^#\/admins?(\/|\?|$)/.test(hash) || /#\/admins/.test(hash);
  }

  function injectRowButtons() {
    if (!isAdminsPage()) return;
    if (!token()) return;
    panels().then(function (list) {
      (list || []).forEach(function (row) {
        if (!row || !row.username) return;
        var username = String(row.username);
        var rows = document.querySelectorAll('tr');
        for (var i = 0; i < rows.length; i++) {
          var tr = rows[i];
          if (tr.closest(CHROME)) continue;
          if (tr.querySelector('[data-pg-panel-link]')) return;
          var leaf = exactLeaf(tr, username);
          if (!leaf) continue;
          var host = actionHost(tr);
          if (host) host.insertBefore(makeLinkButton(row.url, username, false), host.firstChild);
          // یک دکمهٔ کوچک هم کنار نامِ مدیر (همیشه دیده می‌شود، حتی ردیف بسته)
          var nameWrap = leaf.closest('.flex.items-center') || leaf.parentElement;
          if (nameWrap && nameWrap.parentElement) {
            nameWrap.parentElement.insertBefore(makeLinkButton(row.url, username, true), nameWrap.nextSibling);
          }
          return;
        }
      });
    });
  }

  /* ------------------------------------------------------- password strength */
  var LOWER = 'abcdefghijkmnopqrstuvwxyz';
  var UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
  var DIGIT = '23456789';
  var SYMBOL = '!@#$%^&*-_=+?';

  function strongPassword(length) {
    length = length || 16;
    var all = LOWER + UPPER + DIGIT + SYMBOL;
    // پنل حداقل ۲ رقم می‌خواهد؛ ترکیب را از پیش تضمین می‌کنیم تا ذخیره رد نشود.
    var out = [DIGIT, DIGIT, DIGIT, DIGIT, UPPER, UPPER, UPPER, UPPER, LOWER, LOWER, LOWER, LOWER, LOWER, LOWER, SYMBOL, SYMBOL].map(pick);
    while (out.length < length) out.push(pick(all));
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = out[i]; out[i] = out[j]; out[j] = t;
    }
    return out.join('');
    function pick(set) {
      var buf = new Uint32Array(1);
      if (window.crypto && window.crypto.getRandomValues) window.crypto.getRandomValues(buf);
      else buf[0] = Math.floor(Math.random() * 4294967296);
      return set.charAt(buf[0] % set.length);
    }
  }

  function setValue(input, value) {
    if (!input) return;
    var setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    setter.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }

  /* ------------------------------------------------ dialog: time limit + pwd */
  var state = { box: null, days: '', unit: 'day', touched: false, password: '' };

  function findFormItemByLabel(dialog, needle) {
    var labels = dialog.querySelectorAll('label');
    for (var i = 0; i < labels.length; i++) {
      if (String(labels[i].textContent || '').indexOf(needle) >= 0) {
        return labels[i].parentElement;
      }
    }
    return null;
  }

  function dialogMode(dialog) {
    var h = dialog.querySelector('h2');
    var title = h ? String(h.textContent || '').trim() : '';
    if (title.indexOf('ویرایش') >= 0) return { mode: 'edit', title: title };
    return { mode: 'create', title: title };
  }

  function usernameOf(dialog) {
    var input = dialog.querySelector('input[name="username"]');
    return input && input.value ? input.value.trim() : '';
  }

  function syncHint() {
    if (!state.box) return;
    var hint = state.box.querySelector('.pg-hint');
    var days = Number(String(state.days).replace(/[^\d.]/g, ''));
    if (!state.days || !isFinite(days) || days <= 0) {
      hint.innerHTML = 'بدون محدودیت زمانی — پنل این مدیر همیشه فعال است';
    } else {
      var ms = days * (state.unit === 'month' ? 30 : state.unit === 'year' ? 365 : 1) * 86400000;
      hint.innerHTML = 'انقضا: <b>' + faDate(new Date(Date.now() + ms)) + '</b>';
    }
  }

  function enhancePassword(dialog, mode) {
    var pwd = dialog.querySelector('input[name="password"]');
    var confirm = dialog.querySelector('input[name="passwordConfirm"]');
    if (!pwd) return;
    var item = pwd.closest('.space-y-2') || pwd.parentElement.parentElement;
    if (!item || item.querySelector('.pg-pwd-tools')) return;
    var wrap = document.createElement('div');
    wrap.className = 'pg-wrap pg-pwd-tools';
    wrap.innerHTML = '<button type="button" class="pg-btn primary" data-act="gen">رمز قوی تصادفی</button>'
      + '<button type="button" class="pg-btn" data-act="show">نمایش</button>'
      + '<button type="button" class="pg-btn" data-act="copy">کپی</button>';
    item.appendChild(wrap);

    function generate() {
      var value = strongPassword(16);
      state.password = value;
      setValue(pwd, value);
      if (confirm) setValue(confirm, value);
      toast('رمز قوی ساخته شد ✓');
    }

    wrap.addEventListener('click', function (e) {
      var btn = e.target.closest('[data-act]');
      if (!btn) return;
      var act = btn.getAttribute('data-act');
      if (act === 'gen') generate();
      else if (act === 'show') {
        var hidden = pwd.type === 'password';
        pwd.type = hidden ? 'text' : 'password';
        if (confirm) confirm.type = hidden ? 'text' : 'password';
        btn.textContent = hidden ? 'پنهان' : 'نمایش';
      } else if (act === 'copy') {
        copyText(pwd.value || state.password || '');
      }
    });

    if (mode === 'create' && !pwd.value) generate();
  }

  function enhanceExpiry(dialog, mode) {
    if (dialog.querySelector('.pg-expiry-box')) return;
    var dataItem = findFormItemByLabel(dialog, 'محدودیت داده');
    if (!dataItem) return;
    var box = document.createElement('div');
    box.className = 'space-y-2 relative pg-expiry-box';
    box.innerHTML = ''
      + '<label class="text-sm font-medium leading-snug block">محدودیت زمان مدیر</label>'
      + '<div class="relative">'
      + '  <div class="min-w-0 flex-1">'
      + '    <input dir="ltr" type="text" inputmode="numeric" placeholder="نامحدود" data-pg-days '
      + '      class="border-border bg-input placeholder:text-input-placeholder focus-visible:ring-ring flex h-9 w-full rounded-lg border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:outline-none pr-16">'
      + '  </div>'
      + '  <select data-pg-unit class="border-border bg-input focus-visible:ring-ring absolute top-1/2 right-1 -translate-y-1/2 h-7 rounded-md border px-1 text-xs font-medium focus-visible:outline-none">'
      + '    <option value="day">روز</option><option value="month">ماه</option><option value="year">سال</option>'
      + '  </select>'
      + '</div>'
      + '<div class="pg-chips">'
      + '  <button type="button" class="pg-chip" data-days="30">۳۰ روز</button>'
      + '  <button type="button" class="pg-chip" data-days="90">۹۰ روز</button>'
      + '  <button type="button" class="pg-chip" data-days="180">۶ ماه</button>'
      + '  <button type="button" class="pg-chip" data-days="365">۱ سال</button>'
      + '  <button type="button" class="pg-chip" data-days="">نامحدود</button>'
      + '</div>'
      + '<div class="pg-hint">بدون محدودیت زمانی — پنل این مدیر همیشه فعال است</div>';
    dataItem.insertAdjacentElement('afterend', box);

    state.box = box;
    state.days = '';
    state.unit = 'day';
    state.touched = false;

    var daysInput = box.querySelector('[data-pg-days]');
    var unitSel = box.querySelector('[data-pg-unit]');

    daysInput.addEventListener('input', function () {
      state.days = this.value;
      state.touched = true;
      syncHint();
    });
    unitSel.addEventListener('change', function () {
      state.unit = this.value;
      state.touched = true;
      syncHint();
    });
    box.querySelector('.pg-chips').addEventListener('click', function (e) {
      var chip = e.target.closest('[data-days]');
      if (!chip) return;
      var value = chip.getAttribute('data-days');
      Array.prototype.forEach.call(box.querySelectorAll('.pg-chip'), function (c) { c.classList.remove('on'); });
      chip.classList.add('on');
      if (value === '90' && state.unit === 'day') { /* ۹۰ روز */ }
      if (value === '180') { unitSel.value = 'day'; state.unit = 'day'; value = '180'; }
      if (value === '365' && state.unit !== 'day') { unitSel.value = 'day'; state.unit = 'day'; }
      state.days = value;
      daysInput.value = value;
      state.touched = true;
      syncHint();
    });

    if (mode === 'edit') {
      var username = usernameOf(dialog);
      if (username) {
        panels(true).then(function (list) {
          var row = (list || []).filter(function (r) { return r && r.username === username; })[0];
          if (!row || !row.expire_at) { syncHint(); return; }
          var left = Math.max(0, (new Date(row.expire_at).getTime() - Date.now()) / 86400000);
          state.days = left ? String(Math.max(1, Math.round(left))) : '';
          daysInput.value = state.days;
          state.unit = 'day';
          unitSel.value = 'day';
          box.querySelector('.pg-hint').innerHTML = row.expire_at
            ? 'انقضای فعلی: <b>' + faDate(row.expire_at) + '</b>'
            : 'بدون محدودیت زمانی';
        });
      }
    }
    syncHint();
  }

  function enhanceDialogs() {
    var dialogs = document.querySelectorAll('[role="dialog"]');
    Array.prototype.forEach.call(dialogs, function (dialog) {
      if (!dialog.querySelector('input[name="username"]') || !dialog.querySelector('input[name="password"]')) return;
      var info = dialogMode(dialog);
      if (dialog.querySelector('.pg-expiry-box') && dialog.querySelector('.pg-pwd-tools')) return;
      enhancePassword(dialog, info.mode);
      enhanceExpiry(dialog, info.mode);
    });
  }

  /* --------------------------------------------- save the time limit on submit */
  function saveExpiryFor(payload, username) {
    return panels(true).then(function (list) {
      var row = (list || []).filter(function (r) { return r && r.username === username; })[0];
      if (!row) return null;
      var body;
      if (!payload.days) body = { clear: true };
      else {
        var factor = payload.unit === 'month' ? 30 : payload.unit === 'year' ? 365 : 1;
        body = { days: Number(payload.days) * factor };
      }
      return api(API_PANELS + '/' + row.admin_id + '/expiry', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      });
    });
  }

  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      var url = '';
      var method = 'GET';
      try {
        url = typeof input === 'string' ? input : (input && input.url) || '';
        method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      } catch (e) {}
      var promise = origFetch(input, init);
      var isCreate = method === 'POST' && /\/api\/admin\/?(\?|$)/.test(url);
      var isModify = (method === 'PUT' || method === 'PATCH') && /\/api\/admin\/(by-(id|username)\/)?[^/?]+/.test(url);
      if ((isCreate || isModify) && state.touched) {
        promise.then(function (res) {
          if (!res || !res.ok) return;
          res.clone().json().then(function (json) {
            var dialog = document.querySelector('[role="dialog"]');
            var username = (json && json.username) || (dialog ? usernameOf(dialog) : '');
            if (!username) return;
            var payload = { days: state.days, unit: state.unit };
            saveExpiryFor(payload, username).then(function (rows) {
              state.touched = false;
              var row = (rows || []).filter(function (r) { return r && r.username === username; })[0];
              toast(row && row.expire_at ? 'محدودیت زمانی ذخیره شد ✓' : 'بدون محدودیت زمانی ✓');
              CACHE = { at: 0, list: null };
            }).catch(function (err) {
              toast('ذخیرهٔ محدودیت زمانی ناموفق: ' + err.message);
            });
          }).catch(function () {});
        }).catch(function () {});
      }
      return promise;
    };
  }

  /* -------------------------------------------------- stale shell cleanup */
  (function cleanupStaleShell() {
    try {
      if (localStorage.getItem('pg-shell-v8')) return;
      localStorage.setItem('pg-shell-v8', String(Date.now()));
      var jobs = [];
      if (window.caches && caches.keys) {
        jobs.push(caches.keys().then(function (keys) {
          return Promise.all(keys.map(function (k) { return caches.delete(k); }));
        }).catch(function () {}));
      }
      if (navigator.serviceWorker && navigator.serviceWorker.getRegistrations) {
        jobs.push(navigator.serviceWorker.getRegistrations().then(function (regs) {
          return Promise.all(regs.map(function (r) { return r.unregister().catch(function () {}); }));
        }).catch(function () {}));
      }
      Promise.all(jobs).catch(function () {});
    } catch (e) {}
  })();

  /* ------------------------------------------------------------------ boot */
  var timer = null;
  function schedule() {
    clearTimeout(timer);
    timer = setTimeout(function () {
      ensureStyles();
      injectRowButtons();
      enhanceDialogs();
    }, 220);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', schedule);
  else schedule();
  window.addEventListener('hashchange', schedule);
  try {
    new MutationObserver(schedule).observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}
  setInterval(function () {
    ensureStyles();
    injectRowButtons();
    enhanceDialogs();
  }, 2500);
})();
