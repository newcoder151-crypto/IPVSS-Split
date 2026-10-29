const express = require('express');
const { pool } = require('../db');
const config = require('../config');
const { wrap } = require('../errors');
const { hasFfmpeg } = require('../services/clip');

const router = express.Router();

router.get('/config', wrap(async (req, res) => {
  res.json({ version: config.version, clipDownload: await hasFfmpeg(),
    alertPollSeconds: config.alertPollSeconds,
    maxRequestWindowMin: config.maxRequestWindowMin,
    defaultRetentionDays: config.defaultRetentionDays,
    footageLinkMinutes: config.footageLinkMinutes,
  });
}));

// Cameras this post may request footage for: active cameras on NVR units currently in the post's zone.
router.get('/cameras', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT c.id, c.name, c.mount_position, n.id AS nvr_id, n.name AS nvr_name, n.train_no, n.current_zone_id AS zone_id
       FROM camera c JOIN nvr_unit n ON n.id = c.nvr_id
      WHERE c.active AND n.current_zone_id = $1 ORDER BY n.name, c.name`,
    [req.user.zone_id]
  );
  res.json(rows);
}));

module.exports = router;
