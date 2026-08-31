const {databaseQuery}=require('../db');
function createIntegrationAdapterRepository({queryFn=databaseQuery}={}){
  const one=async(sql,params=[])=>(await queryFn(sql,params)).rows[0]||null;
  const many=async(sql,params=[])=>(await queryFn(sql,params)).rows;
  return{
    expireSessions(){return many(`UPDATE integration_adapter_samples SET status='expired',sample_payload=NULL,updated_at=CURRENT_TIMESTAMP
      WHERE (status='waiting' AND capture_expires_at<=CURRENT_TIMESTAMP)
         OR (status='captured' AND sample_expires_at<=CURRENT_TIMESTAMP) RETURNING adapter_sample_id`);},
    cancelWaiting(integrationClientId,targetEventType){return many(`UPDATE integration_adapter_samples SET status='cancelled',updated_at=CURRENT_TIMESTAMP
      WHERE integration_client_id=$1 AND target_event_type=$2 AND status='waiting' RETURNING adapter_sample_id`,[integrationClientId,targetEventType]);},
    createCapture(record){return one(`INSERT INTO integration_adapter_samples(
      adapter_sample_id,integration_client_id,source_system_key,target_event_type,status,capture_expires_at,created_by
      ) VALUES($1,$2,$3,$4,'waiting',$5,$6) RETURNING *`,[record.sampleId,record.integrationClientId,record.sourceSystemKey,record.targetEventType,record.captureExpiresAt,record.createdBy]);},
    findWaitingCapture(integrationClientId){return one(`SELECT * FROM integration_adapter_samples
      WHERE integration_client_id=$1 AND status='waiting' AND capture_expires_at>CURRENT_TIMESTAMP
      ORDER BY created_at DESC LIMIT 1`,[integrationClientId]);},
    captureSample({sampleId,payload,fingerprint,sourceStructure,sizeBytes,fieldCount,sampleExpiresAt}){return one(`UPDATE integration_adapter_samples SET status='captured',sample_payload=$2::jsonb,
      source_structural_fingerprint=$3,source_structure=$4::jsonb,sample_size_bytes=$5,discovered_field_count=$6,
      sample_expires_at=$7,captured_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE adapter_sample_id=$1 AND status='waiting' AND capture_expires_at>CURRENT_TIMESTAMP RETURNING *`,
    [sampleId,JSON.stringify(payload),fingerprint,JSON.stringify(sourceStructure),sizeBytes,fieldCount,sampleExpiresAt]);},
    findSample(integrationClientId,sampleId){return one(`SELECT * FROM integration_adapter_samples
      WHERE integration_client_id=$1 AND adapter_sample_id=$2`,[integrationClientId,sampleId]);},
    findLatestSample(integrationClientId,targetEventType){return one(`SELECT * FROM integration_adapter_samples
      WHERE integration_client_id=$1 AND target_event_type=$2 AND status IN ('waiting','captured')
      ORDER BY created_at DESC LIMIT 1`,[integrationClientId,targetEventType]);},
    createTemplate(record){return one(`INSERT INTO integration_adapter_templates(
      adapter_template_id,source_system_key,source_system_label,target_event_type,lineage_fingerprint,display_name,status,created_by
      ) VALUES($1,$2,$3,$4,$5,$6,'active',$7) RETURNING *`,[record.templateId,record.sourceSystemKey,record.sourceSystemLabel,record.targetEventType,record.fingerprint,record.displayName,record.createdBy]);},
    findTemplate(templateId){return one(`SELECT * FROM integration_adapter_templates WHERE adapter_template_id=$1`,[templateId]);},
    findTemplateByLineage(sourceSystemKey,targetEventType,fingerprint){return one(`SELECT * FROM integration_adapter_templates
      WHERE source_system_key=$1 AND target_event_type=$2 AND lineage_fingerprint=$3`,[sourceSystemKey,targetEventType,fingerprint]);},
    listReusableTemplates(sourceSystemKey,targetEventType){return many(`SELECT t.*,v.adapter_version_id,v.version,v.status AS version_status,v.mapping_rules,
      v.source_structural_fingerprint,v.source_structure,v.activated_at,
      (SELECT COUNT(*)::int FROM integration_adapter_bindings b WHERE b.adapter_template_id=t.adapter_template_id AND b.status='active') AS binding_count
      FROM integration_adapter_templates t JOIN integration_adapter_versions v ON v.adapter_template_id=t.adapter_template_id AND v.status='active'
      WHERE t.source_system_key=$1 AND t.target_event_type=$2 AND t.status='active' ORDER BY t.created_at`,[sourceSystemKey,targetEventType]);},
    nextVersion(templateId){return one(`SELECT COALESCE(MAX(version),0)+1 AS version FROM integration_adapter_versions
      WHERE adapter_template_id=$1`,[templateId]);},
    createDraft(record){return one(`INSERT INTO integration_adapter_versions(
      adapter_version_id,adapter_template_id,version,status,mapping_rules,source_structural_fingerprint,source_structure,created_by
      ) VALUES($1,$2,$3,'draft',$4::jsonb,$5,$6::jsonb,$7) RETURNING *`,
    [record.adapterVersionId,record.templateId,record.version,JSON.stringify(record.mappingRules),record.fingerprint,JSON.stringify(record.sourceStructure),record.createdBy]);},
    findVersion(versionId){return one(`SELECT v.*,t.source_system_key,t.source_system_label,t.target_event_type,t.display_name
      FROM integration_adapter_versions v JOIN integration_adapter_templates t ON t.adapter_template_id=v.adapter_template_id
      WHERE v.adapter_version_id=$1`,[versionId]);},
    findActiveBinding(integrationClientId,targetEventType=null){return one(`SELECT b.*,v.version,v.status AS version_status,v.mapping_rules,v.source_structural_fingerprint,v.source_structure,v.activated_at,
      t.source_system_key,t.source_system_label,t.display_name,t.status AS template_status
      FROM integration_adapter_bindings b
      JOIN integration_adapter_versions v ON v.adapter_version_id=b.adapter_version_id
      JOIN integration_adapter_templates t ON t.adapter_template_id=b.adapter_template_id
      WHERE b.integration_client_id=$1 AND b.status='active' ${targetEventType?'AND b.target_event_type=$2':''}
      ORDER BY b.activated_at DESC LIMIT 1`,targetEventType?[integrationClientId,targetEventType]:[integrationClientId]);},
    listVersions(templateId){return many(`SELECT v.*,t.source_system_key,t.source_system_label,t.target_event_type,t.display_name,
      (SELECT COUNT(*)::int FROM integration_adapter_bindings b WHERE b.adapter_template_id=t.adapter_template_id AND b.status='active') AS binding_count
      FROM integration_adapter_versions v JOIN integration_adapter_templates t ON t.adapter_template_id=v.adapter_template_id
      WHERE v.adapter_template_id=$1 ORDER BY v.version DESC`,[templateId]);},
    supersedeActive(templateId){return many(`UPDATE integration_adapter_versions SET status='superseded',updated_at=CURRENT_TIMESTAMP
      WHERE adapter_template_id=$1 AND status='active' RETURNING adapter_version_id`,[templateId]);},
    activateVersion(versionId,actorReference){return one(`UPDATE integration_adapter_versions SET status='active',
      activated_by=$2,activated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP
      WHERE adapter_version_id=$1 AND status IN ('draft','superseded') RETURNING *`,[versionId,actorReference]);},
    deactivateClientBinding(integrationClientId,targetEventType){return many(`UPDATE integration_adapter_bindings SET status='inactive',updated_at=CURRENT_TIMESTAMP
      WHERE integration_client_id=$1 AND target_event_type=$2 AND status='active' RETURNING adapter_binding_id`,[integrationClientId,targetEventType]);},
    createBinding(record){return one(`INSERT INTO integration_adapter_bindings(adapter_binding_id,integration_client_id,target_event_type,
      adapter_template_id,adapter_version_id,status,activated_by) VALUES($1,$2,$3,$4,$5,'active',$6) RETURNING *`,
    [record.bindingId,record.integrationClientId,record.targetEventType,record.templateId,record.versionId,record.actorReference]);},
    updateTemplateBindings(templateId,versionId,actorReference){return many(`UPDATE integration_adapter_bindings SET adapter_version_id=$2,
      activated_by=$3,activated_at=CURRENT_TIMESTAMP,updated_at=CURRENT_TIMESTAMP WHERE adapter_template_id=$1 AND status='active'
      RETURNING adapter_binding_id`,[templateId,versionId,actorReference]);},
    countBindings(templateId){return one(`SELECT COUNT(*)::int AS count FROM integration_adapter_bindings
      WHERE adapter_template_id=$1 AND status='active'`,[templateId]);},
    consumeSample(sampleId){return one(`UPDATE integration_adapter_samples SET status='consumed',sample_payload=NULL,
      updated_at=CURRENT_TIMESTAMP WHERE adapter_sample_id=$1 AND status='captured' RETURNING adapter_sample_id`,[sampleId]);},
    upsertNotice(record){return one(`INSERT INTO integration_adapter_source_notices(adapter_notice_id,adapter_template_id,adapter_version_id,
      notice_type,source_field_key,source_path,value_type,status) VALUES($1,$2,$3,$4,$5,$6,$7,'available')
      ON CONFLICT(adapter_template_id,notice_type,source_field_key) DO UPDATE SET
        adapter_version_id=EXCLUDED.adapter_version_id,
        occurrence_count=integration_adapter_source_notices.occurrence_count+1,last_seen_at=CURRENT_TIMESTAMP,
        updated_at=CURRENT_TIMESTAMP RETURNING *`,[record.noticeId,record.templateId,record.versionId,record.noticeType,
      record.fieldKey,record.sourcePath,record.valueType||null]);},
    listNotices(templateId){return many(`SELECT adapter_notice_id,notice_type,source_field_key,source_path,value_type,status,
      occurrence_count,first_seen_at,last_seen_at,updated_at FROM integration_adapter_source_notices
      WHERE adapter_template_id=$1 AND status IN ('available','review_later') ORDER BY last_seen_at DESC LIMIT 100`,[templateId]);},
    updateNotice(templateId,noticeId,status,actorReference){return one(`UPDATE integration_adapter_source_notices SET status=$3,updated_by=$4,
      updated_at=CURRENT_TIMESTAMP WHERE adapter_template_id=$1 AND adapter_notice_id=$2 RETURNING *`,[templateId,noticeId,status,actorReference]);},
  };
}
module.exports={createIntegrationAdapterRepository};
