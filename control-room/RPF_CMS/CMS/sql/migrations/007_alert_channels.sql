-- =====================================================================
-- E-mail and SMS for alerts (007). Idempotent: start.sh applies every migration on every start.
--
--   * rpf_post.alert_email / alert_phone : where a post's alerts are sent (set in the CMS console, Registry -> Edit post)
--   * notification_delivery              : the outbox. A row is written in the SAME transaction as the in-app notification, and the
--                                          CMS "notify_outbox" job sends it after commit, with retries (so a rolled-back alert never
--                                          sends anything, a slow gateway never blocks an alert, and nothing is lost while the PC is offline).
-- Provider settings and keys are NOT stored here: they live in config/notify.conf.
-- =====================================================================

ALTER TABLE rpf_post
    ADD COLUMN IF NOT EXISTS alert_email text,
    ADD COLUMN IF NOT EXISTS alert_phone text;

CREATE TABLE IF NOT EXISTS notification_delivery (
    id              bigserial PRIMARY KEY,
    notification_id bigint REFERENCES notification(id) ON DELETE SET NULL,
    post_id         bigint REFERENCES rpf_post(id) ON DELETE SET NULL,
    kind            text NOT NULL,
    channel         text NOT NULL CHECK (channel IN ('email', 'sms')),
    recipient       text NOT NULL,
    subject         text,
    body            text NOT NULL,
    status          text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sent', 'failed', 'expired', 'skipped')),
    attempts        int  NOT NULL DEFAULT 0,
    next_attempt_at timestamptz NOT NULL DEFAULT now(),
    last_error      text,
    provider        text,
    provider_ref    text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    sent_at         timestamptz
);
CREATE INDEX IF NOT EXISTS idx_notif_delivery_due    ON notification_delivery (next_attempt_at) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_notif_delivery_recent ON notification_delivery (id DESC);
