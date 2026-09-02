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
  return{
    listIdentityChains({integrationClientId,status=null,limit=20,offset=0}){return many(`${identityBase}
      SELECT * FROM identity_rows WHERE ($2::text IS NULL OR mapping_status=$2)
      ORDER BY COALESCE(last_seen_at,updated_at,created_at) DESC,row_id DESC LIMIT $3 OFFSET $4`,
    [integrationClientId,status,limit,offset]);},
    countIdentityChains({integrationClientId,status=null}){return one(`${identityBase}
      SELECT COUNT(*)::int AS total FROM identity_rows WHERE ($2::text IS NULL OR mapping_status=$2)`,[integrationClientId,status]);},
  };
}
module.exports={createIntegrationControlCenterRepository};
