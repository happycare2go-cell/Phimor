function clone(value){return value===undefined?undefined:JSON.parse(JSON.stringify(value));}
function createIntegrationAdapterMemoryRepository({now=()=>new Date('2026-09-01T00:00:00.000Z')}={}){
  const state={samples:[],profiles:[]};
  return{state,
    async expireSessions(){const expired=state.samples.filter((row)=>(row.status==='waiting'&&new Date(row.capture_expires_at)<=now())||(row.status==='captured'&&new Date(row.sample_expires_at)<=now()));expired.forEach((row)=>{row.status='expired';row.sample_payload=null;});return clone(expired.map((row)=>({adapter_sample_id:row.adapter_sample_id})));},
    async cancelWaiting(clientId,target){const rows=state.samples.filter((row)=>row.integration_client_id===clientId&&row.target_event_type===target&&row.status==='waiting');rows.forEach((row)=>{row.status='cancelled';});return clone(rows);},
    async createCapture(r){const row={adapter_sample_id:r.sampleId,integration_client_id:r.integrationClientId,target_event_type:r.targetEventType,status:'waiting',capture_expires_at:r.captureExpiresAt,sample_expires_at:null,sample_payload:null,source_structural_fingerprint:null,sample_size_bytes:null,discovered_field_count:null,captured_at:null,created_by:r.createdBy,created_at:'2026-09-01T00:00:00.000Z',updated_at:'2026-09-01T00:00:00.000Z'};state.samples.push(row);return clone(row);},
    async findWaitingCapture(clientId){return clone(state.samples.find((row)=>row.integration_client_id===clientId&&row.status==='waiting'&&new Date(row.capture_expires_at)>now()));},
    async captureSample(r){const row=state.samples.find((item)=>item.adapter_sample_id===r.sampleId&&item.status==='waiting');if(!row)return null;Object.assign(row,{status:'captured',sample_payload:clone(r.payload),source_structural_fingerprint:r.fingerprint,sample_size_bytes:r.sizeBytes,discovered_field_count:r.fieldCount,sample_expires_at:r.sampleExpiresAt,captured_at:'2026-09-01T00:01:00.000Z'});return clone(row);},
    async findSample(clientId,sampleId){return clone(state.samples.find((row)=>row.integration_client_id===clientId&&row.adapter_sample_id===sampleId));},
    async findLatestSample(clientId,target){return clone([...state.samples].reverse().find((row)=>row.integration_client_id===clientId&&row.target_event_type===target&&['waiting','captured'].includes(row.status)));},
    async nextVersion(clientId,target){return{version:1+Math.max(0,...state.profiles.filter((row)=>row.integration_client_id===clientId&&row.target_event_type===target).map((row)=>row.version))};},
    async createDraft(r){const row={adapter_profile_id:r.adapterProfileId,integration_client_id:r.integrationClientId,target_event_type:r.targetEventType,version:r.version,status:'draft',mapping_rules:clone(r.mappingRules),source_structural_fingerprint:r.fingerprint,created_by:r.createdBy,activated_by:null,activated_at:null,created_at:'2026-09-01T00:02:00.000Z',updated_at:'2026-09-01T00:02:00.000Z'};state.profiles.push(row);return clone(row);},
    async findProfile(clientId,id){return clone(state.profiles.find((row)=>row.integration_client_id===clientId&&row.adapter_profile_id===id));},
    async findActive(clientId,target=null){return clone([...state.profiles].reverse().find((row)=>row.integration_client_id===clientId&&row.status==='active'&&(!target||row.target_event_type===target)));},
    async listProfiles(clientId,target){return clone(state.profiles.filter((row)=>row.integration_client_id===clientId&&row.target_event_type===target).sort((a,b)=>b.version-a.version));},
    async supersedeActive(clientId,target){const rows=state.profiles.filter((row)=>row.integration_client_id===clientId&&row.target_event_type===target&&row.status==='active');rows.forEach((row)=>{row.status='superseded';});return clone(rows);},
    async activateProfile(id,actor){const row=state.profiles.find((item)=>item.adapter_profile_id===id&&item.status==='draft');if(!row)return null;Object.assign(row,{status:'active',activated_by:actor,activated_at:'2026-09-01T00:03:00.000Z'});return clone(row);},
    async consumeSample(id){const row=state.samples.find((item)=>item.adapter_sample_id===id&&item.status==='captured');if(!row)return null;row.status='consumed';row.sample_payload=null;return{adapter_sample_id:id};},
  };
}
module.exports={createIntegrationAdapterMemoryRepository};
