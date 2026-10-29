/* RPF Dashboard - single-page client. No frameworks, no CDN, no innerHTML with data. */
(() => {
  'use strict';

  // ---------- tiny DOM helper ------------------------------------------------
  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k === 'style') el.style.cssText = v;   // CSSOM: allowed by the CSP (style="..." attributes and injected <style> tags are not)
      else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
    const add = (kid) => {
      if (kid == null || kid === false) return;
      if (Array.isArray(kid)) kid.forEach(add);
      else el.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    };
    kids.forEach(add);
    return el;
  }

  // ---------- state ----------------------------------------------------------
  const S = {
    token: sessionStorage.getItem('rpf_token'),
    me: null, cfg: null, cameras: [],
    view: 'alerts', alertState: 'unacked', incState: 'active', auditFilter: '',
    seen: null, pollTimer: null, drawer: null, f: {},   // f: filter + sort choices per list, kept while you move between tabs
  };
  const myPost = () => S.me && S.me.post_id;

  // ---------- api ------------------------------------------------------------
  async function api(path, { method = 'GET', body } = {}) {
    const res = await fetch(path, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    let data = null;
    try { data = await res.json(); } catch (_) { /* empty body */ }
    if (res.status === 401 && S.token && !path.startsWith('/api/auth/login') && !path.startsWith('/api/setup')) { logout(); throw new Error('session expired - please sign in again'); }
    if (!res.ok) throw new Error((data && data.error) || `request failed (${res.status})`);
    return data;
  }
  const qs = (o) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(o)) if (v !== '' && v != null) p.set(k, v);
    const s = p.toString();
    return s ? `?${s}` : '';
  };

  // ---------- formatting -----------------------------------------------------
  const fmtTime = (iso) => (iso ? new Date(iso).toLocaleString([], { dateStyle: 'medium', timeStyle: 'medium' }) : '-');
  const fmtShort = (iso) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  const fmtSize = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
  const fmtAge = (iso) => {
    const m = Math.max(0, Math.round((Date.now() - new Date(iso)) / 60000));
    return m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h ${m % 60} min` : `${Math.floor(m / 1440)} d`;
  };
  const toLocalInput = (d) => {
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
  };
  // ---------- icons (inline SVG, no external files) -------------------------
  const ICONS = {
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
  const ic = (name, size = 16) => {
    const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('width', size); s.setAttribute('height', size); s.setAttribute('class', 'ic');
    s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor'); s.setAttribute('stroke-width', '2'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round');
    s.innerHTML = ICONS[name] || '';
    return s;
  };
  const TYPE_ICON = { intrusion: 'shield', panic_button: 'zap', tamper: 'lock', loitering: 'eye', unattended_bag: 'folder', camera_blocked: 'camera', smoke: 'alert', crowding: 'user' };
  const typeIcon = (t) => ic(TYPE_ICON[t] || 'alert', 18);
  const btnI = (icon, text, props) => h('button', props, ic(icon, 15), text);
  const skeleton = (n = 3) => h('div', { class: 'skel-wrap' }, Array.from({ length: n }, () => h('div', { class: 'skel' })));
  // "3 min ago" labels stay fresh without reloading the page
  const agoEl = (iso) => h('span', { class: 'ago', 'data-ago': iso }, ago(iso));
  setInterval(() => document.querySelectorAll('[data-ago]').forEach((el) => { el.textContent = ago(el.dataset.ago); }), 15000);

  const label = (s) => String(s || '').replace(/_/g, ' ');
  const badge = (text, cls) => h('span', { class: `badge ${cls || ''}` }, label(text));
  const REQ_CLS = { submitted: 'blue', approved: 'indigo', amended: 'amber', awaiting_upload: 'teal', fulfilled: 'green', rejected: 'red', cancelled: 'grey', failed: 'red', expired: 'grey' };
  const REQ_TEXT = { submitted: 'awaiting CMS approval', approved: 'approved', amended: 'approved (window amended)', awaiting_upload: 'waiting for train', fulfilled: 'footage ready', rejected: 'rejected', cancelled: 'cancelled', failed: 'failed', expired: 'expired' };
  const reqBadge = (st) => h('span', { class: `badge ${REQ_CLS[st] || ''}` }, REQ_TEXT[st] || label(st));
  const OPEN_REQ = ['submitted', 'approved', 'amended', 'awaiting_upload'];
  const INC_CLS = { open: 'red', under_review: 'amber', closed: 'grey' };
  const SRC_TEXT = { auto: 'auto (CMS)', operator: 'CMS operator', officer: 'from alert', manual: 'manual' };
  const ARCH_CLS = { pending: 'amber', archived: 'green', failed: 'red', purged: 'grey', not_requested: 'grey' };
  const ARCH_TEXT = { pending: 'CMS archiving...', archived: 'on CMS', failed: 'CMS archive failed', purged: 'expired', not_requested: 'not on CMS' };
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleDateString([], { day: '2-digit', month: 'short', year: 'numeric' }) : '-');
  const ago = (iso) => { const sec = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000); return sec < 5 ? 'just now' : sec < 60 ? `${Math.round(sec)}s ago` : sec < 3600 ? `${Math.round(sec / 60)} min ago` : sec < 86400 ? `${Math.round(sec / 3600)} h ago` : `${Math.round(sec / 86400)} d ago`; };
  const fmtDur = (sec) => { const s = Math.max(0, Math.round(sec || 0)); const m = Math.floor(s / 60); return `${m}:${String(s % 60).padStart(2, '0')}`; };
  const parseDur = (txt) => {
    const t = String(txt).trim(); if (!t) return NaN;
    if (/^\d+(\.\d+)?$/.test(t)) return Number(t);
    const m = t.match(/^(\d+):(\d{1,2})(\.\d+)?$/); return m ? Number(m[1]) * 60 + Number(m[2]) + Number(m[3] || 0) : NaN;
  };
  const mapLink = (a) => h('a', { href: `https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lon}#map=15/${a.lat}/${a.lon}`, target: '_blank', rel: 'noopener noreferrer' }, `${a.lat.toFixed(5)}, ${a.lon.toFixed(5)}`);

  // ---------- toasts / dialogs -----------------------------------------------
  // Mild pop-up notifications (bottom right): alert, incident, footage request, request served, ok, error. Click opens the
  // item, hover keeps it, a soft chime plays (switch it off with the Sound button in the top bar).
  // kind -> [icon, default title]
  const TOAST_KIND = { alert: ['alert', 'Alert'], incident: ['folder', 'Incident'], request: ['upload', 'Footage request'], served: ['film', 'Footage delivered'], ok: ['check', ''], err: ['x', ''], info: ['bell', ''] };
  const soundOn = () => { try { return localStorage.getItem('rpf_sound') !== 'off'; } catch (_) { return true; } };
  let audioCtx = null; let lastChime = 0;
  function chime(kind) {
    if (!soundOn() || Date.now() - lastChime < 1500) return;
    lastChime = Date.now();
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const notes = kind === 'alert' ? [523, 440] : kind === 'served' ? [523, 659, 784] : [660];
      notes.forEach((f, i) => {
        const o = audioCtx.createOscillator(); const g = audioCtx.createGain(); const t0 = audioCtx.currentTime + i * 0.14;
        o.type = 'sine'; o.frequency.value = f; g.gain.setValueAtTime(0.0001, t0);
        g.gain.exponentialRampToValueAtTime(0.05, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.22);
        o.connect(g); g.connect(audioCtx.destination); o.start(t0); o.stop(t0 + 0.25);
      });
    } catch (_) { /* browsers block sound until the first click - harmless */ }
  }
  // All styles live in styles.css: the page's Content-Security-Policy (style-src 'self') blocks <style> tags added by script.
  function toastStyle() { /* kept so older call sites keep working */ }
  /** Two-way tab bar with counters: tabs = [[id, text, count, colour]] */
  function subTabs(tabs, current, onPick) {
    toastStyle();
    return h('div', { class: 'subtabs', role: 'tablist' }, tabs.map(([id, text, n, cls]) =>
      h('button', { class: `subtab ${current === id ? 'on' : ''}`, role: 'tab', 'aria-selected': String(current === id), onclick: () => onPick(id) },
        text, h('span', { class: `pill ${cls || ''} ${Number(n) ? '' : 'zero'}` }, String(Number(n) || 0)))));
  }
  /** toast(message, kind, { title, onClick }) - kind: alert | incident | request | served | ok | err | info (old callers pass 'alert' / 'err' / nothing) */
  function toast(msg, cls, opts) {
    toastStyle();
    const kind = TOAST_KIND[cls] ? cls : 'ok';          // plain "Saved" / "Acknowledged" messages are confirmations
    const o = opts || {};
    let box = document.querySelector('.ntoasts');
    if (!box) { box = h('div', { class: 'ntoasts' }); document.body.append(box); }
    const text = String(msg);
    if ([...box.children].some((c) => c.dataset.msg === text)) return;            // the same notice twice in a row is shown once
    while (box.children.length >= 4) box.firstChild.remove();
    const title = o.title !== undefined ? o.title : TOAST_KIND[kind][1];
    const dur = kind === 'err' ? 9000 : 7500;
    const close = () => { t.classList.remove('in'); setTimeout(() => t.remove(), 300); };
    const np = h('div', { class: 'np' });
    const t = h('div', { class: `ntoast ${kind} ${o.onClick ? 'click' : ''}`, 'data-msg': text, style: `--dur:${dur}ms`, role: 'status' },
      h('div', { class: 'ni' }, ic(TOAST_KIND[kind][0], 21)),
      h('div', { class: 'nbox' },
        h('div', { class: 'nt' }, title || text), title ? h('div', { class: 'nb' }, text) : null,
        h('div', { class: 'nm' }, o.onClick ? h('b', {}, 'Click to open') : null, h('span', {}, new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })))),
      h('button', { class: 'nx', title: 'Dismiss', onclick: (e) => { e.stopPropagation(); close(); } }, '\u00d7'), np);
    if (o.onClick) t.addEventListener('click', () => { close(); o.onClick(); });
    box.append(t);
    requestAnimationFrame(() => t.classList.add('in'));
    let timer = setTimeout(close, dur);
    t.addEventListener('mouseenter', () => clearTimeout(timer));
    t.addEventListener('mouseleave', () => { np.style.animation = 'ntp 2.5s linear forwards'; timer = setTimeout(close, 2500); });
    if (kind !== 'ok' && kind !== 'info') chime(kind);
  }

  function dialog({ title, sub, body, wide, onClose }) {
    const dlg = h('dialog', { class: wide ? 'wide' : '' });
    const close = () => { dlg.close(); dlg.remove(); if (onClose) onClose(); };
    dlg.append(h('div', { class: 'dlg' }, h('h2', {}, title), sub ? h('div', { class: 'muted' }, sub) : null, body));
    dlg.addEventListener('cancel', (e) => { e.preventDefault(); close(); });
    document.body.append(dlg);
    dlg.showModal();
    return { dlg, close };
  }

  /** Form dialog: fields = [{name,label,type,value,required,options,min}], submit(values) -> promise. */
  // Account: change my password.
  function accountDialog() {
    formDialog({
      title: `Account - ${S.me.username}`, sub: 'Change your password.',
      fields: [
        { name: 'current_password', label: 'Current password', type: 'password' },
        { name: 'new_password', label: 'New password (at least 8 characters)', type: 'password' },
      ],
      submitLabel: 'Change password',
      submit: async (v) => {
        if (!v.current_password || !v.new_password) throw new Error('enter your current and your new password');
        await api('/api/auth/password', { method: 'POST', body: { current_password: v.current_password, new_password: v.new_password } });
        toast('Password changed');
      },
    });
  }

  function formDialog({ title, sub, fields, submitLabel, submit }) {
    const err = h('div', { class: 'err' });
    const inputs = {};
    const body = h('form', {});
    for (const f of fields) {
      let input;
      if (f.type === 'select') {
        input = h('select', { name: f.name }, f.options.map((o) => h('option', { value: o.value, selected: String(o.value) === String(f.value) }, o.label)));
      } else if (f.type === 'textarea') {
        input = h('textarea', { name: f.name, maxlength: 2000 }, f.value || '');
      } else {
        input = h('input', { name: f.name, type: f.type || 'text', value: f.value || '' });
      }
      inputs[f.name] = input;
      body.append(h('label', {}, f.label), input);
    }
    const saveBtn = h('button', { class: 'btn primary', type: 'submit' }, submitLabel || 'Save');
    const cancelBtn = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    body.append(err, h('div', { class: 'foot' }, cancelBtn, saveBtn));
    const { close } = dialog({ title, sub, body });
    cancelBtn.addEventListener('click', close);
    body.addEventListener('submit', async (e) => {
      e.preventDefault();
      err.textContent = '';
      saveBtn.disabled = true;
      try {
        const values = {};
        for (const f of fields) values[f.name] = inputs[f.name].value;
        await submit(values);
        close();
      } catch (ex) {
        err.textContent = ex.message;
        saveBtn.disabled = false;
      }
    });
    return close;
  }

  // ---------- login / shell --------------------------------------------------
  function logout(tab) {
    sessionStorage.removeItem('rpf_token');
    S.token = null; S.me = null; S.watch = null;
    clearInterval(S.pollTimer); liveStop();
    document.title = 'RPF Dashboard';
    renderLogin(undefined, typeof tab === 'string' ? tab : undefined);
  }
  function registerAnotherPost() {
    if (!confirm('Sign out and register a new Thana / Post?\n\nOfficers of every post sign in on this same dashboard; each sees only their own post.')) return;
    logout('register');
  }
  function toggleSound() {
    try { localStorage.setItem('rpf_sound', soundOn() ? 'off' : 'on'); } catch (_) { /* private mode */ }
    const b = document.getElementById('sound-btn'); if (b) b.textContent = soundOn() ? 'Sound: on' : 'Sound: off';
    if (soundOn()) chime('request');
  }

  // The first screen: Sign in / Register. Both are offered (registering a new
  // post, or signing in as an officer of an existing one). Both stay available every time, also once a post is bound.
  async function renderLogin(message, tab) {
    let setup = null;
    try { setup = await api('/api/setup'); } catch (_) { /* server unreachable: plain sign-in with the error */ }
    renderAuth(setup, tab || (setup && !setup.registered && !setup.officers ? 'register' : 'signin'), message);
  }

  const normUser = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, '.');

  function renderAuth(setup, tab, message) {
    const unbound = !!setup && !setup.registered;
    const err = h('div', { class: 'err' }, message || '');
    const head = h('div', {},
      h('h1', {}, 'RPF Dashboard'),
      h('p', {}, 'Railway Protection Force - Thana / Post'));
    // Sign in and Register post are offered every time the login screen is shown (also when this dashboard already serves a post).
    const choices = setup ? [['signin', 'Sign in'], ['register', 'Register post']] : [];
    const tabs = choices.length ? h('div', { class: 'authtabs' },
      ...choices.map(([k, label]) => h('button', { type: 'button', class: k === tab ? 'on' : '', onclick: () => renderAuth(setup, k) }, label))) : null;
    const form = tab === 'register' && setup ? registerForm(setup, err)
      : signinForm(unbound, err, setup);
    document.getElementById('app').replaceChildren(h('div', { class: 'login-wrap' }, h('div', { class: `login ${tab === 'register' && setup ? 'register' : ''}` }, head, tabs, form)));
  }

  const afterAuth = async (res) => {
    S.token = res.token; sessionStorage.setItem('rpf_token', res.token);
    await start();
  };

  function signinForm(unbound, err, setup) {
    const user = h('input', { name: 'username', autocomplete: 'username', required: true, autofocus: true, placeholder: 'e.g. anshika.sharma' });
    const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
    const form = h('form', {},
      h('label', {}, 'Username'), user, h('label', {}, 'Password'), pass,
      err, h('div', { class: 'foot' }, btn));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = ''; btn.disabled = true;
      try {
        const res = await api('/api/auth/login', { method: 'POST', body: { username: user.value, password: pass.value } });
        await afterAuth(res);
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    return form;
  }

  function registerForm(setup, err) {
    const name = h('input', { name: 'post_name', required: true, placeholder: 'e.g. RPF Post Saharanpur', maxlength: 80 });
    const zone = h('select', { name: 'zone_id', required: true }, h('option', { value: '' }, setup.zones.length ? 'Select the zone' : 'No zones in CMS yet'),
      setup.zones.map((z) => h('option', { value: z.id }, z.name)));
    const lat = h('input', { name: 'latitude', type: 'number', step: 'any', min: -90, max: 90, required: true, placeholder: 'e.g. 29.9680' });
    const lon = h('input', { name: 'longitude', type: 'number', step: 'any', min: -180, max: 180, required: true, placeholder: 'e.g. 77.5460' });
    const here = h('button', { class: 'btn sm', type: 'button', onclick: () => {
      if (!navigator.geolocation) { err.textContent = 'this browser cannot give its location - enter it by hand'; return; }
      navigator.geolocation.getCurrentPosition((p) => { lat.value = p.coords.latitude.toFixed(6); lon.value = p.coords.longitude.toFixed(6); err.textContent = ''; },
        () => { err.textContent = 'location not available here - enter latitude and longitude by hand'; });
    } }, 'Use my current location');
    const user = h('input', { name: 'username', autocomplete: 'username', required: true, placeholder: 'e.g. anshika.sharma' });
    user.addEventListener('blur', () => { user.value = normUser(user.value); }); // "Anshika Sharma" -> anshika.sharma
    const pass = h('input', { name: 'password', type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
    const pass2 = h('input', { name: 'password2', type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
    const authU = setup.registered ? h('input', { name: 'authorizer_username', autocomplete: 'off', required: true, placeholder: 'username' }) : null;
    const authP = setup.registered ? h('input', { name: 'authorizer_password', type: 'password', autocomplete: 'off', required: true }) : null;
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Register this post');
    const form = h('form', {},
      h('p', { class: 'hint' }, setup.registered
        ? 'Registers a new RPF Thana / Post on this dashboard. CMS will then send that post its own alerts and footage, and its officers see only that. Confirm with a current officer below.'
        : 'Enter the details of your RPF Thana / Post; CMS then sends this post its alerts and footage.'),
      h('label', {}, 'Thana / Post name'), name,
      h('label', {}, 'Zone'), zone,
      h('label', {}, 'Post location (used to route alerts to the nearest post)'), h('div', { class: 'row2' }, lat, lon), here,
      h('label', {}, 'Username (your sign-in name: letters, digits, dot, dash)'), user,
      h('label', {}, 'Password (at least 8 characters)'), pass, h('label', {}, 'Repeat password'), pass2,
      setup.registered ? h('p', { class: 'hint' }, 'Confirmation - username and password of any current RPF officer:') : null,
      authU ? h('label', {}, 'Current officer username') : null, authU,
      authP ? h('label', {}, 'Current officer password') : null, authP,
      err, h('div', { class: 'foot' }, btn));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = '';
      if (pass.value !== pass2.value) { err.textContent = 'the two passwords do not match'; return; }
      btn.disabled = true;
      try {
        const body = { post_name: name.value, zone_id: zone.value, latitude: lat.value, longitude: lon.value, username: normUser(user.value), password: pass.value,
          ...(authU ? { authorizer_username: authU.value, authorizer_password: authP.value } : {}) };
        await afterAuth(await api('/api/setup/register', { method: 'POST', body }));
      } catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    return form;
  }

  const TABS = () => [
    ['alerts', 'Alerts'], ['incidents', 'Incidents'], ['requests', 'Requests'], ['footage', 'Footage'], ['flags', 'Evidence'],
    ['team', 'Team'], ['audit', 'Activity log'],
  ];

  function themeButton() {
    const btn = h('button', { class: 'iconbtn', title: 'Dark / light mode', 'aria-label': 'Toggle dark mode' });
    const paint = () => { btn.replaceChildren(ic(window.__theme.get() === 'dark' ? 'sun' : 'moon', 17)); };
    btn.addEventListener('click', () => { window.__theme.set(window.__theme.get() === 'dark' ? 'light' : 'dark'); paint(); });
    paint();
    return btn;
  }

  function renderShell() {
    const tabs = h('nav', { class: 'tabs' }, TABS().map(([id, text]) => h('button', {
      class: `tab ${S.view === id ? 'active' : ''}`, 'data-tab': id, onclick: () => go(id),
    }, ic(TAB_ICON[id] || 'folder', 15), text, TAB_PILL[id] ? h('span', { class: `pill hidden ${TAB_PILL[id][1]}`, id: TAB_PILL[id][0], title: TAB_PILL[id][2] }) : null)));
    toastStyle();
    const quick = h('div', { class: 'quick' },
      btnI('plus', 'Incident', { class: 'btn accent', title: 'Raise an incident (complaint, patrol sighting, anything reported to you)', onclick: () => incidentForm() }),
      btnI('film', 'Footage request', { class: 'btn accent', title: 'Ask CMS for footage from a train camera', onclick: () => requestForm({}) }));
    document.getElementById('app').replaceChildren(
      h('header', { class: 'topbar' }, h('span', { class: 'brand' }, ic('shield', 18), S.me.post_name, h('small', { title: 'build' }, S.cfg && S.cfg.version ? `v${S.cfg.version}` : '')),
        quick,
        h('span', { class: 'who' }, `${S.me.username} - ${S.me.zone_name}`),
        h('span', { class: 'live-dot', id: 'live-dot', title: 'Connecting...' }, h('i', {}), h('span', {}, 'Connecting')),
        themeButton(),
        h('div', { class: 'bell-wrap' },
          h('button', { class: 'bell iconbtn', id: 'bell', title: 'Notices from CMS (footage ready, requests decided, evidence archived)', onclick: toggleNotifications }, ic('bell', 17), h('span', { class: 'pill hidden', id: 'bell-pill' })),
          h('div', { class: 'notif hidden', id: 'notif-box' })),
        h('button', { class: 'sound-btn', id: 'sound-btn', onclick: toggleSound, title: 'Soft chime with pop-up notices' }, soundOn() ? 'Sound: on' : 'Sound: off'),
        h('button', { onclick: accountDialog, title: 'Change password' }, 'Account'),
        h('button', { onclick: registerAnotherPost, title: 'Register a new Thana / Post' }, 'Register post'),
        h('button', { onclick: () => logout() }, 'Sign out')),
      ...[tabs, h('main', { id: 'main' }), h('div', { id: 'drawer-root' })]);
  }
  function go(view) {
    S.view = view;
    document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === view));
    closeDrawer();
    return refresh();
  }

  async function refresh() {
    const main = document.getElementById('main');
    if (!main) return;
    try {
      const node = await VIEWS[S.view]();
      if (node !== main.firstElementChild) main.replaceChildren(node);   // a split view returns its own live root: do not reload the player under the user
    } catch (ex) {
      main.replaceChildren(h('div', { class: 'card empty' }, `Could not load: ${ex.message}`));
    }
  }

  // ---------- shared view pieces ---------------------------------------------
  // counters on the tabs: [element id, colour, tooltip]
  const TAB_PILL = {
    alerts: ['unacked-pill', 'red', 'alerts waiting to be acknowledged'],
    incidents: ['incidents-pill', 'info', 'open incidents'],
    requests: ['requests-pill', 'info', 'footage requests still open'],
    footage: ['footage-pill', 'ok', 'delivered footage nobody at this post has played yet'],
    flags: ['flags-pill', 'warn', 'new notices from CMS about flagged evidence'],
  };
  function setPill(id, n) { const el = document.getElementById(id); if (!el) return; n = Number(n) || 0; el.textContent = n > 99 ? '99+' : n; el.classList.toggle('hidden', !n); }
  const TAB_ICON = { alerts: 'alert', incidents: 'folder', requests: 'upload', footage: 'film', flags: 'flag', audit: 'lock', team: 'user' };

  const table = (cols, rows, opts = {}) => rows.length
    ? h('div', { class: 'card table-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, cols.map((c) => h('th', {}, c)))), h('tbody', {}, rows)))
    : h('div', { class: 'card empty' }, opts.empty || 'Nothing here yet.');
  const head = (title, ...extra) => h('div', { class: 'toolbar' }, h('h2', {}, title), h('div', { class: 'spacer' }), extra);

  // ---------- filters + sorting for every list -------------------------------------
  // Filtering and sorting are done in the browser on the rows already loaded, so they react instantly while you type.
  const DATE_OPTS = [['', 'Any time'], ['today', 'Today'], ['24h', 'Last 24 hours'], ['7d', 'Last 7 days'], ['30d', 'Last 30 days']];
  const inRange = (iso, key) => {
    if (!key) return true; if (!iso) return false;
    const t = new Date(iso).getTime();
    if (key === 'today') { const d = new Date(); d.setHours(0, 0, 0, 0); return t >= d.getTime(); }
    return Date.now() - t <= { '24h': 864e5, '7d': 6048e5, '30d': 2592e6 }[key];
  };
  const uniq = (rows, fn) => [...new Set(rows.map(fn).filter(Boolean))].sort();
  const textFilter = (fn, placeholder) => ({ key: 'q', type: 'search', placeholder, test: (row, v) => !v || fn(row).toLowerCase().includes(v) });
  const selFilter = (key, label, options, test) => ({ key, label, options, test: (row, v) => !v || test(row, v) });
  const byTime = (fn, dir = -1) => (a, b) => dir * (new Date(fn(a)) - new Date(fn(b)));

  function listWith(id, rows, { filters, sorts, view, empty }) {
    const st = (S.f[id] = S.f[id] || {});
    if (!sorts.some(([k]) => k === st.sort)) st.sort = sorts[0][0];
    const out = h('div'); const count = h('span', { class: 'fcount' });
    const clear = h('button', { class: 'btn sm hidden', type: 'button' }, ic('x', 13), 'Clear filters');
    const paint = () => {
      const r = rows.filter((row) => filters.every((f) => f.test(row, st[f.key] || '')));
      r.sort(sorts.find(([k]) => k === st.sort)[2]);
      count.textContent = r.length === rows.length ? `${rows.length} shown` : `${r.length} of ${rows.length}`;
      clear.classList.toggle('hidden', !filters.some((f) => st[f.key]) && st.sort === sorts[0][0]);
      out.replaceChildren(r.length ? view(r) : (empty || h('div', { class: 'card empty' }, ic('x', 24), h('div', {}, 'Nothing matches these filters.'))));
    };
    const controls = filters.map((f) => f.type === 'search'
      ? h('input', { class: 'fsearch', type: 'search', placeholder: f.placeholder, value: st[f.key] || '', 'aria-label': f.placeholder, oninput: (e) => { st[f.key] = e.target.value.trim().toLowerCase(); paint(); } })
      : h('label', { class: 'fsel' }, h('span', {}, f.label), h('select', { onchange: (e) => { st[f.key] = e.target.value; paint(); } },
        (typeof f.options === 'function' ? f.options(rows) : f.options).map(([v, t]) => h('option', { value: v, selected: v === (st[f.key] || '') }, t)))));
    const sortSel = h('label', { class: 'fsel sort' }, h('span', {}, 'Sort'), h('select', { onchange: (e) => { st.sort = e.target.value; paint(); } }, sorts.map(([k, t]) => h('option', { value: k, selected: k === st.sort }, t))));
    clear.addEventListener('click', () => { S.f[id] = {}; refresh(); });
    paint();
    return h('div', { class: 'listwrap' }, h('div', { class: 'filterbar' }, controls, sortSel, count, clear), out);
  }

  const ALERT_CFG = {
    filters: [
      textFilter((a) => `${a.alert_type} ${a.camera_name || ''} ${a.nvr_name} ${a.train_no || ''} ${a.post_name || ''} ${a.incident_id ? 'incident ' + a.incident_id : ''}`, 'Search type, camera, train...'),
      selFilter('prio', 'Priority', [['', 'Any'], ['high', 'High (7+)'], ['low', 'Low (below 7)'], ['9', 'P9 and above']], (a, v) => (v === 'high' ? a.priority >= 7 : v === 'low' ? a.priority < 7 : a.priority >= 9)),
      selFilter('type', 'Type', (rows) => [['', 'Any type'], ...uniq(rows, (a) => a.alert_type).map((t) => [t, label(t)])], (a, v) => a.alert_type === v),
      selFilter('ack', 'Acknowledged', [['', 'Any'], ['no', 'Not yet'], ['yes', 'Yes']], (a, v) => (v === 'yes' ? !!a.ack_at : !a.ack_at)),
      selFilter('inc', 'Incident', [['', 'Any'], ['yes', 'Raised'], ['no', 'Not raised']], (a, v) => (v === 'yes' ? !!a.incident_id : !a.incident_id)),
      selFilter('src', 'How it arrived', [['', 'Any'], ['auto', 'Auto (high priority)'], ['lowauto', 'Auto-delivered (low priority)'], ['operator', 'Forwarded by operator'], ['escalation', 'Escalated']],
        (a, v) => (v === 'escalation' ? a.mode === 'escalation' : v === 'operator' ? a.mode === 'operator' : v === 'auto' ? a.mode === 'auto' && a.priority >= 7 : a.mode === 'auto' && a.priority < 7)),
      selFilter('when', 'When', DATE_OPTS, (a, v) => inRange(a.sent_at, v)),
    ],
    sorts: [['new', 'Newest first', byTime((a) => a.sent_at)], ['old', 'Oldest first', byTime((a) => a.sent_at, 1)],
      ['prio', 'Priority (high first)', (a, b) => b.priority - a.priority || byTime((x) => x.sent_at)(a, b)],
      ['unack', 'Not acknowledged first', (a, b) => (!!a.ack_at - !!b.ack_at) || byTime((x) => x.sent_at)(a, b)]],
  };
  const INC_CFG = {
    filters: [
      textFilter((i) => `${i.title || ''} ${i.alert_type} ${i.camera_name || ''} ${i.nvr_name || ''} ${i.train_no || ''} ${i.id}`, 'Search title, camera, train, #...'),
      selFilter('status', 'Status', [['', 'Any'], ['open', 'Open'], ['under_review', 'Under review'], ['closed', 'Closed']], (i, v) => i.status === v),
      selFilter('src', 'Source', [['', 'Any'], ['auto', 'Auto (CMS)'], ['operator', 'CMS operator'], ['officer', 'From an alert'], ['manual', 'Manual']], (i, v) => i.source === v),
      selFilter('prio', 'Priority', [['', 'Any'], ['high', 'High (7+)'], ['low', 'Low (below 7)']], (i, v) => (v === 'high' ? (i.priority || 0) >= 7 : (i.priority || 0) < 7)),
      selFilter('train', 'Train', (rows) => [['', 'Any train'], ...uniq(rows, (i) => i.train_no || i.nvr_name).map((t) => [t, t])], (i, v) => (i.train_no || i.nvr_name) === v),
      selFilter('foot', 'Footage', [['', 'Any'], ['req', 'Footage requested'], ['none', 'None requested'], ['flag', 'Has flagged evidence']], (i, v) => (v === 'req' ? i.request_count > 0 : v === 'none' ? i.request_count === 0 : Number(i.active_flags) > 0)),
      selFilter('when', 'Raised', DATE_OPTS, (i, v) => inRange(i.created_at, v)),
    ],
    sorts: [['new', 'Newest first', byTime((i) => i.created_at)], ['old', 'Oldest first', byTime((i) => i.created_at, 1)],
      ['prio', 'Priority (high first)', (a, b) => (b.priority || 0) - (a.priority || 0) || byTime((x) => x.created_at)(a, b)],
      ['upd', 'Recently updated', byTime((i) => i.updated_at || i.created_at)]],
  };
  const REQ_CFG = {
    filters: [
      textFilter((r) => `${r.camera_name} ${r.nvr_name} ${r.train_no || ''} ${r.reason || ''} ${r.requested_by_username} ${r.id}`, 'Search camera, reason, #...'),
      selFilter('st', 'Status', [['', 'Any'], ['submitted', 'Waiting for CMS approval'], ['approved', 'Approved'], ['awaiting_upload', 'Waiting for train'], ['fulfilled', 'Footage ready'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled'], ['failed', 'Failed / expired']],
        (r, v) => (v === 'approved' ? ['approved', 'amended'].includes(r.status) : v === 'failed' ? ['failed', 'expired'].includes(r.status) : r.status === v)),
      selFilter('cam', 'Camera', (rows) => [['', 'Any camera'], ...uniq(rows, (r) => `${r.camera_name} / ${r.nvr_name}`).map((t) => [t, t])], (r, v) => `${r.camera_name} / ${r.nvr_name}` === v),
      selFilter('inc', 'Incident', [['', 'Any'], ['yes', 'Linked to an incident'], ['no', 'No incident']], (r, v) => (v === 'yes' ? !!r.incident_id : !r.incident_id)),
      selFilter('when', 'Requested', DATE_OPTS, (r, v) => inRange(r.created_at, v)),
    ],
    sorts: [['new', 'Newest first', byTime((r) => r.created_at)], ['old', 'Oldest first', byTime((r) => r.created_at, 1)],
      ['attn', 'Needs attention first', (a, b) => (['submitted', 'awaiting_upload', 'approved', 'amended'].includes(b.status) - ['submitted', 'awaiting_upload', 'approved', 'amended'].includes(a.status)) || byTime((x) => x.created_at)(a, b)],
      ['win', 'Footage time (newest)', byTime((r) => r.window_start)]],
  };
  const FOOT_CFG = {
    filters: [
      textFilter((f) => `${f.camera_name} ${f.nvr_name} ${f.train_no || ''} ${f.request_id} ${f.id}`, 'Search camera, train, #...'),
      selFilter('cam', 'Camera', (rows) => [['', 'Any camera'], ...uniq(rows, (f) => `${f.camera_name} / ${f.nvr_name}`).map((t) => [t, t])], (f, v) => `${f.camera_name} / ${f.nvr_name}` === v),
      selFilter('flag', 'Retention', [['', 'Any'], ['yes', 'Flagged'], ['no', 'Normal 30-day']], (f, v) => (v === 'yes' ? Number(f.active_flags) > 0 : !Number(f.active_flags))),
      selFilter('when', 'Recorded', DATE_OPTS, (f, v) => inRange(f.start_time || f.window_start, v)),
    ],
    sorts: [['new', 'Newest first', byTime((f) => f.start_time || f.window_start)], ['old', 'Oldest first', byTime((f) => f.start_time || f.window_start, 1)],
      ['long', 'Longest', (a, b) => (b.duration_s || 0) - (a.duration_s || 0)], ['big', 'Largest file', (a, b) => b.file_size_bytes - a.file_size_bytes]],
  };
  const FLAG_CFG = {
    filters: [
      textFilter((f) => `${f.justification} ${f.camera_name} ${f.nvr_name} ${f.flagged_by_username} ${f.id}`, 'Search justification, camera, #...'),
      selFilter('ret', 'Kept', [['', 'Any'], ['permanent', 'For life'], ['timed', 'Until a date']], (f, v) => f.retention === v),
      selFilter('stor', 'Stored', [['', 'Anywhere'], ['cms', 'On CMS'], ['local', 'Locally at the post'], ['both', 'Both']], (f, v) => f.storage === v),
      selFilter('state', 'Copy status', [['', 'Any'], ['ok', 'Archived / saved'], ['pend', 'CMS still archiving'], ['bad', 'Problem']], (f, v) => (v === 'ok' ? (f.archive_status === 'archived' || f.has_local) : v === 'pend' ? f.archive_status === 'pending' : f.archive_status === 'failed' || !!f.local_error)),
      selFilter('when', 'Flagged', DATE_OPTS, (f, v) => inRange(f.flagged_at, v)),
    ],
    sorts: [['new', 'Newest first', byTime((f) => f.flagged_at)], ['old', 'Oldest first', byTime((f) => f.flagged_at, 1)],
      ['len', 'Longest section', (a, b) => ((b.section_end_s ?? 1e9) - (b.section_start_s ?? 0)) - ((a.section_end_s ?? 1e9) - (a.section_start_s ?? 0))]],
  };

  // ---------- views ----------------------------------------------------------
  const MODE_TAG = (a) => (a.mode === 'auto' && a.priority < 7 && !a.incident_id ? h('span', { class: 'tag' }, 'low priority - no incident yet') : a.mode === 'operator' ? h('span', { class: 'tag' }, 'forwarded by CMS operator') : a.mode === 'escalation' ? h('span', { class: 'tag warn' }, 'escalated to you') : null);
  const VIEWS = {
    async alerts() {
      const [rows, sum] = await Promise.all([api('/api/alerts' + qs({ state: S.alertState, limit: 500 })), api('/api/alerts/summary')]);
      const tile = (icon, n, text, cls, onclick) => h('button', { class: `tile ${cls || ''}`, onclick }, h('span', { class: 'tile-ic' }, ic(icon, 20)), h('span', { class: 'tile-n' }, String(n ?? 0)), h('span', { class: 'tile-t' }, text));
      const tiles = h('div', { class: 'tiles' },
        tile('bell', sum.unacked, 'Need acknowledging', Number(sum.unacked) ? 'red' : 'ok', () => { S.alertState = 'unacked'; refresh(); }),
        tile('check', sum.acked, 'Acknowledged', '', () => { S.alertState = 'acked'; refresh(); }),
        tile('upload', sum.open_requests, 'Footage requests in progress', Number(sum.open_requests) ? 'blue' : '', () => go('requests')),
        tile('film', 'Open', 'Delivered footage', '', () => go('footage')));
      if (!['unacked', 'acked'].includes(S.alertState)) S.alertState = 'unacked';
      const chips = subTabs([['unacked', 'Unacknowledged', sum.unacked, 'red'], ['acked', 'Acknowledged', sum.acked, '']], S.alertState, (id) => { S.alertState = id; refresh(); });
      const card = (a) => {
        const hi = a.priority >= 7; const open = !a.ack_at && ['routed', 'escalated'].includes(a.alert_status);
        const mine = a.post_id === myPost();
        return h('article', { class: `acard ${hi ? 'hi' : ''} ${open ? 'unacked' : ''}` },
          h('div', { class: 'acard-main', onclick: () => openAlert(a.delivery_id) },
            h('div', { class: 'aico' }, typeIcon(a.alert_type)),
            h('div', { class: 'abody' },
              h('div', { class: 'arow' }, h('b', { class: 'atitle' }, label(a.alert_type)), h('span', { class: `prio-pill ${hi ? 'hi' : ''}` }, `P${a.priority}`),
                open ? h('span', { class: 'newtag' }, 'NEW') : null, MODE_TAG(a)),
              h('div', { class: 'ameta' }, ic('camera', 13), `${a.camera_name || 'camera n/a'} / ${a.nvr_name}`, a.train_no ? [ic('train', 13), a.train_no] : null, ic('clock', 13), agoEl(a.sent_at)),
              h('div', { class: 'achips' }, a.ack_at ? badge(`acknowledged by ${a.ack_by_username || '-'}`, 'green') : badge('not acknowledged', open ? 'red' : 'grey'),
                a.incident_status ? badge(`incident #${a.incident_id} ${label(a.incident_status)}`, INC_CLS[a.incident_status]) : h('span', { class: 'muted' }, 'no incident yet')))),
          mine ? h('div', { class: 'acard-act' },
            !a.ack_at ? btnI('check', 'Acknowledge', { class: 'btn sm', onclick: async (e) => { e.stopPropagation(); try { await api(`/api/alerts/${a.delivery_id}/ack`, { method: 'POST', body: {} }); toast('Moved to Acknowledged alerts', 'ok', { title: 'Acknowledged', onClick: () => { S.alertState = 'acked'; refresh(); } }); refresh(); } catch (ex) { toast(ex.message, 'err'); } } }) : null,
            !a.incident_id ? btnI('plus', 'Raise incident', { class: 'btn sm primary', onclick: (e) => { e.stopPropagation(); incidentForm({ alert: a }); } }) : btnI('folder', `Incident #${a.incident_id}`, { class: 'btn sm', onclick: (e) => { e.stopPropagation(); openIncident(a.incident_id); } }),
            btnI('film', 'Request footage', { class: 'btn sm accent', onclick: (e) => { e.stopPropagation(); requestForm({ alert: a }); } })) : null);
      };
      return h('div', {}, head('Alerts', chips), tiles,
        rows.length ? listWith('alerts', rows, { ...ALERT_CFG, view: (r) => h('div', { class: 'cards' }, r.map(card)) }) : h('div', { class: 'card empty' }, ic('bell', 28), h('div', {}, S.alertState === 'acked' ? 'No acknowledged alerts yet.' : 'Nothing waiting - every alert has been acknowledged.'), h('div', { class: 'muted' }, 'High-priority alerts arrive with an incident already open; lower-priority ones arrive when a CMS operator forwards them.')));
    },

    async incidents() {
      const rows = await api('/api/incidents' + qs({ status: S.incState, limit: 500 }));
      if (!['active', 'closed'].includes(S.incState)) S.incState = 'active';
      const sumI = await api('/api/alerts/summary');
      const chips = subTabs([['active', 'Open incidents', sumI.open_incidents, 'info'], ['closed', 'Closed incidents', sumI.closed_incidents, '']], S.incState, (id) => { S.incState = id; refresh(); });
      const newBtn = btnI('plus', 'Raise incident', { class: 'btn primary', onclick: () => incidentForm() });
      const STEPS = [['open', 'Open'], ['under_review', 'Under review'], ['closed', 'Closed']];
      const pipeline = (st) => h('div', { class: 'pipe' }, STEPS.map(([id, text], i) => { const cur = STEPS.findIndex(([x]) => x === st); return h('div', { class: `pstep ${i < cur ? 'done' : i === cur ? 'now' : ''}` }, h('i', {}, i < cur ? ic('check', 11) : ''), h('span', {}, text)); }));
      const card = (i) => h('article', { class: `icard ${i.status}`, onclick: () => openIncident(i.id) },
        h('div', { class: 'icard-top' }, h('span', { class: 'idn' }, `#${i.id}`), h('b', {}, i.title || label(i.alert_type)), h('span', { class: `prio-pill ${(i.priority || 0) >= 7 ? 'hi' : ''}` }, `P${i.priority ?? '?'}`), h('span', { class: 'tag' }, SRC_TEXT[i.source] || i.source)),
        pipeline(i.status),
        h('div', { class: 'ameta' }, ic('camera', 13), i.camera_name ? `${i.camera_name} / ${i.nvr_name}` : 'no camera', i.train_no ? [ic('train', 13), i.train_no] : null, ic('clock', 13), agoEl(i.created_at)),
        h('div', { class: 'icard-foot' }, h('span', { class: 'muted' }, `${i.request_count} footage request${i.request_count === 1 ? '' : 's'}`), Number(i.active_flags) ? badge(`${i.active_flags} flagged`, 'amber') : null, h('span', { class: 'spacer' }),
          i.status !== 'closed' && i.post_id === myPost() ? btnI('film', 'Request footage', { class: 'btn sm accent', onclick: (e) => { e.stopPropagation(); requestForm({ incident: i }); } }) : null));
      return h('div', {}, head('Incidents', chips, newBtn),
        rows.length ? listWith('incidents', rows, { ...INC_CFG, view: (r) => h('div', { class: 'cards two' }, r.map(card)) })
          : h('div', { class: 'card empty' }, ic('folder', 28), h('div', {}, S.incState === 'closed' ? 'No closed incidents yet.' : 'No open incidents.'), h('div', { class: 'muted' }, 'High-priority alerts raise one automatically. For anything reported to you directly, press "Raise incident".')));
    },

    async requests() {
      const rows = await api('/api/requests' + qs({ limit: 500 }));
      const newBtn = btnI('film', 'New footage request', { class: 'btn primary', onclick: () => requestForm({}) });
      const steps = ['Sent to CMS', 'Approved', 'Fetching from train', 'Ready to watch'];
      const prog = (r) => {
        const cur = { submitted: 1, approved: 2, amended: 2, awaiting_upload: 2, fulfilled: 4 }[r.status];
        const bad = { rejected: 1, failed: 2, expired: 2, cancelled: 1 }[r.status];
        return h('div', { class: 'pipe wide' }, steps.map((text, i) => {
          let cls = '';
          if (bad !== undefined) cls = i < bad ? 'done' : i === bad ? (r.status === 'cancelled' ? 'stop' : 'bad') : '';
          else cls = i < cur ? 'done' : i === cur ? 'now' : '';
          return h('div', { class: `pstep ${cls}` }, h('i', {}, cls === 'done' ? ic('check', 11) : cls === 'bad' || cls === 'stop' ? ic('x', 11) : ''), h('span', {}, text));
        }));
      };
      const card = (r) => h('article', { class: `rcard ${r.status}` },
        h('div', { class: 'icard-top' }, h('span', { class: 'idn' }, `#${r.id}`), h('b', {}, `${r.camera_name} / ${r.nvr_name}`), reqBadge(r.status), h('span', { class: 'spacer' }),
          r.incident_id ? h('a', { href: '#', onclick: (e) => { e.preventDefault(); openIncident(r.incident_id); } }, `incident #${r.incident_id}`) : null),
        prog(r),
        h('div', { class: 'ameta' }, ic('clock', 13), `${fmtShort(r.window_start)} to ${fmtShort(r.window_end)}`, r.orig_window_start ? h('span', { class: 'tag warn' }, 'window amended by CMS') : null, ic('user', 13), r.requested_by_username, agoEl(r.created_at)),
        r.status === 'awaiting_upload' ? h('div', { class: 'hint-line' }, ic('train', 14), 'CMS has told the train to upload this. It arrives as soon as the train is in coverage - nothing for you to do.') : null,
        r.status === 'submitted' ? h('div', { class: 'hint-line' }, ic('clock', 14), 'Waiting for a CMS operator to approve.') : null,
        r.decision_note ? h('div', { class: 'muted' }, `CMS: ${r.decision_note}`) : null, r.failure_reason ? h('div', { class: 'err-line' }, r.failure_reason) : null,
        h('div', { class: 'icard-foot' }, h('span', { class: 'spacer' }),
          r.status === 'fulfilled' ? btnI('play', 'Watch footage', { class: 'btn sm primary', onclick: () => openRequestFootage(r.id) }) : null,
          OPEN_REQ.includes(r.status) ? h('button', { class: 'btn sm danger', onclick: () => cancelRequest(r.id) }, 'Cancel') : null));
      return h('div', {}, head('Footage requests', newBtn),
        rows.length ? listWith('requests', rows, { ...REQ_CFG, view: (r) => h('div', { class: 'cards two' }, r.map(card)) })
          : h('div', { class: 'card empty' }, ic('film', 28), h('div', {}, 'No footage requests yet.'), [h('div', { class: 'muted' }, 'Open an incident and press "Request footage", or:'), btnI('film', 'New footage request', { class: 'btn primary', onclick: () => requestForm({}) })]));
    },

    async footage() {
      const rows = await api('/api/footage' + qs({ limit: 500 }));
      return splitView('footage', {
        head: head('Delivered footage'),
        emptyPane: 'Select a recording to watch it here. Mark the section that matters, then save it to your PC or flag it for retention.',
        list: (st) => listWith('footage', rows, { ...FOOT_CFG, view: (r) => table(['#', 'Camera / train', 'Recorded', 'Retention', ''],
          r.map((f) => h('tr', { class: `click ${st.current === f.id ? 'sel' : ''}`, 'data-id': f.id, onclick: () => showFootage(st, f) },
            h('td', {}, h('div', { class: 'thumb' }, ic('film', 20), h('span', {}, f.duration_s ? fmtDur(f.duration_s) : '')), h('div', { class: 'muted' }, `#${f.id}`), f.is_new ? h('span', { class: 'badge new' }, 'new') : null),
            h('td', {}, `${f.camera_name} / ${f.nvr_name}`, (f.train_no ? h('div', { class: 'muted' }, f.train_no) : null)),
            h('td', {}, fmtShort(f.start_time || f.window_start), h('div', { class: 'muted' }, `${f.duration_s ? fmtDur(f.duration_s) : ''} - ${fmtSize(f.file_size_bytes)}`)),
            h('td', {}, f.active_flags > 0 ? badge(`${f.active_flags} flagged`, 'amber') : h('span', { class: 'muted' }, 'normal 30-day')),
            h('td', {}, h('button', { class: 'btn sm primary' }, 'Play')))),
          { empty: 'No footage has been delivered yet. Raise or open an incident and request footage for it.' }) }),
      });
    },

    async flags() {
      const rows = await api('/api/flags' + qs({ limit: 500 }));
      api('/api/notifications/read', { method: 'POST', body: { entity: 'evidence_flag' } }).then(() => setPill('flags-pill', 0)).catch(() => {});   // looking at the list = seen
      return splitView('flags', {
        head: head('Evidence - flagged recordings'),
        emptyPane: 'Select a flagged recording to play it. You can watch the CMS copy and the local copy, and save either to your PC.',
        list: (st) => listWith('flags', rows, { ...FLAG_CFG, view: (r) => table(['#', 'Flagged', 'Section', 'Kept', 'Copies', ''],
          r.map((f) => h('tr', { class: `click ${st.current === f.id ? 'sel' : ''}`, 'data-id': f.id, onclick: () => showFlag(st, f) },
            h('td', {}, f.id, f.incident_id ? h('div', {}, h('a', { href: '#', onclick: (e) => { e.preventDefault(); e.stopPropagation(); openIncident(f.incident_id); } }, `inc #${f.incident_id}`)) : null),
            h('td', {}, fmtShort(f.flagged_at), h('div', { class: 'muted' }, f.flagged_by_username)),
            h('td', {}, f.section_start_s != null ? `${fmtDur(f.section_start_s)} - ${fmtDur(f.section_end_s)}` : 'whole file', h('div', { class: 'muted' }, `${f.camera_name} / ${f.nvr_name}`)),
            h('td', {}, f.retention === 'permanent' ? badge('for life', 'indigo') : [badge('timed', 'blue'), h('div', { class: 'muted' }, `until ${fmtDate(f.retain_to)}`)], f.status !== 'active' ? h('div', {}, badge(f.status, 'grey')) : null),
            h('td', {}, copyBadges(f)),
            h('td', {}, h('button', { class: 'btn sm primary' }, 'Play')))),
          { empty: 'Nothing has been flagged for retention. Review delivered footage, mark the section that matters and flag it.' }) }),
      });
    },

    async team() {
      const data = await api('/api/team');
      const addBtn = btnI('plus', 'Add officer', { class: 'btn primary', onclick: () => formDialog({
        title: 'Add an officer to this post', sub: 'Give them a starting password; they can change it under Account.',
        fields: [{ name: 'username', label: 'Username (e.g. ravi.kumar)' }, { name: 'password', label: 'Starting password (at least 8 characters)', type: 'password' }],
        submitLabel: 'Add officer',
        submit: async (v) => { await api('/api/team', { method: 'POST', body: v }); toast(`Officer ${v.username} added`); refresh(); },
      }) });
      const rows = data.officers.map((o) => h('tr', {},
        h('td', {}, o.username, o.you ? h('span', { class: 'muted' }, ' (you)') : null),
        h('td', {}, badge(o.status, o.status === 'active' ? 'green' : 'grey')),
        h('td', {}, fmtDate(o.created_at)),
        h('td', {}, o.you ? '' : h('span', {},
          btnI('lock', 'Set new password', { class: 'btn sm', onclick: () => formDialog({
            title: `New password for ${o.username}`, sub: 'For an officer who is locked out.',
            fields: [{ name: 'password', label: 'New password (at least 8 characters)', type: 'password' }], submitLabel: 'Set password',
            submit: async (v) => { await api(`/api/team/${o.id}/reset-password`, { method: 'POST', body: v }); toast('Password set'); },
          }) }), ' ',
          btnI(o.status === 'active' ? 'x' : 'check', o.status === 'active' ? 'Disable' : 'Enable', { class: 'btn sm', onclick: () => api(`/api/team/${o.id}/status`, { method: 'POST', body: { status: o.status === 'active' ? 'disabled' : 'active' } }).then(refresh).catch((ex) => toast(ex.message, 'err')) })))));
      return h('div', {}, head('Team - officers of this post', addBtn),
        table(['Officer', 'Status', 'Since', ''], rows, { empty: 'No officers.' }));
    },

    async audit() {
      const rows = await api('/api/audit' + qs({ action: S.auditFilter, limit: 200 }));
      const sel = h('select', { onchange: (e) => { S.auditFilter = e.target.value; refresh(); } },
        [['', 'All actions'], ['auth', 'Sign-ins'], ['alert', 'Alerts'], ['incident', 'Incidents'], ['request', 'Requests'], ['footage', 'Footage (view / download / flag)']]
          .map(([v, t]) => h('option', { value: v, selected: v === S.auditFilter }, t)));
      return h('div', {}, head('Activity log - everything done under this post (chain of custody)', sel),
        table(['Time', 'Who', 'Action', 'Record', 'Details'],
          rows.map((a) => h('tr', {},
            h('td', {}, fmtTime(a.occurred_at)), h('td', {}, a.actor_username || 'system'),
            h('td', {}, h('span', { class: 'mono' }, a.action)), h('td', {}, `${a.entity} #${a.entity_id ?? '-'}`),
            h('td', {}, h('span', { class: 'mono muted' }, a.details ? JSON.stringify(a.details) : '')))),
          { empty: 'No audit entries.' }));
    },
  };

  // ---------- split view: list on the left, player on the right ----------------
  // The root node is kept between live refreshes, so a video that is playing is never reloaded under the user.
  const SPLIT = {};
  async function splitView(id, { head: headNode, list, emptyPane }) {
    const main = document.getElementById('main');
    let st = SPLIT[id];
    if (!st || main.firstElementChild !== st.root) {
      st = SPLIT[id] = { current: null, head: h('div'), list: h('div', { class: 'split-list' }), pane: h('div', { class: 'split-pane card' }, h('div', { class: 'empty' }, emptyPane)), emptyPane };
      st.root = h('div', {}, st.head, h('div', { class: 'split' }, st.list, st.pane));
    }
    st.head.replaceChildren(headNode);
    st.list.replaceChildren(list(st));
    return st.root;
  }
  const copyBadges = (f) => [
    f.storage !== 'local' ? h('div', {}, badge(f.archive_status === 'archived' ? 'on CMS' : (ARCH_TEXT[f.archive_status] || f.archive_status), ARCH_CLS[f.archive_status])) : h('div', {}, badge('not on CMS', 'grey')),
    f.storage !== 'cms' ? h('div', {}, f.has_local ? badge('local at post', 'teal') : badge('local copy failed', 'red')) : null,
  ];
  async function showFootage(st, f) {
    st.current = f.id;
    st.list.querySelectorAll('tr.click').forEach((tr) => tr.classList.toggle('sel', tr.dataset.id === String(f.id)));
    st.pane.replaceChildren(skeleton(4));
    const rv = await buildReviewer(f, { onFlagged: () => refresh() });
    if (st.current !== f.id) return;
    st.pane.replaceChildren(rv ? rv.node : h('div', { class: 'empty' }, 'Could not open this recording.'));
  }
  async function showFlag(st, f) {
    st.current = f.id;
    st.list.querySelectorAll('tr.click').forEach((tr) => tr.classList.toggle('sel', tr.dataset.id === String(f.id)));
    st.pane.replaceChildren(skeleton(4));
    const node = await buildFlagPlayer(f);
    if (st.current === f.id) st.pane.replaceChildren(node);
  }

  /** Flagged recording: details (what the officer entered), source switch (CMS copy / local copy), player, save to PC. */
  async function buildFlagPlayer(f) {
    const sources = [];
    if (f.archive_status === 'archived') sources.push(['cms', 'CMS copy']);
    if (f.has_local) sources.push(['local', 'Local copy at this post']);
    const holder = h('div', { class: 'player' });
    const info = h('div', { class: 'muted' });
    let source = sources.length ? sources[0][0] : null;
    const chips = h('div', { class: 'chips' });
    const dl = h('button', { class: 'btn sm', disabled: !source }, 'Save to PC');
    async function load() {
      chips.replaceChildren(...sources.map(([id, text]) => h('button', { class: `chip ${source === id ? 'active' : ''}`, onclick: () => { source = id; load(); } }, text)));
      if (!source) { holder.replaceChildren(h('div', { class: 'note' }, f.archive_status === 'pending' ? 'CMS is still archiving this recording - it will appear here in a moment.' : f.local_error ? `The local copy could not be saved: ${f.local_error}` : 'No playable copy yet.')); return; }
      let link; try { link = await api(`/api/flags/${f.id}/access`, { method: 'POST', body: { purpose: 'view', source } }); } catch (ex) { holder.replaceChildren(h('div', { class: 'note' }, ex.message)); return; }
      const { nodes } = playerBody(link, `Viewing the ${source === 'local' ? 'local copy at this post' : 'copy archived on CMS'} - logged`);
      holder.replaceChildren(...nodes);
      info.textContent = '';
    }
    dl.addEventListener('click', async () => { try { const link = await api(`/api/flags/${f.id}/access`, { method: 'POST', body: { purpose: 'download', source } }); startDownload(link.url); toast(`Download started - the ${source === 'local' ? 'local' : 'CMS'} copy`); } catch (ex) { toast(ex.message, 'err'); } });
    const storageText = { cms: 'On CMS (kept beyond 30 days)', local: 'Locally at the post only', both: 'On CMS and locally at the post' }[f.storage] || f.storage;
    const node = h('div', { class: 'pad' },
      h('h3', {}, `Flag #${f.id} - ${f.camera_name} / ${f.nvr_name}`),
      h('dl', { class: 'kv' },
        h('dt', {}, 'Kept'), h('dd', {}, storageText),
        h('dt', {}, 'Retention'), h('dd', {}, f.retention === 'permanent' ? 'for life' : `until ${fmtTime(f.retain_to)}`, f.status !== 'active' ? ` (${f.status})` : ''),
        h('dt', {}, 'Section'), h('dd', {}, f.section_start_s != null ? `${fmtDur(f.section_start_s)} - ${fmtDur(f.section_end_s)} (${fmtDur(f.section_end_s - f.section_start_s)}), ${fmtTime(f.section_from)} to ${fmtTime(f.section_to)}` : 'whole file'),
        h('dt', {}, 'Entered at the RPF'), h('dd', {}, `${fmtTime(f.flagged_at)} by ${f.flagged_by_username}`),
        h('dt', {}, 'Justification'), h('dd', {}, f.justification),
        f.has_local ? [h('dt', {}, 'Local copy'), h('dd', {}, `saved ${fmtTime(f.local_saved_at)} - ${fmtSize(f.local_size_bytes)}`, h('div', { class: 'mono muted' }, `sha256 ${(f.local_sha256 || '').slice(0, 20)}...`))] : null,
        f.release_note ? [h('dt', {}, 'Released'), h('dd', {}, f.release_note)] : null),
      chips, holder, h('div', { class: 'actions mt' }, dl), info);
    await load();
    return node;
  }

  // ---------- "what was done": action-note composer and a readable timeline -----------
  const NOTE_CHIPS = ['Team dispatched', 'On site', 'Situation under control', 'Suspect detained', 'Handed over to GRP', 'Complainant spoken to', 'False alarm'];
  function noteComposer(onSave, { placeholder, button } = {}) {
    const ta = h('textarea', { rows: 3, placeholder: placeholder || 'What was done? For example: team dispatched, reached the coach, bag checked, handed over...' });
    const chips = h('div', { class: 'chips' }, NOTE_CHIPS.map((t) => h('button', { class: 'chip', type: 'button', onclick: () => { ta.value = `${ta.value ? ta.value.trimEnd() + ' ' : ''}${t}. `; ta.focus(); } }, t)));
    const save = btnI('check', button || 'Save action note', { class: 'btn primary', type: 'button' });
    save.addEventListener('click', async () => {
      if (!ta.value.trim()) { toast('Write what was done first', 'info'); return; }
      save.disabled = true;
      try { await onSave(ta.value.trim()); ta.value = ''; toast('Saved - CMS can see this'); } catch (ex) { toast(ex.message, 'err'); } finally { save.disabled = false; }
    });
    return h('div', { class: 'composer' }, ta, chips, h('div', { class: 'actions' }, save));
  }
  const TL_TEXT = {
    'incident.create': () => ['Incident raised', null], 'incident.status': (d) => [`Status changed: ${label(d.from)} -> ${label(d.to)}`, d.note], 'incident.note': (d) => ['Action note', d.text],
    'alert.routed': (d) => ['Sent to the post', d.note], 'alert.escalated': (d) => ['Escalated', d.note], 'alert.acknowledged': (d) => ['Acknowledged', d.note], 'alert.resolved': (d) => ['Resolved', d.note], 'alert.dismissed': (d) => ['Dismissed by CMS', d.note],
  };
  function timelineItem(x) {
    const d = x.details || {};
    const [title, body] = (TL_TEXT[x.action] || (() => [label(x.action.replace(/^(incident|alert)\./, '')), d.note || d.text]))(d);
    const isNote = x.action === 'incident.note' || (d.note || '').startsWith('Action note:');
    return h('div', { class: `item tl ${isNote ? 'note-item' : ''}` }, h('b', {}, isNote ? 'Action note' : title), body ? h('div', {}, String(body).replace(/^Action note:\s*/, '')) : null,
      h('div', { class: 'muted' }, `${fmtTime(x.occurred_at)} - ${x.actor || 'system'}`));
  }

  // ---------- drawer (alert / incident) ----------------------------------------
  function closeDrawer() { S.drawer = null; document.body.classList.remove('drawer-open'); document.getElementById('drawer-root')?.replaceChildren(); }
  const reopen = async () => { if (!S.drawer) return; const d = S.drawer; if (d.kind === 'alert') await openAlert(d.id); else await openIncident(d.id); };

  const section = (title, ...kids) => h('section', {}, h('h3', {}, title), kids);

  function footageButtons(f, canFlag) {
    return h('div', { class: 'actions' },
      h('button', { class: 'btn sm primary', onclick: () => reviewFootage(f) }, canFlag ? 'Review / flag' : (f.playable ? 'Play' : 'View')),
      h('button', { class: 'btn sm', onclick: () => downloadFootage(f) }, 'Save to PC'),
      h('span', { class: 'muted' }, `${f.duration_s ? fmtDur(f.duration_s) + ' - ' : ''}${f.format} - ${fmtSize(f.file_size_bytes)}${f.active_flags ? ' - flagged' : ''}`));
  }
  function requestList(requests, footage, canFlag) {
    return requests.length ? requests.map((r) => h('div', { class: 'item' },
      h('div', {}, reqBadge(r.status), ` request #${r.id} - ${r.camera_name}`),
      h('div', { class: 'muted' }, `${fmtTime(r.window_start)} to ${fmtTime(r.window_end)}`),
      r.status === 'awaiting_upload' ? h('div', { class: 'muted' }, "CMS is waiting for the train's NVR to upload this footage.") : null,
      r.decision_note ? h('div', { class: 'muted' }, `CMS: ${r.decision_note}`) : null,
      r.failure_reason ? h('div', { class: 'muted' }, r.failure_reason) : null,
      footage.filter((f) => f.request_id === r.id).map((f) => footageButtons(f, canFlag)))) : h('div', { class: 'muted' }, 'No footage requested yet.');
  }
  const actBtn = (text, fn, cls, after) => h('button', { class: `btn ${cls || ''}`, onclick: async (e) => {
    e.target.disabled = true;
    try { await fn(); await (after || reopen)(); refresh(); } catch (ex) { toast(ex.message, 'err'); e.target.disabled = false; }
  } }, text);

  // ---------- detail panels: a "command card" per alert / incident ----------------------------------------------
  // header (what + how urgent + progress)  ->  tabs (Overview | Footage | Activity)  ->  sticky action bar.
  const prioClass = (p) => (p >= 7 ? 'crit' : p >= 4 ? 'med' : 'low');
  const prioText = (p) => (p >= 7 ? 'Critical' : p >= 4 ? 'Medium' : 'Low');
  const fact = (icon, k, v, sub) => h('div', { class: 'fact' }, h('div', { class: 'fi' }, ic(icon, 17)), h('div', {}, h('div', { class: 'fk' }, k), h('div', { class: 'fv' }, v), sub ? h('div', { class: 'fs' }, sub) : null));
  const pinLink = (a) => (a.lat != null && a.lon != null ? mapLink(a) : 'not recorded');
  /** steps: [[label, doneAt|null|true, hint]]  -> a progress line; the first unfinished step is "now". */
  function stepper(steps) {
    let nowSet = false;
    return h('div', { class: 'steps' }, steps.map(([text, at], i) => {
      const done = !!at; const cls = done ? 'done' : (!nowSet ? (nowSet = true, 'now') : '');
      return h('div', { class: `step ${cls}` }, h('i', {}, done ? ic('check', 13) : String(i + 1)), h('b', {}, text), h('em', {}, at && at !== true ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : cls === 'now' ? 'next' : ''));
    }));
  }
  function drawerShell({ tone, icon, title, sub, ring, chips, steps, tabs, actions }) {
    const want = S.drawerTab && tabs.some((t) => t.id === S.drawerTab) ? S.drawerTab : tabs[0].id;
    const panel = h('div', { class: 'dbody' });
    const bar = h('div', { class: 'dtabs', role: 'tablist' });
    const show = (id) => {
      S.drawerTab = id;
      [...bar.children].forEach((b) => b.classList.toggle('on', b.dataset.id === id));
      panel.replaceChildren(h('div', {}, tabs.find((t) => t.id === id).body()));
      panel.scrollTop = 0;
    };
    tabs.forEach((t) => bar.append(h('button', { class: `dtab ${t.id === want ? 'on' : ''}`, 'data-id': t.id, role: 'tab', onclick: () => show(t.id) }, t.label, t.count != null ? h('span', { class: 'c' }, String(t.count)) : null)));
    panel.append(h('div', {}, tabs.find((t) => t.id === want).body()));
    document.body.classList.add('drawer-open');
    return h('aside', { class: 'drawer v2' },
      h('header', { class: `dh ${tone}` },
        h('div', { class: 'dh-top' },
          ring ? h('div', { class: 'ring', style: `--p:${ring.pct}%` }, h('div', {}, h('b', {}, ring.text), h('small', {}, ring.caption))) : null,
          h('div', { class: 'dh-ico' }, icon),
          h('div', { class: 'dh-title' }, h('h2', {}, title), h('div', { class: 'dh-sub' }, sub)),
          h('div', { class: 'dh-btns' }, h('button', { class: 'btn sm', title: 'Reload', onclick: reopen }, ic('clock', 14)), h('button', { class: 'btn sm', title: 'Close', onclick: closeDrawer }, ic('x', 14)))),
        h('div', { class: 'dh-chips' }, chips), stepper(steps)),
      bar, panel,
      actions.length ? h('footer', { class: 'dfoot' }, actions) : null);
  }
  const subItem = (icon, text) => h('span', {}, ic(icon, 13), text);
  const emptyHint = (icon, text, more) => h('div', { class: 'empty2' }, ic(icon, 34), h('div', {}, text), more ? h('div', { class: 'muted' }, more) : null);
  /** Footage requests as cards (status, window, what CMS said, Play / Save buttons) */
  function requestCards(requests, footage, canFlag) {
    if (!requests.length) return emptyHint('film', 'No footage requested yet.', 'Use "Request footage" below to ask CMS for the train\'s recording.');
    return requests.map((r) => h('div', { class: 'rq' },
      h('div', { class: 'rq-top' }, h('b', {}, `#${r.id} - ${r.camera_name || 'camera'}`), reqBadge(r.status)),
      h('div', { class: 'rq-when' }, ic('clock', 12), ` ${fmtTime(r.window_start)} to ${fmtTime(r.window_end)}`),
      r.status === 'awaiting_upload' ? h('div', { class: 'rq-when' }, "CMS is waiting for the train's NVR to upload this footage.") : null,
      r.decision_note ? h('div', { class: 'rq-when' }, `CMS: ${r.decision_note}`) : null,
      r.failure_reason ? h('div', { class: 'rq-when' }, r.failure_reason) : null,
      footage.filter((f) => f.request_id === r.id).map((f) => footageButtons(f, canFlag))));
  }
  /** vertical activity feed: [{ title, body, who, at, tone }] */
  function activityFeed(items) {
    if (!items.length) return emptyHint('clock', 'No activity yet.');
    return h('div', { class: 'feed' }, items.map((x) => h('div', { class: `fe ${x.tone || ''}` }, h('b', {}, x.title), x.body ? h('div', { class: 'fb' }, x.body) : null, h('div', { class: 'fw' }, `${fmtTime(x.at)} - ${x.who || 'system'}`))));
  }

  async function openAlert(deliveryId) {
    let data;
    try { data = await api(`/api/alerts/${deliveryId}`); } catch (ex) { toast(ex.message, 'err'); return; }
    S.drawerTab = S.drawer && S.drawer.kind === 'alert' && S.drawer.id === deliveryId ? S.drawerTab : 'overview';
    S.drawer = { kind: 'alert', id: deliveryId };
    const { alert: a, requests, footage, history } = data;
    const mine = a.post_id === myPost();
    const handled = ['resolved', 'dismissed'].includes(a.alert_status) || a.incident_status === 'closed';
    const needsAck = !a.ack_at && ['routed', 'escalated'].includes(a.alert_status);

    const actions = [];
    if (mine) {
      if (!a.ack_at) actions.push(actBtn('Acknowledge', async () => { await api(`/api/alerts/${deliveryId}/ack`, { method: 'POST', body: {} }); toast('Moved to Acknowledged alerts', 'ok', { title: 'Acknowledged', onClick: () => { S.alertState = 'acked'; go('alerts'); } }); }, 'primary'));
      if (!a.incident_id) actions.push(h('button', { class: 'btn primary', onclick: () => incidentForm({ alert: a }) }, 'Raise incident'));
      else actions.push(h('button', { class: 'btn primary', onclick: () => openIncident(a.incident_id) }, `Open incident #${a.incident_id}`));
      actions.push(h('button', { class: 'btn', onclick: () => requestForm({ alert: a }) }, 'Request footage'));
    } else if (a.incident_id) actions.push(h('button', { class: 'btn', onclick: () => openIncident(a.incident_id) }, `Open incident #${a.incident_id}`));

    const overview = () => h('div', {},
      handled ? h('div', { class: 'banner' }, h('div', { class: 'bi' }, ic('check', 22)), h('div', {}, h('b', {}, 'This alert is handled'), h('div', { class: 'muted' }, a.incident_status === 'closed' ? `Its incident #${a.incident_id} is closed.` : label(a.alert_status)))) : null,
      needsAck && mine ? h('div', { class: 'banner red' }, h('div', { class: 'bi' }, ic('bell', 22)), h('div', {}, h('b', {}, 'Nobody has acknowledged this alert yet'), h('div', { class: 'muted' }, 'Press Acknowledge once someone is on it, or raise an incident to start the paperwork.'))) : null,
      h('div', { class: `facts ${handled || (needsAck && mine) ? 'gap' : ''}` },
        fact('clock', 'Happened', fmtTime(a.alert_event_time), ago(a.alert_event_time)),
        fact('camera', 'Camera', a.camera_name || 'not known', a.nvr_name),
        fact('train', 'Train', a.train_no || 'not known'),
        fact('pin', 'Location', pinLink(a), a.fix_quality ? `GPS ${a.fix_quality}${a.fix_age_s != null ? `, ${a.fix_age_s}s old` : ''}` : null),
        fact('shield', 'Sent to', a.post_name, `${fmtTime(a.sent_at)}${MODE_TAG(a) ? '' : ''}`),
        fact('user', 'Acknowledged', a.ack_at ? `by ${a.ack_by_username}` : 'not yet', a.ack_at ? fmtTime(a.ack_at) : null)),
      MODE_TAG(a) ? h('div', { class: 'card2' }, MODE_TAG(a)) : null,
      mine && !['resolved', 'dismissed'].includes(a.alert_status) ? h('div', { class: 'card2' }, h('h4', {}, 'Record what was done'),
        noteComposer((text) => api(`/api/alerts/${deliveryId}/notes`, { method: 'POST', body: { text } }).then(reopen)),
        !a.incident_id ? h('div', { class: 'actions mt' }, btnI('check', 'Mark alert resolved...', { class: 'btn', onclick: () => formDialog({
          title: 'Resolve this alert', sub: 'Use this when no incident is needed. Say what was done; the alert is acknowledged and closed.',
          fields: [{ name: 'note', label: 'What was done (required)', type: 'textarea' }], submitLabel: 'Resolve alert',
          submit: async (v) => { if (!v.note.trim()) throw new Error('write what was done'); await api(`/api/alerts/${deliveryId}/resolve`, { method: 'POST', body: { note: v.note } }); toast('Alert resolved'); await reopen(); refresh(); },
        }) })) : h('div', { class: 'muted mt' }, 'This alert has an incident - record actions and close it from the incident.')) : null);

    const feed = history.map((x) => {
      const note = (x.note || '').startsWith('Action note:');
      return { title: x.from_status === x.to_status || note ? 'Action note' : `${label(x.from_status)} \u2192 ${label(x.to_status)}`, body: x.note ? String(x.note).replace(/^Action note:\s*/, '') : null, who: x.changed_by_username, at: x.changed_at, tone: note ? 'note' : x.to_status === 'escalated' ? 'warn' : '' };
    });
    feed.unshift({ title: 'Alert reached this post', body: a.mode === 'operator' ? 'Forwarded by a CMS operator' : a.mode === 'escalation' ? 'Escalated to this post' : 'Routed automatically by CMS (nearest post)', who: 'CMS', at: a.sent_at });
    const steps = [['Received', a.sent_at], ['Acknowledged', a.ack_at], ['Incident', a.incident_id ? (a.incident_created_at || true) : null],
      ['Footage', footage.length ? true : null], ['Closed', handled ? true : null]];
    return void document.getElementById('drawer-root').replaceChildren(drawerShell({
      tone: handled ? 'done' : prioClass(a.priority), icon: typeIcon(a.alert_type), title: label(a.alert_type).replace(/\b\w/g, (c) => c.toUpperCase()),
      sub: [a.camera_name ? subItem('camera', `${a.camera_name} / ${a.nvr_name}`) : null, a.train_no ? subItem('train', a.train_no) : null, subItem('clock', ago(a.alert_event_time))],
      ring: { pct: Math.min(100, Number(a.priority) * 10), text: `P${a.priority}`, caption: prioText(a.priority) },
      chips: [needsAck ? h('span', { class: 'badge red pulse' }, 'needs acknowledging') : a.ack_at ? badge('acknowledged', 'green') : null,
        a.incident_status ? badge(`incident #${a.incident_id} ${label(a.incident_status)}`, INC_CLS[a.incident_status]) : badge('no incident yet', 'grey'),
        requests.length ? badge(`${requests.length} footage request${requests.length === 1 ? '' : 's'}`, 'blue') : null],
      steps,
      tabs: [{ id: 'overview', label: 'Overview', body: overview }, { id: 'footage', label: 'Footage', count: requests.length, body: () => requestCards(requests, footage, mine) },
        { id: 'activity', label: 'Activity', count: feed.length, body: () => activityFeed(feed) }],
      actions }));
  }

  async function openIncident(id) {
    let data;
    try { data = await api(`/api/incidents/${id}`); } catch (ex) { toast(ex.message, 'err'); return; }
    S.drawerTab = S.drawer && S.drawer.kind === 'incident' && S.drawer.id === id ? S.drawerTab : 'overview';
    S.drawer = { kind: 'incident', id };
    const { incident: i, requests, footage, flags, timeline } = data;
    const mine = i.post_id === myPost();
    const closed = i.status === 'closed';
    const actions = [];
    if (mine && !closed) {
      actions.push(h('button', { class: 'btn primary', onclick: () => requestForm({ incident: i }) }, 'Request footage'));
      if (i.status === 'open') actions.push(actBtn('Mark under review', () => api(`/api/incidents/${id}/status`, { method: 'PATCH', body: { status: 'under_review' } })));
      actions.push(h('span', { class: 'spacer' }));
      actions.push(h('button', { class: 'btn', onclick: () => formDialog({
        title: 'Close incident', sub: 'Closing resolves the alert. This cannot be reopened from the dashboard (CMS can reopen it).',
        fields: [{ name: 'note', label: 'Action taken / outcome (required)', type: 'textarea' }], submitLabel: 'Close incident',
        submit: async (v) => { if (!v.note.trim()) throw new Error('write the action taken / outcome before closing'); await api(`/api/incidents/${id}/status`, { method: 'PATCH', body: { status: 'closed', note: v.note } }); toast(`Incident #${id} moved to Closed incidents`, 'ok', { title: 'Incident closed', onClick: () => { S.incState = 'closed'; go('incidents'); } }); await reopen(); poll(); refresh(); },
      }) }, 'Close incident'));
    }
    if (i.alert_delivery_id) actions.push(h('button', { class: 'btn', onclick: () => openAlert(i.alert_delivery_id) }, 'View alert'));

    const overview = () => h('div', {},
      closed ? h('div', { class: 'banner' }, h('div', { class: 'bi' }, ic('check', 22)), h('div', {}, h('b', {}, `Closed ${fmtTime(i.closed_at)}${i.closed_by_username ? ` by ${i.closed_by_username}` : ''}`), i.closing_note ? h('div', {}, i.closing_note) : null))
        : i.status === 'under_review' ? h('div', { class: 'banner amber' }, h('div', { class: 'bi' }, ic('eye', 22)), h('div', {}, h('b', {}, 'Under review'), h('div', { class: 'muted' }, 'Record what was done, then close the incident with the outcome.'))) : null,
      h('div', { class: `facts ${closed || i.status === 'under_review' ? 'gap' : ''}` },
        fact('clock', 'Occurred', fmtTime(i.occurred_at), ago(i.occurred_at)),
        fact('user', 'Raised by', i.raised_by_username, `${fmtTime(i.created_at)} - ${SRC_TEXT[i.source] || i.source}`),
        fact('camera', 'Camera', i.camera_name || 'not set', i.nvr_name),
        fact('train', 'Train', i.train_no || 'not set'),
        fact('pin', 'Location', pinLink(i)),
        fact('flag', 'Evidence', flags.length ? `${flags.length} flagged` : 'none flagged', flags.length ? `${flags.filter((f) => f.retention === 'permanent').length} kept for life` : null)),
      i.description ? h('div', { class: 'card2' }, h('h4', {}, 'What is known'), h('div', {}, i.description)) : null,
      mine && !closed ? h('div', { class: 'card2' }, h('h4', {}, 'Record what was done'), noteComposer((text) => api(`/api/incidents/${id}/notes`, { method: 'POST', body: { text } }).then(reopen), { button: 'Save action note' })) : null);

    const footageTab = () => h('div', {}, requestCards(requests, footage, mine),
      flags.length ? h('div', { class: 'card2' }, h('h4', {}, `Evidence flags (${flags.length})`), flags.map((f) => h('div', { class: 'item' },
        f.retention === 'permanent' ? badge('for life', 'indigo') : badge('timed', 'blue'), ' ', badge(ARCH_TEXT[f.archive_status] || f.archive_status, ARCH_CLS[f.archive_status]),
        h('div', {}, `flag #${f.id} - footage #${f.footage_id}${f.section_start_s != null ? ` - ${fmtDur(f.section_start_s)} to ${fmtDur(f.section_end_s)}` : ' - whole file'}`),
        h('div', { class: 'muted' }, f.justification)))) : null);

    const feed = timeline.map((x) => {
      const d = x.details || {};
      const [title, body] = (TL_TEXT[x.action] || (() => [label(x.action.replace(/^(incident|alert)\./, '')), d.note || d.text]))(d);
      const note = x.action === 'incident.note' || (d.note || '').startsWith('Action note:');
      return { title: note ? 'Action note' : title, body: body ? String(body).replace(/^Action note:\s*/, '') : null, who: x.actor, at: x.occurred_at, tone: note ? 'note' : /escalat/.test(x.action) ? 'warn' : '' };
    });
    const steps = [['Raised', i.created_at], ['Under review', i.status === 'under_review' || closed ? true : null], ['Footage', footage.length ? true : null], ['Closed', closed ? i.closed_at : null]];
    return void document.getElementById('drawer-root').replaceChildren(drawerShell({
      tone: closed ? 'done' : i.status === 'under_review' ? 'med' : prioClass(i.priority || 5), icon: ic('folder', 26), title: i.title || label(i.alert_type),
      sub: [subItem('folder', `Incident #${i.id}`), i.camera_name ? subItem('camera', `${i.camera_name} / ${i.nvr_name}`) : null, i.train_no ? subItem('train', i.train_no) : null, subItem('clock', ago(i.occurred_at))],
      ring: i.priority != null ? { pct: Math.min(100, Number(i.priority) * 10), text: `P${i.priority}`, caption: prioText(i.priority) } : null,
      chips: [badge(i.status, INC_CLS[i.status]), badge(label(i.alert_type), 'grey'), requests.length ? badge(`${requests.length} footage request${requests.length === 1 ? '' : 's'}`, 'blue') : null],
      steps,
      tabs: [{ id: 'overview', label: 'Overview', body: overview }, { id: 'footage', label: 'Footage & evidence', count: requests.length + flags.length, body: footageTab },
        { id: 'activity', label: 'Activity', count: feed.length, body: () => activityFeed(feed) }],
      actions }));
  }

  // ---------- forms -----------------------------------------------------------
  const CATEGORIES = [['theft', 'Theft / snatching'], ['harassment', 'Harassment'], ['assault', 'Assault / fight'], ['unattended_bag', 'Unattended bag'], ['fire_smoke', 'Fire / smoke'], ['trespass', 'Trespass / unauthorised entry'], ['vandalism', 'Vandalism'], ['medical', 'Medical emergency'], ['other', 'Other']];

  async function incidentForm({ alert } = {}) {
    if (!alert && !S.cameras.length) S.cameras = await api('/api/cameras');
    const now = new Date();
    const fields = alert ? [
      { name: 'title', label: 'Title (optional)', value: `${label(alert.alert_type)} (P${alert.priority})` },
      { name: 'description', label: 'What you know so far (optional)', type: 'textarea' },
    ] : [
      { name: 'title', label: 'Title', value: '' },
      { name: 'category', label: 'Category', type: 'select', value: 'other', options: CATEGORIES.map(([v, t]) => ({ value: v, label: t })) },
      { name: 'camera_id', label: 'Camera nearest the incident', type: 'select', value: '', options: [{ value: '', label: 'choose a camera...' }, ...S.cameras.map((c) => ({ value: c.id, label: `${c.train_no ? c.train_no + ' - ' : ''}${c.name} / ${c.nvr_name}${c.mount_position ? ` (${c.mount_position})` : ''}` }))] },
      { name: 'occurred_at', label: 'When it happened', type: 'datetime-local', value: toLocalInput(now) },
      { name: 'priority', label: 'Priority (1 low - 10 critical)', type: 'number', value: '5' },
      { name: 'description', label: 'Description', type: 'textarea' },
    ];
    formDialog({
      title: alert ? `Raise incident for this ${label(alert.alert_type)} alert` : 'Raise an incident',
      sub: alert ? 'This acknowledges the alert. You can then request footage for the incident.' : 'For something reported to you directly (a complaint, a patrol sighting) with no alert behind it. Request the footage once it is raised.',
      fields, submitLabel: 'Raise incident',
      submit: async (v) => {
        let created;
        if (alert) {
          created = await api('/api/incidents', { method: 'POST', body: { delivery_id: alert.delivery_id, title: v.title, description: v.description } });
        } else {
          if (!v.title.trim()) throw new Error('give the incident a title');
          if (!v.camera_id) throw new Error('choose the camera nearest the incident');
          created = await api('/api/incidents', { method: 'POST', body: { manual: true, title: v.title, category: v.category, camera_id: Number(v.camera_id),
            occurred_at: new Date(v.occurred_at).toISOString(), priority: Number(v.priority), description: v.description } });
        }
        S.quietUntil = Date.now() + 6000;
        toast(v.title && v.title.trim() ? v.title.trim() : (alert ? label(alert.alert_type) : 'New incident'), 'incident', { title: `Incident #${created.id} raised`, onClick: () => openIncident(created.id) });
        poll(); refresh();
        await openIncident(created.id);
      },
    });
  }

  // ---------- requests / footage actions -------------------------------------
  async function requestForm({ alert, incident }) {
    if (!S.cameras.length) S.cameras = await api('/api/cameras');
    const now = new Date();
    const anchor = incident ? new Date(incident.occurred_at) : alert ? new Date(alert.alert_event_time) : null;
    const start = anchor ? new Date(anchor.getTime() - 5 * 60000) : new Date(now.getTime() - 10 * 60000);
    const end = anchor ? new Date(Math.min(anchor.getTime() + 5 * 60000, now.getTime())) : now;
    const camId = incident ? incident.camera_id : alert ? alert.camera_id : '';
    formDialog({
      title: incident ? `Request footage for incident #${incident.id}` : 'Request footage',
      sub: `A CMS operator approves each request. If the footage is still on the train, CMS fetches it when the train is back in coverage. Maximum window: ${S.cfg.maxRequestWindowMin} minutes.`,
      submitLabel: 'Send request',
      fields: [
        { name: 'camera_id', label: 'Camera', type: 'select', value: camId || '', options: [{ value: '', label: 'choose a camera...' }, ...S.cameras.map((c) => ({ value: c.id, label: `${c.train_no ? c.train_no + ' - ' : ''}${c.name} / ${c.nvr_name}${c.mount_position ? ` (${c.mount_position})` : ''}` }))] },
        { name: 'window_start', label: 'From', type: 'datetime-local', value: toLocalInput(start) },
        { name: 'window_end', label: 'To', type: 'datetime-local', value: toLocalInput(end) },
        { name: 'reason', label: 'Reason', type: 'textarea', value: incident ? (incident.title || '') : '' },
      ],
      submit: async (v) => {
        if (!v.camera_id) throw new Error('choose a camera');
        if (!v.window_start || !v.window_end) throw new Error('choose both a start and an end time');
        const body = { camera_id: Number(v.camera_id), reason: v.reason, window_start: new Date(v.window_start).toISOString(), window_end: new Date(v.window_end).toISOString() };
        if (incident) await api(`/api/incidents/${incident.id}/requests`, { method: 'POST', body });
        else await api('/api/requests', { method: 'POST', body: { ...body, alert_id: alert ? alert.alert_id : undefined } });
        S.quietUntil = Date.now() + 6000;
        toast('Request sent to CMS', 'request');
        await reopen(); refresh();
      },
    });
  }

  async function cancelRequest(id) {
    if (!window.confirm(`Cancel footage request #${id}?`)) return;
    try { await api(`/api/requests/${id}/cancel`, { method: 'POST' }); toast(`Request #${id} cancelled`); await reopen(); refresh(); } catch (ex) { toast(ex.message, 'err'); }
  }

  async function openRequestFootage(requestId) {
    try {
      const { footage } = await api(`/api/requests/${requestId}`);
      if (!footage.length) { toast('No footage has been delivered for this request yet'); return; }
      reviewFootage(footage[0]);
    } catch (ex) { toast(ex.message, 'err'); }
  }

  const startDownload = (url) => { const a = h('a', { href: url, download: '' }); document.body.append(a); a.click(); a.remove(); };

  async function downloadFootage(f, section) {
    try {
      const link = await api(`/api/footage/${f.id}/access`, { method: 'POST', body: { purpose: 'download', ...(section ? { start_s: section.start, end_s: section.end } : {}) } });
      startDownload(link.url);
      toast(section ? `Downloading ${fmtDur(section.end - section.start)} section (original quality, not re-encoded)` : 'Download started - the original file, unmodified');
    } catch (ex) { toast(ex.message, 'err'); }
  }

  /** Dialog with a player. `src` is a fetched link; `after` renders extra controls. */
  function playerBody(link, meta) {
    const problem = h('div', { class: 'note hidden', role: 'alert' });
    const video = h('video', { controls: true, autoplay: true, src: link.url });
    video.addEventListener('error', () => {
      const unsupported = video.error && video.error.code === 4;
      problem.textContent = unsupported
        ? 'This browser cannot play this video (unsupported codec). Use "Save to PC" to download the original file and open it in a media player.'
        : 'Playback failed. The link may have expired - close this window and press Play again.';
      problem.classList.remove('hidden'); video.classList.add('hidden');
    });
    return { video, nodes: [h('div', { class: 'muted' }, meta), video, problem] };
  }

  async function playFlag(f) {
    let link;
    try { link = await api(`/api/flags/${f.id}/access`, { method: 'POST', body: { purpose: 'view' } }); } catch (ex) { toast(ex.message, 'err'); return; }
    const { nodes } = playerBody(link, `Evidence flag #${f.id} - archived clip - ${f.camera_name} / ${f.nvr_name} - viewing is logged`);
    const foot = h('div', { class: 'foot' });
    const { close } = dialog({ title: `Evidence clip #${f.id}`, wide: true, body: [nodes, foot], onClose: () => document.querySelector('dialog video')?.pause() });
    foot.append(h('button', { class: 'btn', onclick: () => downloadFlag(f) }, 'Save to PC'), h('button', { class: 'btn', onclick: close }, 'Close'));
  }
  async function downloadFlag(f) {
    try { const link = await api(`/api/flags/${f.id}/access`, { method: 'POST', body: { purpose: 'download' } }); startDownload(link.url); toast('Download started - the archived evidence clip'); } catch (ex) { toast(ex.message, 'err'); }
  }

  /**
   * The footage reviewer. Officers mark a section (start/end) while watching, then either flag that
   * section for retention (for life, or until a date) or download just that section to their PC.
   */
  async function buildReviewer(f, opts = {}) {
    const closeCb = opts.onFlagged || (() => {});
    let link;
    try { link = await api(`/api/footage/${f.id}/access`, { method: 'POST', body: { purpose: 'view' } }); } catch (ex) { toast(ex.message, 'err'); return null; }
    const canFlag = f.post_id === myPost();
    const baseMs = new Date(f.start_time || f.window_start).getTime();
    const { video, nodes } = playerBody(link, `${f.camera_name} / ${f.nvr_name} - ${fmtTime(f.start_time || f.window_start)}${f.duration_s ? ` - ${fmtDur(f.duration_s)} long` : ''} - viewing is logged`);
    let duration = f.duration_s || 0;
    const sel = { start: null, end: null };

    const clock = h('span', { class: 'mono' }, '0:00');
    const startIn = h('input', { class: 'tin', placeholder: 'm:ss', 'aria-label': 'section start' });
    const endIn = h('input', { class: 'tin', placeholder: 'm:ss', 'aria-label': 'section end' });
    const bar = h('div', { class: 'secbar', title: 'click to seek' }, h('div', { class: 'secsel hidden' }), h('div', { class: 'secpos' }));
    const info = h('div', { class: 'muted' }, 'Mark the part of this footage that matters.');
    const btnPrev = h('button', { class: 'btn sm', type: 'button' }, 'Preview section');
    const btnFlag = h('button', { class: 'btn sm primary', type: 'button' }, 'Flag section for retention...');
    const btnDl = h('button', { class: 'btn sm', type: 'button' }, 'Save section to PC');

    const readInputs = () => { const a = parseDur(startIn.value); const b = parseDur(endIn.value); sel.start = Number.isFinite(a) ? a : null; sel.end = Number.isFinite(b) ? b : null; };
    const valid = () => sel.start != null && sel.end != null && sel.end - sel.start >= 1 && sel.start >= 0 && (!duration || sel.start < duration);
    const paint = () => {
      const selEl = bar.querySelector('.secsel');
      if (valid() && duration) { selEl.classList.remove('hidden'); selEl.style.left = `${(sel.start / duration) * 100}%`; selEl.style.width = `${(Math.min(sel.end, duration) - sel.start) / duration * 100}%`; } else selEl.classList.add('hidden');
      for (const b of [btnPrev, btnFlag, btnDl]) b.disabled = !valid() || (b === btnDl && link.format && false);
      if (!canFlag) btnFlag.classList.add('hidden');
      info.textContent = valid() ? `Section ${fmtDur(sel.start)} - ${fmtDur(sel.end)} (${fmtDur(sel.end - sel.start)}) = ${fmtShort(baseMs + sel.start * 1000)} to ${fmtShort(baseMs + sel.end * 1000)}`
        : 'Mark the part of this footage that matters: play to the start and press "Mark start", then to the end and press "Mark end" (or type m:ss).';
    };
    const setStart = (v) => { startIn.value = fmtDur(v); readInputs(); if (sel.end != null && sel.end <= sel.start) { endIn.value = ''; readInputs(); } paint(); };
    const setEnd = (v) => { endIn.value = fmtDur(v); readInputs(); paint(); };
    startIn.addEventListener('input', () => { readInputs(); paint(); });
    endIn.addEventListener('input', () => { readInputs(); paint(); });
    video.addEventListener('loadedmetadata', () => { if (Number.isFinite(video.duration)) { duration = f.duration_s || video.duration; paint(); } });
    video.addEventListener('timeupdate', () => {
      clock.textContent = `${fmtDur(video.currentTime)} / ${fmtDur(duration || video.duration)} - ${fmtShort(baseMs + video.currentTime * 1000)}`;
      if (duration) bar.querySelector('.secpos').style.left = `${Math.min(100, (video.currentTime / duration) * 100)}%`;
      if (preview && video.currentTime >= sel.end) { video.pause(); preview = false; }
    });
    bar.addEventListener('click', (e) => { if (!duration) return; const r = bar.getBoundingClientRect(); video.currentTime = Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration; });
    let preview = false;
    btnPrev.addEventListener('click', () => { readInputs(); if (!valid()) return; preview = true; video.currentTime = sel.start; video.play(); });
    btnDl.addEventListener('click', () => { readInputs(); if (valid()) downloadFootage(f, { start: sel.start, end: Math.min(sel.end, duration || sel.end) }); });
    btnFlag.addEventListener('click', () => { readInputs(); if (valid()) flagDialog(f, { start: sel.start, end: Math.min(sel.end, duration || sel.end) }, closeCb); });

    const markers = canFlag || f.playable ? h('div', { class: 'secrow' },
      f.playable ? [h('button', { class: 'btn sm', type: 'button', onclick: () => setStart(video.currentTime) }, 'Mark start'), h('button', { class: 'btn sm', type: 'button', onclick: () => setEnd(video.currentTime) }, 'Mark end')] : null,
      h('label', { class: 'inl' }, 'start', startIn), h('label', { class: 'inl' }, 'end', endIn)) : null;

    const node = h('div', { class: 'pad reviewer' }, h('h3', {}, `Footage #${f.id}${f.request_id ? ` - request #${f.request_id}` : ''}`), nodes[0], h('div', { class: 'player' }, nodes[1], nodes[2]),
      h('div', { class: 'secbox' }, h('div', { class: 'secline' }, clock), bar, markers, info, h('div', { class: 'actions' }, btnPrev, canFlag ? btnFlag : null, btnDl)),
      h('div', { class: 'actions mt' }, h('button', { class: 'btn', onclick: () => downloadFootage(f) }, 'Save whole file to PC'), canFlag ? h('button', { class: 'btn', onclick: () => flagDialog(f, null, closeCb) }, 'Flag whole file...') : null));
    paint();
    return { node, pause: () => video.pause() };
  }

  /** Same reviewer in a window (used from the incident and request pages). */
  async function reviewFootage(f) {
    let closeDlg = () => {};
    const rv = await buildReviewer(f, { onFlagged: () => closeDlg() });
    if (!rv) return;
    const foot = h('div', { class: 'foot' });
    const { close } = dialog({ title: `Footage #${f.id}`, wide: true, body: [rv.node, foot], onClose: rv.pause });
    closeDlg = close;
    foot.append(h('button', { class: 'btn', onclick: close }, 'Close'));
  }

  /** Flag a section (or the whole file): retention for life or until a date, justification mandatory. */
  function flagDialog(f, secn, onDone) {
    const until = new Date(Date.now() + S.cfg.defaultRetentionDays * 86400000);
    const baseMs = new Date(f.start_time || f.window_start).getTime();
    const storage = h('select', { name: 'storage' },
      h('option', { value: 'cms' }, 'On CMS - kept beyond the 30-day limit'),
      h('option', { value: 'local' }, 'Locally at this post (RPF) - a copy saved here'),
      h('option', { value: 'both' }, 'Both - CMS and a local copy'));
    const retention = h('select', { name: 'retention' }, h('option', { value: 'permanent' }, 'For life - keep permanently (until an admin releases it)'), h('option', { value: 'timed' }, 'Until a date'));
    const dateIn = h('input', { type: 'datetime-local', value: toLocalInput(until) });
    const dateWrap = h('div', { class: 'hidden' }, h('label', {}, 'Retain until'), dateIn);
    const why = h('textarea', { name: 'justification', maxlength: 2000 });
    const err = h('div', { class: 'err' });
    const save = h('button', { class: 'btn primary', type: 'submit' }, 'Flag for retention');
    const cancel = h('button', { class: 'btn', type: 'button' }, 'Cancel');
    retention.addEventListener('change', () => dateWrap.classList.toggle('hidden', retention.value !== 'timed'));
    const form = h('form', {},
      h('div', { class: 'note' }, secn
        ? `Section ${fmtDur(secn.start)} - ${fmtDur(secn.end)} (${fmtDur(secn.end - secn.start)}) = ${fmtShort(baseMs + secn.start * 1000)} to ${fmtShort(baseMs + secn.end * 1000)}. CMS copies just this section to the data centre.`
        : 'The whole file will be copied to the data centre by CMS.'),
      h('label', {}, 'Where to keep it'), storage,
      h('label', {}, 'How long (the time you enter is recorded with the flag)'), retention, dateWrap,
      h('label', {}, 'Justification (required)'), why, err, h('div', { class: 'foot' }, cancel, save));
    const { close } = dialog({ title: `Flag footage #${f.id} for retention`, sub: 'Flagged footage is never deleted by the 30-day policy. A justification is mandatory (RDSO 3.15.6.2).', body: form });
    cancel.addEventListener('click', close);
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = ''; save.disabled = true;
      try {
        if (!why.value.trim()) throw new Error('a justification is required');
        const body = { justification: why.value, retention: retention.value, storage: storage.value };
        if (retention.value === 'timed') body.retain_to = new Date(dateIn.value).toISOString();
        if (secn) { body.start_s = secn.start; body.end_s = secn.end; }
        const res = await api(`/api/footage/${f.id}/flag`, { method: 'POST', body });
        const where = { cms: 'CMS is archiving the clip', local: 'saved locally at this post', both: 'CMS is archiving it and a local copy is saved' }[storage.value];
        toast(`${retention.value === 'permanent' ? 'Flagged for life' : 'Flagged for retention'} - ${where}`);
        if (res.local_error) toast(`The local copy could not be saved: ${res.local_error}`);
        close(); if (onDone) onDone(); await reopen(); refresh();
      } catch (ex) { err.textContent = ex.message; save.disabled = false; }
    });
  }

  // ---------- notifications ---------------------------------------------------
  /** Marks a notice read and takes the officer to what it is about. Used by the bell list and by the pop-ups. */
  async function openNotice(n) {
    if (!n.read_at) { try { await api('/api/notifications/read', { method: 'POST', body: { ids: [n.id] } }); poll(); } catch (_) { /* not critical */ } }
    const to = (v) => { S.view = v; renderShell(); refresh(); };
    if (n.ref_entity === 'alert_delivery') openAlert(n.ref_id);
    else if (n.ref_entity === 'incident') openIncident(n.ref_id);
    else if (n.ref_entity === 'video_request') to('requests');
    else if (n.ref_entity === 'delivered_footage') to('footage');
    else if (n.ref_entity === 'evidence_flag') to('flags');
  }
  const BAD_NOTICE = /reject|fail|expire|cancel|dismiss/i;
  const noticeKind = (n) => (BAD_NOTICE.test(n.title || '') && n.kind !== 'alert' ? 'err' : n.kind === 'footage' ? 'served' : n.kind === 'alert' ? 'alert' : n.kind === 'incident' ? 'incident' : n.kind === 'evidence' ? 'ok' : 'request');
  function noticeToast(n) {
    const kind = noticeKind(n);
    const generic = { footage: 'Footage delivered', evidence: 'Evidence', request: 'Footage request', incident: 'Incident', alert: 'Alert' }[n.kind];
    if (n.body) toast(n.body, kind, { title: n.title, onClick: () => openNotice(n) });
    else toast(n.title, kind, { title: generic, onClick: () => openNotice(n) });
  }
  document.addEventListener('click', (e) => { const box = document.getElementById('notif-box'); if (box && !box.classList.contains('hidden') && !e.target.closest('#notif-box') && !e.target.closest('#bell')) box.classList.add('hidden'); });
  async function toggleNotifications() {
    const box = document.getElementById('notif-box');
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
    let rows;
    try { rows = await api('/api/notifications'); } catch (ex) { toast(ex.message, 'err'); return; }
    const head2 = h('div', { class: 'notif-head' }, h('b', {}, 'Notices'), h('span', { class: 'spacer' }),
      rows.some((n) => !n.read_at) ? h('button', { class: 'btn sm', onclick: async () => { await api('/api/notifications/read', { method: 'POST', body: {} }); box.classList.add('hidden'); poll(); } }, 'Mark all read') : null);
    toastStyle();
    const items = rows.length ? rows.map((n) => { const k = noticeKind(n); return h('div', { class: `notif-item ${n.read_at ? '' : 'unread'}`, onclick: () => { box.classList.add('hidden'); openNotice(n); } },
      h('div', { class: `nic ${k}` }, ic(TOAST_KIND[k][0], 17)),
      h('div', { class: 'nbody' }, h('div', { class: 'nt' }, n.title), n.body ? h('div', { class: 'nb' }, n.body) : null, h('div', { class: 'nw' }, agoEl(n.created_at)))); })
      : [h('div', { class: 'notif-empty' }, ic('bell', 30), h('div', {}, 'No notices yet.'))];
    box.replaceChildren(head2, ...items);   // spread: an array here would be printed as text ("[object HTMLDivElement]")
    box.classList.remove('hidden');
  }

  // ---------- live polling ---------------------------------------------------
  async function poll(force) {
    let s;
    try { s = await api('/api/alerts/summary'); } catch (_) { return; }
    setPill('unacked-pill', s.unacked); setPill('incidents-pill', s.open_incidents); setPill('requests-pill', s.open_requests); setPill('footage-pill', s.unseen_footage); setPill('flags-pill', s.unread_evidence);
    const bell = document.getElementById('bell-pill');
    if (bell) { bell.textContent = s.unread_notifications; bell.classList.toggle('hidden', !Number(s.unread_notifications)); }
    document.title = s.unacked ? `(${s.unacked}) RPF Dashboard` : 'RPF Dashboard';
    const prev = S.seen;
    S.seen = s;
    watchChanges();
    if (!prev) {
      if (Number(s.unread_notifications) > 0 && !S.announced) { S.announced = true; toast(`${s.unread_notifications} unread notice${Number(s.unread_notifications) === 1 ? '' : 's'} from CMS`, 'info', { title: 'Welcome back', onClick: toggleNotifications }); }
      return;
    }
    if (s.last_delivery_id > prev.last_delivery_id) {
      let a = null;
      try { a = (await api('/api/alerts' + qs({ state: 'all', limit: 5 }))).find((x) => x.delivery_id > prev.last_delivery_id); } catch (_) { /* generic text below */ }
      toast(a ? `${label(a.alert_type)}${a.priority != null ? ` - priority ${a.priority}` : ''}${a.train_no ? ` - train ${a.train_no}` : ''}` : 'New alert received', 'alert',
        a ? { onClick: () => openAlert(a.delivery_id) } : undefined);
    }
    if (s.last_notification_id > prev.last_notification_id) {
      try {
        // every notice CMS writes becomes a pop-up (footage delivered, request decided, evidence archived ...); the notice of a brand-new
        // alert is skipped because the alert has its own pop-up above
        const fresh = (await api('/api/notifications' + qs({ limit: 20 }))).filter((n) => n.id > prev.last_notification_id
          && !(n.ref_entity === 'alert_delivery' && n.ref_id > prev.last_delivery_id)).reverse();
        fresh.slice(0, 3).forEach(noticeToast);
        if (fresh.length > 3) toast(`${fresh.length - 3} more notices - open the bell`, 'info', { onClick: toggleNotifications });
      } catch (_) { /* toast is a courtesy */ }
    }
    const changed = force || ['last_delivery_id', 'last_footage_id', 'last_notification_id', 'unacked', 'open_requests'].some((k) => s[k] !== prev[k]);
    const typing = document.activeElement && /input|select|textarea/i.test(document.activeElement.tagName) && document.getElementById('main') && document.getElementById('main').contains(document.activeElement);
    if (changed && !document.querySelector('dialog[open]') && !typing) { refresh(); if (S.drawer) reopen(); }
  }


  // ---------- pop-ups for incidents and footage requests ------------------------------------------------------------------
  // Compares the lists with what was seen last time and announces what a COLLEAGUE did: a new incident or a new footage request.
  // (What CMS does - approve, deliver, reject, archive - arrives as notices and is announced from there.) The first run only
  // remembers the state, so nothing pops up for old items.
  let watchBusy = false;
  async function watchChanges() {
    if (watchBusy || !S.token) return;
    watchBusy = true;
    try {
      const [incs, reqs] = await Promise.all([api('/api/incidents' + qs({ status: 'all', limit: 100 })), api('/api/requests' + qs({ limit: 100 }))]);
      const W = S.watch; const quiet = Date.now() < (S.quietUntil || 0);
      if (W) {
        for (const i of incs) {
          const was = W.inc.get(i.id);
          if (was === undefined) { if (!quiet && i.source !== 'auto') toast(`${i.title || label(i.alert_type)}${i.priority != null ? ` - P${i.priority}` : ''}`, 'incident', { title: `Incident #${i.id} raised`, onClick: () => openIncident(i.id) }); }
        }
        for (const r of reqs) {
          const was = W.req.get(r.id); const cam = r.camera_name ? ` - ${r.camera_name}` : '';
          if (was === undefined) { if (!quiet) toast(`#${r.id}${cam}`, 'request', { title: 'Footage request sent', onClick: () => go('requests') }); continue; }
          // approved / uploading / delivered / rejected / failed: CMS writes a notice for each, and the notice pop-up announces it
        }
      }
      S.watch = { inc: new Map(incs.map((i) => [i.id, i.status])), req: new Map(reqs.map((r) => [r.id, r.status])) };
    } catch (_) { /* pop-ups are a courtesy; the lists themselves report errors */ }
    finally { watchBusy = false; }
  }

  // ---------- live stream (Server-Sent Events) -------------------------------
  // Postgres triggers -> NOTIFY -> this server -> here, a few milliseconds after the write. EventSource
  // cannot send an Authorization header, so we trade the session for a 60-second ticket first.
  const LIVE = { es: null, timer: null, debounce: null, stopped: true };
  function setLiveDot(on) {
    const d = document.getElementById('live-dot'); if (!d) return;
    d.classList.toggle('on', on); d.title = on ? 'Live: updates appear instantly' : 'Reconnecting... (falling back to periodic refresh)';
    d.lastChild.textContent = on ? 'Live' : 'Reconnecting';
  }
  async function liveOpen() {
    if (LIVE.stopped || !S.token) return;
    let ticket;
    try { ticket = (await api('/api/stream-ticket', { method: 'POST', body: {} })).ticket; }
    catch (_) { setLiveDot(false); LIVE.timer = setTimeout(liveOpen, 2000); return; }
    if (LIVE.stopped) return;
    const es = new EventSource(`/api/stream?ticket=${encodeURIComponent(ticket)}`);
    LIVE.es = es;
    es.addEventListener('hello', () => setLiveDot(true));
    es.addEventListener('change', (e) => {
      let ev = {}; try { ev = JSON.parse(e.data); } catch (_) { /* ignore */ }
      if (ev.t === 'resync') { poll(true); return; }
      clearTimeout(LIVE.debounce);                 // bursts (one action = several rows) become one refresh
      LIVE.debounce = setTimeout(() => poll(true), 80);
    });
    es.onerror = () => { es.close(); if (LIVE.es === es) LIVE.es = null; setLiveDot(false); if (!LIVE.stopped) LIVE.timer = setTimeout(liveOpen, 1000); };
  }
  function liveStart() { liveStop(); LIVE.stopped = false; liveOpen(); }
  function liveStop() { LIVE.stopped = true; clearTimeout(LIVE.timer); clearTimeout(LIVE.debounce); if (LIVE.es) { LIVE.es.close(); LIVE.es = null; } }

  // ---------- boot -----------------------------------------------------------
  async function start() {
    try {
      S.me = await api('/api/auth/me');
      S.cfg = await api('/api/config');
    } catch (ex) { renderLogin(ex.message); return; }
    if (!TABS().some(([id]) => id === S.view)) S.view = 'alerts';
    S.seen = null; S.cameras = []; S.watch = null;
    renderShell();
    await refresh();
    await poll();
    clearInterval(S.pollTimer);
    S.pollTimer = setInterval(() => poll(), 20000);   // safety net only: the live stream does the real work
    liveStart();
  }

  if (S.token) start(); else renderLogin();
})();
