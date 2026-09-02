const {databaseQuery}=require('../db');
function createIntegrationControlCenterRepository({queryFn=databaseQuery}={}){
  const many=async(sql,params=[])=>(await queryFn(sql,params)).rows;
  const one=async(sql,params=[])=>(await queryFn(sql,params)).rows[0]||null;
  const identityBase=`WITH identity_rows AS (
    SELECT sm.external_subject_mapping_id AS row_id,sm.external_center_id,sm.external_resident_id,
      sm.mapping_status,sm.center_id,sm.resident_id,sm.care_profile_id,sm.last_seen_at,
      sm.created_at,sm.updated_at,cm.status AS center_mapping_status,
      c.data->>'name' AS center_name,r.data->>'full_name' AS resident_name,
      r.data->>'room' AS room,r.data->>'status' AS resident_status,
      CASE WHEN NULLIF(r.data->>'care_profile_id','')=sm.care_profile_id
        AND cp.data IS NOT NULL
        AND COALESCE(cp.data->>'status','active') NOT IN ('inactive','revoked','deleted')
        THEN TRUE ELSE FALSE END AS care_profile_ready,
      EXISTS(SELECT 1 FROM "groupBindings" gb WHERE gb.data->>'kind'='family'
        AND gb.data->>'care_profile_id'=sm.care_profile_id AND gb.data->>'status'='active') AS family_destination_ready,
      (SELECT al.data->>'source' FROM "auditLog" al
        WHERE al.data->>'action'='integration.mapping_origin'
          AND al.data->>'integration_client_id'=sm.integration_client_id
          AND al.data->>'external_center_id'=sm.external_center_id
          AND al.data->>'external_resident_id'=sm.external_resident_id
        ORDER BY al.created_at DESC LIMIT 1) AS mapping_source,
      NULL::int AS candidate_count,NULL::text AS alert_status,'mapping'::text AS row_kind
    FROM external_subject_mappings sm
    LEFT JOIN external_center_mappings cm ON cm.integration_client_id=sm.integration_client_id
      AND cm.external_center_id=sm.external_center_id
    LEFT JOIN "centers" c ON c.data->>'center_id'=sm.center_id
    LEFT JOIN "residents" r ON r.data->>'resident_id'=sm.resident_id
    LEFT JOIN "careProfiles" cp ON cp.data->>'care_profile_id'=sm.care_profile_id
    WHERE sm.integration_client_id=$1
    UNION ALL
    SELECT al.data->>'log_id',al.data->>'external_center_id',al.data->>'external_resident_id',
      'ambiguous',NULL,NULL,NULL,al.data->>'last_seen_at',al.created_at,al.updated_at,
      NULL,NULL,NULL,NULL,NULL,FALSE,FALSE,NULL,
      CASE WHEN COALESCE(al.data->>'candidate_count','')~'^[0-9]+$' THEN (al.data->>'candidate_count')::int ELSE 0 END,
      al.data->>'status','ambiguity'
    FROM "auditLog" al WHERE al.data->>'action'='integration.identity_ambiguity_alert'
      AND al.data->>'integration_client_id'=$1
  )`;
  const historyFrom=`FROM integration_event_inbox e
    JOIN integration_clients ic ON ic.integration_client_id=e.integration_client_id
    LEFT JOIN "centers" c ON c.data->>'center_id'=e.center_id
    LEFT JOIN "residents" r ON r.data->>'resident_id'=e.resident_id
    LEFT JOIN LATERAL (
      SELECT CASE WHEN data->>'status' IN ('pending','sending','retrying','dead_letter','sent','suppressed') THEN data->>'status' END AS delivery_status,
        CASE WHEN COALESCE(data->>'attempts','')~'^[0-9]{1,9}$' THEN (data->>'attempts')::int ELSE 0 END AS delivery_attempts,
        CASE WHEN COALESCE(data->>'last_error','')~'^[A-Z0-9_]{2,100}$' THEN data->>'last_error' END AS delivery_error_code,
        data->>'created_at' AS notification_created_at,data->>'next_attempt_at' AS notification_next_attempt_at,
        data->>'sent_at' AS notification_sent_at,
        COALESCE(data->>'updated_at',data->>'_updatedAt') AS notification_updated_at,
        CASE WHEN COALESCE(data->>'provider_acceptance','')~'^[a-z0-9_:-]{1,80}$' THEN data->>'provider_acceptance' END AS provider_acceptance
      FROM "notificationOutbox" n
      WHERE n.data->'meta'->>'resourceId'=e.canonical_resource_id
        AND n.data->'meta'->>'resourceType' IN ('daily_care','daily_care_report')
      ORDER BY n.created_at DESC LIMIT 1
    ) notification ON TRUE`;
  const historyColumns=`e.integration_event_id,e.integration_client_id,e.event_type,e.status,e.resident_id,e.care_profile_id,
    e.canonical_resource_type,e.canonical_resource_id,e.pending_reason,e.last_error_code,
    (e.verified_line_group_id IS NOT NULL) AS family_destination_verified,e.group_reconciliation_status,e.notification_intent_status,
    e.attempt_count,e.next_attempt_at,e.created_at,e.updated_at,e.processed_at,
    ic.display_name AS integration_name,ic.client_code,ic.source_system,
    c.data->>'name' AS center_name,r.data->>'full_name' AS resident_name,r.data->>'room' AS room,
    notification.delivery_status AS notification_delivery_status,notification.delivery_attempts,
    notification.delivery_error_code,notification.notification_created_at,notification.notification_next_attempt_at,
    notification.notification_sent_at,notification.notification_updated_at,notification.provider_acceptance`;
  const historyFilter=`WHERE ($1::text IS NULL OR e.integration_client_id=$1)
    AND ($2::text IS NULL OR e.status=$2)
    AND ($3::timestamptz IS NULL OR e.created_at >= $3)
    AND ($4::timestamptz IS NULL OR e.created_at < $4)
    AND ($5::text IS NULL
      OR ($5='identity' AND (e.pending_reason='subject_mapping' OR e.last_error_code IN ('SUBJECT_MAPPING_NOT_FOUND','RESIDENT_MAPPING_INVALID','CARE_PROFILE_RELATIONSHIP_INVALID')))
      OR ($5='family_destination' AND e.group_reconciliation_status IN ('group_binding_missing','group_binding_mismatch'))
      OR ($5='notification' AND (e.notification_intent_status='enqueue_failed' OR notification.delivery_status IN ('retrying','dead_letter')))
      OR ($5='processing' AND e.status IN ('rejected','retrying','dead')))
    AND ($6::text IS NULL OR RIGHT(e.integration_event_id,6)=$6)`;
  return{
    listIdentityChains({integrationClientId,status=null,limit=20,offset=0}){return many(`${identityBase}
      SELECT * FROM identity_rows WHERE ($2::text IS NULL OR mapping_status=$2)
      ORDER BY COALESCE(last_seen_at,updated_at,created_at) DESC,row_id DESC LIMIT $3 OFFSET $4`,
    [integrationClientId,status,limit,offset]);},
    countIdentityChains({integrationClientId,status=null}){return one(`${identityBase}
      SELECT COUNT(*)::int AS total FROM identity_rows WHERE ($2::text IS NULL OR mapping_status=$2)`,[integrationClientId,status]);},
    listHistory({integrationClientId=null,status=null,from=null,to=null,category=null,referenceSuffix=null,limit=20,offset=0}){return many(`SELECT ${historyColumns} ${historyFrom} ${historyFilter}
      ORDER BY e.created_at DESC,e.integration_event_id DESC LIMIT $7 OFFSET $8`,[integrationClientId,status,from,to,category,referenceSuffix,limit,offset]);},
    countHistory({integrationClientId=null,status=null,from=null,to=null,category=null,referenceSuffix=null}){return one(`SELECT COUNT(*)::int AS total ${historyFrom} ${historyFilter}`,[integrationClientId,status,from,to,category,referenceSuffix]);},
    findHistoryEvent(integrationEventId){return one(`SELECT ${historyColumns} ${historyFrom} WHERE e.integration_event_id=$1`,[integrationEventId]);},
  };
}
module.exports={createIntegrationControlCenterRepository};
