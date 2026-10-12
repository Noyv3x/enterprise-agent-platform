/*
 * Artifact page runtime helper (docs/frontend.md § Artifact pages).
 *
 * Plain browser JavaScript, no dependencies. Platform injects it as the first
 * script of every HTML page served from /artifact-view/ and /artifact-live/.
 * Those pages run in an opaque origin (CSP sandbox without allow-same-origin),
 * where localStorage, sessionStorage and document.cookie throw SecurityError.
 * This script therefore never touches the native accessors.
 *
 * Provides: in-memory Storage shim (seeded from the URL fragment, changes
 * posted to the parent), in-memory document.cookie, console/error capture in
 * window.__eapLog, and the annotate inspector driven by the parent window.
 *
 * Protocol (only window.parent is trusted):
 *   parent -> page  {type:'eap-inspect', on}
 *   page -> parent  {type:'eap-storage', data}
 *                   {type:'eap-pick', kind:'element'|'region', rect, path, scroll, viewport,
 *                    selector?, tag?, text?}
 *                   {type:'eap-inspect-exit'}
 */
(function () {
  'use strict';
  if (window.__eapRuntime) return;
  window.__eapRuntime = 1;

  var LOG_MAX = 50;
  var LOG_LEN = 500;
  var SEED_KEY = '__eap';
  var POST_DELAY = 400;
  var inFrame = window.parent !== window;

  function post(msg) {
    if (!inFrame) return;
    try { window.parent.postMessage(msg, '*'); } catch (e) { /* parent gone */ }
  }

  // ---- console and error capture ------------------------------------------
  var log = (window.__eapLog = []);
  function record(text) {
    if (log.length < LOG_MAX) log.push(String(text).slice(0, LOG_LEN));
  }
  function fmt(v) {
    if (v instanceof Error) return v.stack || v.name + ': ' + v.message;
    if (typeof v === 'string') return v;
    try {
      var s = JSON.stringify(v);
      if (s !== undefined) return s;
    } catch (e) { /* cyclic */ }
    try { return String(v); } catch (e) { return '[unprintable]'; }
  }
  ['error', 'warn'].forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      var parts = [];
      for (var i = 0; i < arguments.length && i < 8; i++) parts.push(fmt(arguments[i]));
      record('[' + level + '] ' + parts.join(' '));
      return typeof orig === 'function' ? orig.apply(this, arguments) : undefined;
    };
  });
  window.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t !== window && t.tagName) {
      record('[resource] <' + t.tagName.toLowerCase() + '> failed to load: ' + (t.currentSrc || t.src || t.href || ''));
    } else {
      record('[uncaught] ' + (e.message || fmt(e.error)) + (e.filename ? ' (' + e.filename + ':' + e.lineno + ')' : ''));
    }
  }, true);
  window.addEventListener('unhandledrejection', function (e) {
    record('[unhandledrejection] ' + fmt(e.reason));
  });

  // ---- storage shim --------------------------------------------------------
  var dirty = false;
  var timer = 0;
  var local;
  function flush() {
    clearTimeout(timer);
    timer = 0;
    if (!dirty || !local) return;
    dirty = false;
    var data = {};
    for (var i = 0, n = local.length; i < n; i++) {
      var k = local.key(i);
      data[k] = local.getItem(k);
    }
    post({ type: 'eap-storage', data: data });
  }
  function changed() {
    dirty = true;
    if (!timer) timer = setTimeout(flush, POST_DELAY);
  }

  function makeStorage(onChange) {
    var map = new Map();
    var api = {
      getItem: function (k) { k = String(k); return map.has(k) ? map.get(k) : null; },
      setItem: function (k, v) {
        k = String(k); v = String(v);
        if (map.get(k) === v) return;
        map.set(k, v);
        onChange();
      },
      removeItem: function (k) { if (map.delete(String(k))) onChange(); },
      clear: function () { if (map.size) { map.clear(); onChange(); } },
      key: function (i) { var a = Array.from(map.keys()); return i >= 0 && i < a.length ? a[i] : null; }
    };
    var proto = {};
    Object.keys(api).forEach(function (name) {
      Object.defineProperty(proto, name, { value: api[name], writable: true, configurable: true });
    });
    Object.defineProperty(proto, 'length', { get: function () { return map.size; }, configurable: true });
    Object.defineProperty(proto, Symbol.toStringTag, { value: 'Storage', configurable: true });
    return new Proxy(proto, {
      get: function (t, p, r) {
        if (typeof p === 'symbol' || p in t) return Reflect.get(t, p, r);
        return map.has(p) ? map.get(p) : undefined;
      },
      set: function (t, p, v) {
        if (typeof p === 'symbol') return Reflect.set(t, p, v);
        api.setItem(p, v);
        return true;
      },
      deleteProperty: function (t, p) {
        if (typeof p === 'symbol') return Reflect.deleteProperty(t, p);
        api.removeItem(p);
        return true;
      },
      has: function (t, p) { return typeof p === 'string' && map.has(p) || p in t; },
      ownKeys: function () { return Array.from(map.keys()); },
      getOwnPropertyDescriptor: function (t, p) {
        if (typeof p === 'string' && map.has(p)) {
          return { value: map.get(p), writable: true, enumerable: true, configurable: true };
        }
        return undefined;
      },
      defineProperty: function (t, p, d) {
        if (typeof p !== 'string' || !('value' in d)) return false;
        api.setItem(p, d.value);
        return true;
      }
    });
  }

  function install(name, value) {
    try {
      Object.defineProperty(window, name, { value: value, configurable: true });
    } catch (e) { /* leave whatever the browser provides */ }
  }
  local = makeStorage(changed);
  install('localStorage', local);
  install('sessionStorage', makeStorage(function () {}));

  // Seed localStorage from the URL fragment `#__eap=<base64url JSON>`, then
  // strip it so reloads and shared links do not carry it.
  (function seed() {
    var hash = location.hash.replace(/^#/, '');
    if (hash.indexOf(SEED_KEY + '=') < 0) return;
    var rest = [];
    hash.split('&').forEach(function (part) {
      if (part.indexOf(SEED_KEY + '=') !== 0) { rest.push(part); return; }
      try {
        var b64 = part.slice(SEED_KEY.length + 1).replace(/-/g, '+').replace(/_/g, '/');
        while (b64.length % 4) b64 += '=';
        var bin = atob(b64);
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        var data = JSON.parse(new TextDecoder().decode(bytes));
        Object.keys(data).forEach(function (k) {
          if (typeof data[k] === 'string') local[k] = data[k];
        });
      } catch (e) { /* malformed seed: start empty */ }
    });
    dirty = false;
    if (timer) { clearTimeout(timer); timer = 0; }
    try {
      history.replaceState(history.state, '', location.pathname + location.search + (rest.length ? '#' + rest.join('&') : ''));
    } catch (e) { /* cannot strip: harmless */ }
  })();
  window.addEventListener('pagehide', flush);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });

  // ---- in-memory cookie ----------------------------------------------------
  var cookies = new Map();
  try {
    Object.defineProperty(document, 'cookie', {
      configurable: true,
      get: function () {
        return Array.from(cookies, function (e) { return e[0] ? e[0] + '=' + e[1] : e[1]; }).join('; ');
      },
      set: function (v) {
        var parts = String(v).split(';');
        var kv = parts[0];
        var i = kv.indexOf('=');
        var name = (i < 0 ? '' : kv.slice(0, i)).trim();
        var val = (i < 0 ? kv : kv.slice(i + 1)).trim();
        var gone = false;
        parts.slice(1).forEach(function (a) {
          var j = a.indexOf('=');
          var key = (j < 0 ? a : a.slice(0, j)).trim().toLowerCase();
          var av = j < 0 ? '' : a.slice(j + 1).trim();
          if (key === 'max-age' && Number(av) <= 0) gone = true;
          if (key === 'expires' && Date.parse(av) <= Date.now()) gone = true;
        });
        if (gone) cookies.delete(name); else cookies.set(name, val);
      }
    });
  } catch (e) { /* keep native */ }

  // ---- inspector -----------------------------------------------------------
  function esc(s) {
    return String(s).replace(/[^\w-]/g, function (c) { return '\\' + c; }).replace(/^(-?)(\d)/, function (m, d, n) { return d + '\\3' + n + ' '; });
  }
  function attr(n, a) { return n.getAttribute(a) || ''; }
  function stableClasses(n) {
    return attr(n, 'class').split(/\s+/).filter(function (c) {
      return c && c.length <= 24 && !/\d{3,}|[0-9a-f]{6,}|^(css|sc|jsx|_)|^(is|has)-|^(active|hover|focus|selected|open|show|visible|disabled|current)$/i.test(c);
    }).slice(0, 2);
  }
  function qsa(sel) { try { return document.querySelectorAll(sel); } catch (e) { return []; } }
  function segment(n) {
    var tag = n.tagName.toLowerCase();
    var id = n.id;
    if (id && qsa('#' + esc(id)).length === 1) return '#' + esc(id);
    var s = tag + stableClasses(n).map(function (c) { return '.' + esc(c); }).join('');
    var p = n.parentElement;
    if (p) {
      var same = 0, idx = 0, mine = 0;
      for (var c = p.firstElementChild; c; c = c.nextElementSibling) {
        if (c.tagName === n.tagName) { idx++; if (c === n) mine = idx; }
        if (c.matches && c.matches(s)) same++;
      }
      if (same > 1) s += ':nth-of-type(' + mine + ')';
    }
    return s;
  }
  function selectorFor(el) {
    var parts = [];
    for (var n = el; n && n.nodeType === 1; n = n.parentElement) {
      var seg = segment(n);
      parts.unshift(seg);
      var sel = parts.join(' > ');
      var hit = qsa(sel);
      if (sel.length > 500) break;
      if (hit.length === 1 && hit[0] === el) return sel;
    }
    // Too deep for the 500-character limit: drop the outermost ancestors first
    // (the tail names the element), and cut as a last resort.
    while (parts.length > 1 && parts.join(' > ').length > 500) parts.shift();
    return parts.join(' > ').slice(0, 500);
  }
  function geometry() {
    return {
      scroll: { x: Math.round(window.scrollX), y: Math.round(window.scrollY) },
      viewport: { w: window.innerWidth, h: window.innerHeight }
    };
  }
  function pagePath() {
    var p = location.pathname.split('/').slice(3).join('/');
    try { p = decodeURIComponent(p); } catch (e) { /* keep encoded */ }
    return p.slice(0, 500);
  }
  function docRect(r) {
    return {
      x: Math.round(r.left + window.scrollX), y: Math.round(r.top + window.scrollY),
      w: Math.round(r.width), h: Math.round(r.height)
    };
  }

  var active = false;
  var box = null;
  var hover = null;
  var drag = null;
  var swallow = false;
  var BLOCK = ['click', 'dblclick', 'auxclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'contextmenu', 'submit', 'dragstart'];

  function place(l, t, w, h) {
    var s = box.style;
    s.left = l + 'px'; s.top = t + 'px'; s.width = w + 'px'; s.height = h + 'px'; s.display = 'block';
  }
  function outline(el) {
    hover = el;
    if (!el || el === document.documentElement) { box.style.display = 'none'; return; }
    var r = el.getBoundingClientRect();
    place(r.left, r.top, r.width, r.height);
  }
  function onMove(e) {
    if (drag) {
      drag.x2 = e.clientX; drag.y2 = e.clientY;
      place(Math.min(drag.x, e.clientX), Math.min(drag.y, e.clientY), Math.abs(e.clientX - drag.x), Math.abs(e.clientY - drag.y));
      box.style.borderStyle = 'dashed';
      return;
    }
    box.style.borderStyle = 'solid';
    outline(e.target);
  }
  function onDown(e) {
    if (e.type === 'mousedown' && e.shiftKey && e.button === 0) {
      drag = { x: e.clientX, y: e.clientY, x2: e.clientX, y2: e.clientY };
    }
  }
  function onUp(e) {
    if (e.type !== 'mouseup' || !drag) return;
    var d = drag;
    drag = null;
    swallow = true;
    setTimeout(function () { swallow = false; }, 0);
    var w = Math.abs(d.x2 - d.x), h = Math.abs(d.y2 - d.y);
    box.style.borderStyle = 'solid';
    if (w < 4 || h < 4) { outline(null); return; }
    var g = geometry();
    post({
      type: 'eap-pick', kind: 'region',
      rect: { x: Math.round(Math.min(d.x, d.x2) + window.scrollX), y: Math.round(Math.min(d.y, d.y2) + window.scrollY), w: Math.round(w), h: Math.round(h) },
      path: pagePath(), scroll: g.scroll, viewport: g.viewport
    });
  }
  function onClick(e) {
    if (swallow) { swallow = false; return; }
    var el = e.target;
    if (!el || el.nodeType !== 1) return;
    var g = geometry();
    post({
      type: 'eap-pick', kind: 'element',
      selector: selectorFor(el), tag: el.tagName.toLowerCase(),
      text: String(el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 300),
      rect: docRect(el.getBoundingClientRect()),
      path: pagePath(), scroll: g.scroll, viewport: g.viewport
    });
  }
  function onSuppress(e) {
    if (!active) return;
    // Cancelling pointerdown would suppress the compatibility mousedown/mouseup
    // events the region drag relies on, so pointer events are only stopped.
    if (e.type.indexOf('pointer') !== 0) e.preventDefault();
    e.stopImmediatePropagation();
    if (e.type === 'mousedown') onDown(e);
    else if (e.type === 'mouseup') onUp(e);
    else if (e.type === 'click') onClick(e);
  }
  function onKey(e) {
    if (!active) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopImmediatePropagation();
      setInspect(false);
      post({ type: 'eap-inspect-exit' });
    }
  }
  function onReflow() { if (active && hover && !drag) outline(hover); }

  function setInspect(on) {
    if (on === active) return;
    active = on;
    var fn = on ? 'addEventListener' : 'removeEventListener';
    BLOCK.forEach(function (t) { window[fn](t, onSuppress, true); });
    window[fn]('mousemove', onMove, true);
    window[fn]('keydown', onKey, true);
    window[fn]('scroll', onReflow, true);
    window[fn]('resize', onReflow, true);
    if (on) {
      if (!box) {
        box = document.createElement('div');
        box.setAttribute('data-eap-overlay', '');
        box.style.cssText = 'position:fixed;display:none;pointer-events:none;box-sizing:border-box;z-index:2147483647;border:2px solid #2563eb;background:rgba(37,99,235,.14);margin:0;padding:0';
      }
      (document.documentElement).appendChild(box);
      document.documentElement.style.cursor = 'crosshair';
    } else {
      if (box && box.parentNode) box.parentNode.removeChild(box);
      document.documentElement.style.cursor = '';
      hover = null; drag = null; swallow = false;
    }
  }

  window.addEventListener('message', function (e) {
    if (e.source !== window.parent || !inFrame) return;
    var d = e.data;
    if (d && d.type === 'eap-inspect') setInspect(!!d.on);
  });
})();
