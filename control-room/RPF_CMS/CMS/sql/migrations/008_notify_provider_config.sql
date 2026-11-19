-- Provider login for e-mail / SMS entered in the CMS console (page "E-mail & SMS"). Idempotent.
-- These values override the same keys in config/notify.conf. Secrets (SMTP password, API keys, auth tokens) are written here but
-- NEVER returned by any API; only the CMS database role can read this table (the RPF role has no grant on it).
CREATE TABLE IF NOT EXISTS notify_provider_config (
    key        text PRIMARY KEY,
    value      text NOT NULL,
    updated_by bigint REFERENCES users(id),
    updated_at timestamptz NOT NULL DEFAULT now()
);
