/* CMS console - login, shell, navigation, refresh loop, boot */
(function () {
  'use strict';
  const C = window.C; const { h, S, api } = C;

  const NAV_ICON = { dashboard: 'gauge', queue: 'bell', alerts: 'alert', incidents: 'folder', map: 'map', requests: 'upload', footage: 'film', evidence: 'flag', fleet: 'train', segments: 'db', registry: 'pin', cluster: 'hard', users: 'users', retention: 'clock', settings: 'cog', notify: 'bell', jobs: 'activity', audit: 'clip', lab: 'flask' };
  const NAV = [
    ['Operations', [['dashboard', 'Control room'], ['queue', 'Alert queue', 'queue'], ['alerts', 'Alerts', 'unacked'], ['incidents', 'Incidents'], ['map', 'Live map']]],
    ['Footage', [['requests', 'Footage requests', 'decide'], ['footage', 'Delivered footage'], ['evidence', 'Evidence', 'archive_failed'], ['retention', 'Retention register', 'ext_pending']]],
    ['Fleet', [['fleet', 'M-NVR fleet']]],
    ['Administration', [['registry', 'Zones & posts'], ['cluster', 'Cluster', 'cluster_down'], ['users', 'Users', null, 'admin'], ['settings', 'Settings', null, 'admin'], ['notify', 'E-mail & SMS', null, 'admin'], ['audit', 'Audit trail']]],
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
      try { const { token } = await api('/auth/login', { method: 'POST', body: { username: user.value, password: pass.value } }); S.token = token; C.saveToken(token); await start(); }
      catch (ex) { err.textContent = ex.message; btn.disabled = false; }
    });
    document.getElementById('app').replaceChildren(h('div', { class: 'login-wrap' }, form));
  };

  C.refreshCounts = async function () {
    try { S.counts = await api('/counts' + C.qs({ zone_id: S.params.zone_id })); } catch (_) { return; }
    noticesTick();
    document.querySelectorAll('[data-pill]').forEach((el) => { const n = S.counts[el.dataset.pill] || 0; el.textContent = n; el.classList.toggle('hidden', !n); });
    const total = (S.counts.queue || 0) + (S.counts.decide || 0) + (S.counts.escalated || 0);
    document.title = total ? `(${total}) CMS Console` : 'CMS Console';
  };

  // ---------- the bell: notices for the control room (shared by the zone's console users) ----------
  const NOTICE_ICON = { alert: ['bell', 'alert'], error: ['alert', 'err'], incident: ['folder', 'incident'], request: ['upload', 'info'], evidence: ['flag', 'info'], retention: ['clock', 'info'] };
  S.unread = new Set();      // "alert:12" - the things that have an unread notice: their rows get the boundary until they are opened
  S.noticeLast = null;       // highest unread notice id seen: a higher one means something new arrived
  C.paintNew = (root) => (root || document).querySelectorAll('[data-ref]').forEach((el) => el.classList.toggle('isnew', S.unread.has(el.dataset.ref)));
  C.loadUnread = async function () {
    try {
      const rows = await api('/notices' + C.qs({ unread: 1, limit: 500, zone_id: S.params.zone_id }));
      S.unread = new Set(rows.map((n) => `${n.ref_entity}:${n.ref_id}`)); C.paintNew(); return rows;
    } catch (_) { return []; }
  };
  /** Opening something clears its boundary and its notice, for everybody in the zone. */
  C.seen = async function (entity, id) {
    const key = `${entity}:${id}`; if (!S.unread.has(key)) return;
    S.unread.delete(key); C.paintNew();
    try { await api('/notices/read', { method: 'POST', body: { entity, ref_id: id } }); } catch (_) { /* not critical */ }
    C.refreshCounts();
  };
  const OPEN = { alert: 'openAlert', incident: 'openIncident', train_request: 'openRequest', evidence_flag: 'openFlag' };
  for (const [fn, ent] of [['openAlert', 'alert'], ['openIncident', 'incident'], ['openRequest', 'train_request'], ['openFlag', 'evidence_flag']]) {
    const orig = C[fn]; if (!orig) continue; C[fn] = (id, ...rest) => { C.seen(ent, id); return orig(id, ...rest); };
  }
  // a click on any row that has an unread notice clears it (the row's own click handler opens the details)
  document.addEventListener('click', (e) => {
    const row = e.target.closest && e.target.closest('[data-ref]');
    if (row && S.unread.has(row.dataset.ref)) { const [en, id] = row.dataset.ref.split(':'); C.seen(en, Number(id)); }
    const box = document.getElementById('notif-box');
    if (box && !box.classList.contains('hidden') && !e.target.closest('#notif-box') && !e.target.closest('#bell')) box.classList.add('hidden');
  });
  /** Called with every counts refresh: the bell number, a pop-up for what is new, and the boundaries. */
  async function noticesTick() {
    const unread = S.counts.notices_unread || 0; const last = S.counts.notices_last || 0;
    const pill = document.getElementById('bell-pill'); if (pill) { pill.textContent = unread > 99 ? '99+' : unread; pill.classList.toggle('hidden', !unread); }
    const bell = document.getElementById('bell'); if (bell) bell.title = unread ? `${unread} unread notice${unread === 1 ? '' : 's'}` : 'Notices';
    const known = S.noticeLast; const changed = known === null || last !== known || unread !== S.noticeUnread;
    if (!changed) return;
    S.noticeUnread = unread;
    const rows = await C.loadUnread();
    if (known !== null && last > known) {
      // what is new: a pop-up for the things the console does not already announce by itself (new alerts, requests and flags have their own)
      const fresh = rows.filter((n) => n.id > known && ['incident', 'error', 'retention'].includes(n.kind));
      fresh.slice(0, 3).forEach((n) => C.toast(n.title, n.kind === 'error' ? 'alert' : ''));
      if (fresh.length > 3) C.toast(`${fresh.length - 3} more notices - open the bell`);
      if (fresh.length) chime();
    }
    S.noticeLast = last;
  }
  C.toggleNotices = async function () {
    const box = document.getElementById('notif-box'); if (!box) return;
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
    let rows; try { rows = await api('/notices' + C.qs({ limit: 40, zone_id: S.params.zone_id })); } catch (ex) { C.toast(ex.message); return; }
    const ackAll = h('button', { class: 'btn sm', onclick: async () => { await api('/notices/read', { method: 'POST', body: {} }); box.classList.add('hidden'); await C.refreshCounts(); } }, 'Acknowledge all');
    const head2 = h('div', { class: 'notif-head' }, h('b', {}, 'Notices'), h('span', { class: 'spacer' }), rows.some((n) => !n.read_at) ? ackAll : null);
    const items = rows.length ? rows.map((n) => {
      const [icon, cls] = NOTICE_ICON[n.kind] || ['bell', 'info'];
      const act = h('div', { class: 'nact' });
      const done = () => h('span', { class: 'nack-done' }, C.ic('check', 12), ' Acknowledged');
      const ackBtn = h('button', { class: 'btn sm nack', title: 'Acknowledge this notice (without opening it)', onclick: async (ev) => {
        ev.stopPropagation(); ackBtn.disabled = true;
        try { await api('/notices/read', { method: 'POST', body: { ids: [n.id] } }); n.read_at = new Date().toISOString(); item.classList.remove('unread'); act.replaceChildren(done()); if (!rows.some((x) => !x.read_at)) ackAll.remove(); await C.refreshCounts(); }
        catch (ex) { ackBtn.disabled = false; C.toast(ex.message); } } }, 'Acknowledge');
      act.append(n.read_at ? done() : ackBtn);
      const item = h('div', { class: `notif-item ${n.read_at ? '' : 'unread'}`, onclick: () => {
        box.classList.add('hidden');
        if (OPEN[n.ref_entity] && C[OPEN[n.ref_entity]]) C[OPEN[n.ref_entity]](n.ref_id); // opening it also clears it
        else if (!n.read_at) api('/notices/read', { method: 'POST', body: { ids: [n.id] } }).then(() => C.refreshCounts());
      } }, h('div', { class: `nic ${cls}` }, C.ic(icon, 17)),
      h('div', { class: 'nbody' }, h('div', { class: 'nt' }, n.title), n.body ? h('div', { class: 'nb' }, n.body) : null, h('div', { class: 'nw' }, `${n.post_name ? n.post_name + ' - ' : ''}${C.ago(n.created_at)}`), act));
      return item;
    }) : [h('div', { class: 'notif-empty' }, C.ic('bell', 30), h('div', {}, 'No notices yet.'))];
    box.replaceChildren(head2, ...items);
    box.classList.remove('hidden');
  };

  function renderShell() {
    const scope = S.me.role === 'super_admin' ? 'All zones' : S.me.zone_name;
    const nav = h('nav', { class: 'side' }, NAV.map(([group, items]) => [h('div', { class: 'grp' }, group), items.filter(visible).map(([id, text, pill]) =>
      h('button', { class: `navitem ${S.view === id ? 'active' : ''}`, 'data-view': id, onclick: () => C.go(id) }, C.ic(NAV_ICON[id] || 'folder', 16), text, pill ? h('span', { class: 'pill hidden', 'data-pill': pill }) : null))]));
    document.getElementById('app').replaceChildren(h('div', { class: 'shell' },
      h('header', { class: 'topbar' }, h('span', { class: 'brand' }, C.ic('shield', 18), 'CMS Console', h('small', {}, S.me.version ? `v${S.me.version}` : '')), h('span', { class: 'who' }, `${S.me.username} - ${C.label(S.me.role)} - ${scope}`),
        h('span', { class: 'live-dot', id: 'live-dot' }, h('i', {}), h('span', {}, 'Connecting')),
        h('span', { class: 'bell-wrap' }, h('button', { class: 'bell iconbtn', id: 'bell', title: 'Notices', onclick: (e) => { e.stopPropagation(); C.toggleNotices(); } }, C.ic('bell', 17), h('span', { class: 'pill hidden', id: 'bell-pill' })), h('div', { class: 'notif-box hidden', id: 'notif-box' })), C.themeButton(),
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
    try { const node = await C.views[S.view](); if (my === rendering && node !== main.firstElementChild) { const y = main.scrollTop; main.replaceChildren(node); main.scrollTop = y; C.paintNew(main); }
      if (S.params._focus) { const el = main.querySelector(`input[data-fkey="${S.params._focus}"]`); if (el) { el.focus(); el.setSelectionRange(el.value.length, el.value.length); } delete S.params._focus; } }
    catch (ex) { if (my === rendering && ex.message !== 'session ended') main.replaceChildren(h('div', { class: 'card empty' }, `Could not load: ${ex.message}`)); }
  };

  // sound + toast on new work, so a busy control room notices without watching the screen
  function chime() { try { const a = new (window.AudioContext || window.webkitAudioContext)(); const o = a.createOscillator(); const g = a.createGain(); o.connect(g); g.connect(a.destination); o.frequency.value = 880; g.gain.value = 0.05; o.start(); o.stop(a.currentTime + 0.12); } catch (_) { /* no audio */ } }
  C.onLive.push((e) => {
    if (e.t === 'alert' && e.op === 'INSERT') { C.toast('New alert', 'alert'); chime(); }
    // ONE pop-up per request for a train. The per-camera requests CMS creates for it (video_request) and the files delivered
    // (delivered_footage) are many events for the same request and raise nothing.
    else if (e.t === 'train_request' && e.op === 'INSERT') { C.toast('New footage request for a train, awaiting approval'); chime(); }
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
    S.tick = setInterval(() => { C.refreshCounts(); if (['fleet', 'map', 'dashboard'].includes(S.view)) C.refresh({ live: true }); }, 5000);
  }
  window.addEventListener('hashchange', () => { const v = location.hash.replace('#', ''); if (S.me && v !== S.view && allViews().includes(v)) C.go(v); });
  if (S.token) start(); else C.renderLogin();
})();
