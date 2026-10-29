/* CMS console - login, shell, navigation, refresh loop, boot */
(function () {
  'use strict';
  const C = window.C; const { h, S, api } = C;

  const NAV_ICON = { dashboard: 'gauge', queue: 'bell', alerts: 'alert', incidents: 'folder', map: 'map', requests: 'upload', footage: 'film', evidence: 'flag', fleet: 'train', segments: 'db', registry: 'pin', users: 'users', retention: 'clock', settings: 'cog', jobs: 'activity', audit: 'clip', lab: 'flask' };
  const NAV = [
    ['Operations', [['dashboard', 'Control room'], ['queue', 'Alert queue', 'queue'], ['alerts', 'Alerts', 'unacked'], ['incidents', 'Incidents'], ['map', 'Live map']]],
    ['Footage', [['requests', 'Footage requests', 'decide'], ['footage', 'Delivered footage'], ['evidence', 'Evidence', 'archive_failed']]],
    ['Fleet', [['fleet', 'M-NVR fleet'], ['segments', 'Stored segments']]],
    ['Administration', [['registry', 'Zones & posts'], ['users', 'Users', null, 'admin'], ['retention', 'Retention', null, 'admin'], ['settings', 'Settings', null, 'admin'], ['jobs', 'Jobs & health'], ['audit', 'Audit trail'], ['lab', 'Test lab', null, 'dev']]],
  ];
  const visible = ([id, , , need]) => !need || (need === 'dev' ? !!(S.me && S.me.dev_tools) : C.isAdmin());
  const allViews = () => NAV.flatMap(([, items]) => items.filter(visible).map((i) => i[0]));

  C.renderLogin = function (message) {
    const err = h('div', { class: 'err' }, message || '');
    const user = h('input', { name: 'username', autocomplete: 'username', required: true, autofocus: true });
    const pass = h('input', { name: 'password', type: 'password', autocomplete: 'current-password', required: true });
    const btn = h('button', { class: 'btn primary', type: 'submit' }, 'Sign in');
    const form = h('form', { class: 'login' }, h('h1', {}, 'CMS Console'), h('p', {}, 'Central Management System - control room'), h('label', {}, 'Username'), user, h('label', {}, 'Password'), pass, err, h('div', { class: 'foot' }, btn));
    form.addEventListener('submit', async (e) => {
      e.preventDefault(); err.textContent = ''; btn.disabled = true;
      try { const { token } = await api('/auth/login', { method: 'POST', body: { username: user.value, password: pass.value } }); S.token = token; sessionStorage.setItem('cms_token', token); await start(); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    document.getElementById('app').replaceChildren(h('div', { class: 'login-wrap' }, form));
  };

  C.refreshCounts = async function () {
    try { S.counts = await api('/counts' + C.qs({ zone_id: S.params.zone_id })); } catch (_) { return; }
    document.querySelectorAll('[data-pill]').forEach((el) => { const n = S.counts[el.dataset.pill] || 0; el.textContent = n; el.classList.toggle('hidden', !n); });
    const total = (S.counts.queue || 0) + (S.counts.decide || 0) + (S.counts.escalated || 0);
    document.title = total ? `(${total}) CMS Console` : 'CMS Console';
  };

  function renderShell() {
    const scope = S.me.role === 'super_admin' ? 'All zones' : S.me.zone_name;
    const nav = h('nav', { class: 'side' }, NAV.map(([group, items]) => [h('div', { class: 'grp' }, group), items.filter(visible).map(([id, text, pill]) =>
      h('button', { class: `navitem ${S.view === id ? 'active' : ''}`, 'data-view': id, onclick: () => C.go(id) }, C.ic(NAV_ICON[id] || 'folder', 16), text, pill ? h('span', { class: 'pill hidden', 'data-pill': pill }) : null))]));
    document.getElementById('app').replaceChildren(h('div', { class: 'shell' },
      h('header', { class: 'topbar' }, h('span', { class: 'brand' }, C.ic('shield', 18), 'CMS Console', h('small', {}, S.me.version ? `v${S.me.version}` : '')), h('span', { class: 'who' }, `${S.me.username} - ${C.label(S.me.role)} - ${scope}`),
        h('span', { class: 'live-dot', id: 'live-dot' }, h('i', {}), h('span', {}, 'Connecting')), C.themeButton(),
        h('button', { onclick: () => C.formDialog({ title: 'Change password', fields: [{ name: 'current', label: 'Current password', type: 'password' }, { name: 'next', label: 'New password (8+ characters)', type: 'password' }], submit: async (v) => { await api('/auth/password', { method: 'POST', body: v }); C.toast('Password changed'); } }) }, 'Password'),
        h('button', { onclick: () => C.logout() }, 'Sign out')),
      nav, h('main', { id: 'main' }), h('div', { id: 'drawer-root' })));
  }

  C.go = function (view, params) {
    if (!allViews().includes(view)) view = 'dashboard';
    S.view = view; S.params = { zone_id: S.params.zone_id, ...(params || {}) };
    document.querySelectorAll('.navitem').forEach((b) => b.classList.toggle('active', b.dataset.view === view));
    location.hash = view; C.closeDrawer();
    return C.refresh();
  };

  let rendering = 0;
  C.refresh = async function (opts = {}) {
    const main = document.getElementById('main'); if (!main) return;
    if (opts.live && document.querySelector('dialog[open]')) return;           // never rebuild under an open form
    if (opts.live && /input|textarea|select/i.test((document.activeElement || {}).tagName || '') && main.contains(document.activeElement)) return;
    const my = ++rendering;
    try { const node = await C.views[S.view](); if (my === rendering && node !== main.firstElementChild) { const y = main.scrollTop; main.replaceChildren(node); main.scrollTop = y; }
      if (S.params._focus) { const el = main.querySelector(`input[data-fkey="${S.params._focus}"]`); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } delete S.params._focus; } }
    catch (ex) { if (my === rendering && ex.message !== 'session ended') main.replaceChildren(h('div', { class: 'card empty' }, `Could not load: ${ex.message}`)); }
  };

  // sound + toast on new work, so a busy control room notices without watching the screen
  function chime() { try { const a = new (window.AudioContext || window.webkitAudioContext)(); const o = a.createOscillator(); const g = a.createGain(); o.connect(g); g.connect(a.destination); o.frequency.value = 880; g.gain.value = 0.05; o.start(); o.stop(a.currentTime + 0.12); } catch (_) { /* no audio */ } }
  C.onLive.push((e) => {
    if (e.t === 'alert' && e.op === 'INSERT') { C.toast('New alert', 'alert'); chime(); }
    else if (e.t === 'video_request' && e.op === 'INSERT') { C.toast('New footage request awaiting approval'); chime(); }
    else if (e.t === 'delivered_footage' && e.op === 'INSERT') C.toast('Footage delivered to the post');
    else if (e.t === 'evidence_flag' && e.op === 'INSERT') C.toast('Evidence flagged by a post - archiving');
  });

  async function start() {
    try { S.me = await api('/auth/me'); S.zones = await api('/zones'); } catch (ex) { C.renderLogin(ex.message === 'session ended' ? '' : ex.message); return; }
    const want = location.hash.replace('#', '');
    S.view = allViews().includes(want) ? want : 'dashboard'; S.params = {};
    renderShell();
    await Promise.all([C.refresh(), C.refreshCounts()]);
    C.liveStart();
    clearInterval(S.tick);
    // Safety net + things that change without a database write (NVR heartbeats, "x min ago" text).
    S.tick = setInterval(() => { C.refreshCounts(); if (['fleet', 'map', 'dashboard', 'lab'].includes(S.view)) C.refresh({ live: true }); }, 5000);
  }
  window.addEventListener('hashchange', () => { const v = location.hash.replace('#', ''); if (S.me && v !== S.view && allViews().includes(v)) C.go(v); });
  if (S.token) start(); else C.renderLogin();
})();
