/* CMS console - operations views: dashboard, alert queue, alerts, incidents, requests, footage, evidence */
(function () {
  'use strict';
  const C = window.C; const { h, S, api, badge, fmtDate, stBadge, fmtTime, fmtShort, ago, fmtSize, fmtDur, label, table, head, section, kv, actionBtn, qs, chips, pager, prio, toast } = C;
  const V = C.views;

  const age = (sec) => { sec = Math.round(sec || 0); return sec < 3600 ? `${Math.max(1, Math.round(sec / 60))} min` : sec < 172800 ? `${Math.round(sec / 3600)} h` : `${Math.round(sec / 86400)} days`; };
  const nvrCell = (r) => [`${r.camera_name || 'camera n/a'} / ${r.nvr_name}`, r.train_no ? h('div', { class: 'muted' }, r.train_no) : null];

  // =========================================================================================
  // Dashboard
  // =========================================================================================
  function barChart(rows, key, hi) {
    const w = 640; const hgt = 140; const pad = 22;
    const hours = []; const now = new Date(); now.setMinutes(0, 0, 0);
    const map = new Map(rows.map((r) => [new Date(r.hour).getTime(), r]));
    for (let i = 23; i >= 0; i--) { const t = now.getTime() - i * 3600000; hours.push({ t, n: Number((map.get(t) || {}).n || 0), high: Number((map.get(t) || {}).high || 0) }); }
    const max = Math.max(1, ...hours.map((x) => x.n)); const bw = (w - pad) / 24;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', `0 0 ${w} ${hgt + 20}`); svg.setAttribute('class', 'chart');
    hours.forEach((x, i) => {
      const bh = (x.n / max) * hgt; const hh = (x.high / max) * hgt;
      const r1 = document.createElementNS(ns, 'rect'); r1.setAttribute('x', pad + i * bw + 2); r1.setAttribute('y', hgt - bh); r1.setAttribute('width', bw - 4); r1.setAttribute('height', bh); r1.setAttribute('fill', '#90a4ae');
      const t1 = document.createElementNS(ns, 'title'); t1.textContent = `${new Date(x.t).getHours()}:00 - ${x.n} alerts (${x.high} high priority)`; r1.append(t1); svg.append(r1);
      if (hh) { const r2 = document.createElementNS(ns, 'rect'); r2.setAttribute('x', pad + i * bw + 2); r2.setAttribute('y', hgt - hh); r2.setAttribute('width', bw - 4); r2.setAttribute('height', hh); r2.setAttribute('fill', '#c62828'); svg.append(r2); }
      if (i % 3 === 0) { const tx = document.createElementNS(ns, 'text'); tx.setAttribute('x', pad + i * bw); tx.setAttribute('y', hgt + 14); tx.setAttribute('font-size', '10'); tx.setAttribute('fill', '#6a7686'); tx.textContent = `${new Date(x.t).getHours()}h`; svg.append(tx); }
    });
    const my = document.createElementNS(ns, 'text'); my.setAttribute('x', 0); my.setAttribute('y', 10); my.setAttribute('font-size', '10'); my.setAttribute('fill', '#6a7686'); my.textContent = max; svg.append(my);
    return svg;
  }
  const KPI_IC = { 'Alert queue': 'bell', 'Needs approval': 'check', 'Waiting for train': 'train', 'Unacknowledged': 'alert', 'Open incidents': 'folder', 'NVRs online': 'activity', 'Evidence held': 'flag', 'Footage stored': 'db' };
  const kpi = (title, value, sub, cls, onclick) => h('div', { class: `kpi ${cls || ''} ${onclick ? 'click' : ''}`, onclick }, h('span', { class: 'kpi-ic' }, C.ic(KPI_IC[title] || 'gauge', 18)), h('div', { class: 'kpi-t' }, title), h('div', { class: 'kpi-v' }, value), sub ? h('div', { class: 'kpi-s' }, sub) : null);

  V.dashboard = async () => {
    const d = await api('/dashboard' + qs({ zone_id: S.params.zone_id }));
    S.threshold = d.threshold;
    const go = (view, params) => () => C.go(view, params);
    const attention = d.attention.length ? d.attention.map((a) => h('div', { class: `attn ${a.level}`, onclick: go(a.view, a.params) }, a.text)) : h('div', { class: 'attn ok' }, 'Nothing needs attention right now.');
    return h('div', {},
      head('Control room', C.zoneSelect(), h('span', { class: 'muted' }, `updated ${fmtTime(d.generated_at)}`)),
      h('div', { class: 'kpis' },
        kpi('Alert queue', d.alerts.queue, d.alerts.oldest_queue_s ? `oldest ${age(d.alerts.oldest_queue_s)}` : 'empty', +d.alerts.queue ? 'amber' : 'ok', go('queue')),
        kpi('Needs approval', d.requests.needs_decision, 'footage requests', +d.requests.needs_decision ? 'amber' : 'ok', go('requests', { tab: 'decide' })),
        kpi('Waiting for train', d.requests.awaiting_upload, 'approved, footage still on NVR', +d.requests.awaiting_upload ? 'teal' : '', go('requests', { tab: 'waiting' })),
        kpi('Unacknowledged', d.unacked.n, d.unacked.oldest_s ? `oldest ${age(d.unacked.oldest_s)} at post` : 'all acknowledged', +d.unacked.n ? 'red' : 'ok', go('alerts')),
        kpi('Open incidents', +d.incidents.open + +d.incidents.under_review, `${d.incidents.last_24h} in the last 24 h`, '', go('incidents')),
        kpi('NVRs online', `${d.nvr.online}/${d.nvr.total}`, `${d.nvr.suspended} suspended`, +d.nvr.online < +d.nvr.total ? 'amber' : 'ok', go('fleet')),
        kpi('Evidence held', d.evidence.active, `${d.evidence.permanent} for life - ${fmtSize(d.evidence.archive_bytes)}`, +d.evidence.failed_archive ? 'red' : '', go('evidence')),
        kpi('Footage stored', fmtSize(d.segments.stored_bytes), `${d.segments.stored} segments, ${d.segments.uploading} uploading`, '', go('segments'))),
      h('div', { class: 'cols' },
        h('div', { class: 'card pad' }, h('h3', {}, 'Needs attention'), attention),
        h('div', { class: 'card pad' }, h('h3', {}, `Alerts, last 24 hours (${d.alerts.last_24h}, ${d.alerts.high_24h} high priority)`), barChart(d.by_hour),
          h('div', { class: 'legend' }, h('i', { style: 'background:#90a4ae' }), 'all ', h('i', { style: 'background:#c62828' }), `priority ${d.threshold}+`))),
      h('div', { class: 'cols' },
        h('div', { class: 'card pad' }, h('h3', {}, 'By type (24 h)'), d.by_type.length ? d.by_type.map((t) => { const max = Math.max(...d.by_type.map((x) => +x.n)); return h('div', { class: 'hbar' }, h('span', {}, label(t.alert_type)), h('div', {}, h('i', { style: `width:${(+t.n / max) * 100}%` })), h('b', {}, t.n)); }) : h('div', { class: 'muted' }, 'No alerts in the last 24 hours.')),
        h('div', { class: 'card pad' }, h('h3', {}, 'Recent activity'), d.activity.map((a) => h('div', { class: 'item' }, h('b', {}, a.action), ` ${a.entity}${a.entity_id ? ` #${a.entity_id}` : ''}`, h('div', { class: 'muted' }, `${ago(a.occurred_at)} - ${a.actor || 'system'}`))))));
  };

  // =========================================================================================
  // Alerts: queue + list + drawer
  // =========================================================================================
  async function sendDialog(alertId, { incident }) {
    const data = await api(`/alerts/${alertId}`);
    const a = data.alert;
    if (!data.candidates.length) { toast('No active RPF post exists in this alert\'s zone. Add one under Registry first.'); return; }
    C.formDialog({
      title: `${incident ? 'Send + raise incident' : 'Forward to post'}: ${label(a.alert_type)} P${a.priority}`,
      sub: incident ? 'The post receives the alert with an incident already raised.' : 'The post receives the alert and decides whether to raise an incident.',
      submitLabel: incident ? 'Send and raise incident' : 'Forward',
      fields: [
        { name: 'post_id', label: 'Post (nearest first)', type: 'select', value: data.candidates[0].id, options: data.candidates.map((c) => ({ value: c.id, label: `${c.name} - ${(c.distance_m / 1000).toFixed(1)} km` })) },
        { name: 'note', label: 'Note for the post (optional)', type: 'textarea' },
      ],
      submit: async (v) => { await api(`/alerts/${alertId}/${incident ? 'promote' : 'forward'}`, { method: 'POST', body: { post_id: Number(v.post_id), note: v.note } }); toast('Sent to the post'); C.refresh(); C.reloadDrawer(); },
    });
  }
  function dismissDialog(ids) {
    C.formDialog({ title: ids.length > 1 ? `Dismiss ${ids.length} alerts` : 'Dismiss alert', sub: 'Dismissed alerts leave the queue and are kept in the audit trail.', submitLabel: 'Dismiss', danger: true,
      fields: [{ name: 'reason', label: 'Reason (required)', type: 'textarea' }],
      submit: async (v) => {
        if (!v.reason.trim()) throw new Error('give a reason');
        if (ids.length > 1) { const r = await api('/alerts/dismiss-bulk', { method: 'POST', body: { ids, reason: v.reason } }); toast(`${r.dismissed} dismissed${r.failed.length ? `, ${r.failed.length} failed` : ''}`); }
        else { await api(`/alerts/${ids[0]}/dismiss`, { method: 'POST', body: { reason: v.reason } }); toast('Alert dismissed'); }
        C.refresh(); C.reloadDrawer();
      } });
  }
  const quickSend = (id, incident) => actionBtn(incident ? 'Send + incident' : 'Forward to nearest', async () => {
    const d = await api(`/alerts/${id}`);
    if (!d.candidates.length) throw new Error('no active post in this zone');
    await api(`/alerts/${id}/${incident ? 'promote' : 'forward'}`, { method: 'POST', body: { post_id: d.candidates[0].id } });
    toast(`Sent to ${d.candidates[0].name}`); C.refresh();
  }, incident ? 'primary sm' : 'sm');

  const selected = new Set();
  const TYPE_IC = { intrusion: 'shield', panic_button: 'zap', tamper: 'lock', loitering: 'eye', unattended_bag: 'folder', camera_blocked: 'camera', smoke: 'alert', crowding: 'users' };
  V.queue = async () => {
    const d = await api('/alerts' + qs({ queue: 1, limit: 100, zone_id: S.params.zone_id }));
    S.threshold = S.threshold || 7; const allQueue = [...d.rows];
    [...selected].forEach((id) => { if (!d.rows.some((r) => r.id === id)) selected.delete(id); });
    const bulk = h('button', { class: 'btn danger', disabled: !selected.size, onclick: () => dismissDialog([...selected]) }, `Dismiss selected (${selected.size})`);
    const qs0 = (S.params.qsort || 'old'); const qp = S.params.qprio || '';
    d.rows = d.rows.filter((a) => (qp === 'high' ? a.priority >= 7 : qp === 'low' ? a.priority < 7 : true) && (!S.params.qtype || a.alert_type === S.params.qtype));
    d.rows.sort(qs0 === 'new' ? (x, y) => new Date(y.received_time) - new Date(x.received_time) : qs0 === 'prio' ? (x, y) => y.priority - x.priority : (x, y) => new Date(x.received_time) - new Date(y.received_time));
    const card = (a) => h('article', { class: `qcard ${(Date.now() - new Date(a.received_time).getTime()) > 300000 ? 'old' : ''}` },
      h('div', { class: 'qmain', onclick: (e) => { if (!e.target.closest('input,button')) openAlert(a.id); } },
        h('input', { type: 'checkbox', checked: selected.has(a.id), onchange: (e) => { e.target.checked ? selected.add(a.id) : selected.delete(a.id); bulk.disabled = !selected.size; bulk.textContent = `Dismiss selected (${selected.size})`; } }),
        h('div', { class: 'qico' }, C.ic(TYPE_IC[a.alert_type] || 'alert', 20)),
        h('div', { style: 'min-width:0;flex:1' },
          h('div', { class: 'qrow' }, h('b', { class: 'qtitle' }, label(a.alert_type)), prio(a.priority), h('span', { class: 'muted' }, `waiting ${ago(a.received_time).replace(' ago', '')}`)),
          h('div', { class: 'qmeta' }, C.ic('camera', 13), `${a.camera_name || 'camera n/a'} / ${a.nvr_name}`, a.train_no ? [C.ic('train', 13), a.train_no] : null, C.ic('pin', 13), C.mapLink(a.lat, a.lon), C.ic('clock', 13), fmtTime(a.event_time)))),
      h('div', { class: 'qact' }, quickSend(a.id, true), quickSend(a.id, false), h('button', { class: 'btn sm', onclick: () => sendDialog(a.id, { incident: false }) }, 'Choose post...'), h('button', { class: 'btn sm danger', onclick: () => dismissDialog([a.id]) }, 'Dismiss')));
    return h('div', {},
      head('Alert queue', C.zoneSelect(), bulk),
      h('div', { class: 'filterbar' }, h('label', { class: 'fsel' }, h('span', {}, 'Priority'), h('select', { onchange: (e) => { S.params.qprio = e.target.value; C.refresh(); } }, [['', 'Any'], ['high', 'High (7+)'], ['low', 'Low (below 7)']].map(([v, t]) => h('option', { value: v, selected: v === qp }, t)))),
        h('label', { class: 'fsel' }, h('span', {}, 'Type'), h('select', { onchange: (e) => { S.params.qtype = e.target.value; C.refresh(); } }, [['', 'Any type'], ...[...new Set(allQueue.map((a) => a.alert_type))].map((t) => [t, label(t)])].map(([v, t]) => h('option', { value: v, selected: v === (S.params.qtype || '') }, t)))),
        h('label', { class: 'fsel sort' }, h('span', {}, 'Sort'), h('select', { onchange: (e) => { S.params.qsort = e.target.value; C.refresh(); } }, [['old', 'Waiting longest first'], ['new', 'Newest first'], ['prio', 'Priority (high first)']].map(([v, t]) => h('option', { value: v, selected: v === qs0 }, t)))), h('span', { class: 'fcount' }, `${d.rows.length} in the queue`)),
      h('div', { class: 'note' }, 'Alerts below the auto-dispatch threshold wait here. Forward one to the nearest post, or send it with an incident if it is serious. High-priority alerts never wait: CMS dispatches them and raises the incident itself.'),
      d.rows.length ? h('div', { class: 'qcards' }, d.rows.map(card)) : h('div', { class: 'card empty' }, C.ic('check', 28), h('div', {}, 'The queue is empty.'), h('div', { class: 'muted' }, 'Nothing is waiting for an operator.')));
  };

  const ALERT_STATUSES = ['new', 'routed', 'escalated', 'acknowledged', 'resolved', 'dismissed'];
  V.alerts = async () => {
    const limit = 50; const off = Number(S.params.offset || 0); const P = S.params;
    const [d, types] = await Promise.all([api('/alerts' + qs({ status: P.status, priority_min: P.priority_min, type: P.type, when: P.when, q: P.q, mode: P.mode, sort: P.sort, limit, offset: off, zone_id: P.zone_id })), api('/alerts/types')]);
    const bar = C.filterBar([
      { type: 'search', key: 'q', placeholder: 'Search type, unit, train, post, #...' },
      { key: 'status', label: 'Status', options: [['', 'Any'], ...ALERT_STATUSES.map((x) => [x, label(x)])] },
      { key: 'priority_min', label: 'Priority', options: [['', 'Any'], ['7', 'High (7+)'], ['9', 'P9 and above'], ['1', 'All']] },
      { key: 'type', label: 'Type', options: [['', 'Any type'], ...types.map((t) => [t, label(t)])] },
      { key: 'mode', label: 'Routing', options: [['', 'Any'], ['auto', 'High priority (auto)'], ['manual', 'Below threshold']] },
      { key: 'when', label: 'When', options: C.DATE_OPTS },
    ], [['new', 'Newest first'], ['old', 'Oldest first'], ['prio', 'Priority (high first)'], ['status', 'Needs attention first']]);
    return h('div', {}, head('Alerts', C.zoneSelect(), h('span', { class: 'muted' }, `${d.total} found`)), bar,
      table(['Event time', 'Priority', 'Type', 'Camera / train', 'Zone', 'Status', 'Post', 'Mode'],
        d.rows.map((a) => h('tr', { class: 'click', onclick: () => openAlert(a.id) }, h('td', {}, fmtTime(a.event_time)), h('td', {}, prio(a.priority)), h('td', {}, label(a.alert_type)), h('td', {}, nvrCell(a)), h('td', {}, a.zone_name),
          h('td', {}, stBadge('alert', a.status)), h('td', {}, a.post_name || '-', a.incident_id ? h('div', {}, badge(`incident #${a.incident_id}`, 'red')) : null), h('td', {}, label(a.routing_mode)))),
        'No alerts match these filters.'),
      pager(+d.total, limit, off, (o) => { S.params.offset = o; C.refresh(); }));
  };
  function openAlert(id) {
    C.openDrawer(`alert-${id}`, async () => {
      const d = await api(`/alerts/${id}`);
      const a = d.alert; const waiting = ['new', 'escalated'].includes(a.status); const canDismiss = ['new', 'routed', 'escalated'].includes(a.status);
      return C.drawerShell(`Alert #${a.id} - ${label(a.alert_type)} P${a.priority}`,
        section('Alert', kv([['Event time', fmtTime(a.event_time)], ['Received', `${fmtTime(a.received_time)} (${ago(a.received_time)})`], ['Status', [stBadge('alert', a.status), ' ', h('span', { class: 'muted' }, `routing: ${label(a.routing_mode)}`)]],
          ['Zone', a.zone_name], ['Camera / NVR', nvrCell(a)], ['Location', [C.mapLink(a.lat, a.lon), a.fix_quality ? h('span', { class: 'muted' }, ` (fix ${a.fix_quality}${a.fix_age_s != null ? `, ${a.fix_age_s}s old` : ''})`) : null]],
          ['NVR last seen', d.nvr ? `${ago(d.nvr.last_seen)}` : '-']])),
        (waiting || canDismiss) ? section('Actions', h('div', { class: 'actions' },
          waiting ? [h('button', { class: 'btn', onclick: () => sendDialog(a.id, { incident: false }) }, 'Forward to post...'), h('button', { class: 'btn primary', onclick: () => sendDialog(a.id, { incident: true }) }, 'Send + raise incident...')] : null,
          canDismiss ? h('button', { class: 'btn danger', onclick: () => dismissDialog([a.id]) }, 'Dismiss') : null),
          a.status === 'routed' ? h('div', { class: 'muted mt' }, 'Already at a post and waiting for acknowledgement. Dismiss only if it is not real or is handled elsewhere - the post is told.') : null) : null,
        section(`Deliveries (${d.deliveries.length})`, d.deliveries.length ? d.deliveries.map((x) => h('div', { class: 'item' }, h('b', {}, x.post_name), ' ', badge(x.mode, x.mode === 'escalation' ? 'red' : x.mode === 'auto' ? 'indigo' : 'blue'),
          h('div', { class: 'muted' }, `sent ${fmtTime(x.sent_at)}${x.forwarded_by_username ? ` by ${x.forwarded_by_username}` : ''}`), x.ack_at ? h('div', {}, badge('acknowledged', 'green'), ` ${fmtTime(x.ack_at)} by ${x.ack_by_username}`) : h('div', {}, badge('not acknowledged', 'amber')))) : h('div', { class: 'muted' }, 'Not sent to any post yet.')),
        d.incidents.length ? section('Incidents', d.incidents.map((i) => h('div', { class: 'item' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openIncident(i.id); } }, `#${i.id} ${i.title || ''}`), ' ', stBadge('inc', i.status), h('div', { class: 'muted' }, `${i.post_name} - ${i.source}`)))) : null,
        d.requests.length ? section('Footage requests', d.requests.map((r) => h('div', { class: 'item' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openRequest(r.id); } }, `#${r.id}`), ' ', stBadge('req', r.status), h('div', { class: 'muted' }, `${r.post_name} - ${fmtShort(r.window_start)} to ${fmtShort(r.window_end)}`)))) : null,
        section('History', d.history.map((x) => h('div', { class: 'item' }, `${label(x.from_status || 'received')} -> ${label(x.to_status)}`, h('div', { class: 'muted' }, `${fmtTime(x.changed_at)} - ${x.changed_by_username || 'system'}${x.note ? ` - ${x.note}` : ''}`)))));
    });
  }

  // =========================================================================================
  // Incidents
  // =========================================================================================
  V.incidents = async () => {
    const limit = 50; const off = Number(S.params.offset || 0); const P = S.params;
    const d = await api('/incidents' + qs({ status: P.status || 'active', source: P.source, prio: P.prio, when: P.when, q: P.q, sort: P.sort, limit, offset: off, zone_id: P.zone_id }));
    const bar = C.filterBar([
      { type: 'search', key: 'q', placeholder: 'Search title, unit, train, post, #...' },
      { key: 'source', label: 'Source', options: [['', 'Any'], ['auto', 'Auto (high priority)'], ['operator', 'CMS operator'], ['officer', 'From an alert'], ['manual', 'Manual (no alert)']] },
      { key: 'prio', label: 'Priority', options: [['', 'Any'], ['high', 'High (7+)'], ['low', 'Low (below 7)']] },
      { key: 'when', label: 'Raised', options: C.DATE_OPTS },
    ], [['new', 'Newest first'], ['old', 'Oldest first'], ['prio', 'Priority (high first)'], ['upd', 'Recently updated']]);
    return h('div', {}, head('Incidents', C.zoneSelect(), chips([['active', 'Active'], ['closed', 'Closed'], ['all', 'All']], P.status || 'active', (v) => { S.params.status = v; S.params.offset = 0; C.refresh(); }), h('span', { class: 'muted' }, `${d.total} found`)), bar,
      table(['#', 'Raised', 'Incident', 'Post', 'Camera / train', 'Source', 'Status', 'Footage'],
        d.rows.map((i) => h('tr', { class: 'click', onclick: () => openIncident(i.id) }, h('td', {}, i.id), h('td', {}, fmtTime(i.created_at), h('div', { class: 'muted' }, i.raised_by_username)),
          h('td', {}, h('b', {}, i.title || label(i.alert_type)), h('div', { class: 'muted' }, `${label(i.alert_type)} P${i.priority ?? '?'}`)), h('td', {}, i.post_name), h('td', {}, nvrCell(i)),
          h('td', {}, badge(i.source, i.source === 'auto' ? 'indigo' : i.source === 'manual' ? 'blue' : 'grey')), h('td', {}, stBadge('inc', i.status)), h('td', {}, `${i.requests} req`, +i.flags ? h('div', {}, badge(`${i.flags} flagged`, 'amber')) : null))),
        'No incidents match these filters.'), pager(+d.total, limit, off, (o) => { S.params.offset = o; C.refresh(); }));
  };
  function openIncident(id) {
    C.openDrawer(`incident-${id}`, async () => {
      const d = await api(`/incidents/${id}`); const i = d.incident;
      return C.drawerShell(`Incident #${i.id}`,
        section('Incident', kv([['Title', h('b', {}, i.title || label(i.alert_type))], ['Status', stBadge('inc', i.status)], ['Source', i.source], ['Post', i.post_name], ['Occurred', fmtTime(i.occurred_at)], ['Raised', `${fmtTime(i.created_at)} by ${i.raised_by_username}`],
          ['Camera / train', i.camera_name ? nvrCell(i) : '-'], ['Location', C.mapLink(i.lat, i.lon)], i.description ? ['Description', i.description] : null, i.closed_at ? ['Closed', `${fmtTime(i.closed_at)}${i.closing_note ? ` - ${i.closing_note}` : ''}`] : null,
          d.alert ? ['Alert', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openAlert(d.alert.id); } }, `#${d.alert.id} ${label(d.alert.alert_type)} P${d.alert.priority}`)] : ['Alert', 'none (raised manually by the post)']])),
        section('Actions', h('div', { class: 'actions' },
          h('button', { class: 'btn', onclick: () => C.formDialog({ title: 'Add CMS note', fields: [{ name: 'text', label: 'Note', type: 'textarea' }], submitLabel: 'Add', submit: async (v) => { await api(`/incidents/${id}/note`, { method: 'POST', body: { text: v.text } }); C.reloadDrawer(); } }) }, 'Add note'),
          i.status === 'closed' ? h('button', { class: 'btn', onclick: () => C.formDialog({ title: 'Reopen incident', sub: 'The post is notified.', fields: [{ name: 'reason', label: 'Reason', type: 'textarea' }], submitLabel: 'Reopen', submit: async (v) => { await api(`/incidents/${id}/reopen`, { method: 'POST', body: { reason: v.reason } }); C.reloadDrawer(); C.refresh(); } }) }, 'Reopen') : null)),
        section(`Footage requests (${d.requests.length})`, d.requests.length ? d.requests.map((r) => h('div', { class: 'item' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openRequest(r.id); } }, `#${r.id}`), ' ', stBadge('req', r.status), ' ', r.camera_name, h('div', { class: 'muted' }, `${fmtShort(r.window_start)} to ${fmtShort(r.window_end)}`),
          r.footage_id ? h('div', { class: 'actions' }, h('button', { class: 'btn sm', onclick: () => playFootage(r.footage_id) }, 'Play'), h('button', { class: 'btn sm', onclick: () => downloadFootage(r.footage_id) }, 'Download')) : null)) : h('div', { class: 'muted' }, 'None.')),
        d.flags.length ? section('Evidence flags', d.flags.map((f) => h('div', { class: 'item' }, h('a', { href: '#', onclick: (e) => { e.preventDefault(); openFlag(f.id); } }, `#${f.id}`), ' ', f.retention === 'permanent' ? badge('for life', 'indigo') : badge('timed', 'blue'), ' ', stBadge('arch', f.archive_status), h('div', { class: 'muted' }, f.justification)))) : null,
        section('Timeline', d.timeline.map((t) => h('div', { class: 'item' }, label(t.action.replace('incident.', '')), t.details && (t.details.text || t.details.note || t.details.reason) ? h('div', {}, t.details.text || t.details.note || t.details.reason) : null, h('div', { class: 'muted' }, `${fmtTime(t.occurred_at)} - ${t.actor || 'system'}`)))));
    });
  }

  // =========================================================================================
  // Footage requests
  // =========================================================================================
  const approve = (r) => actionBtn('Approve', async () => { await api(`/requests/${r.id}/approve`, { method: 'POST', body: {} }); toast(`Request #${r.id} approved`); C.refresh(); C.reloadDrawer(); }, 'primary sm');
  function amendDialog(r) {
    C.formDialog({ title: `Amend request #${r.id}`, sub: 'Change the time window, then approve. The post sees both the original and the amended window.', submitLabel: 'Amend and approve',
      fields: [{ name: 'ws', label: 'From', type: 'datetime-local', value: C.toLocalInput(new Date(r.window_start)) }, { name: 'we', label: 'To', type: 'datetime-local', value: C.toLocalInput(new Date(r.window_end)) }, { name: 'note', label: 'Note', type: 'textarea' }],
      submit: async (v) => { await api(`/requests/${r.id}/amend`, { method: 'POST', body: { window_start: new Date(v.ws).toISOString(), window_end: new Date(v.we).toISOString(), note: v.note } }); toast('Amended and approved'); C.refresh(); C.reloadDrawer(); } });
  }
  function rejectDialog(r) {
    C.formDialog({ title: `Reject request #${r.id}`, sub: 'The post is told why.', submitLabel: 'Reject', danger: true, fields: [{ name: 'note', label: 'Reason (required)', type: 'textarea' }],
      submit: async (v) => { await api(`/requests/${r.id}/reject`, { method: 'POST', body: { note: v.note } }); toast('Request rejected'); C.refresh(); C.reloadDrawer(); } });
  }
  const STEPS = ['Sent', 'Approved', 'Fetching', 'Ready'];
  const stepper = (r) => {
    const cur = { submitted: 1, approved: 2, amended: 2, awaiting_upload: 2, fulfilled: 4 }[r.status]; const bad = { rejected: 1, failed: 2, expired: 2, cancelled: 1 }[r.status];
    return h('div', { class: 'pipe' }, STEPS.map((text, i) => { const cls = bad !== undefined ? (i < bad ? 'done' : i === bad ? (r.status === 'cancelled' ? 'stop' : 'bad') : '') : (i < cur ? 'done' : i === cur ? 'now' : '');
      return h('div', { class: `pstep ${cls}` }, h('i', {}, cls === 'done' ? C.ic('check', 10) : cls === 'bad' || cls === 'stop' ? C.ic('x', 10) : ''), h('span', {}, text)); }));
  };
  V.requests = async () => {
    const tab = S.params.tab || 'decide'; const limit = 50; const off = Number(S.params.offset || 0);
    const P = S.params;
    const d = await api('/requests' + qs({ tab: tab === 'all' ? '' : tab, status: P.rstatus, when: P.when, q: P.q, sort: P.sort, limit, offset: off, zone_id: P.zone_id }));
    const rbar = C.filterBar([
      { type: 'search', key: 'q', placeholder: 'Search reason, unit, train, post, officer, #...' },
      { key: 'rstatus', label: 'Status', options: [['', 'Any'], ['submitted', 'Needs decision'], ['awaiting_upload', 'Waiting for train'], ['fulfilled', 'Delivered'], ['rejected', 'Rejected'], ['cancelled', 'Cancelled'], ['failed', 'Failed'], ['expired', 'Expired']] },
      { key: 'when', label: 'Requested', options: C.DATE_OPTS },
    ], [['attn', 'Needs attention first'], ['new', 'Newest first'], ['old', 'Oldest first'], ['win', 'Footage time (newest)']]);
    const cn = S.counts;
    return h('div', {}, head('Footage requests', C.zoneSelect(), chips([['decide', 'Needs decision', cn.decide], ['waiting', 'Waiting for train', cn.waiting], ['done', 'Finished'], ['all', 'All']], tab, (v) => { S.params.tab = v; S.params.offset = 0; C.refresh(); }), h('span', { class: 'muted' }, `${d.total} found`)), rbar,
      table(['#', 'Requested', 'Post', 'Camera / train', 'Window', 'Status', 'Actions'],
        d.rows.map((r) => h('tr', { class: 'click', onclick: (e) => { if (!e.target.closest('button')) openRequest(r.id); } }, h('td', {}, r.id, r.incident_id ? h('div', { class: 'muted' }, `inc #${r.incident_id}`) : null),
          h('td', {}, fmtTime(r.created_at), h('div', { class: 'muted' }, r.requested_by_username)), h('td', {}, r.post_name), h('td', {}, nvrCell(r)),
          h('td', {}, fmtShort(r.window_start), h('div', { class: 'muted' }, `to ${fmtShort(r.window_end)} (${Math.round((new Date(r.window_end) - new Date(r.window_start)) / 60000)} min)`), r.reason ? h('div', { class: 'muted clip' }, r.reason) : null),
          h('td', {}, stepper(r), stBadge('req', r.status), r.status === 'awaiting_upload' ? h('div', { class: 'muted' }, r.nvr_last_seen ? `NVR seen ${ago(r.nvr_last_seen)}` : 'NVR never seen') : null, r.failure_reason ? h('div', { class: 'muted' }, r.failure_reason) : null),
          h('td', {}, r.status === 'submitted' ? h('div', { class: 'actions' }, approve(r), h('button', { class: 'btn sm', onclick: () => amendDialog(r) }, 'Amend'), h('button', { class: 'btn sm danger', onclick: () => rejectDialog(r) }, 'Reject')) : r.status === 'fulfilled' ? h('button', { class: 'btn sm', onclick: () => openRequest(r.id) }, 'Footage') : null))),
        tab === 'decide' ? 'No requests are waiting for a decision.' : 'No requests.'), pager(+d.total, limit, off, (o) => { S.params.offset = o; C.refresh(); }));
  };
  function openRequest(id) {
    C.openDrawer(`request-${id}`, async () => {
      const d = await api(`/requests/${id}`); const r = d.request; const open = ['approved', 'amended', 'awaiting_upload'].includes(r.status);
      const online = r.nvr_last_seen && Date.now() - new Date(r.nvr_last_seen).getTime() < 90000;
      return C.drawerShell(`Request #${r.id}`,
        section('Request', kv([['Status', stBadge('req', r.status)], ['Post', r.post_name], ['Requested', `${fmtTime(r.created_at)} by ${r.requested_by_username}`], ['Camera / train', nvrCell(r)],
          ['Window', `${fmtTime(r.window_start)} to ${fmtTime(r.window_end)}`], r.orig_window_start ? ['Original window', `${fmtTime(r.orig_window_start)} to ${fmtTime(r.orig_window_end)}`] : null, ['Reason', r.reason],
          r.incident_id ? ['Incident', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openIncident(r.incident_id); } }, `#${r.incident_id}`)] : null,
          r.operator_username ? ['Decision', `${r.operator_username} at ${fmtTime(r.decided_at)}${r.decision_note ? ` - ${r.decision_note}` : ''}`] : null, r.failure_reason ? ['Failure', r.failure_reason] : null])),
        r.status === 'submitted' ? section('Decide', h('div', { class: 'actions' }, approve(r), h('button', { class: 'btn', onclick: () => amendDialog(r) }, 'Amend window'), h('button', { class: 'btn danger', onclick: () => rejectDialog(r) }, 'Reject'))) : null,
        ['submitted', 'approved', 'amended', 'awaiting_upload', 'failed'].includes(r.status) ? section('Footage on the CMS', kv([
          ['Covered', d.coverage.covered ? badge('complete', 'green') : badge(d.coverage.segments ? 'partial' : 'not uploaded yet', 'amber')], ['Segments stored', `${d.coverage.segments} (${fmtDur(d.coverage.seconds_have)} of footage)`],
          ['NVR', `${r.nvr_name} - ${online ? 'online' : `offline (last seen ${ago(r.nvr_last_seen)})`}`], d.coverage.gaps.length ? ['Missing', d.coverage.gaps.map((g) => h('div', {}, `${fmtShort(g.from)} to ${fmtShort(g.to)}`))] : null]),
          h('div', { class: 'actions mt' }, open || r.status === 'failed' ? h('button', { class: 'btn sm', onclick: async () => { try { await api(`/requests/${id}/retry-upload`, { method: 'POST', body: {} }); toast('Upload command re-issued'); C.reloadDrawer(); } catch (e) { toast(e.message); } } }, 'Re-send upload command') : null,
            (open || r.status === 'failed') && d.coverage.segments ? h('button', { class: 'btn sm', onclick: async () => { try { await api(`/requests/${id}/deliver-partial`, { method: 'POST', body: {} }); toast('Delivered what the CMS has'); C.refresh(); C.reloadDrawer(); } catch (e) { toast(e.message); } } }, 'Deliver what we have') : null,
            ['submitted', ...['approved', 'amended', 'awaiting_upload']].includes(r.status) ? h('button', { class: 'btn sm danger', onclick: () => C.formDialog({ title: 'Cancel request', fields: [{ name: 'note', label: 'Reason (optional)', type: 'textarea' }], submitLabel: 'Cancel request', danger: true, submit: async (v) => { await api(`/requests/${id}/cancel`, { method: 'POST', body: { note: v.note } }); C.refresh(); C.reloadDrawer(); } }) }, 'Cancel request') : null)) : null,
        d.footage.length ? section('Delivered footage', d.footage.map((f) => h('div', { class: 'item' }, `#${f.id} - ${f.format} - ${fmtSize(f.file_size_bytes)}${f.duration_s ? ` - ${fmtDur(f.duration_s)}` : ''}`, h('div', { class: 'muted' }, `${fmtTime(f.start_time)} to ${fmtTime(f.end_time)} - ${f.segment_count} segment(s)`, h('div', { class: 'mono' }, `sha256 ${f.sha256.slice(0, 20)}...`)),
          h('div', { class: 'actions' }, h('button', { class: 'btn sm primary', onclick: () => playFootage(f.id) }, 'Play'), h('button', { class: 'btn sm', onclick: () => downloadFootage(f.id) }, 'Download'))))) : null,
        d.commands.length ? section('Commands to the NVR', d.commands.map((c) => h('div', { class: 'item' }, `#${c.id} ${label(c.kind)} `, stBadge('cmd', c.status), h('div', { class: 'muted' }, `created ${fmtTime(c.created_at)}${c.completed_at ? `, finished ${fmtTime(c.completed_at)}` : ''}`)))) : null,
        section('History', d.history.map((x) => h('div', { class: 'item' }, label(x.action.replace('request.', '')), h('div', { class: 'muted' }, `${fmtTime(x.occurred_at)} - ${x.actor || 'system'}`)))));
    });
  }
  C.openRequest = openRequest; C.openIncident = openIncident; C.openAlert = openAlert;

  // =========================================================================================
  // Footage + evidence
  // =========================================================================================
  async function playFootage(id) {
    try { const l = await api(`/footage/${id}/link`, { method: 'POST', body: { purpose: 'view' } }); C.playVideo(`Footage #${id}`, 'Viewing is logged in the audit trail.', l, h('button', { class: 'btn', onclick: () => downloadFootage(id) }, 'Download')); } catch (e) { toast(e.message); }
  }
  async function downloadFootage(id) {
    try { const l = await api(`/footage/${id}/link`, { method: 'POST', body: { purpose: 'download' } }); C.download(l.url); toast('Download started (logged)'); } catch (e) { toast(e.message); }
  }
  async function showFootage(st, f) {
    C.selectRow(st, f.id);
    st.pane.replaceChildren(h('div', { class: 'empty' }, 'Loading...'));
    let link;
    try { link = await api(`/footage/${f.id}/link`, { method: 'POST', body: { purpose: 'view' } }); } catch (e) { st.pane.replaceChildren(h('div', { class: 'note' }, e.message)); return; }
    if (st.current !== f.id) return;
    st.pane.replaceChildren(h('div', { class: 'pad' }, h('h3', {}, `Footage #${f.id} - ${f.camera_name} / ${f.nvr_name}`),
      kv([['Post', f.post_name], ['Recorded', `${fmtTime(f.start_time)} to ${fmtTime(f.end_time)} (${f.duration_s ? fmtDur(f.duration_s) : '?'})`], ['Request', h('a', { href: '#', onclick: (e) => { e.preventDefault(); openRequest(f.request_id); } }, `#${f.request_id}`)],
        ['File', `${f.format} ${fmtSize(f.file_size_bytes)} - ${f.segment_count} segment(s)`], ['SHA-256', h('span', { class: 'mono' }, f.sha256)], ['Flags', +f.active_flags ? badge(`${f.active_flags} flagged`, 'amber') : 'none (normal 30-day policy)']]),
      h('div', { class: 'player' }, C.videoEl(link, 'Viewing is logged in the audit trail.')),
      h('div', { class: 'actions mt' }, h('button', { class: 'btn', onclick: () => downloadFootage(f.id) }, 'Download original'))));
  }
  V.footage = async () => {
    const limit = 50; const off = Number(S.params.offset || 0);
    const d = await api('/footage' + qs({ limit, offset: off, zone_id: S.params.zone_id }));
    return C.splitView('footage', {
      head: head('Delivered footage', C.zoneSelect()),
      emptyPane: 'Select a recording to watch it here.',
      list: (st) => h('div', {}, table(['#', 'Post', 'Camera / train', 'Recorded', 'Flags', ''],
        d.rows.map((f) => h('tr', { class: `click ${st.current === f.id ? 'sel' : ''}`, 'data-id': f.id, onclick: () => showFootage(st, f) }, h('td', {}, f.id, h('div', { class: 'muted' }, `req #${f.request_id}`)), h('td', {}, f.post_name), h('td', {}, nvrCell(f)),
          h('td', {}, fmtShort(f.start_time), h('div', { class: 'muted' }, `${f.duration_s ? fmtDur(f.duration_s) : ''} - ${fmtSize(f.file_size_bytes)}`)), h('td', {}, +f.active_flags ? badge(`${f.active_flags} flagged`, 'amber') : h('span', { class: 'muted' }, '30-day')),
          h('td', {}, h('button', { class: 'btn sm primary' }, 'Play')))), 'No footage has been delivered yet.'), pager(+d.total, limit, off, (o) => { S.params.offset = o; C.refresh(); })),
    });
  };

  async function playFlag(f) {
    try { const l = await api(`/evidence/${f.id}/link`, { method: 'POST', body: { purpose: 'view' } }); C.playVideo(`Evidence #${f.id}`, `${f.camera_name} / ${f.nvr_name} - archived clip - logged`, l); } catch (e) { toast(e.message); }
  }
  async function downloadFlag(f) {
    try { const l = await api(`/evidence/${f.id}/link`, { method: 'POST', body: { purpose: 'download' } }); C.download(l.url); toast('Download started (logged)'); } catch (e) { toast(e.message); }
  }
  const sectionText = (f) => (f.section_start_s != null ? `${fmtDur(f.section_start_s)} - ${fmtDur(f.section_end_s)} (${fmtDur(f.section_end_s - f.section_start_s)})` : 'whole file');
  const STORAGE_TEXT = { cms: 'On CMS (kept beyond 30 days)', local: 'Locally at the post only - CMS keeps no copy', both: 'On CMS and a local copy at the post' };
  const storageBadges = (f) => [f.storage !== 'local' ? h('div', {}, f.archive_status === 'archived' ? badge('on CMS', 'green') : stBadge('arch', f.archive_status)) : h('div', {}, badge('not on CMS', 'grey')), f.storage !== 'cms' ? h('div', {}, f.has_local ? badge('local at post', 'teal') : badge('local copy failed', 'red')) : null];
  const flagFacts = (f) => kv([['Kept', STORAGE_TEXT[f.storage] || f.storage], ['Retention', f.retention === 'permanent' ? badge('for life', 'indigo') : `until ${fmtTime(f.retain_to)}`], ['Status', badge(f.status, f.status === 'active' ? 'green' : 'grey')], ['Post', f.post_name],
    ['Footage', `#${f.footage_id} - ${f.camera_name} / ${f.nvr_name}`], ['Section', [sectionText(f), f.section_from ? h('div', { class: 'muted' }, `${fmtTime(f.section_from)} to ${fmtTime(f.section_to)}`) : null]],
    ['Entered at the RPF', `${fmtTime(f.flagged_at)} by ${f.flagged_by_username}`], ['Justification', f.justification],
    f.storage !== 'local' ? ['CMS copy', [stBadge('arch', f.archive_status), f.archive_size_bytes ? ` ${fmtSize(f.archive_size_bytes)}` : '', f.archive_error ? h('div', { class: 'muted' }, f.archive_error) : null]] : null,
    f.storage !== 'cms' ? ['Local copy at the post', f.has_local ? `saved ${fmtTime(f.local_saved_at)} - ${fmtSize(f.local_size_bytes)} (the file is on the post's own server)` : badge(f.local_error || 'not saved', 'red')] : null,
    f.archive_sha256 ? ['CMS SHA-256', h('span', { class: 'mono' }, f.archive_sha256)] : null, f.local_sha256 ? ['Local SHA-256', h('span', { class: 'mono' }, f.local_sha256)] : null,
    f.released_at ? ['Released', `${fmtTime(f.released_at)}${f.released_by_username ? ` by ${f.released_by_username}` : ''} - ${f.release_note}`] : null]);
  async function showFlag(st, f) {
    C.selectRow(st, f.id);
    st.pane.replaceChildren(h('div', { class: 'empty' }, 'Loading...'));
    let player;
    if (f.archive_status === 'archived') {
      try { const link = await api(`/evidence/${f.id}/link`, { method: 'POST', body: { purpose: 'view' } }); player = h('div', { class: 'player' }, C.videoEl(link, 'Archived clip on CMS - viewing is logged.')); } catch (e) { player = h('div', { class: 'note' }, e.message); }
    } else player = h('div', { class: 'note' }, f.storage === 'local' ? 'The recording is kept locally at the post; CMS holds no copy to play. The details below are what the officer entered.' : f.archive_status === 'pending' ? 'CMS is still archiving this recording.' : 'No archived clip on CMS.');
    if (st.current !== f.id) return;
    st.pane.replaceChildren(h('div', { class: 'pad' }, h('h3', {}, `Flagged recording #${f.id}`), player, flagFacts(f),
      h('div', { class: 'actions mt' }, f.archive_status === 'archived' ? h('button', { class: 'btn', onclick: () => downloadFlag(f) }, 'Download CMS copy') : null,
        f.archive_status === 'failed' ? actionBtn('Retry archive', async () => { await api(`/evidence/${f.id}/retry-archive`, { method: 'POST', body: {} }); C.refresh(); }) : null,
        h('button', { class: 'btn', onclick: () => openFlag(f.id) }, 'Chain of custody...'))));
  }
  V.evidence = async () => {
    const limit = 50; const off = Number(S.params.offset || 0);
    const d = await api('/evidence' + qs({ status: S.params.estatus === undefined ? 'active' : S.params.estatus, limit, offset: off, zone_id: S.params.zone_id }));
    return C.splitView('evidence', {
      head: head('Evidence - flagged recordings', C.zoneSelect(), chips([['active', 'Held'], ['released', 'Released'], ['', 'All']], S.params.estatus === undefined ? 'active' : S.params.estatus, (v) => { S.params.estatus = v; S.params.offset = 0; C.refresh(); }), h('span', { class: 'muted' }, `${fmtSize(d.archive_bytes)} archived on CMS`)),
      emptyPane: 'Select a flagged recording to play it and see what the officer entered.',
      list: (st) => h('div', {}, table(['#', 'Flagged', 'Section', 'Kept', 'Copies'],
        d.rows.map((f) => h('tr', { class: `click ${st.current === f.id ? 'sel' : ''}`, 'data-id': f.id, onclick: () => showFlag(st, f) }, h('td', {}, f.id, f.incident_id ? h('div', { class: 'muted' }, `inc #${f.incident_id}`) : null), h('td', {}, fmtShort(f.flagged_at), h('div', { class: 'muted' }, `${f.flagged_by_username} - ${f.post_name}`)),
          h('td', {}, sectionText(f), h('div', { class: 'muted' }, `${f.camera_name} / ${f.nvr_name}`)), h('td', {}, f.retention === 'permanent' ? badge('for life', 'indigo') : [badge('timed', 'blue'), h('div', { class: 'muted' }, `until ${C.fmtDate(f.retain_to)}`)], f.status !== 'active' ? h('div', {}, badge(f.status, 'grey')) : null), h('td', {}, storageBadges(f)))),
        'Nothing has been flagged.'), pager(+d.total, limit, off, (o) => { S.params.offset = o; C.refresh(); })),
    });
  };
  function openFlag(id) {
    C.openDrawer(`flag-${id}`, async () => {
      const { flag: f, custody } = await api(`/evidence/${id}`);
      return C.drawerShell(`Evidence flag #${f.id}`,
        section('Flag', flagFacts(f)),
        section('Actions', h('div', { class: 'actions' }, f.archive_status === 'archived' ? [h('button', { class: 'btn primary', onclick: () => playFlag(f) }, 'Play clip'), h('button', { class: 'btn', onclick: () => downloadFlag(f) }, 'Download')] : null,
          f.archive_status === 'failed' ? actionBtn('Retry archive', async () => { await api(`/evidence/${id}/retry-archive`, { method: 'POST', body: {} }); C.reloadDrawer(); }) : null,
          C.isAdmin() && f.status === 'active' ? h('button', { class: 'btn danger', onclick: () => C.formDialog({ title: 'Release evidence flag', sub: 'Ends the retention hold. The post is notified. A timed flag also releases itself when its date passes.', fields: [{ name: 'note', label: 'Reason (required)', type: 'textarea' }], submitLabel: 'Release', danger: true, submit: async (v) => { await api(`/evidence/${id}/release`, { method: 'POST', body: { note: v.note } }); C.reloadDrawer(); C.refresh(); } }) }, 'Release hold...') : null)),
        section('Chain of custody', custody.map((x) => h('div', { class: 'item' }, h('b', {}, x.action), h('div', { class: 'muted' }, `${fmtTime(x.occurred_at)} - ${x.actor || 'system'}`)))));
    });
  }
  C.openFlag = openFlag;
})();
