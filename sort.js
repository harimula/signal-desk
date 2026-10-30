// Signal Desk table sorting — one engine for every page (index.html, retire.html, rentemi.html, the docs pages).
// Click (or tap, or Enter on) any table heading: numbers and dates sort largest / newest first, words A→Z; click again
// for the other way; a third click puts the table back in its own order. The choice is remembered on this device and
// applied again whenever the page redraws its numbers, and every table with the same headings follows it (all the
// "Closed trades by day" groups sort together). The Stocks board keeps its own sorter. Nothing to wire up per table.
(function () {
  'use strict';
  const KEY = 'sd-sort';
  let state = {};
  try { state = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { state = {}; }
  const save = () => { try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private window: this visit only */ } };

  // ---------- reading a cell ----------
  const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const MRX = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\\.?(?![a-z])';   // whole month words only: "Market 5" is not March 5
  const RX_MD = new RegExp('\\b' + MRX + '\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4}))?', 'i');   // Oct 29 · Oct 29, 2026
  const RX_DM = new RegExp('\\b(\\d{1,2})\\s+' + MRX + '(?:\\s+(\\d{4}))?(?![a-z])', 'i');            // 30 Oct · Fri 30 Oct
  const RX_ISO = /\b(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?/;
  const RX_TIME = /\b(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?/i;
  const EMPTY = /^(|[–—\-…·]+|n\/a|na|none|never|unknown)$/i;
  const clean = s => String(s || '').replace(/\s+/g, ' ').trim();
  const hm = (h, m, ap) => { h = +h; if (ap) { const p = /^p/i.test(ap); if (p && h < 12) h += 12; if (!p && h === 12) h = 0; } return h * 60 + +m; };
  function dateOf(s) {
    let m = RX_ISO.exec(s);
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3]) + (m[4] ? (+m[4] * 60 + +m[5]) * 60000 : 0);
    let mon, day, yr, rest;
    if ((m = RX_MD.exec(s))) { mon = MON[m[1].slice(0, 3).toLowerCase()]; day = +m[2]; yr = m[3]; rest = s.slice(m.index + m[0].length); }
    else if ((m = RX_DM.exec(s))) { day = +m[1]; mon = MON[m[2].slice(0, 3).toLowerCase()]; yr = m[3]; rest = s.slice(m.index + m[0].length); }
    else return null;
    if (!(day >= 1 && day <= 31)) return null;
    const now = new Date();
    let y = yr ? +yr : now.getFullYear();
    let t = Date.UTC(y, mon, day);
    if (!yr && t > Date.now() + 75 * 864e5) t = Date.UTC(--y, mon, day);   // "Dec 30" seen in January is last year's
    const tm = RX_TIME.exec(rest || ''); if (tm) t += hm(tm[1], tm[2], tm[3]) * 60000;
    return t;
  }
  const UNIT = { k: 1e3, m: 1e6, mn: 1e6, b: 1e9, bn: 1e9, l: 1e5, lac: 1e5, lakh: 1e5, lakhs: 1e5, cr: 1e7, crore: 1e7, crores: 1e7 };
  const DUR = { min: 1, mins: 1, minute: 1, minutes: 1, m: 1, h: 60, hr: 60, hrs: 60, hour: 60, hours: 60, d: 1440, day: 1440, days: 1440, session: 1440, sessions: 1440, w: 10080, wk: 10080, week: 10080, weeks: 10080 };
  function numOf(s) {
    let m = /^(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?(?![\d:])/i.exec(s);                                   // 10:15 AM · 09:50 ET
    if (m) return hm(m[1], m[2], m[3]);
    m = /^[(\s]*([+\-−–]?)\s*(?:[$₹€£]|rs\.?|us\$)?\s*([+\-−–]?)\s*(\d[\d,]*(?:\.\d+)?|\.\d+)\s*([a-z]+)?/i.exec(s);
    if (!m) return null;
    let v = parseFloat(m[3].replace(/,/g, ''));
    if (!isFinite(v)) return null;
    const u = (m[4] || '').toLowerCase();
    if (u && DUR[u] && !UNIT[u]) v *= DUR[u];                    // 45 min · 1.5 h · 3.0 days
    else if (u && UNIT[u]) v *= UNIT[u];                         // $12k · ₹1.20 cr · ₹45.3 lakh · $1.2M (a lone "m" is millions)
    if (/[\-−–]/.test(m[1] + m[2])) v = -v;
    return v;
  }
  // a column is dates when most cells read as dates, numbers when most read as numbers, words otherwise
  function kindOf(texts) {
    let n = 0, d = 0, x = 0;
    for (const t of texts) { if (EMPTY.test(t)) continue; n++; if (dateOf(t) != null) d++; else if (numOf(t) != null) x++; }
    if (!n) return 'text';
    if (d / n >= 0.6) return 'date';
    if ((x + d) / n >= 0.6 && x >= d) return 'num';
    return 'text';
  }
  const valOf = (kind, t) => EMPTY.test(t) ? null : kind === 'date' ? dateOf(t) : kind === 'num' ? (dateOf(t) == null ? numOf(t) : null) : t;
  const COLL = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

  // ---------- which tables, which rows ----------
  const skip = t => t.id === 'tb' || t.hasAttribute('data-nosort') || !!t.querySelector('[rowspan]:not([rowspan="1"])');
  function headRow(t) {
    if (t.tHead && t.tHead.rows.length) return t.tHead.rows[t.tHead.rows.length - 1];
    const r = t.rows[0];
    return r && r.cells.length > 1 && [...r.cells].every(c => c.tagName === 'TH') ? r : null;
  }
  const label = th => clean(th.textContent);
  const sigOf = (t, hr) => (location.pathname.split('/').pop() || 'index.html') + '#' + [...hr.cells].map(label).join('|');
  const width = hr => [...hr.cells].reduce((a, c) => a + (c.colSpan || 1), 0);
  function bodies(t, hr) {                                                              // [[tbody, rows that move]]
    const out = [];
    for (const b of t.tBodies) out.push([b, [...b.rows].filter(r => r !== hr && r.parentNode === b)]);
    return out;
  }
  const pinned = (r, w) => (r.cells.length === 1 && (r.cells[0].colSpan || 1) >= w) || /\b(tot|total|net|sum|foot)\b/.test(r.className || '');
  function cellAt(r, col) { let x = 0; for (const c of r.cells) { const s = c.colSpan || 1; if (col < x + s) return c; x += s; } return null; }
  const colStart = (hr, th) => { let x = 0; for (const c of hr.cells) { if (c === th) return x; x += c.colSpan || 1; } return -1; };

  // ---------- sorting ----------
  function setHeads(t, hr, spec) {
    for (const th of hr.cells) {
      if (!label(th)) continue;
      const on = spec && colStart(hr, th) === spec.c;
      if (!th.hasAttribute('data-sdsort')) th.setAttribute('data-sdsort', '');
      if (!th.hasAttribute('tabindex')) th.setAttribute('tabindex', '0');
      const as = on ? (spec.d < 0 ? 'descending' : 'ascending') : 'none';
      if (th.getAttribute('aria-sort') !== as) th.setAttribute('aria-sort', as);
      if (on) { const dd = spec.d < 0 ? ' ▼' : ' ▲'; if (th.getAttribute('data-sddir') !== dd) th.setAttribute('data-sddir', dd); }
      else if (th.hasAttribute('data-sddir')) th.removeAttribute('data-sddir');
    }
  }
  function stamp(t, hr) {                                                                // the order the page drew: kept on each row
    for (const [, rows] of bodies(t, hr)) rows.forEach((r, i) => { r._sdOrd = i; });
  }
  function restore(t, hr) {
    for (const [b, rows] of bodies(t, hr)) {
      if (!rows.every(r => r._sdOrd != null)) continue;
      const want = [...rows].sort((a, z) => a._sdOrd - z._sdOrd);
      if (want.some((r, i) => r !== rows[i])) for (const r of want) b.appendChild(r);
    }
    t._sdOn = null;
  }
  // spec: { c: first column, h: its heading, d: −1 largest first / +1 smallest first }
  function apply(t, hr, spec) {
    const w = width(hr);
    for (const [b, rows] of bodies(t, hr)) {
      if (!rows.every(r => r._sdOrd != null)) rows.forEach((r, i) => { r._sdOrd = i; });
      const moving = rows.filter(r => !pinned(r, w)), pin = rows.filter(r => pinned(r, w));
      const texts = moving.map(r => { const c = cellAt(r, spec.c); return c ? clean(c.textContent) : ''; });
      const kind = kindOf(texts);
      const keyed = moving.map((r, i) => ({ r, v: valOf(kind, texts[i]) }));
      keyed.sort((a, z) => {
        if (a.v == null || z.v == null) return a.v == null && z.v == null ? a.r._sdOrd - z.r._sdOrd : a.v == null ? 1 : -1;   // blanks last either way
        const c = kind === 'text' ? COLL.compare(a.v, z.v) : a.v - z.v;
        return c ? c * spec.d : a.r._sdOrd - z.r._sdOrd;
      });
      const want = keyed.map(k => k.r).concat(pin.sort((a, z) => a._sdOrd - z._sdOrd));
      if (want.some((r, i) => r !== rows[i])) for (const r of want) b.appendChild(r);
    }
    t._sdOn = spec.c + ':' + spec.d;
  }
  // the saved choice for this table, if its heading still sits where it was (or has moved)
  function specFor(sig, hr) {
    const s = state[sig]; if (!s) return null;
    const ths = [...hr.cells];
    let th = ths.find(c => colStart(hr, c) === s.c && label(c) === s.h) || ths.find(c => label(c) === s.h);
    return th ? { c: colStart(hr, th), h: s.h, d: s.d } : null;
  }
  // one table: headings marked, and the saved order applied when the rows are new or changed under it
  function touch(t, force) {
    if (!t || t.tagName !== 'TABLE' || skip(t)) return;
    const hr = headRow(t); if (!hr) return;
    const sig = sigOf(t, hr), spec = specFor(sig, hr);
    setHeads(t, hr, spec);
    if (!spec) { if (t._sdOn) restore(t, hr); return; }
    const fresh = bodies(t, hr).some(([, rows]) => rows.some(r => r._sdOrd == null));
    if (force || fresh || t._sdOn !== spec.c + ':' + spec.d) apply(t, hr, spec);
  }
  const all = root => { if (!root) return; if (root.tagName === 'TABLE') touch(root); else if (root.querySelectorAll) root.querySelectorAll('table').forEach(t => touch(t)); };

  // ---------- clicks and keys ----------
  function choose(th) {
    const t = th.closest('table'); if (!t || skip(t)) return;
    const hr = headRow(t); if (!hr || th.parentNode !== hr || !label(th)) return;
    const sig = sigOf(t, hr), c = colStart(hr, th), cur = specFor(sig, hr);
    if (!t._sdOn) stamp(t, hr);                                                         // the page's own order, before the first sort
    // the first click goes the natural way for the column: newest / largest first for dates and numbers, A→Z for words
    const texts = []; for (const [, rows] of bodies(t, hr)) for (const r of rows) { const x = cellAt(r, c); if (x) texts.push(clean(x.textContent)); }
    const first = kindOf(texts) === 'text' ? 1 : -1;
    if (cur && cur.c === c) { if (cur.d === first) state[sig] = { c, h: label(th), d: -first }; else delete state[sig]; }
    else state[sig] = { c, h: label(th), d: first };
    save();
    document.querySelectorAll('table').forEach(x => { if (x === t || (!skip(x) && headRow(x) && sigOf(x, headRow(x)) === sig)) { const h2 = headRow(x); if (!x._sdOn) stamp(x, h2); if (state[sig]) apply(x, h2, specFor(sig, h2)); else restore(x, h2); setHeads(x, h2, specFor(sig, h2)); } });
  }
  const IGNORE = 'a, button, input, select, textarea, label, [data-drill], [role="button"]';
  document.addEventListener('click', e => {
    const th = e.target && e.target.closest && e.target.closest('th[data-sdsort]'); if (!th) return;
    const own = e.target.closest(IGNORE); if (own && th.contains(own)) return;
    choose(th);
  });
  document.addEventListener('keydown', e => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const th = e.target && e.target.matches && e.target.matches('th[data-sdsort]') ? e.target : null; if (!th) return;
    e.preventDefault(); choose(th);
  });

  // ---------- redraws ----------
  // Pages that rebuild a table (innerHTML) get it sorted again before it is painted (MutationObserver runs before paint).
  // index.html also patches tables in place (morphSet): it calls before() so the patch lines up with the page's own order,
  // and after() to sort the patched rows again.
  function before(el) { if (!el || !el.querySelectorAll) return; el.querySelectorAll('table').forEach(t => { if (t._sdOn && !skip(t)) { const hr = headRow(t); if (hr) restore(t, hr); } }); }
  function after(el) {
    if (!el || !el.querySelectorAll) return;
    el.querySelectorAll('table').forEach(t => { if (skip(t)) return; const hr = headRow(t); if (!hr) return; stamp(t, hr); t._sdOn = null; touch(t, true); });
  }
  const css = document.createElement('style');
  css.textContent = 'th[data-sdsort]{cursor:pointer;-webkit-user-select:none;user-select:none}th[data-sdsort]:hover{color:var(--text,inherit);background-image:linear-gradient(rgba(127,127,127,.08),rgba(127,127,127,.08))}th[data-sdsort][aria-sort="ascending"],th[data-sdsort][aria-sort="descending"]{color:var(--text,inherit)}th[data-sddir]::after{content:attr(data-sddir);font-size:.8em;opacity:.85}th[data-sdsort]:focus-visible{outline:2px solid var(--accent,#2563eb);outline-offset:-2px}';
  function start() {
    document.head.appendChild(css);
    all(document.body);
    new MutationObserver(list => {
      const seen = new Set();
      for (const m of list) {
        const t = m.target && m.target.closest ? m.target.closest('table') : null;
        if (t) seen.add(t);
        for (const n of m.addedNodes) if (n.nodeType === 1) { if (n.tagName === 'TABLE') seen.add(n); else if (n.querySelectorAll) n.querySelectorAll('table').forEach(x => seen.add(x)); }
      }
      seen.forEach(t => touch(t));
    }).observe(document.body, { childList: true, subtree: true });
  }
  if (document.body) start(); else document.addEventListener('DOMContentLoaded', start);
  window.SD_SORT = { before, after, dateOf, numOf, kindOf, state: () => state };
})();
