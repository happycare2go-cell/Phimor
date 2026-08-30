const { Centers, CenterStaff, Residents, GroupBindings, databaseQuery } = require('../db');
const subscriptionService = require('./subscriptionService');
const { displayIdentity } = require('../utils/safeIdentity');

const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;
const MAX_SEARCH_LENGTH = 100;
const DIRECTORY_STATUSES = new Set([
  'all', 'active', 'trial', 'expired', 'not_configured', 'not_started', 'suspended',
]);

class CenterDirectoryInputError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_CENTER_DIRECTORY_QUERY';
    this.status = 400;
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeDirectoryQuery(input = {}) {
  const search = String(input.search || '').trim().normalize('NFC');
  if (search.length > MAX_SEARCH_LENGTH) {
    throw new CenterDirectoryInputError(`คำค้นหาต้องไม่เกิน ${MAX_SEARCH_LENGTH} ตัวอักษร`);
  }
  const subscriptionStatus = String(input.subscriptionStatus || 'all').trim().toLowerCase();
  if (!DIRECTORY_STATUSES.has(subscriptionStatus)) {
    throw new CenterDirectoryInputError('ตัวกรองสถานะแพ็กเกจไม่ถูกต้อง');
  }
  const page = positiveInteger(input.page, 1);
  const limit = Math.min(MAX_LIMIT, positiveInteger(input.limit, DEFAULT_LIMIT));
  return { search, subscriptionStatus, page, limit, offset:(page - 1) * limit };
}

function directoryStatus(center, at = new Date()) {
  const subscription = subscriptionService.entitlement(center, at);
  if (subscription.operationalStatus !== 'active') return 'suspended';
  return subscription.state;
}

function projectCenterDirectoryRow({ center, owner, activeResidentCount = 0,
  centerStaffGroupReady = false, capabilityCounts = {}, at = new Date() }) {
  const subscription = subscriptionService.entitlement(center, at);
  const enabledCapabilityCount = Number(capabilityCounts.enabled) || 0;
  const capabilityCount = Number(capabilityCounts.total) || 0;
  return {
    centerId:center.center_id,
    name:center.name,
    ownerIdentity:displayIdentity({ displayName:owner?.display_name, lineUserId:center.owner_line_id }),
    status:center.status,
    operationalStatus:subscription.operationalStatus,
    directoryStatus:directoryStatus(center, at),
    centerStaffGroupReady:Boolean(centerStaffGroupReady),
    capabilityReadiness:{
      enabled:enabledCapabilityCount, total:capabilityCount,
      state:capabilityCount > 0 && enabledCapabilityCount === capabilityCount ? 'ready'
        : enabledCapabilityCount > 0 ? 'partial' : 'not_configured',
    },
    createdAt:center.created_at || null,
    address:center.address || '',
    contactPhone:center.contact_phone || '',
    activeResidentCount:Number(activeResidentCount) || 0,
    subscriptionStartAt:center.subscription_start_at || null,
    subscriptionEndAt:center.subscription_end_at || null,
    packageType:center.subscription_package_type || null,
    subscription,
  };
}

function emptyCounts() {
  return { all:0, active:0, trial:0, expired:0, notConfigured:0, notStarted:0, suspended:0 };
}

function incrementCount(counts, status) {
  counts.all += 1;
  if (status === 'not_configured') counts.notConfigured += 1;
  else if (status === 'not_started') counts.notStarted += 1;
  else if (Object.hasOwn(counts, status)) counts[status] += 1;
}

async function queryMemory({ search, subscriptionStatus, page, limit, offset }, at) {
  const [centers, residents, staffRows, groupBindings] = await Promise.all([
    Centers.findAll(), Residents.findAll(), CenterStaff.findAll(), GroupBindings.findAll(),
  ]);
  const needle = search.toLocaleLowerCase('en-US');
  const searched = centers
    .filter((center) => !needle || String(center.name || '').normalize('NFC').toLocaleLowerCase('en-US').includes(needle))
    .map((center) => ({ center, status:directoryStatus(center, at) }))
    .sort((left, right) => String(left.center.name || '').localeCompare(String(right.center.name || ''), 'th')
      || String(left.center.center_id || '').localeCompare(String(right.center.center_id || '')));
  const counts = emptyCounts();
  searched.forEach((item) => incrementCount(counts, item.status));
  const filtered = subscriptionStatus === 'all' ? searched : searched.filter((item) => item.status === subscriptionStatus);
  const items = filtered.slice(offset, offset + limit).map(({ center }) => {
    const owner = staffRows.find((row) => row.center_id === center.center_id
      && row.line_user_id === center.owner_line_id && row.role === 'owner');
    const activeResidentCount = residents.filter((row) => row.center_id === center.center_id && row.status === 'active').length;
    const centerStaffGroupReady = groupBindings.some((row) => row.kind === 'center_staff'
      && row.center_id === center.center_id && row.status === 'active');
    return projectCenterDirectoryRow({ center, owner, activeResidentCount, centerStaffGroupReady, at });
  });
  return {
    items, counts,
    pagination:{ page, limit, total:filtered.length, totalPages:Math.ceil(filtered.length / limit) },
  };
}

const DIRECTORY_SQL = `
  WITH classified AS (
    SELECT c.data,
      CASE
        WHEN COALESCE(c.data->>'status', 'active') <> 'active' THEN 'suspended'
        WHEN NULLIF(c.data->>'subscription_start_at', '') IS NULL
          OR NULLIF(c.data->>'subscription_end_at', '') IS NULL THEN 'not_configured'
        WHEN $5::timestamptz < (c.data->>'subscription_start_at')::timestamptz THEN 'not_started'
        WHEN $5::timestamptz > (c.data->>'subscription_end_at')::timestamptz THEN 'expired'
        WHEN c.data->>'subscription_package_type' = 'trial' THEN 'trial'
        ELSE 'active'
      END AS directory_status
    FROM centers c
    WHERE $1::text = '' OR POSITION(LOWER($1::text) IN LOWER(COALESCE(c.data->>'name', ''))) > 0
  ), resident_counts AS (
    SELECT data->>'center_id' AS center_id, COUNT(*) FILTER (WHERE data->>'status'='active')::int AS active_count
    FROM residents GROUP BY data->>'center_id'
  ), staff_groups AS (
    SELECT data->>'center_id' AS center_id, true AS ready FROM "groupBindings"
    WHERE data->>'kind'='center_staff' AND data->>'status'='active' GROUP BY data->>'center_id'
  ), capability_counts AS (
    SELECT center_id, COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE enabled)::int AS enabled
    FROM center_capabilities GROUP BY center_id
  ), filtered AS (
    SELECT * FROM classified WHERE $2 = 'all' OR directory_status = $2
  ), paged AS (
    SELECT * FROM filtered
    ORDER BY LOWER(COALESCE(data->>'name', '')), COALESCE(data->>'center_id', '')
    LIMIT $3 OFFSET $4
  )
  SELECT
    COALESCE((
      SELECT jsonb_agg(jsonb_build_object(
        'center', p.data,
        'activeResidentCount', COALESCE(rc.active_count, 0),
        'centerStaffGroupReady', COALESCE(sg.ready, false),
        'capabilityCounts', jsonb_build_object('total', COALESCE(cc.total, 0), 'enabled', COALESCE(cc.enabled, 0)),
        'owner', (
          SELECT s.data FROM "centerStaff" s
          WHERE s.data->>'center_id' = p.data->>'center_id'
            AND s.data->>'line_user_id' = p.data->>'owner_line_id'
            AND s.data->>'role' = 'owner'
          ORDER BY s.created_at ASC LIMIT 1
        )
      ) ORDER BY LOWER(COALESCE(p.data->>'name', '')), COALESCE(p.data->>'center_id', ''))
      FROM paged p
      LEFT JOIN resident_counts rc ON rc.center_id = p.data->>'center_id'
      LEFT JOIN staff_groups sg ON sg.center_id = p.data->>'center_id'
      LEFT JOIN capability_counts cc ON cc.center_id = p.data->>'center_id'
    ), '[]'::jsonb) AS items,
    (SELECT COUNT(*)::int FROM filtered) AS total,
    (SELECT jsonb_build_object(
      'all', COUNT(*)::int,
      'active', COUNT(*) FILTER (WHERE directory_status='active')::int,
      'trial', COUNT(*) FILTER (WHERE directory_status='trial')::int,
      'expired', COUNT(*) FILTER (WHERE directory_status='expired')::int,
      'notConfigured', COUNT(*) FILTER (WHERE directory_status='not_configured')::int,
      'notStarted', COUNT(*) FILTER (WHERE directory_status='not_started')::int,
      'suspended', COUNT(*) FILTER (WHERE directory_status='suspended')::int
    ) FROM classified) AS counts
`;

async function queryPostgres(query, at) {
  const result = await databaseQuery(DIRECTORY_SQL, [
    query.search, query.subscriptionStatus, query.limit, query.offset, at.toISOString(),
  ]);
  const row = result.rows[0] || { items:[], total:0, counts:emptyCounts() };
  const items = (row.items || []).map((item) => projectCenterDirectoryRow({
    center:item.center, owner:item.owner,
    activeResidentCount:item.activeResidentCount,
    centerStaffGroupReady:item.centerStaffGroupReady,
    capabilityCounts:item.capabilityCounts, at,
  }));
  const total = Number(row.total) || 0;
  return {
    items,
    counts:{ ...emptyCounts(), ...(row.counts || {}) },
    pagination:{
      page:query.page, limit:query.limit, total,
      totalPages:Math.ceil(total / query.limit),
    },
  };
}

async function listAdminCenters(input = {}, options = {}) {
  const query = normalizeDirectoryQuery(input);
  const at = options.at instanceof Date ? options.at : new Date(options.at || Date.now());
  if (Number.isNaN(at.getTime())) throw new CenterDirectoryInputError('เวลาอ้างอิงไม่ถูกต้อง');
  return process.env.NODE_ENV === 'test' ? queryMemory(query, at) : queryPostgres(query, at);
}

module.exports = {
  DEFAULT_LIMIT, MAX_LIMIT, MAX_SEARCH_LENGTH, DIRECTORY_STATUSES, DIRECTORY_SQL,
  CenterDirectoryInputError, normalizeDirectoryQuery, directoryStatus,
  projectCenterDirectoryRow, listAdminCenters,
};
