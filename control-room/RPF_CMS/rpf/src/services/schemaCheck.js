/**
 * RPF owns no schema. This verifies the shared CMS database has the tables
 * and columns RPF reads/writes, and reports privileges the connected role
 * lacks. It never creates or alters anything.
 */
const { pool } = require('../db');

const REQUIRED_COLUMNS = {
  zone: ['id', 'name'],
  rpf_post: ['id', 'zone_id', 'name', 'location', 'active'],
  users: ['id', 'zone_id', 'post_id', 'role', 'username', 'password_hash', 'status'],
  nvr_unit: ['id', 'name', 'current_zone_id', 'train_no', 'last_seen', 'last_lat', 'last_lon'],
  camera: ['id', 'nvr_id', 'name', 'mount_position', 'active'],
  alert: ['id', 'nvr_id', 'camera_id', 'zone_id', 'alert_type', 'priority', 'event_time', 'received_time', 'location', 'fix_age_s', 'fix_quality', 'status'],
  alert_delivery: ['id', 'alert_id', 'alert_event_time', 'post_id', 'sent_at', 'ack_at', 'ack_by', 'escalated_from', 'mode'],
  alert_history: ['alert_id', 'alert_event_time', 'changed_by', 'from_status', 'to_status', 'note'],
  incident: ['id', 'alert_delivery_id', 'post_id', 'alert_type', 'location', 'occurred_at', 'status', 'raised_by', 'source', 'title', 'description', 'priority', 'nvr_id', 'camera_id', 'closed_at', 'closed_by', 'closing_note', 'updated_at'],
  video_request: ['id', 'post_id', 'requested_by', 'alert_id', 'alert_event_time', 'camera_id', 'window_start', 'window_end', 'reason', 'status', 'operator_id', 'decided_at', 'decision_note', 'incident_id', 'failure_reason', 'fulfilled_at'],
  video_access_grant: ['request_id', 'user_id', 'token_hash', 'expires_at', 'revoked_at', 'footage_id', 'flag_id', 'clip_start_s', 'clip_end_s', 'purpose'],
  delivered_footage: ['id', 'video_request_id', 'storage_path', 'format', 'sha256', 'file_size_bytes', 'delivered_at', 'start_time', 'end_time', 'duration_s', 'segment_count'],
  evidence_flag: ['id', 'footage_id', 'retain_from', 'retain_to', 'justification', 'flagged_by', 'status', 'retention', 'section_start_s', 'section_end_s',
    'section_from', 'section_to', 'incident_id', 'archive_status', 'archive_path', 'archive_sha256', 'archive_size_bytes', 'archived_at', 'archive_error', 'released_at', 'release_note',
    'storage', 'local_path', 'local_sha256', 'local_size_bytes', 'local_saved_at', 'local_error'],
  notification: ['id', 'zone_id', 'post_id', 'kind', 'title', 'body', 'ref_entity', 'ref_id', 'created_at', 'read_at', 'read_by'],
  audit_log: ['actor_id', 'action', 'entity', 'entity_id', 'zone_id', 'occurred_at', 'details'],
};

// [table, privilege] pairs RPF needs (see sql/rpf_app_role.sql).
const REQUIRED_PRIVILEGES = [
  ...Object.keys(REQUIRED_COLUMNS).map((t) => [t, 'SELECT']),
  ['alert', 'UPDATE'], ['alert_delivery', 'UPDATE'], ['incident', 'UPDATE'], ['video_request', 'UPDATE'], ['notification', 'UPDATE'],
  ['incident', 'INSERT'], ['alert_history', 'INSERT'], ['video_request', 'INSERT'],
  ['video_access_grant', 'INSERT'], ['evidence_flag', 'INSERT'], ['audit_log', 'INSERT'],
];

async function checkSchema() {
  const { rows } = await pool.query(
    `SELECT table_name, column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ANY($1)`,
    [Object.keys(REQUIRED_COLUMNS)]
  );
  const have = new Map();
  for (const r of rows) {
    if (!have.has(r.table_name)) have.set(r.table_name, new Set());
    have.get(r.table_name).add(r.column_name);
  }
  const missing = [];
  for (const [table, cols] of Object.entries(REQUIRED_COLUMNS)) {
    if (!have.has(table)) { missing.push(`table ${table}`); continue; }
    for (const c of cols) if (!have.get(table).has(c)) missing.push(`column ${table}.${c}`);
  }

  const lacking = [];
  if (!missing.length) {
    for (const [table, priv] of REQUIRED_PRIVILEGES) {
      // UPDATE/INSERT may be granted per column (sql/rpf_app_role.sql), which has_table_privilege cannot see.
      const fn = priv === 'SELECT' ? 'has_table_privilege' : 'has_any_column_privilege';
      const { rows: r } = await pool.query(`SELECT ${fn}(current_user, $1, $2) AS ok`, [`public.${table}`, priv]);
      if (!r[0].ok) lacking.push(`${priv} on ${table}`);
    }
  }
  return { missing, lacking };
}

module.exports = { checkSchema };
