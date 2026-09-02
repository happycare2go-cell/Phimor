const { databaseQuery } = require('../db');

const CATEGORIES = Object.freeze([
  'all', 'dsr', 'pending_mapping', 'groups', 'group_missing', 'group_mismatch',
  'identity_ambiguity', 'integration_failure', 'retry_warning', 'scheduler_warning',
]);
const STATUSES = Object.freeze(['all', 'pending', 'in_progress', 'open', 'retrying', 'dead', 'rejected', 'failed']);

const NOTIFICATION_KIND_LABELS = Object.freeze({
  family_daily_care_finalized:'รายงานสุขภาพส่งถึงครอบครัว',
  family_vital_signs_recorded:'สัญญาณชีพส่งถึงครอบครัว',
  subscription_updated:'แจ้งสถานะแพ็กเกจ',
  subscription_expiring:'แจ้งเตือนแพ็กเกจใกล้หมดอายุ',
  appointment_reminder:'แจ้งเตือนนัดหมาย',
  appointment_reminder_center:'แจ้งเตือนนัดหมายถึงศูนย์',
  appointment_created_family:'แจ้งนัดหมายใหม่ถึงครอบครัว',
  appointment_created_center:'แจ้งนัดหมายใหม่ถึงศูนย์',
  appointment_updated_family:'แจ้งการเปลี่ยนแปลงนัดหมายถึงครอบครัว',
  appointment_updated_center:'แจ้งการเปลี่ยนแปลงนัดหมายถึงศูนย์',
  appointment_cancelled_family:'แจ้งยกเลิกนัดหมายถึงครอบครัว',
  appointment_cancelled_center:'แจ้งยกเลิกนัดหมายถึงศูนย์',
  appointment_tomorrow_summary:'สรุปนัดหมายวันพรุ่งนี้',
  appointment_weekly_summary:'สรุปนัดหมายประจำสัปดาห์',
  transport_choice_required:'ขอให้ครอบครัวเลือกการเดินทาง',
  pending_card_reminder:'เตือนรายการที่รอดำเนินการ',
  consultation_closed:'แจ้งปิดการปรึกษา',
});

const NOTIFICATION_ERROR_LABELS = Object.freeze({
  LINE_DELIVERY_FAILED:'การส่งผ่าน LINE ไม่สำเร็จ',
  LINE_RETRY_WINDOW_EXPIRED:'หมดช่วงเวลาที่ระบบสามารถลองส่งซ้ำได้',
});

function notificationKindLabel(value) {
  return NOTIFICATION_KIND_LABELS[String(value || '')] || 'การแจ้งเตือน';
}

function notificationErrorLabel(value) {
  return NOTIFICATION_ERROR_LABELS[String(value || '')] || 'ส่งการแจ้งเตือนไม่สำเร็จ';
}

function sqlCase(expression, values, fallback) {
  const clauses = Object.entries(values).map(([key, label]) => `WHEN '${key}' THEN '${label}'`).join(' ');
  return `CASE ${expression} ${clauses} ELSE '${fallback}' END`;
}

const NOTIFICATION_KIND_LABEL_SQL = sqlCase("data->>'kind'", NOTIFICATION_KIND_LABELS, 'การแจ้งเตือน');
const NOTIFICATION_ERROR_LABEL_SQL = sqlCase("data->>'last_error'", NOTIFICATION_ERROR_LABELS, 'ส่งการแจ้งเตือนไม่สำเร็จ');

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
      '{}'::jsonb AS details,
      10 AS category_rank
    FROM "dataSubjectRequests"
    WHERE data->>'status' IN ('pending','in_progress')

    UNION ALL

    SELECT CASE
        WHEN ie.status='pending' AND ie.pending_reason='subject_mapping' THEN 'pending_mapping'
        WHEN ie.group_reconciliation_status='group_binding_mismatch' THEN 'group_mismatch'
        WHEN ie.group_reconciliation_status='group_binding_missing' THEN 'group_missing'
        WHEN ie.status IN ('retrying','dead') THEN 'integration_failure'
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
      '{}'::jsonb AS details,
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
      '{}'::jsonb AS details,
      50 AS category_rank
    FROM "auditLog"
    WHERE data->>'action'='integration.identity_ambiguity_alert'
      AND COALESCE(data->>'status','open')='open'

    UNION ALL

    SELECT 'retry_warning'::text AS category,
      notification.exception_status AS status,
      notification.kind_label || CASE WHEN notification.exception_status='retrying'
        THEN 'ยังไม่สำเร็จ' ELSE 'ส่งไม่สำเร็จ' END AS title,
      CASE WHEN notification.exception_status='retrying'
        THEN 'ส่งไม่สำเร็จ ' || notification.attempts || ' ครั้ง'
        ELSE 'ระบบลองส่งแล้ว ' || notification.attempts || ' ครั้ง แต่ยังไม่สำเร็จ' END AS summary,
      NULL::text AS center_name,
      'การแจ้งเตือน ••••' || RIGHT(COALESCE(notification.data->>'notification_id',''),4) AS safe_reference,
      'inspect_notification'::text AS action_kind,
      COALESCE(NULLIF(notification.data->>'_updatedAt','')::timestamptz,
        NULLIF(notification.data->>'created_at','')::timestamptz, notification.created_at) AS occurred_at,
      jsonb_build_object(
        'notificationKind', notification.safe_kind,
        'notificationKindLabel', notification.kind_label,
        'attempts', notification.attempts,
        'createdAt', COALESCE(NULLIF(notification.data->>'created_at',''), notification.created_at::text),
        'statusUpdatedAt', NULLIF(notification.data->>'_updatedAt',''),
        'nextAttemptAt', CASE WHEN notification.exception_status='retrying'
          THEN NULLIF(notification.data->>'next_attempt_at','') END,
        'sentAt', NULLIF(notification.data->>'sent_at',''),
        'lastErrorCode', notification.safe_error_code,
        'lastErrorMessage', notification.error_label,
        'recipientType', notification.recipient_type,
        'maskedDestination', notification.masked_destination,
        'resourceType', notification.resource_type,
        'safeResourceReference', notification.safe_resource_reference,
        'providerAcceptance', notification.provider_acceptance,
        'providerRequestReference', notification.provider_request_reference
      ) AS details,
      60 AS category_rank
    FROM (
      SELECT data, created_at,
        CASE data->>'status' WHEN 'retrying' THEN 'retrying' ELSE 'dead' END AS exception_status,
        ${NOTIFICATION_KIND_LABEL_SQL} AS kind_label,
        ${NOTIFICATION_ERROR_LABEL_SQL} AS error_label,
        CASE WHEN COALESCE(data->>'attempts','') ~ '^[0-9]{1,9}$'
          THEN (data->>'attempts')::int ELSE 0 END AS attempts,
        CASE WHEN COALESCE(data->>'kind','') ~ '^[a-z0-9_:-]{1,100}$'
          THEN data->>'kind' ELSE 'notification' END AS safe_kind,
        CASE WHEN COALESCE(data->>'last_error','') ~ '^[A-Z0-9_]{2,100}$'
          THEN data->>'last_error' ELSE 'NOTIFICATION_DELIVERY_FAILED' END AS safe_error_code,
        CASE WHEN COALESCE(data->'meta'->>'recipientType','') ~ '^[a-z0-9_:-]{1,40}$'
          THEN data->'meta'->>'recipientType' END AS recipient_type,
        CASE WHEN LENGTH(COALESCE(data->>'to','')) >= 9
          THEN LEFT(data->>'to',4) || '…' || RIGHT(data->>'to',4)
          WHEN NULLIF(data->>'to','') IS NOT NULL THEN '••••' END AS masked_destination,
        CASE WHEN COALESCE(data->'meta'->>'resourceType','') ~ '^[a-z0-9_:-]{1,60}$'
          THEN data->'meta'->>'resourceType' END AS resource_type,
        CASE WHEN NULLIF(data->'meta'->>'resourceId','') IS NOT NULL
          THEN 'รายการ ••••' || RIGHT(data->'meta'->>'resourceId',4) END AS safe_resource_reference,
        CASE WHEN COALESCE(data->>'provider_acceptance','') ~ '^[a-z0-9_:-]{1,80}$'
          THEN data->>'provider_acceptance' END AS provider_acceptance,
        CASE WHEN COALESCE(data->>'provider_request_id','') ~ '^[A-Za-z0-9._:-]{1,160}$'
          THEN 'LINE ••••' || RIGHT(data->>'provider_request_id',4) END AS provider_request_reference
      FROM "notificationOutbox"
      WHERE data->>'status' IN ('retrying','dead_letter')
    ) notification
  )
`;

const FILTER_SQL = `
  WHERE ($1::text='all' OR category=$1
    OR ($1='groups' AND category IN ('group_missing','group_mismatch')))
    AND ($2::text='all' OR status=$2)
    AND ($3::text='' OR POSITION(LOWER($3) IN LOWER(CONCAT_WS(' ',title,summary,center_name,safe_reference)))>0)
`;

const LIST_SQL = `${EXCEPTION_ROWS_SQL}
  SELECT category,status,title,summary,center_name,safe_reference,action_kind,occurred_at,details
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

function safeTimestamp(value) {
  const text = boundedText(value, 60);
  return text && Number.isFinite(new Date(text).getTime()) ? text : null;
}

function projectNotificationDetails(value, status) {
  const details = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const kind = /^[a-z0-9_:-]{1,100}$/.test(String(details.notificationKind || ''))
    ? String(details.notificationKind) : 'notification';
  const errorCode = /^[A-Z0-9_]{2,100}$/.test(String(details.lastErrorCode || ''))
    ? String(details.lastErrorCode) : 'NOTIFICATION_DELIVERY_FAILED';
  const destination = boundedText(details.maskedDestination, 20);
  return {
    kind,
    kindLabel:boundedText(details.notificationKindLabel, 120) || notificationKindLabel(kind),
    attempts:Math.max(0, Math.min(999999999, Number(details.attempts) || 0)),
    createdAt:safeTimestamp(details.createdAt),
    statusUpdatedAt:safeTimestamp(details.statusUpdatedAt),
    nextAttemptAt:status === 'retrying' ? safeTimestamp(details.nextAttemptAt) : null,
    sentAt:safeTimestamp(details.sentAt),
    lastErrorCode:errorCode,
    lastErrorMessage:boundedText(details.lastErrorMessage, 180) || notificationErrorLabel(errorCode),
    recipientType:/^[a-z0-9_:-]{1,40}$/.test(String(details.recipientType || ''))
      ? String(details.recipientType) : null,
    maskedDestination:/^(?:[^…]{1,4}…[^…]{1,4}|••••)$/u.test(destination) ? destination : null,
    resourceType:/^[a-z0-9_:-]{1,60}$/.test(String(details.resourceType || ''))
      ? String(details.resourceType) : null,
    safeResourceReference:boundedText(details.safeResourceReference, 80) || null,
    providerAcceptance:/^[a-z0-9_:-]{1,80}$/.test(String(details.providerAcceptance || ''))
      ? String(details.providerAcceptance) : null,
    providerRequestReference:boundedText(details.providerRequestReference, 80) || null,
  };
}

function projectRow(row) {
  const result = {
    category:row.category,
    status:row.status,
    title:boundedText(row.title, 160),
    summary:boundedText(row.summary, 300),
    centerName:boundedText(row.center_name, 160) || null,
    safeReference:boundedText(row.safe_reference, 80),
    action:{ kind:row.action_kind, label:{
      manage_dsr:'เปิดขั้นตอนคำขอ', open_pending_mapping:'จับคู่ผู้พัก',
      open_group_reconciliation:'ตรวจ GroupBinding', open_identity_review:'ตรวจการจับคู่',
      inspect_reliability:'ดูสถานะระบบ', inspect_notification:'ตรวจสอบรายละเอียด',
    }[row.action_kind] || 'ตรวจสอบ' },
    occurredAt:row.occurred_at || null,
  };
  if (row.action_kind === 'inspect_notification') {
    result.notification = projectNotificationDetails(row.details, row.status);
  }
  return result;
}

function syntheticRows({ scheduler = {} } = {}) {
  const rows = [];
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
  schedulerHealth = () => ({ configuredJobs:0, jobs:{} }),
} = {}) {
  async function listExceptions(input = {}) {
    const query = normalizeQuery(input);
    const params = [query.category, query.status, query.search];
    const countResult = await queryFn(COUNT_SQL, params);
    const persistedTotal = Number(countResult.rows?.[0]?.total) || 0;
    const synthetic = syntheticRows({ scheduler:schedulerHealth() })
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

module.exports = { CATEGORIES, STATUSES, NOTIFICATION_KIND_LABELS, NOTIFICATION_ERROR_LABELS,
  LIST_SQL, COUNT_SQL, normalizeQuery, notificationKindLabel, notificationErrorLabel,
  projectNotificationDetails, projectRow, syntheticRows, createAdminExceptionService };
