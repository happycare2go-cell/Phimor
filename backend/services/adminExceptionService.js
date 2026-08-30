const { databaseQuery } = require('../db');

const CATEGORIES = Object.freeze([
  'all', 'dsr', 'pending_mapping', 'groups', 'group_missing', 'group_mismatch',
  'identity_ambiguity', 'integration_failure', 'retry_warning', 'scheduler_warning',
]);
const STATUSES = Object.freeze(['all', 'pending', 'in_progress', 'open', 'retrying', 'dead', 'rejected', 'failed']);

const EXCEPTION_ROWS_SQL = `
  WITH exception_rows AS (
    SELECT 'dsr'::text AS category,
      COALESCE(data->>'status','pending') AS status,
      CASE data->>'type'
        WHEN 'export' THEN 'ขอสำเนาข้อมูล'
        WHEN 'correct' THEN 'ขอแก้ไขข้อมูล'
        WHEN 'restrict' THEN 'ขอจำกัดการใช้ข้อมูล'
        WHEN 'delete' THEN 'ขอลบข้อมูล'
        ELSE 'คำขอเกี่ยวกับข้อมูลส่วนบุคคล' END AS title,
      COALESCE(NULLIF(data->>'requester_display_name',''),'ผู้ขอที่ยืนยันแล้ว') AS summary,
      NULL::text AS center_name,
      'คำขอ ••••' || RIGHT(COALESCE(data->>'request_id',''),4) AS safe_reference,
      'manage_dsr'::text AS action_kind,
      COALESCE(NULLIF(data->>'requested_at','')::timestamptz, created_at) AS occurred_at,
      10 AS category_rank
    FROM "dataSubjectRequests"
    WHERE data->>'status' IN ('pending','in_progress')

    UNION ALL

    SELECT CASE
        WHEN ie.status='pending' AND ie.pending_reason='subject_mapping' THEN 'pending_mapping'
        WHEN ie.group_reconciliation_status='group_binding_mismatch' THEN 'group_mismatch'
        WHEN ie.group_reconciliation_status='group_binding_missing' THEN 'group_missing'
        WHEN ie.status IN ('retrying','dead') THEN 'retry_warning'
        ELSE 'integration_failure' END AS category,
      CASE
        WHEN ie.status='pending' AND ie.pending_reason='subject_mapping' THEN 'pending'
        WHEN ie.group_reconciliation_status IN ('group_binding_missing','group_binding_mismatch') THEN 'open'
        ELSE ie.status END AS status,
      COALESCE(NULLIF(ic.display_name,''),'ระบบเชื่อมต่อ') AS title,
      CASE
        WHEN ie.status='pending' AND ie.pending_reason='subject_mapping'
          THEN 'ผู้พักจากระบบภายนอก ••••' || RIGHT(ie.external_resident_id,4) || ' รอการจับคู่แบบตรงตัว'
        WHEN ie.group_reconciliation_status='group_binding_missing' THEN 'ยังไม่พบ Family GroupBinding ที่ยืนยันแล้ว'
        WHEN ie.group_reconciliation_status='group_binding_mismatch' THEN 'กลุ่ม LINE ที่คาดไว้ไม่ตรงกับ GroupBinding ที่ยืนยันแล้ว'
        ELSE 'รหัสข้อผิดพลาดที่ปลอดภัย: ' || COALESCE(ie.last_error_code,'PROCESSING_FAILED') END AS summary,
      NULLIF(c.data->>'name','') AS center_name,
      'งาน ••••' || RIGHT(ie.integration_event_id,4) AS safe_reference,
      CASE
        WHEN ie.status='pending' AND ie.pending_reason='subject_mapping' THEN 'open_pending_mapping'
        WHEN ie.group_reconciliation_status IN ('group_binding_missing','group_binding_mismatch') THEN 'open_group_reconciliation'
        ELSE 'inspect_reliability' END AS action_kind,
      ie.updated_at AS occurred_at,
      CASE
        WHEN ie.status='pending' AND ie.pending_reason='subject_mapping' THEN 20
        WHEN ie.group_reconciliation_status='group_binding_missing' THEN 30
        WHEN ie.group_reconciliation_status='group_binding_mismatch' THEN 40
        WHEN ie.status IN ('retrying','dead') THEN 60 ELSE 55 END AS category_rank
    FROM integration_event_inbox ie
    LEFT JOIN integration_clients ic ON ic.integration_client_id=ie.integration_client_id
    LEFT JOIN centers c ON c.data->>'center_id'=ie.center_id
    WHERE (ie.status='pending' AND ie.pending_reason='subject_mapping')
      OR ie.group_reconciliation_status IN ('group_binding_missing','group_binding_mismatch')
      OR ie.status IN ('retrying','dead','rejected')

    UNION ALL

    SELECT 'identity_ambiguity'::text AS category,
      COALESCE(data->>'status','open') AS status,
      COALESCE(NULLIF(data->>'source_system_display_name',''),'ระบบเชื่อมต่อ') AS title,
      'พบชื่อที่ตรงกันมากกว่าหนึ่งรายการใน ' || COALESCE(data->>'candidate_count','0') || ' ศูนย์ที่เป็นไปได้' AS summary,
      NULL::text AS center_name,
      'รายการ ••••' || RIGHT(COALESCE(data->>'log_id',''),4) AS safe_reference,
      'open_identity_review'::text AS action_kind,
      COALESCE(NULLIF(data->>'last_seen_at','')::timestamptz, created_at) AS occurred_at,
      50 AS category_rank
    FROM "auditLog"
    WHERE data->>'action'='integration.identity_ambiguity_alert'
      AND COALESCE(data->>'status','open')='open'
  )
`;

const FILTER_SQL = `
  WHERE ($1::text='all' OR category=$1
    OR ($1='groups' AND category IN ('group_missing','group_mismatch')))
    AND ($2::text='all' OR status=$2)
    AND ($3::text='' OR POSITION(LOWER($3) IN LOWER(CONCAT_WS(' ',title,summary,center_name,safe_reference)))>0)
`;

const LIST_SQL = `${EXCEPTION_ROWS_SQL}
  SELECT category,status,title,summary,center_name,safe_reference,action_kind,occurred_at
  FROM exception_rows ${FILTER_SQL}
  ORDER BY category_rank, occurred_at DESC NULLS LAST, safe_reference
  LIMIT $4 OFFSET $5`;

const COUNT_SQL = `${EXCEPTION_ROWS_SQL}
  SELECT COUNT(*)::int AS total FROM exception_rows ${FILTER_SQL}`;

function boundedText(value, max = 240) {
  return String(value || '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}

function normalizeQuery(input = {}) {
  const category = CATEGORIES.includes(input.category) ? input.category : 'all';
  const status = STATUSES.includes(input.status) ? input.status : 'all';
  const page = Math.min(1000, Math.max(1, Number(input.page) || 1));
  const pageSize = Math.min(50, Math.max(5, Number(input.pageSize || input.limit) || 20));
  return { category, status, search:boundedText(input.search, 100), page, pageSize, offset:(page - 1) * pageSize };
}

function projectRow(row) {
  return {
    category:row.category,
    status:row.status,
    title:boundedText(row.title, 160),
    summary:boundedText(row.summary, 300),
    centerName:boundedText(row.center_name, 160) || null,
    safeReference:boundedText(row.safe_reference, 80),
    action:{ kind:row.action_kind, label:{
      manage_dsr:'เปิดขั้นตอนคำขอ', open_pending_mapping:'จับคู่ผู้พัก',
      open_group_reconciliation:'ตรวจ GroupBinding', open_identity_review:'ตรวจการจับคู่',
      inspect_reliability:'ดูสถานะระบบ',
    }[row.action_kind] || 'ตรวจสอบ' },
    occurredAt:row.occurred_at || null,
  };
}

function syntheticRows({ notificationHealth = {}, scheduler = {} } = {}) {
  const rows = [];
  const deadLetters = Math.max(0, Number(notificationHealth.deadLetters ?? notificationHealth.deadLetter) || 0);
  if (deadLetters) rows.push({
    category:'retry_warning', status:'dead', title:'คิวแจ้งเตือน',
    summary:`มีรายการหยุดรอตรวจ ${deadLetters} รายการ`, center_name:null,
    safe_reference:'สถานะคิวรวม', action_kind:'inspect_reliability', occurred_at:null,
  });
  Object.entries(scheduler.jobs || {}).filter(([, job]) => job?.status === 'failed').forEach(([name, job]) => rows.push({
    category:'scheduler_warning', status:'failed', title:'งานเบื้องหลังต้องตรวจ',
    summary:`${boundedText(name, 80)} · ${boundedText(job.safeErrorCode || 'SCHEDULER_JOB_FAILED', 100)}`,
    center_name:null, safe_reference:'Scheduler', action_kind:'inspect_reliability',
    occurred_at:job.completedAt || job.startedAt || null,
  }));
  return rows;
}

function matchesSynthetic(row, query) {
  if (query.category !== 'all' && row.category !== query.category
    && !(query.category === 'groups' && ['group_missing','group_mismatch'].includes(row.category))) return false;
  if (query.status !== 'all' && row.status !== query.status) return false;
  if (!query.search) return true;
  return [row.title,row.summary,row.center_name,row.safe_reference].join(' ').toLocaleLowerCase('th')
    .includes(query.search.toLocaleLowerCase('th'));
}

function createAdminExceptionService({
  queryFn = databaseQuery,
  notificationService = require('./notificationService'),
  schedulerHealth = () => ({ configuredJobs:0, jobs:{} }),
} = {}) {
  async function listExceptions(input = {}) {
    const query = normalizeQuery(input);
    const params = [query.category, query.status, query.search];
    const [countResult, notificationHealth] = await Promise.all([
      queryFn(COUNT_SQL, params), notificationService.getHealth(),
    ]);
    const persistedTotal = Number(countResult.rows?.[0]?.total) || 0;
    const synthetic = syntheticRows({ notificationHealth, scheduler:schedulerHealth() })
      .filter((row) => matchesSynthetic(row, query));
    const total = persistedTotal + synthetic.length;
    const rows = [];
    if (query.offset < persistedTotal) {
      const persistedLimit = Math.min(query.pageSize, persistedTotal - query.offset);
      const result = await queryFn(LIST_SQL, [...params, persistedLimit, query.offset]);
      rows.push(...(result.rows || []));
    }
    if (rows.length < query.pageSize) {
      const syntheticOffset = Math.max(0, query.offset - persistedTotal);
      rows.push(...synthetic.slice(syntheticOffset, syntheticOffset + query.pageSize - rows.length));
    }
    return {
      items:rows.map(projectRow),
      categories:CATEGORIES.filter((item) => item !== 'all'),
      pagination:{ page:query.page, pageSize:query.pageSize, total, totalPages:Math.ceil(total / query.pageSize) },
    };
  }
  return { listExceptions };
}

module.exports = { CATEGORIES, STATUSES, LIST_SQL, COUNT_SQL, normalizeQuery, projectRow,
  syntheticRows, createAdminExceptionService };
