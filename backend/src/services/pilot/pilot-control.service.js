'use strict';

const crypto = require('crypto');
const { query } = require('../../config/database');
const logger = require('../../config/logger');

const MODE = {
  DISABLED: 'disabled',
  AUDIT: 'audit',
  ENFORCE: 'enforce',
};

const getMode = () => {
  const mode = (process.env.PILOT_CONTROL_MODE || MODE.AUDIT).toLowerCase();
  return Object.values(MODE).includes(mode) ? mode : MODE.AUDIT;
};

const stableBucket = (merchantId, flagKey) => {
  const hash = crypto.createHash('sha256').update(`${merchantId}:${flagKey}`).digest('hex');
  return parseInt(hash.slice(0, 8), 16) % 100;
};

const decideFeatureAccess = ({ flag, override, enrollment, merchantId }) => {
  if (!flag) {
    return { allowed: true, source: 'missing_flag', reason: 'Flag absent: allow for backward compatibility' };
  }

  if (flag.status === 'disabled') {
    return { allowed: false, source: 'flag', reason: 'Feature disabled globally' };
  }

  if (override) {
    return {
      allowed: !!override.enabled,
      source: 'merchant_override',
      reason: override.enabled ? 'Merchant override enabled' : 'Merchant override disabled',
    };
  }

  const enrolled = enrollment && enrollment.status === 'active';
  if (flag.pilot_only && !enrolled) {
    return { allowed: false, source: 'pilot', reason: 'Merchant not enrolled in active pilot' };
  }

  if (flag.default_enabled) {
    return { allowed: true, source: 'default', reason: 'Feature enabled by default' };
  }

  const rollout = Number(enrollment?.rollout_percent ?? flag.rollout_percent ?? 0);
  const bucket = merchantId ? stableBucket(merchantId, flag.flag_key) : 100;
  return {
    allowed: bucket < rollout,
    source: 'rollout',
    reason: bucket < rollout ? `Bucket ${bucket} inside rollout ${rollout}%` : `Bucket ${bucket} outside rollout ${rollout}%`,
    bucket,
    rollout,
  };
};

const logDecision = async ({ merchantId, pilotKey, flagKey, decision, mode, reason, context, requestId }) => {
  try {
    await query(
      `INSERT INTO pilot_decision_logs
        (merchant_id, pilot_key, flag_key, decision, mode, reason, context, request_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [merchantId || null, pilotKey || null, flagKey || null, decision, mode, reason || null, context || {}, requestId || null]
    );
  } catch (err) {
    logger.warn('Pilot decision log skipped', { err: err.message, flagKey, merchantId });
  }
};

const evaluateFeature = async ({ merchantId, flagKey, context = {}, requestId }) => {
  const mode = getMode();
  if (mode === MODE.DISABLED) {
    return { allowed: true, enforced: false, mode, flagKey, reason: 'Pilot control disabled' };
  }

  try {
    const [flagResult, overrideResult, enrollmentResult] = await Promise.all([
      query('SELECT * FROM feature_flags WHERE flag_key = $1', [flagKey]),
      merchantId
        ? query('SELECT * FROM feature_flag_overrides WHERE flag_key = $1 AND merchant_id = $2', [flagKey, merchantId])
        : Promise.resolve({ rows: [] }),
      merchantId
        ? query(
            `SELECT p.pilot_key, e.status, e.rollout_percent
             FROM pilot_merchant_enrollments e
             JOIN pilot_programs p ON p.pilot_id = e.pilot_id
             WHERE e.merchant_id = $1 AND p.status = 'active'
             ORDER BY e.enrolled_at DESC LIMIT 1`,
            [merchantId]
          )
        : Promise.resolve({ rows: [] }),
    ]);

    const flag = flagResult.rows[0] || null;
    const decision = decideFeatureAccess({
      flag,
      override: overrideResult.rows[0] || null,
      enrollment: enrollmentResult.rows[0] || null,
      merchantId,
    });
    const enforced = mode === MODE.ENFORCE || flag?.status === 'enabled';
    const allowed = enforced ? decision.allowed : true;

    await logDecision({
      merchantId,
      pilotKey: enrollmentResult.rows[0]?.pilot_key,
      flagKey,
      decision: allowed ? 'allowed' : 'blocked',
      mode,
      reason: decision.reason,
      context,
      requestId,
    });

    return {
      ...decision,
      allowed,
      wouldAllow: decision.allowed,
      enforced,
      mode,
      flagKey,
      status: flag?.status || 'missing',
      pilotKey: enrollmentResult.rows[0]?.pilot_key || null,
    };
  } catch (err) {
    logger.warn('Pilot feature evaluation failed open', { err: err.message, flagKey, merchantId });
    return { allowed: true, enforced: false, mode, flagKey, reason: 'Pilot control unavailable: fail open', error: err.message };
  }
};

const listPrograms = async () => {
  const result = await query(
    `SELECT p.*,
       COUNT(e.enrollment_id)::int AS enrolled_merchants,
       COUNT(e.enrollment_id) FILTER (WHERE e.status = 'active')::int AS active_merchants
     FROM pilot_programs p
     LEFT JOIN pilot_merchant_enrollments e ON e.pilot_id = p.pilot_id
     GROUP BY p.pilot_id
     ORDER BY p.created_at DESC`
  );
  return result.rows;
};

const upsertProgram = async ({ pilotKey, name, targetVersion, status, countryScope, successMetrics, riskControls, startAt, endAt, actorId }) => {
  const result = await query(
    `INSERT INTO pilot_programs
      (pilot_key, name, target_version, status, country_scope, success_metrics, risk_controls, start_at, end_at, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (pilot_key) DO UPDATE SET
       name = EXCLUDED.name,
       target_version = EXCLUDED.target_version,
       status = EXCLUDED.status,
       country_scope = EXCLUDED.country_scope,
       success_metrics = EXCLUDED.success_metrics,
       risk_controls = EXCLUDED.risk_controls,
       start_at = EXCLUDED.start_at,
       end_at = EXCLUDED.end_at,
       updated_at = NOW()
     RETURNING *`,
    [
      pilotKey,
      name,
      targetVersion || '2.3',
      status || 'draft',
      countryScope || [],
      successMetrics || {},
      riskControls || {},
      startAt || null,
      endAt || null,
      actorId || null,
    ]
  );
  return result.rows[0];
};

const enrollMerchant = async ({ pilotKey, merchantId, status = 'active', rolloutPercent = 100, notes, actorId }) => {
  const result = await query(
    `WITH p AS (SELECT pilot_id FROM pilot_programs WHERE pilot_key = $1)
     INSERT INTO pilot_merchant_enrollments (pilot_id, merchant_id, status, rollout_percent, notes, enrolled_by)
     SELECT p.pilot_id, $2, $3, $4, $5, $6 FROM p
     ON CONFLICT (pilot_id, merchant_id) DO UPDATE SET
       status = EXCLUDED.status,
       rollout_percent = EXCLUDED.rollout_percent,
       notes = EXCLUDED.notes,
       updated_at = NOW()
     RETURNING *`,
    [pilotKey, merchantId, status, rolloutPercent, notes || null, actorId || null]
  );
  return result.rows[0] || null;
};

const listFeatureFlags = async () => {
  const result = await query('SELECT * FROM feature_flags ORDER BY flag_key');
  return result.rows;
};

const upsertFeatureFlag = async ({ flagKey, displayName, description, status, defaultEnabled, pilotOnly, rolloutPercent, config }) => {
  const result = await query(
    `INSERT INTO feature_flags
      (flag_key, display_name, description, status, default_enabled, pilot_only, rollout_percent, config)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (flag_key) DO UPDATE SET
       display_name = COALESCE(EXCLUDED.display_name, feature_flags.display_name),
       description = COALESCE(EXCLUDED.description, feature_flags.description),
       status = COALESCE(EXCLUDED.status, feature_flags.status),
       default_enabled = EXCLUDED.default_enabled,
       pilot_only = EXCLUDED.pilot_only,
       rollout_percent = EXCLUDED.rollout_percent,
       config = EXCLUDED.config,
       updated_at = NOW()
     RETURNING *`,
    [flagKey, displayName || flagKey, description || null, status || 'audit', !!defaultEnabled, pilotOnly !== false, rolloutPercent || 0, config || {}]
  );
  return result.rows[0];
};

const setMerchantOverride = async ({ flagKey, merchantId, enabled, reason, actorId }) => {
  const result = await query(
    `INSERT INTO feature_flag_overrides (flag_key, merchant_id, enabled, reason, updated_by)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (flag_key, merchant_id) DO UPDATE SET
       enabled = EXCLUDED.enabled,
       reason = EXCLUDED.reason,
       updated_by = EXCLUDED.updated_by,
       updated_at = NOW()
     RETURNING *`,
    [flagKey, merchantId, !!enabled, reason || null, actorId || null]
  );
  return result.rows[0];
};

const getMerchantPilotState = async (merchantId) => {
  const [enrollments, overrides, flags] = await Promise.all([
    query(
      `SELECT p.pilot_key, p.name, p.target_version, p.status AS pilot_status,
              e.status AS enrollment_status, e.rollout_percent, e.enrolled_at
       FROM pilot_merchant_enrollments e
       JOIN pilot_programs p ON p.pilot_id = e.pilot_id
       WHERE e.merchant_id = $1
       ORDER BY e.enrolled_at DESC`,
      [merchantId]
    ),
    query('SELECT flag_key, enabled, reason, updated_at FROM feature_flag_overrides WHERE merchant_id = $1 ORDER BY flag_key', [merchantId]),
    listFeatureFlags(),
  ]);
  return { merchantId, mode: getMode(), enrollments: enrollments.rows, overrides: overrides.rows, flags };
};

const listReadinessChecks = async () => {
  const result = await query('SELECT * FROM pilot_readiness_checks ORDER BY required DESC, category, check_key');
  const blockers = result.rows.filter((row) => row.required && row.status !== 'done');
  return { data: result.rows, ready: blockers.length === 0, blockers };
};

module.exports = {
  MODE,
  getMode,
  stableBucket,
  decideFeatureAccess,
  evaluateFeature,
  listPrograms,
  upsertProgram,
  enrollMerchant,
  listFeatureFlags,
  upsertFeatureFlag,
  setMerchantOverride,
  getMerchantPilotState,
  listReadinessChecks,
};
