/* CMS console - core: DOM helper, API, formatting, dialogs, live stream. Shared through window.C */
(function () {
  'use strict';
  const C = window.C = { views: {}, nav: [], S: { token: sessionStorage.getItem('cms_token'), me: null, view: 'dashboard', params: {}, zones: [], posts: [], counts: {}, drawer: null } };
  const S = C.S;

  // ---------- DOM ----------
  C.h = function h(tag, props, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(props || {})) {
      if (v == null || v === false) continue;
      if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'value') el.value = v;
      else if (k === 'selected' || k === 'checked' || k === 'disabled') el[k] = !!v;
      else el.setAttribute(k, v === true ? '' : v);
    }
    const add = (n) => { if (n == null || n === false) return; if (Array.isArray(n)) n.forEach(add); else el.append(n.nodeType ? n : document.createTextNode(String(n))); };
    kids.forEach(add);
    return el;
  };
  const h = C.h;

  // ---------- icons ----------
  const ICONS = {
    gauge: '<path d="M12 14l4-4"/><path d="M3.3 19a10 10 0 1 1 17.4 0"/>', list: '<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>', map: '<path d="M1 6v16l7-4 8 4 7-4V2l-7 4-8-4-7 4z"/><path d="M8 2v16M16 6v16"/>', users: '<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>', cog: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>', flask: '<path d="M9 3h6M10 3v6L4 19a2 2 0 0 0 1.7 3h12.6a2 2 0 0 0 1.7-3l-6-10V3"/>', activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>', clip: '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/>', db: '<ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M21 12c0 1.7-4 3-9 3s-9-1.3-9-3M3 5v14c0 1.7 4 3 9 3s9-1.3 9-3V5"/>',
    sun: '<circle cx="12" cy="12" r="5"/><path d="M12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4"/>',
    moon: '<path d="M21 12.8A9 9 0 1 1 11.2 3 7 7 0 0 0 21 12.8z"/>',
    bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.7 21a2 2 0 0 1-3.4 0"/>',
    alert: '<path d="M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/><path d="M12 9v4M12 17h.01"/>',
    zap: '<path d="M13 2 3 14h9l-1 8 10-12h-9l1-8z"/>',
    shield: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    eye: '<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8S1 12 1 12z"/><circle cx="12" cy="12" r="3"/>',
    film: '<rect x="2" y="2" width="20" height="20" rx="2.2"/><path d="M7 2v20M17 2v20M2 12h20M2 7h5M2 17h5M17 17h5M17 7h5"/>',
    play: '<path d="M6 4l14 8-14 8V4z"/>',
    flag: '<path d="M4 15s1-1 4-1 5 2 8 2 4-1 4-1V3s-1 1-4 1-5-2-8-2-4 1-4 1z"/><path d="M4 22v-7"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18M6 6l12 12"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    camera: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/>',
    pin: '<path d="M21 10c0 7-9 13-9 13S3 17 3 10a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
    train: '<rect x="4" y="3" width="16" height="16" rx="2"/><path d="M4 11h16M12 3v8M8 19l-2 3M16 19l2 3"/>',
    download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3"/>',
    upload: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M17 8l-5-5-5 5M12 3v12"/>',
    folder: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
    user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    lock: '<rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>',
    hard: '<rect x="2" y="12" width="20" height="8" rx="2"/><path d="M6 16h.01M10 16h.01M5.5 12 8 4h8l2.5 8"/>',
  };
  C.ic = (name, size = 16) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('class', 'ic');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.innerHTML = ICONS[name] || '';
    return s;
  };
  C.skeleton = (n = 3) => h('div', { class: 'skel-wrap' }, Array.from({ length: n }, () => h('div', { class: 'skel' })));
  C.themeButton = function () {
    const btn = h('button', { class: 'iconbtn', title: 'Dark / light mode', 'aria-label': 'Toggle dark mode' });
    const paint = () => btn.replaceChildren(C.ic(window.__theme.get() === 'dark' ? 'sun' : 'moon', 17));
    btn.addEventListener('click', () => { window.__theme.set(window.__theme.get() === 'dark' ? 'light' : 'dark'); paint(); });
    paint(); return btn;
  };

  // ---------- formatting ----------
  C.fmtTime = (iso) => (iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '-');
  C.fmtShort = (iso) => (iso ? new Date(iso).toLocaleString([], { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : '-');
  C.fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
  C.fmtSize = (n) => { n = Number(n || 0); return n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : n >= 1e3 ? `${Math.round(n / 1e3)} KB` : `${n} B`; };
  C.fmtDur = (sec) => { const s = Math.max(0, Math.round(sec || 0)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
  C.ago = (iso) => {
    if (!iso) return 'never';
    const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
    return s < 5 ? 'just now' : s < 60 ? `${Math.round(s)}s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
  };
  C.label = (s) => String(s == null ? '' : s).replace(/_/g, ' ');
  C.toLocalInput = (d) => { const p = (n) => String(n).padStart(2, '0'); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`; };
  C.qs = (o) => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o || {})) if (v !== '' && v != null) p.set(k, v); const s = p.toString(); return s ? `?${s}` : ''; };
  C.isAdmin = () => S.me && ['zone_admin', 'super_admin'].includes(S.me.role);
  C.isSuper = () => S.me && S.me.role === 'super_admin';
  C.badge = (text, cls) => h('span', { class: `badge ${cls || ''}` }, C.label(text));
  const CLS = {
    alert: { new: 'amber', routed: 'blue', escalated: 'red', acknowledged: 'green', resolved: 'green', dismissed: 'grey' },
    req: { submitted: 'amber', approved: 'indigo', amended: 'indigo', awaiting_upload: 'teal', fulfilled: 'green', rejected: 'red', cancelled: 'grey', failed: 'red', expired: 'grey' },
    inc: { open: 'red', under_review: 'amber', closed: 'grey' },
    arch: { pending: 'amber', archived: 'green', failed: 'red', purged: 'grey', not_requested: 'grey' },
    seg: { pending: 'amber', partial: 'blue', complete: 'green', failed: 'red' },
    cmd: { queued: 'amber', sent: 'blue', acked: 'indigo', done: 'green', failed: 'red', cancelled: 'grey' },
  };
  C.stBadge = (kind, st) => C.badge(st, CLS[kind][st]);
  C.prio = (p, thr) => h('span', { class: `prio ${p >= (thr || S.threshold || 7) ? 'hi' : ''}` }, `P${p}`);

  // ---------- API ----------
  C.api = async function api(path, opts = {}) {
    const res = await fetch(`/console/api${path}`, {
      method: opts.method || 'GET',
      headers: { ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}), ...(opts.body ? { 'Content-Type': 'application/json' } : {}) },
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (res.status === 401 && S.token && !path.startsWith('/auth/login')) { C.logout('Your session ended - please sign in again.'); throw new Error('session ended'); }
    const ct = res.headers.get('content-type') || '';
    const data = ct.includes('json') ? await res.json().catch(() => null) : null;
    if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
    return data;
  };

  // ---------- toasts, dialogs, drawer ----------
  C.toast = function toast(msg, cls) {
    const t = h('div', { class: `toast ${cls || ''}` }, msg);
    document.getElementById('toasts').append(t);
    setTimeout(() => t.remove(), cls === 'alert' ? 9000 : 4500);
  };
  C.dialog = function dialog({ title, sub, body, wide, onClose }) {
    const dlg = h('dialog', { class: wide ? 'wide' : '' }, h('div', { class: 'dlg' }, h('h2', {}, title), sub ? h('p', { class: 'muted' }, sub) : null, body));
    const close = () => { try { dlg.close(); } catch (_) { /* closed */ } dlg.remove(); if (onClose) onClose(); };
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    document.body.append(dlg); dlg.showModal();
    return { close, dlg };
  };
  /** fields: [{name,label,type,value,options:[{value,label}],hint,required}] ; submit(values) may throw to show an error. */
  C.formDialog = function formDialog({ title, sub, fields, submitLabel, submit, danger }) {
    const err = h('div', { class: 'err' });
    const inputs = {};
    const rows = fields.map((f) => {
      let el;
      if (f.type === 'textarea') el = h('textarea', { name: f.name, value: f.value || '' });
      else if (f.type === 'select') el = h('select', { name: f.name }, (f.options || []).map((o) => h('option', { value: o.value, selected: String(o.value) === String(f.value) }, o.label)));
      else if (f.type === 'checkbox') el = h('input', { type: 'checkbox', name: f.name, checked: !!f.value });
      else el = h('input', { name: f.name, type: f.type || 'text', value: f.value ?? '', step: f.step, min: f.min, max: f.max, autocomplete: 'off' });
      inputs[f.name] = el;
      return [h('label', {}, f.label), el, f.hint ? h('div', { class: 'hint' }, f.hint) : null];
    });
    const save = h('button', { class: `btn ${danger ? 'danger-solid' : 'primary'}`, type: 'submit' }, submitLabel || 'Save');
    const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    const form = h('form', {}, rows, err, h('div', { class: 'foot' }, cancel, save));
    const { close } = C.dialog({ title, sub, body: form });
    cancel.addEventListener('click', close);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = ''; save.disabled = true;
      const v = {}; for (const f of fields) v[f.name] = f.type === 'checkbox' ? inputs[f.name].checked : inputs[f.name].value;
      try { await submit(v); close(); } catch (ex) { err.textContent = ex.message; save.disabled = false; }
    });
    return { close };
  };
  C.confirm = (title, sub, label, fn, danger) => C.formDialog({ title, sub, fields: [], submitLabel: label, submit: fn, danger });

  C.openDrawer = function (id, render) { S.drawer = { id, render }; return C.reloadDrawer(); };
  C.closeDrawer = () => { S.drawer = null; const r = document.getElementById('drawer-root'); if (r) r.replaceChildren(); };
  C.reloadDrawer = async function () {
    if (!S.drawer) return;
    const d = S.drawer;
    try {
      const body = await d.render();
      if (S.drawer !== d) return;
      const keep = document.querySelector('.drawer'); const scroll = keep ? keep.scrollTop : 0;
      document.getElementById('drawer-root').replaceChildren(body);
      const now = document.querySelector('.drawer'); if (now) now.scrollTop = scroll;
    } catch (ex) { C.toast(ex.message); }
  };
  C.drawerShell = (title, ...sections) => h('aside', { class: 'drawer' }, h('header', {}, h('h2', {}, title), h('button', { class: 'btn sm', onclick: C.reloadDrawer }, 'Refresh'), h('button', { class: 'btn sm', onclick: C.closeDrawer }, 'Close')), sections);
  C.section = (title, ...kids) => h('section', {}, h('h3', {}, title), kids);
  C.kv = (pairs) => h('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]));
  C.actionBtn = (text, fn, cls) => h('button', { class: `btn ${cls || ''}`, onclick: async (e) => {
    const b = e.currentTarget; b.disabled = true;
    try { await fn(); } catch (ex) { C.toast(ex.message); } finally { b.disabled = false; }
  } }, text);

  C.table = (cols, rows, empty) => rows.length
    ? h('div', { class: 'card table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))), h('tbody', {}, rows)))
    : h('div', { class: 'card empty' }, empty || 'Nothing here.');
  C.head = (title, ...extra) => h('div', { class: 'toolbar' }, h('h2', {}, title), h('div', { class: 'spacer' }), extra);
  C.chips = (opts, current, onPick) => h('div', { class: 'chips' }, opts.map(([id, text, n]) => h('button', { class: `chip ${current === id ? 'active' : ''}`, onclick: () => onPick(id) }, text, n ? h('span', { class: 'pill' }, n) : null)));
  C.pager = (total, limit, offset, onPage) => total > limit ? h('div', { class: 'pager' },
    h('button', { class: 'btn sm', disabled: offset <= 0, onclick: () => onPage(Math.max(0, offset - limit)) }, 'Previous'),
    h('span', { class: 'muted' }, `${offset + 1}-${Math.min(total, offset + limit)} of ${total}`),
    h('button', { class: 'btn sm', disabled: offset + limit >= total, onclick: () => onPage(offset + limit) }, 'Next')) : null;
  // Filter + sort bar for the server-filtered lists. Choices live in S.params; changing one reloads the list.
  C.DATE_OPTS = [['', 'Any time'], ['today', 'Today'], ['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']];
  C.filterBar = function (items, sorts) {
    const reload = () => { S.params.offset = 0; C.refresh(); };
    let timer;
    const controls = items.map((f) => f.type === 'search'
      ? h('input', { class: 'fsearch', type: 'search', placeholder: f.placeholder, value: S.params[f.key] || '', 'data-fkey': f.key, 'aria-label': f.placeholder,
        oninput: (e) => { clearTimeout(timer); const v = e.target.value; timer = setTimeout(() => { S.params[f.key] = v.trim(); S.params._focus = f.key; reload(); }, 300); } })
      : h('label', { class: 'fsel' }, h('span', {}, f.label), h('select', { onchange: (e) => { S.params[f.key] = e.target.value; reload(); } },
        f.options.map(([v, t]) => h('option', { value: v, selected: String(v) === String(S.params[f.key] || '') }, t)))));
    const sortSel = sorts ? h('label', { class: 'fsel sort' }, h('span', {}, 'Sort'), h('select', { onchange: (e) => { S.params.sort = e.target.value; reload(); } }, sorts.map(([k, t]) => h('option', { value: k, selected: k === (S.params.sort || sorts[0][0]) }, t)))) : null;
    const active = items.some((f) => S.params[f.key]) || (sorts && S.params.sort && S.params.sort !== sorts[0][0]);
    const clear = active ? h('button', { class: 'btn sm', type: 'button', onclick: () => { items.forEach((f) => delete S.params[f.key]); delete S.params.sort; reload(); } }, C.ic('x', 13), 'Clear filters') : null;
    return h('div', { class: 'filterbar' }, controls, sortSel, clear);
  };
  C.zoneSelect = () => (C.isSuper() ? h('select', { onchange: (e) => { S.params.zone_id = e.target.value; C.refresh(); } }, h('option', { value: '' }, 'All zones'), S.zones.map((z) => h('option', { value: z.id, selected: String(z.id) === String(S.params.zone_id) }, z.name))) : null);
  C.mapLink = (lat, lon) => (lat == null ? '-' : h('a', { href: `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=15/${lat}/${lon}`, target: '_blank', rel: 'noopener noreferrer' }, `${Number(lat).toFixed(5)}, ${Number(lon).toFixed(5)}`));
  C.download = (url) => { const a = h('a', { href: url, download: '' }); document.body.append(a); a.click(); a.remove(); };

  // ---------- split view: list left, player right. The root node survives live refreshes, so a playing video is never reloaded. ----------
  const SPLIT = {};
  C.splitView = function (id, { head: headNode, list, emptyPane }) {
    const main = document.getElementById('main');
    let st = SPLIT[id];
    if (!st || main.firstElementChild !== st.root) {
      st = SPLIT[id] = { current: null, head: h('div'), list: h('div', { class: 'split-list' }), pane: h('div', { class: 'split-pane card' }, h('div', { class: 'empty' }, emptyPane)) };
      st.root = h('div', {}, st.head, h('div', { class: 'split' }, st.list, st.pane));
    }
    st.head.replaceChildren(headNode);
    st.list.replaceChildren(list(st));
    return st.root;
  };
  C.selectRow = (st, id) => { st.current = id; st.list.querySelectorAll('tr.click').forEach((tr) => tr.classList.toggle('sel', tr.dataset.id === String(id))); };
  C.videoEl = function (link, meta) {
    const problem = h('div', { class: 'note hidden' });
    const video = h('video', { controls: true, autoplay: true, src: link.url });
    video.addEventListener('error', () => {
      problem.textContent = video.error && video.error.code === 4 ? 'This browser cannot play this codec. Use Download and open the file in a media player.' : 'Playback failed - the link may have expired. Select the recording again.';
      problem.classList.remove('hidden'); video.classList.add('hidden');
    });
    return [h('div', { class: 'muted' }, meta), video, problem];
  };

  // ---------- video player dialog (footage / evidence) ----------
  C.playVideo = function (title, meta, link, extraButtons) {
    const problem = h('div', { class: 'note hidden' });
    const video = h('video', { controls: true, autoplay: true, src: link.url });
    video.addEventListener('error', () => {
      problem.textContent = video.error && video.error.code === 4 ? 'This browser cannot play this codec. Use Download and open the file in a media player.' : 'Playback failed - the link may have expired. Close and try again.';
      problem.classList.remove('hidden'); video.classList.add('hidden');
    });
    const foot = h('div', { class: 'foot' });
    const { close } = C.dialog({ title, wide: true, body: [h('div', { class: 'muted' }, meta), video, problem, foot], onClose: () => video.pause() });
    foot.append(extraButtons || null, h('button', { class: 'btn', onclick: close }, 'Close'));
  };

  // ---------- live stream (SSE) ----------
  const LIVE = { es: null, timer: null, debounce: null, stopped: true };
  C.liveDot = (on) => { const d = document.getElementById('live-dot'); if (!d) return; d.classList.toggle('on', on); d.lastChild.textContent = on ? 'Live' : 'Reconnecting'; };
  C.onLive = []; // listeners (evt) => void
  async function liveOpen() {
    if (LIVE.stopped || !S.token) return;
    let ticket;
    try { ticket = (await C.api('/stream-ticket', { method: 'POST', body: {} })).ticket; } catch (_) { C.liveDot(false); LIVE.timer = setTimeout(liveOpen, 2000); return; }
    if (LIVE.stopped) return;
    const es = new EventSource(`/console/api/stream?ticket=${encodeURIComponent(ticket)}`);
    LIVE.es = es;
    es.addEventListener('hello', () => C.liveDot(true));
    es.addEventListener('change', (e) => {
      let ev = {}; try { ev = JSON.parse(e.data); } catch (_) { return; }
      C.onLive.forEach((fn) => { try { fn(ev); } catch (_) { /* a bad listener must not stop the stream */ } });
      clearTimeout(LIVE.debounce);
      LIVE.debounce = setTimeout(() => { C.refreshCounts(); C.refresh({ live: true }); C.reloadDrawer(); }, 80);
    });
    es.onerror = () => { es.close(); if (LIVE.es === es) LIVE.es = null; C.liveDot(false); if (!LIVE.stopped) LIVE.timer = setTimeout(liveOpen, 1000); };
  }
  C.liveStart = () => { C.liveStop(); LIVE.stopped = false; liveOpen(); };
  C.liveStop = () => { LIVE.stopped = true; clearTimeout(LIVE.timer); clearTimeout(LIVE.debounce); if (LIVE.es) { LIVE.es.close(); LIVE.es = null; } };

  C.logout = function (message) {
    sessionStorage.removeItem('cms_token'); S.token = null; S.me = null; C.liveStop(); clearInterval(S.tick);
    C.renderLogin(message);
  };
})();
