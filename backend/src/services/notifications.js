'use strict';
const { query } = require('../config/database');

const notify = async ({ type, title, message, entityType, entityId, metadata = {} }) => {
  try {
    await query(
      `INSERT INTO admin_notifications (type, title, message, entity_type, entity_id, metadata)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [type, title, message, entityType||null, entityId||null, JSON.stringify(metadata)]
    );
  } catch(err) { console.error('Notification error:', err.message); }
};

module.exports = { notify };
