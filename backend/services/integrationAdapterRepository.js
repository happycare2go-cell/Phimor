const {databaseQuery}=require('../db');
function createIntegrationAdapterRepository({queryFn=databaseQuery}={}){
  const one=async(sql,params=[])=>(await queryFn(sql,params)).rows[0]||null;
  const many=async(sql,params=[])=>(await queryFn(sql,params)).rows;
  return{
    expireSessions(){return many(`UPDATE integration_adapter_samples SET status='expired',sample_payload=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE (status='waiting' AND capture_expires_at<=CURRENT_TIMESTAMP)
         OR (status='captured' AND sample_expires_at<=CURRENT_TIMESTAMP)
      RETURNING adapter_sample_id`);},
    cancelWaiting(integrationClientId,targetEventType){return many(`UPDATE integration_adapter_samples SET status='cancelled',updated_at=CURRENT_TIMESTAMP
      WHERE integration_client_id=$1 AND target_event_type=$2 AND status='waiting' RETURNING adapter_sample_id`,[integrationClientId,targetEventType]);},
    createCapture(record){return one(`INSERT INTO integration_adapter_samples(
      adapter_sample_id,integration_client_id,target_event_type,status,capture_expires_at,created_by
      ) VALUES($1,$2,$3,'waiting',$4,$5) RETURNING *`,[record.sampleId,record.integrationClientId,record.targetEventType,record.captureExpiresAt,record.createdBy]);},
    findWaitingCapture(integrationClientId){return one(`SELECT * FROM integration_adapter_samples
      WHERE integration_client_id=$1 AND status='waiting' AND capture_expires_at>CURRENT_TIMESTAMP
      ORDER BY created_at DESC LIMIT 1`,[integrationClientId]);},
    captureSample({sampleId,payload,fingerprint,sizeBytes,fieldCount,sampleExpiresAt}){return one(`UPDATE integration_adapter_samples SET status='captured',sample_payload=$2::jsonb,
      source_structural_fingerprint=$3,sample_size_bytes=$4,discovered_field_count=$5,
      sample_expires_at=$6,captured_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE adapter_sample_id=$1 AND status='waiting' AND capture_expires_at>CURRENT_TIMESTAMP RETURNING *`,
    [sampleId,JSON.stringify(payload),fingerprint,sizeBytes,fieldCount,sampleExpiresAt]);},
    findSample(integrationClientId,sampleId){return one(`SELECT * FROM integration_adapter_samples
      WHERE integration_client_id=$1 AND adapter_sample_id=$2`,[integrationClientId,sampleId]);},
    findLatestSample(integrationClientId,targetEventType){return one(`SELECT * FROM integration_adapter_samples
      WHERE integration_client_id=$1 AND target_event_type=$2 AND status IN ('waiting','captured')
      ORDER BY created_at DESC LIMIT 1`,[integrationClientId,targetEventType]);},
    nextVersion(integrationClientId,targetEventType){return one(`SELECT COALESCE(MAX(version),0)+1 AS version
      FROM integration_adapter_profiles WHERE integration_client_id=$1 AND target_event_type=$2`,[integrationClientId,targetEventType]);},
    createDraft(record){return one(`INSERT INTO integration_adapter_profiles(
      adapter_profile_id,integration_client_id,target_event_type,version,status,mapping_rules,
      source_structural_fingerprint,created_by) VALUES($1,$2,$3,$4,'draft',$5::jsonb,$6,$7) RETURNING *`,
    [record.adapterProfileId,record.integrationClientId,record.targetEventType,record.version,
      JSON.stringify(record.mappingRules),record.fingerprint,record.createdBy]);},
    findProfile(integrationClientId,adapterProfileId){return one(`SELECT * FROM integration_adapter_profiles
      WHERE integration_client_id=$1 AND adapter_profile_id=$2`,[integrationClientId,adapterProfileId]);},
    findActive(integrationClientId,targetEventType=null){return one(`SELECT * FROM integration_adapter_profiles
      WHERE integration_client_id=$1 AND status='active' ${targetEventType?'AND target_event_type=$2':''}
      ORDER BY version DESC LIMIT 1`,targetEventType?[integrationClientId,targetEventType]:[integrationClientId]);},
    listProfiles(integrationClientId,targetEventType){return many(`SELECT adapter_profile_id,integration_client_id,target_event_type,version,status,
      source_structural_fingerprint,created_by,activated_by,activated_at,created_at,updated_at
      FROM integration_adapter_profiles WHERE integration_client_id=$1 AND target_event_type=$2
      ORDER BY version DESC`,[integrationClientId,targetEventType]);},
    supersedeActive(integrationClientId,targetEventType){return many(`UPDATE integration_adapter_profiles SET status='superseded',updated_at=CURRENT_TIMESTAMP
      WHERE integration_client_id=$1 AND target_event_type=$2 AND status='active' RETURNING adapter_profile_id`,[integrationClientId,targetEventType]);},
    activateProfile(adapterProfileId,actorReference){return one(`UPDATE integration_adapter_profiles SET status='active',
      activated_by=$2,activated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE adapter_profile_id=$1 AND status='draft' RETURNING *`,[adapterProfileId,actorReference]);},
    consumeSample(sampleId){return one(`UPDATE integration_adapter_samples SET status='consumed',sample_payload=NULL,
      updated_at=CURRENT_TIMESTAMP WHERE adapter_sample_id=$1 AND status='captured' RETURNING adapter_sample_id`,[sampleId]);},
  };
}
module.exports={createIntegrationAdapterRepository};
