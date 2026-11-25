'use strict';
/**
 * The complete story of ONE incident, built from the shared database - so the CMS console and the post's dashboard
 * always show exactly the same thing (this file is identical in both servers).
 *
 *   build(pool, incident, { scope: 'cms' | 'post' })  ->  { stages, waiting_on, summary, footage, events }
 *
 *   stages      the progress tracker: alert -> sent to post -> acknowledged -> incident -> review -> footage requested ->
 *               footage delivered -> evidence retained -> closed.  state: done | active | pending | na
 *   waiting_on  who has to act next ("cms" | "post" | "train" | null) and what for, in words
 *   summary     counts for list views (requests, cameras ready, files, flags, last activity)
 *   footage     every delivered recording of the incident (with SHA-256, who viewed it, whether it is retained)
 *   events      the action trail, oldest first: who did what, when, on which side (cms | post | system)
 *
 * Scope 'post' only ever shows the incident's own post (never another post an alert was also sent to).
 */

const label = (s) => String(s == null ? '' : s).replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const day = (d) => new Date(d).toISOString().slice(0, 10);
const mins = (a, b) => Math.max(0, Math.round((new Date(b) - new Date(a)) / 60000));
const ago = (d) => {
  const m = mins(d, Date.now());
  return m < 1 ? 'just now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};
const sideOf = (actor, actorPost) => (!actor ? 'system' : actorPost ? 'post' : 'cms');

/** How an audit row reads. Returns [title, body, tone, icon] or null to leave it out (the same fact is already an event of its own). */
function auditText(a) {
  const d = a.details || {};
  switch (a.action) {
    case 'incident.create': return null; // shown as "Incident opened" from the incident row
    case 'incident.status': return [`Status changed: ${label(d.from)} to ${label(d.to)}`, d.note, d.to === 'closed' ? 'done' : '', 'eye'];
    case 'incident.note': return ['Action note', d.text, 'note', 'folder'];
    case 'incident.reopen': return ['Reopened by CMS', d.reason, 'warn', 'alert'];
    case 'train_request.create': return null; // shown from the request row
    case 'train_request.approve': return ['Footage request approved', d.note, 'done', 'check'];
    case 'train_request.amend': return ['Footage request amended and approved', d.note, '', 'folder'];
    case 'train_request.reject': return ['Footage request rejected', d.note, 'bad', 'x'];
    case 'train_request.cancel': return ['Footage request cancelled', null, '', 'x'];
    case 'train_request.awaiting_upload': return null; // told by the per-camera line below
    case 'train_request.expanded': return ['Every M-NVR of the train was asked for its footage', null, '', 'train'];
    case 'train_request.fulfilled': return ['All requested footage is ready', null, 'done', 'check'];
    case 'train_request.partial': return ['Part of the requested footage is ready', null, '', 'film'];
    case 'train_request.failed': return ['Footage request failed', d.reason || d.note, 'bad', 'alert'];
    case 'train_request.expired': return ['Footage request expired', null, 'bad', 'clock'];
    case 'request.awaiting_upload': return ['Asked the train for its footage - waiting for the upload', null, '', 'train'];
    case 'request.fulfil': return null; // shown as "Footage delivered"
    case 'request.force_deliver': return ['Delivered with the footage that was available', d.note, '', 'film'];
    case 'request.reissue_upload': return ['Upload asked for again', null, '', 'upload'];
    case 'request.cancel': return ['Camera request cancelled', d.note, '', 'x'];
    case 'request.failed': return ['Camera request failed', d.reason || d.note, 'bad', 'alert'];
    case 'request.expired': return ['Camera request expired', null, 'bad', 'clock'];
    case 'footage.view': return ['Footage viewed', d.request_id ? `request #${d.request_id}` : null, '', 'eye'];
    case 'footage.download': case 'footage.download.served': return ['Footage downloaded', d.request_id ? `request #${d.request_id}` : null, '', 'download'];
    case 'footage.download.section': return ['Footage section downloaded', null, '', 'download'];
    case 'footage.flag': return null; // shown from the evidence flag row
    case 'evidence.archive': return ['Evidence copy archived at the data centre', d.sha256 ? `SHA-256 ${String(d.sha256).slice(0, 16)}...` : null, 'done', 'shield'];
    case 'evidence.archive_failed': return ['Evidence archive failed', d.error, 'bad', 'alert'];
    case 'evidence.retry_archive': return ['Evidence archive retried', null, '', 'upload'];
    case 'evidence.local_save': return ['Evidence copy saved at the post', null, '', 'hard'];
    case 'evidence.extend_request': return ['Longer retention requested', [d.to ? `kept ${d.to}` : null, d.justification].filter(Boolean).join(' - '), 'warn', 'clock'];
    case 'evidence.extend_approve': return ['Longer retention approved', [d.to ? `now kept ${d.to}` : null, d.note].filter(Boolean).join(' - '), 'done', 'check'];
    case 'evidence.extend_reject': return ['Longer retention rejected', d.note, 'bad', 'x'];
    case 'evidence.extend': return ['Retention extended by CMS', [d.to ? `now kept ${d.to}` : null, d.justification].filter(Boolean).join(' - '), 'done', 'clock'];
    case 'evidence.release': return ['Evidence released by CMS', d.note, '', 'flag'];
    case 'evidence.expire': return ['Retention period ended - evidence released', null, '', 'clock'];
    case 'evidence.view': case 'evidence.download': return [a.action === 'evidence.view' ? 'Evidence viewed' : 'Evidence downloaded', null, '', 'eye'];
    case 'evidence.verify': return [`Checksum verified: ${d.result || ''}`.trim(), d.text, d.ok === false ? 'bad' : 'done', 'shield'];
    case 'alert.ack': return null; // shown from the delivery row
    case 'alert.note': return ['Alert note', d.text || d.note, 'note', 'folder'];
    case 'alert.resolve': return ['Alert resolved', d.note, 'done', 'check'];
    default: return [label(a.action.replace(/^[a-z_]+\./, '')), d.note || d.text || d.reason || null, '', 'clock'];
  }
}

async function build(pool, inc, { scope = 'cms' } = {}) {
  const q = (sql, params) => pool.query(sql, params).then((r) => r.rows);
  const onlyPost = scope === 'post';
  const events = [];
  const add = (e) => events.push({ tone: '', icon: 'clock', body: null, actor: null, side: 'system', ref: null, ...e });

  // ---- the alert behind it, and how it reached the post(s) ----
  let alert = null; let deliveries = []; let history = [];
  if (inc.alert_delivery_id) {
    [alert] = await q(
      `SELECT a.id, a.alert_type, a.priority, a.event_time, a.received_time, a.nvr_id, n.name AS nvr_name, n.train_no, a.event_time AS et
         FROM alert_delivery d JOIN alert a ON a.id = d.alert_id AND a.event_time = d.alert_event_time JOIN nvr_unit n ON n.id = a.nvr_id WHERE d.id = $1`, [inc.alert_delivery_id]);
    if (alert) {
      deliveries = await q(
        `SELECT d.id, d.post_id, p.name AS post_name, d.sent_at, d.ack_at, d.mode, uf.username AS forwarded_by, ua.username AS ack_by, d.escalated_from
           FROM alert_delivery d JOIN rpf_post p ON p.id = d.post_id LEFT JOIN users uf ON uf.id = d.forwarded_by LEFT JOIN users ua ON ua.id = d.ack_by
          WHERE d.alert_id = $1 AND d.alert_event_time = $2 ${onlyPost ? 'AND d.post_id = $3' : ''} ORDER BY d.sent_at, d.id`,
        onlyPost ? [alert.id, alert.et, inc.post_id] : [alert.id, alert.et]);
      history = await q(
        `SELECT h.changed_at, h.from_status, h.to_status, h.note, u.username AS actor, u.post_id AS actor_post
           FROM alert_history h LEFT JOIN users u ON u.id = h.changed_by WHERE h.alert_id = $1 AND h.alert_event_time = $2 ORDER BY h.changed_at, h.id`, [alert.id, alert.et]);
      if (onlyPost) history = history.filter((h) => (h.actor_post == null || h.actor_post === inc.post_id) && !(/(dispatched|escalated|forwarded) to /i.test(h.note || '') && !String(h.note).toLowerCase().includes(String(inc.post_name || '').toLowerCase())));
      add({ at: alert.received_time || alert.event_time, kind: 'alert', icon: 'zap', title: `Alert detected: ${label(alert.alert_type)} (priority ${alert.priority})`, body: `${alert.nvr_name}${alert.train_no ? ` - train ${alert.train_no}` : ''}`, side: 'system', ref: { entity: 'alert', id: alert.id } });
      for (const h of history) {
        if (h.to_status === 'acknowledged' || h.to_status === 'routed') continue; // told by the delivery rows below
        add({ at: h.changed_at, kind: 'alert', icon: /escalat/.test(h.to_status) ? 'alert' : 'bell', tone: /escalat/.test(h.to_status) ? 'warn' : '', title: `Alert ${h.to_status}`, body: h.note && !/^acknowledged at/.test(h.note) ? h.note : null, actor: h.actor, side: sideOf(h.actor, h.actor_post) });
      }
      for (const d of deliveries) {
        const how = d.mode === 'operator' ? `forwarded by ${d.forwarded_by || 'a CMS operator'}` : d.mode === 'escalation' ? 'escalated (nobody acknowledged it in time)' : 'dispatched automatically';
        add({ at: d.sent_at, kind: 'delivery', icon: 'bell', tone: d.mode === 'escalation' ? 'warn' : '', title: `Sent to ${d.post_name}`, body: how, side: d.mode === 'operator' ? 'cms' : 'system', actor: d.forwarded_by });
        if (d.ack_at) add({ at: d.ack_at, kind: 'delivery', icon: 'check', tone: 'done', title: `Acknowledged at ${d.post_name}`, body: mins(d.sent_at, d.ack_at) ? `after ${mins(d.sent_at, d.ack_at)} min` : null, actor: d.ack_by, side: 'post' });
      }
    }
  }

  // ---- the incident itself ----
  const [closer] = inc.closed_at ? await q(`SELECT u.username FROM incident i LEFT JOIN users u ON u.id = i.closed_by WHERE i.id = $1`, [inc.id]) : [null];
  add({ at: inc.created_at, kind: 'incident', icon: 'folder', tone: 'done', title: 'Incident opened', body: [{ auto: 'dispatched automatically by CMS', operator: 'promoted by a CMS operator', officer: 'raised by an officer from the alert', manual: 'raised by an officer (no alert behind it)' }[inc.source] || null, inc.title].filter(Boolean).join(' - '), actor: inc.raised_by_username, side: ['auto'].includes(inc.source) ? 'system' : inc.source === 'operator' ? 'cms' : 'post', ref: { entity: 'incident', id: inc.id } });
  if (inc.closed_at) add({ at: inc.closed_at, kind: 'incident', icon: 'check', tone: 'done', title: 'Incident closed', body: inc.closing_note || null, actor: closer && closer.username, side: 'post', ref: { entity: 'incident', id: inc.id } });

  // ---- footage requests, cameras, delivered files, evidence ----
  const trs = await q(
    `SELECT t.id, t.train_no, t.status, t.window_start, t.window_end, t.reason, t.created_at, t.decided_at, t.decision_note, t.cameras_total, t.cameras_fulfilled, t.cameras_open, t.cameras_failed, t.failure_reason, t.fulfilled_at,
            ur.username AS requested_by, uo.username AS decided_by
       FROM train_request t LEFT JOIN users ur ON ur.id = t.requested_by LEFT JOIN users uo ON uo.id = t.operator_id
      WHERE t.post_id = $2 AND (t.incident_id = $1 ${alert ? 'OR t.alert_id = $3' : ''}) ORDER BY t.id`, alert ? [inc.id, inc.post_id, alert.id] : [inc.id, inc.post_id]);
  const trIds = trs.map((t) => t.id);
  for (const t of trs) {
    add({ at: t.created_at, kind: 'request', icon: 'upload', title: `Footage requested for train ${t.train_no}`, body: `${new Date(t.window_start).toISOString().slice(0, 16).replace('T', ' ')} to ${new Date(t.window_end).toISOString().slice(11, 16)} UTC${t.reason ? ` - ${t.reason}` : ''}`, actor: t.requested_by, side: 'post', ref: { entity: 'train_request', id: t.id } });
  }
  const vrs = await q(
    `SELECT r.id, r.status, r.camera_id, c.name AS camera_name, r.train_request_id, r.fulfilled_at, r.failure_reason, f.id AS footage_id, f.delivered_at, f.file_size_bytes, f.sha256, f.format, f.duration_s, f.start_time, f.end_time, f.camera_no, f.unit_no, f.file_name, f.train_no
       FROM video_request r JOIN camera c ON c.id = r.camera_id LEFT JOIN delivered_footage f ON f.video_request_id = r.id
      WHERE r.post_id = $3 AND (r.incident_id = $1 OR r.train_request_id = ANY($2)) ORDER BY r.id`, [inc.id, trIds, inc.post_id]);
  const fIds = vrs.filter((v) => v.footage_id).map((v) => v.footage_id);
  const flags = await q(
    `SELECT e.id, e.footage_id, e.retention, e.retain_to, e.status, e.archive_status, e.archived_at, e.flagged_at, e.justification, e.section_start_s, e.section_end_s, e.ext_status, u.username AS flagged_by
       FROM evidence_flag e JOIN users u ON u.id = e.flagged_by JOIN delivered_footage f ON f.id = e.footage_id JOIN video_request r ON r.id = f.video_request_id
      WHERE r.post_id = $2 AND (e.incident_id = $1 OR e.footage_id = ANY($3)) ORDER BY e.id`, [inc.id, inc.post_id, fIds]);
  const flagIds = flags.map((f) => f.id);
  for (const v of vrs) {
    if (v.footage_id) add({ at: v.delivered_at, kind: 'footage', icon: 'film', tone: 'done', title: `Footage delivered: camera ${v.camera_no || ''} ${v.camera_name || ''}`.replace(/\s+/g, ' ').trim(), body: `${v.format}, ${Math.max(1, Math.round(v.file_size_bytes / 1024))} KB${v.duration_s ? `, ${Math.round(v.duration_s)} s` : ''} - SHA-256 ${String(v.sha256).slice(0, 12)}...`, side: 'system', ref: { entity: 'delivered_footage', id: v.footage_id } });
    else if (v.status === 'failed') add({ at: v.fulfilled_at || new Date(), kind: 'footage', icon: 'alert', tone: 'bad', title: `Footage could not be fetched: ${v.camera_name}`, body: v.failure_reason, side: 'system' });
  }
  for (const f of flags) {
    add({ at: f.flagged_at, kind: 'evidence', icon: 'flag', tone: 'warn', title: `Evidence flagged (${f.retention === 'permanent' ? 'kept for life' : `kept until ${day(f.retain_to)}`})`, body: f.justification, actor: f.flagged_by, side: 'post', ref: { entity: 'evidence_flag', id: f.id } });
    if (f.archive_status === 'archived' && f.archived_at) add({ at: f.archived_at, kind: 'evidence', icon: 'shield', tone: 'done', title: `Evidence flag #${f.id} archived at the data centre`, side: 'system', ref: { entity: 'evidence_flag', id: f.id } });
  }

  // ---- who did what (the append-only audit trail of everything above) ----
  const dIds = deliveries.map((d) => d.id);
  const auditRows = await q(
    `SELECT a.occurred_at, a.entity, a.entity_id, a.action, a.details, u.username AS actor, u.post_id AS actor_post
       FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
      WHERE (a.entity = 'incident' AND a.entity_id = $1) OR (a.entity = 'train_request' AND a.entity_id = ANY($2)) OR (a.entity = 'video_request' AND a.entity_id = ANY($3))
         OR (a.entity = 'delivered_footage' AND a.entity_id = ANY($4)) OR (a.entity = 'evidence_flag' AND a.entity_id = ANY($5)) OR (a.entity = 'alert_delivery' AND a.entity_id = ANY($6))
      ORDER BY a.occurred_at, a.id`, [inc.id, trIds, vrs.map((v) => v.id), fIds, flagIds, dIds]);
  const views = new Map(); // footage id -> { n, last, by:Set }
  const vrById = new Map(vrs.map((v) => [v.id, v]));
  const grouped = new Map(); // one line for "the same thing happened to N cameras"
  for (const a of auditRows) {
    if (a.entity === 'delivered_footage' && /^footage\.(view|download)/.test(a.action)) {
      const v = views.get(a.entity_id) || { n: 0, last: null, by: new Set() }; v.n++; v.last = a.occurred_at; if (a.actor) v.by.add(a.actor); views.set(a.entity_id, v);
    }
    // a post only sees what its own people did, plus everything CMS did for it
    if (onlyPost && a.actor_post != null && a.actor_post !== inc.post_id) continue;
    const t = auditText(a);
    if (!t) continue;
    const ref = { entity: a.entity === 'video_request' ? 'train_request' : a.entity, id: a.entity_id };
    if (a.entity === 'video_request') {
      const gk = `${a.action}|${(vrById.get(a.entity_id) || {}).train_request_id}|${new Date(a.occurred_at).toISOString().slice(0, 16)}`;
      const g = grouped.get(gk);
      if (g) { g.n++; g.ev.body = `${g.n} cameras`; continue; }
      add({ at: a.occurred_at, kind: 'request', title: t[0], body: t[1] || null, tone: t[2] || '', icon: t[3] || 'clock', actor: a.actor, side: sideOf(a.actor, a.actor_post), ref });
      grouped.set(gk, { n: 1, ev: events[events.length - 1] });
      continue;
    }
    add({ at: a.occurred_at, kind: a.entity === 'delivered_footage' ? 'footage' : a.entity === 'evidence_flag' ? 'evidence' : a.entity === 'incident' ? 'incident' : 'request', title: t[0], body: t[1] || null, tone: t[2] || '', icon: t[3] || 'clock', actor: a.actor, side: sideOf(a.actor, a.actor_post), ref });
  }

  events.sort((x, y) => new Date(x.at) - new Date(y.at));

  // ---- footage list (what is actually on file for this incident) ----
  const flagByFootage = new Map(flags.filter((f) => f.status === 'active').map((f) => [f.footage_id, f]));
  const footage = vrs.map((v) => ({
    request_id: v.id, train_request_id: v.train_request_id, status: v.status, camera_name: v.camera_name, camera_no: v.camera_no, unit_no: v.unit_no, train_no: v.train_no,
    footage_id: v.footage_id, delivered_at: v.delivered_at, start_time: v.start_time, end_time: v.end_time, duration_s: v.duration_s, format: v.format, file_size_bytes: v.file_size_bytes, sha256: v.sha256, failure_reason: v.failure_reason,
    views: v.footage_id && views.get(v.footage_id) ? { count: views.get(v.footage_id).n, last: views.get(v.footage_id).last, by: [...views.get(v.footage_id).by] } : null,
    flag: v.footage_id && flagByFootage.get(v.footage_id) ? { id: flagByFootage.get(v.footage_id).id, retention: flagByFootage.get(v.footage_id).retention, retain_to: flagByFootage.get(v.footage_id).retain_to } : null,
  }));

  // ---- progress + who has to act next ----
  const mine = deliveries.find((d) => d.post_id === inc.post_id) || deliveries[0] || null;
  const delivered = footage.filter((f) => f.footage_id).length;
  const activeFlags = flags.filter((f) => f.status === 'active');
  const openReqs = trs.filter((t) => ['submitted', 'approved', 'awaiting_upload'].includes(t.status));
  const closed = inc.status === 'closed';
  const st = (done, active) => (done ? 'done' : active ? 'active' : 'pending');
  const stages = [];
  if (alert) {
    stages.push({ key: 'detected', label: 'Alert detected', state: 'done', at: alert.received_time || alert.event_time });
    stages.push({ key: 'sent', label: 'Sent to post', state: mine ? 'done' : 'active', at: mine && mine.sent_at, detail: mine && (mine.mode === 'operator' ? 'forwarded by CMS' : mine.mode === 'escalation' ? 'escalated' : 'auto') });
    stages.push({ key: 'ack', label: 'Acknowledged', state: st(mine && mine.ack_at, mine && !mine.ack_at), at: mine && mine.ack_at, by: mine && mine.ack_by, detail: mine && !mine.ack_at ? `waiting ${ago(mine.sent_at)}` : null });
  }
  stages.push({ key: 'incident', label: 'Incident opened', state: 'done', at: inc.created_at, by: inc.raised_by_username });
  stages.push({ key: 'review', label: 'Under review', state: st(inc.status !== 'open', inc.status === 'open' && !closed), at: null });
  stages.push({ key: 'requested', label: 'Footage requested', state: st(trs.length, false), detail: trs.length ? `${trs.length} request${trs.length === 1 ? '' : 's'}` : 'none yet' });
  stages.push({ key: 'delivered', label: 'Footage delivered', state: st(delivered, openReqs.length), detail: trs.length ? `${trs.reduce((s, t) => s + (t.cameras_fulfilled || 0), 0)} of ${trs.reduce((s, t) => s + (t.cameras_total || 0), 0)} cameras ready` : null });
  stages.push({ key: 'evidence', label: 'Evidence retained', state: st(activeFlags.length, false), detail: activeFlags.length ? `${activeFlags.length} flagged` : 'none flagged' });
  stages.push({ key: 'closed', label: 'Closed', state: st(closed, false), at: inc.closed_at, by: closer && closer.username });

  let waiting = null;
  const pendingExt = flags.find((f) => f.status === 'active' && f.ext_status === 'pending');
  const failedArchive = flags.find((f) => f.status === 'active' && f.archive_status === 'failed');
  if (closed) waiting = null;
  else if (alert && mine && !mine.ack_at) waiting = { who: 'post', text: `Waiting for ${mine.post_name} to acknowledge the alert (sent ${ago(mine.sent_at)} ago)` };
  else if (trs.find((t) => t.status === 'submitted')) { const t = trs.find((x) => x.status === 'submitted'); waiting = { who: 'cms', text: `Waiting for CMS to decide on footage request #${t.id} (train ${t.train_no}, asked ${ago(t.created_at)} ago)` }; }
  else if (pendingExt) waiting = { who: 'cms', text: `Waiting for CMS to decide on a longer retention for evidence flag #${pendingExt.id}` };
  else if (failedArchive) waiting = { who: 'cms', text: `Evidence flag #${failedArchive.id} could not be archived - CMS must retry` };
  else if (trs.find((t) => ['approved', 'awaiting_upload'].includes(t.status))) { const t = trs.find((x) => ['approved', 'awaiting_upload'].includes(x.status)); waiting = { who: 'train', text: `Fetching footage from train ${t.train_no} (${t.cameras_fulfilled || 0} of ${t.cameras_total || '?'} cameras ready)` }; }
  else waiting = { who: 'post', text: inc.status === 'open' ? 'With the post - being worked' : 'Under review at the post - waiting for the outcome to be recorded and the incident closed' };

  const last = events.length ? events[events.length - 1].at : inc.updated_at || inc.created_at;
  return {
    stages, waiting_on: waiting, footage, events,
    summary: { requests: trs.length, requests_open: openReqs.length, cameras_total: trs.reduce((s, t) => s + (t.cameras_total || 0), 0), cameras_ready: trs.reduce((s, t) => s + (t.cameras_fulfilled || 0), 0), files: delivered, flags: activeFlags.length, acked_at: mine && mine.ack_at, last_activity: last },
  };
}

module.exports = { build, auditText };
