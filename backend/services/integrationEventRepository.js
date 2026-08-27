const {databaseQuery}=require('../db');
function createIntegrationEventRepository({queryFn=databaseQuery}={}){const one=async(sql,p=[])=>(await queryFn(sql,p)).rows[0]||null;const many=async(sql,p=[])=>(await queryFn(sql,p)).rows;
  return{
    insertEvent(r){return one(`INSERT INTO integration_event_inbox (
      integration_event_id,integration_client_id,organization_id,external_event_id,event_type,
      payload_sha256,canonical_payload,status,external_center_id,external_resident_id,center_id
    ) VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,'received',$8,$9,$10)
    ON CONFLICT (integration_client_id,external_event_id) DO NOTHING RETURNING *`,
    [r.integrationEventId,r.integrationClientId,r.organizationId,r.externalEventId,r.eventType,r.payloadSha256,
      JSON.stringify(r.canonicalPayload),r.externalCenterId,r.externalResidentId,r.centerId]);},
    findByExternalId(clientId,eventId){return one('SELECT * FROM integration_event_inbox WHERE integration_client_id=$1 AND external_event_id=$2',[clientId,eventId]);},
    findEvent(id){return one('SELECT * FROM integration_event_inbox WHERE integration_event_id=$1',[id]);},
    claimEvent(id){return one(`UPDATE integration_event_inbox SET status='processing',attempt_count=attempt_count+1,updated_at=CURRENT_TIMESTAMP
      WHERE integration_event_id=$1 AND (
        (status IN ('received','pending','retrying') AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP))
        OR (status='processing' AND updated_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes')
      ) RETURNING *`,[id]);},
    markPending(id,{residentId=null,careProfileId=null,reason='subject_mapping'}={}){return one(`UPDATE integration_event_inbox SET status='pending',resident_id=$2,care_profile_id=$3,pending_reason=$4,
      last_error_code=NULL,next_attempt_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE integration_event_id=$1 RETURNING *`,[id,residentId,careProfileId,reason]);},
    markProcessed(id,{residentId,careProfileId,resourceType,resourceId}){return one(`UPDATE integration_event_inbox SET status='processed',resident_id=$2,care_profile_id=$3,
      canonical_resource_type=$4,canonical_resource_id=$5,pending_reason=NULL,last_error_code=NULL,next_attempt_at=NULL,
      processed_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE integration_event_id=$1 RETURNING *`,[id,residentId,careProfileId,resourceType,resourceId]);},
    markRejected(id,errorCode){return one(`UPDATE integration_event_inbox SET status='rejected',last_error_code=$2,pending_reason=NULL,
      next_attempt_at=NULL,updated_at=CURRENT_TIMESTAMP WHERE integration_event_id=$1 RETURNING *`,[id,errorCode]);},
    markRetry(id,{errorCode,nextAttemptAt,dead}){return one(`UPDATE integration_event_inbox SET status=$2,last_error_code=$3,
      next_attempt_at=$4,updated_at=CURRENT_TIMESTAMP WHERE integration_event_id=$1 RETURNING *`,[id,dead?'dead':'retrying',errorCode,dead?null:nextAttemptAt]);},
    listDue(limit=25){return many(`SELECT integration_event_id FROM integration_event_inbox
      WHERE (status IN ('received','retrying') AND (next_attempt_at IS NULL OR next_attempt_at<=CURRENT_TIMESTAMP))
      OR (status='processing' AND updated_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes')
      ORDER BY created_at,integration_event_id LIMIT $1`,[limit]);},
    listPending({integrationClientId=null,externalCenterId=null,externalResidentId=null,limit=50}={}){const p=[];const where=["status='pending'"];if(integrationClientId){p.push(integrationClientId);where.push(`integration_client_id=$${p.length}`);}if(externalCenterId){p.push(externalCenterId);where.push(`external_center_id=$${p.length}`);}if(externalResidentId){p.push(externalResidentId);where.push(`external_resident_id=$${p.length}`);}p.push(limit);return many(`SELECT integration_event_id,integration_client_id,organization_id,event_type,external_event_id,
      external_center_id,external_resident_id,status,pending_reason,attempt_count,created_at,updated_at,
      canonical_payload->'subject'->>'displayName' AS display_name,
      canonical_payload->'subject'->>'room' AS room
      FROM integration_event_inbox WHERE ${where.join(' AND ')} ORDER BY created_at,integration_event_id LIMIT $${p.length}`,p);},
  };}
module.exports={createIntegrationEventRepository};
