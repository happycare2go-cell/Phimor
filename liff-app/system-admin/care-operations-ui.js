(function initCareOperationsUI(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhimorCareOperationsUI = api;
}(typeof window !== 'undefined' ? window : globalThis, function careOperationsFactory() {
  const CAPABILITY_LABELS = Object.freeze({
    vital_signs_v1: 'สัญญาณชีพ', daily_care_v1: 'บันทึกการดูแลประจำวัน',
  });
  const SUPPORTED_EVENT_TYPES = Object.freeze([
    'care.daily_report.finalized', 'care.vitals.recorded',
  ]);
  const CLIENT_STATUS_LABELS = Object.freeze({
    active:['เปิดใช้งาน', 'ok'], suspended:['ระงับการใช้งาน', 'warn'], revoked:['เพิกถอนแล้ว', 'bad'],
  });
  const GROUP_LABELS = Object.freeze({
    verified_match: ['VERIFIED', 'กลุ่ม LINE ตรงกัน', 'ok'],
    group_binding_missing: ['MISSING', 'ยังไม่พบกลุ่ม LINE ที่พี่หมอยืนยันแล้ว', 'warn'],
    group_binding_mismatch: ['MISMATCH', 'กลุ่ม LINE ไม่ตรงกัน', 'bad'],
    no_expected_group: ['NOT_PROVIDED', 'ระบบต้นทางไม่ได้ส่ง Group ID สำหรับตรวจสอบ', ''],
  });
  const EVENT_STATUS_LABELS = Object.freeze({
    pending_subject_mapping:['รอเชื่อมผู้พัก', 'ข้อมูลถูกเก็บไว้อย่างปลอดภัยและยังไม่สร้างข้อมูลผู้พัก', 'warn'],
    rejected:['ปฏิเสธ', 'event ไม่ผ่านข้อกำหนดและจะไม่ถูกประมวลผลอัตโนมัติ', 'bad'],
    retrying:['ประมวลผลไม่สำเร็จ', 'ระบบจะลองประมวลผลใหม่ตามนโยบาย', 'warn'],
    dead:['ประมวลผลไม่สำเร็จ', 'ครบจำนวนครั้งที่ระบบกำหนดแล้ว ต้องตรวจสอบ', 'bad'],
  });
  const REJECTION_REASON_LABELS = Object.freeze({
    CENTER_MAPPING_NOT_FOUND:'ไม่พบการเชื่อมสาขา',
    RESIDENT_MAPPING_INVALID:'การเชื่อมผู้พักไม่ถูกต้อง',
    CARE_PROFILE_RELATIONSHIP_INVALID:'ความสัมพันธ์ผู้พักกับ Care Profile ไม่ถูกต้อง',
    INVALID_FINALIZED_RECORD:'ข้อมูลไม่ตรง schema หรือข้อกำหนดของ finalized record',
    INVALID_EXTERNAL_RECORD_ID:'รหัสรายการต้นทางไม่ถูกต้อง',
    SUBJECT_MAPPING_NOT_FOUND:'ยังไม่พบการเชื่อมผู้พัก',
    GROUP_RECONCILIATION_BLOCKED:'การตรวจสอบกลุ่ม LINE ยังไม่ผ่าน',
    CAPABILITY_NOT_ENABLED:'capability ยังไม่เปิด',
    EVENT_ID_REUSED:'event_id ถูกใช้กับข้อมูลที่ต่างกัน',
    INTEGRATION_SCOPE_FORBIDDEN:'Integration ไม่มีสิทธิ์สำหรับข้อมูลนี้',
    INVALID_CREDENTIAL:'Credential ไม่ถูกต้องหรือถูกเพิกถอน',
    RATE_LIMITED:'เรียกใช้งานถี่เกินไป',
    TEMPORARY_PROCESSING_UNAVAILABLE:'ระบบประมวลผลชั่วคราวไม่สำเร็จ',
    PROCESSING_RETRY_EXHAUSTED:'ประมวลผลไม่สำเร็จภายในจำนวนครั้งที่กำหนด',
  });
  const IDENTITY_POLICY_LABELS = Object.freeze({
    identityResolutionMode:{ exact_name_learning:'จับคู่ชื่อเต็มแบบตรงกันและเรียนรู้รหัสภายนอก', manual_mapping_only:'ใช้ Mapping ที่ผู้ดูแลกำหนดเท่านั้น' },
    unresolvedEventPolicy:{ ignore:'ตีตกและไม่เก็บข้อมูล', pending_subject_mapping:'เก็บไว้ให้ผู้ดูแลจับคู่ภายหลัง' },
    familyGroupRequirement:{ required_before_ingest:'ต้องมี', optional_for_ingest:'ไม่บังคับ' },
  });
  const safeArray = (value, limit = 250) => (Array.isArray(value) ? value.slice(0, limit) : []);
  const safeText = (value, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
  const formatDate = (value) => {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime())
      ? date.toLocaleString('th-TH', { dateStyle:'medium', timeStyle:'short', timeZone:'Asia/Bangkok' }) : 'ยังไม่มีข้อมูล';
  };
  const formatDateOnly = (value) => {
    const date = /^\d{4}-\d{2}-\d{2}$/.test(String(value||'')) ? new Date(`${value}T00:00:00+07:00`) : null;
    return date && Number.isFinite(date.getTime())
      ? date.toLocaleDateString('th-TH',{dateStyle:'long',timeZone:'Asia/Bangkok'}) : 'ยังไม่มีข้อมูล';
  };
  const buildResidentOptionsRequest = (centerId, search = '') => ({
    path:`/api/admin/platform/centers/${encodeURIComponent(centerId)}/resident-options?search=${encodeURIComponent(search)}&limit=100`,
    options:{ method:'GET' },
  });
  const buildMappingRequest = (item, residentId) => ({
    path:'/api/admin/platform/pending-subjects/map',
    options:{ method:'POST', body:JSON.stringify({
      integrationClientId:item.integrationClientId, externalCenterId:item.externalCenterId,
      externalResidentId:item.externalResidentId, residentId,
    }) },
  });
  const buildCapabilityRequest = (centerId, capabilityKey, enabled) => ({
    path:`/api/admin/platform/centers/${encodeURIComponent(centerId)}/capabilities/${encodeURIComponent(capabilityKey)}`,
    options:{ method:'PATCH', body:JSON.stringify({ enabled:Boolean(enabled) }) },
  });
  const buildReconcileRequest = (integrationEventId) => ({
    path:`/api/admin/platform/integration-events/${encodeURIComponent(integrationEventId)}/reconcile-group`,
    options:{ method:'POST', body:'{}' },
  });
  const normalizeClientCode = (value) => safeText(value).toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
  const buildCreateClientRequest = ({ organizationId, clientCode, displayName, sourceSystem }) => ({
    path:`/api/admin/platform/organizations/${encodeURIComponent(organizationId)}/integration-clients`,
    options:{ method:'POST', body:JSON.stringify({
      clientCode:normalizeClientCode(clientCode), displayName:safeText(displayName),
      sourceSystem:safeText(sourceSystem), initialStatus:'suspended',
    }) },
  });
  const buildClientStatusRequest = (integrationClientId, status) => ({
    path:`/api/admin/platform/integration-clients/${encodeURIComponent(integrationClientId)}/status`,
    options:{ method:'PATCH', body:JSON.stringify({ status }) },
  });
  const buildIntegrationDirectoryRequest = ({ search = '', status = '', view = 'current', page = 1, limit = 20 } = {}) => ({
    path:`/api/admin/platform/integration-clients?${new URLSearchParams({search,status,view,page:String(page),limit:String(limit)}).toString()}`,
    options:{ method:'GET' },
  });
  const buildCenterScopeRequest = (integrationClientId, centerId, allowed) => ({
    path:`/api/admin/platform/integration-clients/${encodeURIComponent(integrationClientId)}/centers/${encodeURIComponent(centerId)}`,
    options:{ method:allowed ? 'PUT' : 'DELETE', ...(allowed ? { body:'{}' } : {}) },
  });
  const buildEventScopeRequest = (integrationClientId, eventType, allowed) => ({
    path:`/api/admin/platform/integration-clients/${encodeURIComponent(integrationClientId)}/event-scopes/${encodeURIComponent(eventType)}`,
    options:{ method:allowed ? 'PUT' : 'DELETE', ...(allowed ? { body:'{}' } : {}) },
  });
  const buildCredentialRequest = (integrationClientId, action, credentialId = null) => {
    const base = `/api/admin/platform/integration-clients/${encodeURIComponent(integrationClientId)}/credentials`;
    return { path:credentialId ? `${base}/${encodeURIComponent(credentialId)}/${action}` : base,
      options:{ method:'POST', body:action === 'rotate' ? JSON.stringify({ overlapSeconds:0 }) : '{}' } };
  };
  const buildCenterMappingListRequest = (integrationClientId, { page = 1, status = '', search = '' } = {}) => ({
    path:`/api/admin/platform/integration-clients/${encodeURIComponent(integrationClientId)}/external-centers?${new URLSearchParams({page:String(page),limit:'50',status,search}).toString()}`,
    options:{ method:'GET' },
  });
  const buildCenterMappingRequest = (integrationClientId, externalCenterId, centerId) => ({
    path:`/api/admin/platform/integration-clients/${encodeURIComponent(integrationClientId)}/external-centers/${encodeURIComponent(safeText(externalCenterId))}`,
    options:{ method:'PUT', body:JSON.stringify({ centerId }) },
  });
  const buildDeactivateCenterMappingRequest = (integrationClientId, externalCenterId) => ({
    path:`/api/admin/platform/integration-clients/${encodeURIComponent(integrationClientId)}/external-centers/${encodeURIComponent(externalCenterId)}`,
    options:{ method:'DELETE' },
  });
  const buildSubjectMappingListRequest = (integrationClientId, { page = 1, status = '', search = '' } = {}) => ({
    path:`/api/admin/platform/integration-clients/${encodeURIComponent(integrationClientId)}/external-subjects?${new URLSearchParams({page:String(page),limit:'50',status,search}).toString()}`,
    options:{ method:'GET' },
  });
  const buildSubjectMappingRequest = (integrationClientId, externalCenterId, externalResidentId, residentId) => ({
    path:`/api/admin/platform/integration-clients/${encodeURIComponent(integrationClientId)}/external-centers/${encodeURIComponent(externalCenterId)}/subjects/${encodeURIComponent(safeText(externalResidentId))}`,
    options:{ method:'PUT', body:JSON.stringify({ residentId }) },
  });
  const buildDeactivateSubjectMappingRequest = (integrationClientId, externalCenterId, externalResidentId) => ({
    path:`/api/admin/platform/integration-clients/${encodeURIComponent(integrationClientId)}/external-centers/${encodeURIComponent(externalCenterId)}/subjects/${encodeURIComponent(externalResidentId)}`,
    options:{ method:'DELETE' },
  });
  const buildIdentityPolicyRequest = (integrationClientId, policy) => ({
    path:`/api/admin/platform/integration-clients/${encodeURIComponent(integrationClientId)}/identity-resolution-policy`,
    options:{ method:'PATCH', body:JSON.stringify(policy) },
  });
  const buildAlertStatusRequest = (alertId, status) => ({
    path:`/api/admin/platform/integration-identity-alerts/${encodeURIComponent(alertId)}/status`,
    options:{ method:'PATCH', body:JSON.stringify({ status }) },
  });
  const ADAPTER_EVENT_TYPE='care.daily_report.finalized';
  const adapterBase=(integrationClientId)=>`/api/admin/platform/integration-clients/${encodeURIComponent(integrationClientId)}`;
  const buildAdapterCaptureRequest=(integrationClientId)=>({path:`${adapterBase(integrationClientId)}/adapter-capture`,options:{method:'POST',body:JSON.stringify({targetEventType:ADAPTER_EVENT_TYPE})}});
  const buildAdapterSampleRequest=(integrationClientId)=>({path:`${adapterBase(integrationClientId)}/adapter-samples/latest?targetEventType=${encodeURIComponent(ADAPTER_EVENT_TYPE)}`,options:{method:'GET'}});
  const buildAdapterStatusRequest=(integrationClientId)=>({path:`${adapterBase(integrationClientId)}/adapter-status?targetEventType=${encodeURIComponent(ADAPTER_EVENT_TYPE)}`,options:{method:'GET'}});
  const buildAdapterPreviewRequest=(integrationClientId,sampleId,mappingRules)=>({path:`${adapterBase(integrationClientId)}/adapter-preview`,options:{method:'POST',body:JSON.stringify({sampleId,mappingRules})}});
  const buildAdapterDraftRequest=(integrationClientId,sampleId,mappingRules)=>({path:`${adapterBase(integrationClientId)}/adapter-draft`,options:{method:'PUT',body:JSON.stringify({sampleId,mappingRules})}});
  const buildAdapterActivateRequest=(integrationClientId,sampleId,adapterProfileId)=>({path:`${adapterBase(integrationClientId)}/adapter-activate`,options:{method:'POST',body:JSON.stringify({sampleId,adapterProfileId})}});
  const buildAdapterReuseRequest=(integrationClientId,sampleId,adapterVersionId)=>({path:`${adapterBase(integrationClientId)}/adapter-reuse`,options:{method:'POST',body:JSON.stringify({sampleId,adapterVersionId})}});
  const buildAdapterRollbackRequest=(integrationClientId,adapterVersionId)=>({path:`${adapterBase(integrationClientId)}/adapter-versions/${encodeURIComponent(adapterVersionId)}/rollback`,options:{method:'POST',body:'{}'}});
  const buildAdapterNoticeRequest=(integrationClientId,noticeId,status)=>({path:`${adapterBase(integrationClientId)}/adapter-notices/${encodeURIComponent(noticeId)}`,options:{method:'PATCH',body:JSON.stringify({status})}});
  function createOneTimeSecretState() {
    let value = null;
    return {
      show(secret) { value = safeText(secret); return Boolean(value); },
      read() { return value; },
      clear() { value = null; },
      hasValue() { return Boolean(value); },
    };
  }
  const truncateGroupId = (value) => {
    const normalized = safeText(value);
    return normalized.length > 14 ? `${normalized.slice(0, 6)}…${normalized.slice(-4)}` : normalized;
  };
  const mappingConfirmationMessage = (item, resident, client, center) => [
    'ข้อมูลจากระบบภายนอก',
    `${safeText(client?.displayName) || 'ระบบเชื่อมต่อ'} · ${safeText(center?.name) || 'ไม่ระบุศูนย์'}`,
    safeText(item?.externalResidentId, 'ไม่ระบุรหัสผู้พัก'),
    `${safeText(item?.displayName, 'ไม่ระบุชื่อ')}${safeText(item?.room) ? ` · ห้อง ${item.room}` : ''}`,
    '',
    'กำลังจะเชื่อมกับ',
    `${safeText(resident?.displayName, 'ไม่ระบุชื่อ')}${safeText(resident?.room) ? ` · ห้อง ${resident.room}` : ''}`,
    safeText(center?.name) || 'ไม่ระบุศูนย์',
  ].join('\n');

  function createController({ doc, request, confirmAction = async () => true }) {
    if (!doc || typeof request !== 'function') throw new TypeError('doc and request are required');
    const content = doc.getElementById('careOperationsContent');
    const tabs = Array.from(doc.querySelectorAll('[data-care-ops-tab]')).slice(0, 10);
    let generation = 0;
    let detailGeneration = 0;
    let residentOptionsGeneration = 0;
    const oneTimeSecret = createOneTimeSecretState();
    const state = {
      activeTab:'capabilities', loading:false, error:null, organizations:[], centers:[],
      capabilities:new Map(), integrations:[], pending:[], operational:[], identityAlerts:[], mapping:null, feedback:null,
      integrationSearch:'', integrationStatus:'', integrationView:'current', integrationPage:1,
      integrationPagination:{page:1,limit:20,total:0,totalPages:0}, detail:null, wizard:null,
      availableTabs:tabs.map((tab) => tab.dataset.careOpsTab), loadedTabs:new Set(),
      foundationLoaded:false, foundationCapabilitiesLoaded:false, foundationBounded:null,
    };
    const send = (descriptor) => request(descriptor.path, descriptor.options);
    const element = (tag, className, text) => {
      const node = doc.createElement(tag); if (className) node.className = className;
      if (text !== undefined) node.textContent = text; return node;
    };
    const button = (label, handler, className = 'secondary') => {
      const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', handler); return node;
    };
    const input = (labelText, { type = 'text', maxLength = 160, value = '', required = false, placeholder = '' } = {}) => {
      const label = element('label', 'care-ops__field');
      label.append(element('span', '', labelText));
      const control = element('input'); control.type = type; control.maxLength = maxLength;
      control.value = value; control.required = required; control.placeholder = placeholder; label.append(control);
      return { label, control };
    };
    const selectField = (labelText, options, selected = '') => {
      const label = element('label', 'care-ops__field'); label.append(element('span', '', labelText));
      const control = element('select');
      options.forEach((option) => { const node = element('option', '', option.label); node.value = option.value;
        node.disabled = Boolean(option.disabled); control.append(node); });
      control.value = selected; label.append(control); return { label, control };
    };
    function ensureDialog(id, title) {
      let dialog = doc.getElementById(id);
      if (!dialog) {
        dialog = element('dialog', 'care-ops__dialog'); dialog.id = id;
        const shell = element('div', 'care-ops__dialog-shell');
        const header = element('div', 'care-ops__dialog-header');
        const heading = element('h2', '', title); heading.id = `${id}Title`;
        const close = button('ปิด', () => closeDialog(dialog), 'secondary'); close.setAttribute('aria-label', `ปิด ${title}`);
        header.append(heading, close);
        const live = element('div', 'care-ops__dialog-live'); live.id = `${id}Live`; live.setAttribute('role', 'status');
        const body = element('div', 'care-ops__dialog-body'); body.id = `${id}Body`;
        shell.append(header, live, body); dialog.append(shell); dialog.setAttribute('aria-labelledby', heading.id);
        doc.body.append(dialog);
      }
      return dialog;
    }
    function restoreDialogFocus(dialog){const origin=dialog.__phimorFocusOrigin;dialog.__phimorFocusOrigin=null;if(origin?.isConnected)origin.focus();}
    function openDialog(dialog) { dialog.__phimorFocusOrigin=doc.activeElement;if(!dialog.dataset.focusRestoreBound){dialog.addEventListener('close',()=>restoreDialogFocus(dialog));dialog.dataset.focusRestoreBound='true';}if (typeof dialog.showModal === 'function') dialog.showModal(); else dialog.setAttribute('open', ''); }
    function closeDialog(dialog) { if (typeof dialog.close === 'function') dialog.close(); else {dialog.removeAttribute('open');restoreDialogFocus(dialog);} }
    function dialogParts(dialog) { return { live:dialog.querySelector('.care-ops__dialog-live'), body:dialog.querySelector('.care-ops__dialog-body') }; }
    function setBusy(container, busy) { container.querySelectorAll('button,input,select').forEach((node) => { node.disabled = Boolean(busy); }); }
    function showDialogError(dialog, message) { const { live } = dialogParts(dialog); live.textContent = message; live.className = 'care-ops__dialog-live care-ops__feedback--error'; }
    function itemCard(title, meta = '') {
      const card = element('article', 'care-ops__item'); card.append(element('h3', '', title));
      if (meta) card.append(element('div', 'care-ops__meta', meta)); return card;
    }
    function errorMessage(error) {
      return safeText(error?.message, 'โหลดข้อมูลงานระบบไม่สำเร็จ');
    }
    function renderEmpty(text) { content.replaceChildren(element('div', 'care-ops__empty', text)); }
    function renderCapabilities() {
      if (!state.centers.length) return renderEmpty('ยังไม่มีศูนย์ที่เชื่อมกับ Organization');
      const list = element('div', 'care-ops__list');
      state.centers.forEach((center) => {
        const card = itemCard(center.name || 'ไม่ระบุชื่อศูนย์', `${center.organizationName} · ${center.status || 'ไม่ระบุสถานะ'}`);
        safeArray(state.capabilities.get(center.centerId)).forEach((capability) => {
          const row = element('div', 'row');
          const label = element('div', '', CAPABILITY_LABELS[capability.capabilityKey] || capability.capabilityKey); label.style.flex = '1';
          const toggle = button(capability.enabled ? 'ON' : 'OFF', async () => {
            const next = !capability.enabled;
            state.feedback = null;
            const approved = await confirmAction(
              `${next ? 'เปิด' : 'ปิด'} ${CAPABILITY_LABELS[capability.capabilityKey] || capability.capabilityKey}`,
              `${center.name || 'ศูนย์นี้'} จะ${next ? 'เริ่ม' : 'หยุด'}รับข้อมูลใหม่สำหรับความสามารถนี้ ข้อมูลย้อนหลังไม่ถูกลบ`,
            );
            if (!approved) return;
            toggle.disabled = true;
            try {
              const result = await send(buildCapabilityRequest(center.centerId, capability.capabilityKey, next));
              if (typeof result?.capability?.enabled !== 'boolean') throw new Error('ไม่ได้รับสถานะล่าสุดจากระบบ');
              capability.enabled = result.capability.enabled;
              state.feedback = { tone:'success', text:`อัปเดต ${CAPABILITY_LABELS[capability.capabilityKey] || capability.capabilityKey} เป็น ${capability.enabled ? 'ON' : 'OFF'} แล้ว` };
              render();
            } catch (error) { state.feedback = { tone:'error', text:errorMessage(error) }; render(); }
          }, 'care-ops__toggle');
          toggle.dataset.enabled = String(Boolean(capability.enabled)); toggle.setAttribute('aria-pressed', String(Boolean(capability.enabled)));
          row.append(label, toggle); card.append(row);
        });
        list.append(card);
      }); content.replaceChildren(list);
    }
    function statusBadge(status) {
      const descriptor = CLIENT_STATUS_LABELS[status] || [status || 'ไม่ทราบสถานะ', ''];
      return element('span', `care-ops__status${descriptor[1] ? ` care-ops__status--${descriptor[1]}` : ''}`, descriptor[0]);
    }
    function renderReadiness(readiness) {
      const box = element('div', 'care-ops__readiness');
      box.append(element('strong', '', readiness?.label || 'ตั้งค่ายังไม่ครบ'));
      const labels = {
        organization:'Organization', centerScope:'Center scope', eventScope:'Event scope',
        activeCredential:'Active Credential', externalCenterMapping:'External Center mapping',
        externalResidentMapping:'External Resident mapping', clientActive:'Client active',
      };
      const list = element('ul');
      Object.entries(labels).forEach(([key, label]) => {
        const ready = Boolean(readiness?.checks?.[key]);
        list.append(element('li', ready ? 'is-ready' : 'is-pending', `${ready ? '✓' : '○'} ${label}${key === 'externalResidentMapping' && !ready ? ' (แนะนำก่อน Pilot)' : ''}`));
      });
      box.append(list); return box;
    }
    async function refreshWizardClient() {
      if (!state.wizard?.integrationClientId) return null;
      const clientId = state.wizard.integrationClientId;
      const result = await request(`/api/admin/platform/integration-clients/${encodeURIComponent(clientId)}`, {method:'GET'});
      if (state.wizard?.integrationClientId === clientId) state.wizard.client = result.integrationClient;
      return result.integrationClient;
    }
    function wizardActions(dialog, { previous = true, nextLabel = 'ถัดไป', onNext = null } = {}) {
      const actions = element('div', 'care-ops__actions care-ops__wizard-actions');
      actions.append(button('ไว้ก่อน', () => closeDialog(dialog), 'secondary'));
      if (previous) actions.append(button('ย้อนกลับ', () => { state.wizard.step -= 1; renderIntegrationWizard(); }, 'secondary'));
      if (onNext) actions.append(button(nextLabel, onNext, ''));
      return actions;
    }
    function renderIntegrationWizard() {
      const dialog = doc.getElementById('integrationClientCreateDialog'); if (!dialog || !state.wizard) return;
      const { live, body } = dialogParts(dialog); live.textContent=''; live.className='care-ops__dialog-live';
      const wizard = state.wizard;
      const progress = element('ol','care-ops__wizard-progress');
      ['ข้อมูลระบบ','ศูนย์ที่อนุญาต','ประเภทข้อมูล','ข้อมูลรับรอง','การเชื่อมรหัส','ตรวจความพร้อม'].forEach((label,index)=>{
        const item=element('li',index+1===wizard.step?'is-current':index+1<wizard.step?'is-complete':'',`${index+1}. ${label}`);
        if(index+1===wizard.step)item.setAttribute('aria-current','step');progress.append(item);
      });
      const panel=element('section','care-ops__wizard-panel');panel.append(progress);
      const fail=(error)=>{showDialogError(dialog,errorMessage(error));setBusy(panel,false);};
      if(wizard.step===1){
        panel.append(element('h3','','1. ข้อมูลระบบ'));
        const organizations=state.organizations.filter((item)=>item.status==='active'&&item.organizationType==='external_care_center');
        const organization=selectField('Organization',[{value:'',label:'เลือก Organization'},...organizations.map((item)=>({value:item.organizationId,label:item.displayName}))],wizard.organizationId||'');
        const name=input('ชื่อที่แสดง',{required:true,maxLength:240,value:wizard.displayName||'',placeholder:'ระบบ HHS Pilot'});
        const source=input('ระบบต้นทาง',{required:true,maxLength:100,value:wizard.sourceSystem||'',placeholder:'HHS'});
        const code=input('Client code',{required:true,maxLength:100,value:wizard.clientCode||'',placeholder:'hhs-pilot'});
        const advanced=element('details','care-ops__advanced');advanced.append(element('summary','','ขั้นสูง: Client code'),code.label);
        panel.append(organization.label,name.label,source.label,advanced,element('p','care-ops__notice','ระบบใหม่เริ่มในสถานะระงับ จนกว่าการตรวจความพร้อมฝั่ง Server จะผ่าน'));
        panel.append(wizardActions(dialog,{previous:false,nextLabel:'สร้างและไปขั้นถัดไป',onNext:async()=>{setBusy(panel,true);try{const result=await send(buildCreateClientRequest({organizationId:organization.control.value,clientCode:code.control.value,displayName:name.control.value,sourceSystem:source.control.value}));Object.assign(wizard,{integrationClientId:result.integrationClient.integrationClientId,organizationId:organization.control.value,step:2});await refreshWizardClient();renderIntegrationWizard();}catch(error){fail(error)}}}));
      } else if(wizard.step===2){
        panel.append(element('h3','','2. ศูนย์ที่อนุญาต'),element('p','care-ops__meta','เลือกเฉพาะศูนย์ใน Organization เดียวกัน'));
        const allowed=new Set(safeArray(wizard.client?.centers).map((item)=>item.centerId));
        const choices=element('div','care-ops__wizard-choices');
        state.centers.filter((item)=>item.organizationId===wizard.client.organizationId).forEach((center)=>{const label=element('label','care-ops__choice-row');const checkbox=element('input');checkbox.type='checkbox';checkbox.checked=allowed.has(center.centerId);checkbox.disabled=center.status!=='active';checkbox.addEventListener('change',async()=>{setBusy(panel,true);try{await send(buildCenterScopeRequest(wizard.integrationClientId,center.centerId,checkbox.checked));await refreshWizardClient();renderIntegrationWizard()}catch(error){fail(error)}});label.append(checkbox,element('span','',center.name||'ไม่ระบุชื่อศูนย์'));choices.append(label)});panel.append(choices,wizardActions(dialog,{onNext:()=>{if(!safeArray(wizard.client?.centers).length)return showDialogError(dialog,'กรุณาเลือกอย่างน้อย 1 ศูนย์');wizard.step=3;renderIntegrationWizard()}}));
      } else if(wizard.step===3){
        panel.append(element('h3','','3. ประเภทข้อมูลที่อนุญาต'));
        const selected=new Set(safeArray(wizard.client?.eventScopes));const choices=element('div','care-ops__wizard-choices');
        SUPPORTED_EVENT_TYPES.forEach((eventType)=>{const label=element('label','care-ops__choice-row');const checkbox=element('input');checkbox.type='checkbox';checkbox.checked=selected.has(eventType);checkbox.addEventListener('change',async()=>{setBusy(panel,true);try{await send(buildEventScopeRequest(wizard.integrationClientId,eventType,checkbox.checked));await refreshWizardClient();renderIntegrationWizard()}catch(error){fail(error)}});label.append(checkbox,element('code','',eventType));choices.append(label)});panel.append(choices,wizardActions(dialog,{onNext:()=>{if(!safeArray(wizard.client?.eventScopes).length)return showDialogError(dialog,'กรุณาเลือกอย่างน้อย 1 ประเภทข้อมูล');wizard.step=4;renderIntegrationWizard()}}));
      } else if(wizard.step===4){
        panel.append(element('h3','','4. ข้อมูลรับรอง'));
        const active=safeArray(wizard.client?.credentials).filter((item)=>item.status==='active');
        if(oneTimeSecret.hasValue()){
          panel.append(element('p','care-ops__secret-warning','Credential แสดงครั้งเดียว กรุณาเก็บใน Server ของผู้เชื่อมต่อ ห้ามใส่ใน browser หรือ URL'),element('code','care-ops__secret-value',oneTimeSecret.read()));
          const copy=button('คัดลอก Credential',async()=>{try{await doc.defaultView.navigator.clipboard.writeText(oneTimeSecret.read());live.textContent='คัดลอกแล้ว กรุณายืนยันว่าบันทึกในช่องทางที่ปลอดภัย';live.className='care-ops__dialog-live care-ops__feedback--success'}catch(_){showDialogError(dialog,'คัดลอกไม่สำเร็จ กรุณาคัดลอกจากข้อความที่แสดง')}});const acknowledge=element('label','care-ops__choice-row');const checkbox=element('input');checkbox.type='checkbox';checkbox.checked=wizard.credentialAcknowledged;checkbox.addEventListener('change',()=>{wizard.credentialAcknowledged=checkbox.checked;renderIntegrationWizard()});acknowledge.append(checkbox,element('span','','ฉันคัดลอกและเก็บ Credential ในระบบ Server ที่ปลอดภัยแล้ว'));panel.append(copy,acknowledge);
        } else if(active.length) panel.append(element('p','care-ops__notice','มี Credential ที่ใช้งานอยู่แล้ว ระบบจะไม่เปิดเผยค่าเดิมซ้ำ'));
        else panel.append(button('ออก Credential ครั้งเดียว',async()=>{setBusy(panel,true);try{const result=await send(buildCredentialRequest(wizard.integrationClientId,'issue'));oneTimeSecret.show(result.token);wizard.credentialAcknowledged=false;await refreshWizardClient();renderIntegrationWizard()}catch(error){fail(error)}},''));
        panel.append(wizardActions(dialog,{onNext:()=>{if(oneTimeSecret.hasValue()&&!wizard.credentialAcknowledged)return showDialogError(dialog,'กรุณายืนยันว่าเก็บ Credential แล้ว');if(!active.length&&!oneTimeSecret.hasValue())return showDialogError(dialog,'กรุณาออก Credential ก่อน');oneTimeSecret.clear();wizard.step=5;renderIntegrationWizard()}}));
      } else if(wizard.step===5){
        panel.append(element('h3','','5. การเชื่อมรหัส'));
        const current=wizard.client?.identityResolutionPolicy||{};
        const mode=selectField('วิธีจับคู่ผู้พัก',Object.entries(IDENTITY_POLICY_LABELS.identityResolutionMode).map(([value,label])=>({value,label})),current.identityResolutionMode);
        const unresolved=selectField('เมื่อจับคู่ไม่ได้',Object.entries(IDENTITY_POLICY_LABELS.unresolvedEventPolicy).map(([value,label])=>({value,label})),current.unresolvedEventPolicy);
        const group=selectField('ข้อกำหนดกลุ่มครอบครัว',Object.entries(IDENTITY_POLICY_LABELS.familyGroupRequirement).map(([value,label])=>({value,label})),current.familyGroupRequirement);
        panel.append(mode.label,unresolved.label,group.label,element('p','care-ops__notice',`Mapping ปัจจุบัน: ศูนย์ ${wizard.client?.mappingCounts?.activeCenters||0} · ผู้พัก ${wizard.client?.mappingCounts?.mappedResidents||0} ระบบจับคู่ชื่อแบบตรงกันเท่านั้น ไม่ใช้ห้อง โทรศัพท์ fuzzy หรือ AI`),wizardActions(dialog,{nextLabel:'บันทึกและตรวจความพร้อม',onNext:async()=>{setBusy(panel,true);try{await send(buildIdentityPolicyRequest(wizard.integrationClientId,{identityResolutionMode:mode.control.value,unresolvedEventPolicy:unresolved.control.value,familyGroupRequirement:group.control.value}));await refreshWizardClient();wizard.step=6;renderIntegrationWizard()}catch(error){fail(error)}}}));
      } else {
        panel.append(element('h3','','6. ตรวจความพร้อม'),renderReadiness(wizard.client?.readiness));
        const actions=wizardActions(dialog,{nextLabel:wizard.client?.status==='active'?'เสร็จสิ้น':'เปิดใช้งาน',onNext:async()=>{if(wizard.client?.status==='active'){closeDialog(dialog);await load({tabs:['integrations']});return}setBusy(panel,true);try{await send(buildClientStatusRequest(wizard.integrationClientId,'active'));await refreshWizardClient();renderIntegrationWizard()}catch(error){fail(error)}}});
        if(!wizard.client?.readiness?.configurationComplete&&wizard.client?.status!=='active')actions.querySelectorAll('button').forEach((node)=>{if(node.textContent==='เปิดใช้งาน')node.disabled=true});
        panel.append(element('p','care-ops__meta','Backend ตรวจ Organization, Center scope, Event scope, Credential, identity policy และ mapping readiness ซ้ำก่อนเปิดใช้งาน'),actions,button('เปิดหน้าจัดการ Mapping / ขั้นสูง',async()=>{const id=wizard.integrationClientId;closeDialog(dialog);await openIntegrationDetail(id)},'secondary'));
      }
      body.replaceChildren(panel);
    }
    function openCreateClient() {
      const dialog=ensureDialog('integrationClientCreateDialog','ตั้งค่าระบบเชื่อมต่อ');
      state.wizard={step:1,integrationClientId:null,credentialAcknowledged:false};
      if(!dialog.dataset.wizardBound){dialog.addEventListener('close',()=>{oneTimeSecret.clear();state.wizard=null});dialog.dataset.wizardBound='true'}
      renderIntegrationWizard();openDialog(dialog);
    }
    function openSecretModal(secret, credential) {
      if (!oneTimeSecret.show(secret)) throw new Error('ไม่ได้รับ Credential ใหม่จากระบบ');
      const dialog = ensureDialog('integrationCredentialSecretDialog', 'Credential ใหม่');
      const { live, body } = dialogParts(dialog); live.textContent = ''; live.className = 'care-ops__dialog-live';
      const warning = element('p', 'care-ops__secret-warning', 'ระบบจะแสดง Credential นี้เพียงครั้งเดียว กรุณาคัดลอกและเก็บในระบบ Server ของผู้เชื่อมต่อ');
      const secretValue = element('code', 'care-ops__secret-value', oneTimeSecret.read());
      const reference = element('p', 'care-ops__meta', `อ้างอิง ${credential?.publicPrefix || 'Credential ใหม่'}`);
      const actions = element('div', 'care-ops__actions');
      actions.append(button('คัดลอก Credential', async () => {
        try {
          const value = oneTimeSecret.read(); if (!value) throw new Error('Credential ถูกล้างแล้ว');
          await doc.defaultView.navigator.clipboard.writeText(value);
          live.textContent = 'คัดลอก Credential แล้ว'; live.className = 'care-ops__dialog-live care-ops__feedback--success';
        } catch (_) { showDialogError(dialog, 'คัดลอกไม่สำเร็จ กรุณาคัดลอกจากข้อความที่แสดงก่อนปิดหน้าต่าง'); }
      }));
      actions.append(button('ฉันบันทึกแล้ว', () => closeDialog(dialog), ''));
      body.replaceChildren(warning, reference, secretValue, actions);
      if (!dialog.dataset.secretBound) {
        dialog.addEventListener('close', () => { oneTimeSecret.clear(); secretValue.textContent = ''; body.replaceChildren(); });
        dialog.dataset.secretBound = 'true';
      }
      openDialog(dialog);
    }
    async function refreshIntegrationDetail({ centerPage, subjectPage } = {}) {
      if (!state.detail?.integrationClientId) return;
      const token = ++detailGeneration; const clientId = state.detail.integrationClientId;
      const nextCenterPage = centerPage || state.detail.centerPage || 1;
      const nextSubjectPage = subjectPage || state.detail.subjectPage || 1;
      const clientResult = await request(`/api/admin/platform/integration-clients/${encodeURIComponent(clientId)}`, {method:'GET'});
      if (token !== detailGeneration || !state.detail || state.detail.integrationClientId !== clientId) return;
      const archived = clientResult.integrationClient?.status === 'revoked';
      const dialog=doc.getElementById('integrationClientDetailDialog');const title=doc.getElementById('integrationClientDetailDialogTitle');const close=dialog?.querySelector('.care-ops__dialog-header button');
      if(title)title.textContent=archived?'ประวัติการเชื่อมต่อ':'จัดการระบบเชื่อมต่อ';if(close)close.setAttribute('aria-label',archived?'ปิด ประวัติการเชื่อมต่อ':'ปิด จัดการระบบเชื่อมต่อ');
      const [centerResult, subjectResult, adapterSampleResult, adapterStatusResult] = await Promise.all([
        send(buildCenterMappingListRequest(clientId, {page:nextCenterPage,search:state.detail.centerSearch || ''})),
        send(buildSubjectMappingListRequest(clientId, {page:nextSubjectPage,search:state.detail.subjectSearch || ''})),
        archived ? Promise.resolve({sample:null}) : send(buildAdapterSampleRequest(clientId)),
        send(buildAdapterStatusRequest(clientId)),
      ]);
      if (token !== detailGeneration || !state.detail || state.detail.integrationClientId !== clientId) return;
      Object.assign(state.detail, { client:clientResult.integrationClient, centerMappings:safeArray(centerResult.items),
        centerPagination:centerResult.pagination, subjectMappings:safeArray(subjectResult.items),
        subjectPagination:subjectResult.pagination, centerPage:nextCenterPage, subjectPage:nextSubjectPage,
        adapterSample:adapterSampleResult.sample||null,adapterStatus:adapterStatusResult,
        loading:false, error:null });
      const directoryClient = state.integrations.find((item) => item.integrationClientId === clientId);
      if (directoryClient) Object.assign(directoryClient, clientResult.integrationClient);
      renderIntegrationDetail();
    }
    async function openIntegrationDetail(integrationClientId) {
      residentOptionsGeneration += 1;
      const dialog = ensureDialog('integrationClientDetailDialog', 'จัดการระบบเชื่อมต่อ');
      state.detail = { integrationClientId, loading:true, centerPage:1, subjectPage:1,
        centerSearch:'', subjectSearch:'', residentOptions:[], residentCenterId:null };
      const { live, body } = dialogParts(dialog); live.textContent = ''; live.className = 'care-ops__dialog-live';
      body.replaceChildren(element('div', 'care-ops__spinner', 'กำลังโหลดการตั้งค่า…')); openDialog(dialog);
      try { await refreshIntegrationDetail(); }
      catch (error) { if (state.detail?.integrationClientId === integrationClientId) { state.detail.loading = false; state.detail.error = errorMessage(error); renderIntegrationDetail(); } }
    }
    async function detailAction(descriptor, success, { confirmTitle = null, confirmMessage = '' } = {}) {
      if (confirmTitle && !(await confirmAction(confirmTitle, confirmMessage))) return false;
      const dialog = doc.getElementById('integrationClientDetailDialog');
      const { body } = dialogParts(dialog); setBusy(body, true);
      try { const result = await send(descriptor); state.feedback = {tone:'success',text:success}; await refreshIntegrationDetail(); return result; }
      catch (error) { showDialogError(dialog, errorMessage(error)); setBusy(body, false); return false; }
    }
    async function revokeIntegrationClient(clientId) {
      const confirmed = await confirmAction('เพิกถอนระบบเชื่อมต่อ?', 'หลังเพิกถอน ระบบนี้จะไม่สามารถส่งข้อมูลใหม่เข้า PHIMOR ได้อีก Credential ที่ยังใช้งานจะถูกเพิกถอน ข้อมูลและประวัติเดิมจะยังคงอยู่ใน “ประวัติการเชื่อมต่อ” การเพิกถอนเป็นแบบถาวร');
      if (!confirmed) return false;
      const dialog = doc.getElementById('integrationClientDetailDialog'); const { body } = dialogParts(dialog); setBusy(body, true);
      try {
        await send({path:`/api/admin/platform/integration-clients/${encodeURIComponent(clientId)}/revoke`,options:{method:'POST',body:'{}'}});
        closeDialog(dialog); state.detail = null; state.integrationView = 'current'; state.integrationStatus = ''; state.integrationPage = 1;
        state.feedback = {tone:'success',text:'เพิกถอนระบบเชื่อมต่อแล้ว ระบบนี้ถูกย้ายไปยังประวัติการเชื่อมต่อ'};
        await load({tabs:['integrations']}); return true;
      } catch (error) { showDialogError(dialog, errorMessage(error)); setBusy(body, false); return false; }
    }
    function section(title, description = '') {
      const node = element('section', 'care-ops__detail-section'); node.append(element('h3', '', title));
      if (description) node.append(element('p', 'care-ops__meta', description)); return node;
    }
    function adapterRulesFromSelection(sample,selections){return safeArray(sample?.targetFields).map((target)=>{
      const selected=selections?.[target.id];if(Array.isArray(selected)){const locatorKeys=selected.filter(Boolean);return locatorKeys.length?{targetField:target.id,locatorKeys}:null;}
      return selected?{targetField:target.id,locatorKey:selected}:null;
    }).filter(Boolean);}
    function ensureAdapterSelections(sample){
      if(!state.detail.adapterSelections||state.detail.adapterSelectionSampleId!==sample.sampleId){const selections={};
        safeArray(sample.fields).forEach((field)=>{if(field.selectable&&field.suggestedTarget&&!selections[field.suggestedTarget])selections[field.suggestedTarget]=field.locatorKey;});
        state.detail.adapterSelections=selections;state.detail.adapterSelectionSampleId=sample.sampleId;state.detail.adapterPreview=null;}
      return state.detail.adapterSelections;
    }
    function renderAdapterSection(clientId,{readOnly=false}={}){
      const node=section('7. การจับคู่ข้อมูล','เลือกข้อมูล PHIMOR ก่อน แล้วเลือกค่าจากตัวอย่างของระบบต้นทาง ไม่ต้องเขียน JSON หรือ JSONPath');
      const active=state.detail.adapterStatus?.activeAdapter;
      node.append(element('p','care-ops__meta','ประเภทข้อมูล: รายงานสุขภาพที่ยืนยันแล้ว'));
      if(active){node.append(element('strong','',active.displayName||'รูปแบบรายงานสุขภาพ'),element('p','care-ops__meta',`ระบบต้นทาง ${active.sourceSystem||'-'} · Version ${active.version} · ใช้งานอยู่`),element('p','care-ops__meta',`ใช้งานร่วมกับ ${active.bindingCount||1} ระบบเชื่อมต่อ · เปิด ${formatDate(active.activatedAt)}`));
        if(readOnly){safeArray(state.detail.adapterStatus?.versions).forEach((version)=>node.append(element('div','care-ops__managed-row',`Version ${version.version} · ${version.status} · ${formatDate(version.activatedAt||version.createdAt)}`)));safeArray(state.detail.adapterStatus?.notices).forEach((notice)=>node.append(element('div','care-ops__meta',`${notice.sourcePath} · ${notice.noticeType} · ${notice.status}`)));return node;}
        const activeActions=element('div','care-ops__actions');activeActions.append(button('ดูการจับคู่',()=>{const dialog=doc.getElementById('integrationClientDetailDialog');const {live}=dialogParts(dialog);live.textContent=`${active.displayName} · V${active.version} · ใช้งานร่วมกับ ${active.bindingCount||1} ระบบเชื่อมต่อ`;live.className='care-ops__dialog-live care-ops__feedback--success';},'secondary'),button('แก้ไข',()=>detailAction(buildAdapterCaptureRequest(clientId),'เปิดช่วงรอรับข้อมูลตัวอย่างสำหรับ Draft เวอร์ชันใหม่แล้ว'),'secondary'),button('รับข้อมูลตัวอย่างใหม่',()=>detailAction(buildAdapterCaptureRequest(clientId),'เปิดช่วงรอรับข้อมูลตัวอย่างใหม่แล้ว'),'secondary'));node.append(activeActions);
        const notices=safeArray(state.detail.adapterStatus?.notices);if(notices.length){const noticeBox=element('div','care-ops__notice');noticeBox.append(element('strong','','ตรวจสอบการเปลี่ยนแปลงจากระบบต้นทาง'));notices.forEach((notice)=>{const row=element('div','care-ops__adapter-unused',`${notice.sourcePath} · ${notice.noticeType==='NEW_SOURCE_FIELDS_AVAILABLE'?'ข้อมูลใหม่':'รูปแบบข้อมูลต้นทางเปลี่ยน'}`);const actions=element('div','care-ops__actions');if(notice.noticeType==='NEW_SOURCE_FIELDS_AVAILABLE'){actions.append(button('เพิ่มข้อมูลนี้',()=>detailAction(buildAdapterCaptureRequest(clientId),'เปิดช่วงรับตัวอย่างสำหรับ Adapter เวอร์ชันใหม่แล้ว'),'secondary'),button('ไม่รับข้อมูล',()=>detailAction(buildAdapterNoticeRequest(clientId,notice.noticeId,'ignored'),'บันทึกว่าไม่รับข้อมูลนี้แล้ว'),'secondary'),button('ตรวจภายหลัง',()=>detailAction(buildAdapterNoticeRequest(clientId,notice.noticeId,'review_later'),'เก็บไว้ตรวจภายหลังแล้ว'),'secondary'));}else actions.append(button('รับข้อมูลตัวอย่างใหม่',()=>detailAction(buildAdapterCaptureRequest(clientId),'เปิดช่วงรับตัวอย่างสำหรับแก้ไข Adapter แล้ว'),'secondary'));row.append(actions);noticeBox.append(row);});node.append(noticeBox);}
        const rollback=safeArray(state.detail.adapterStatus?.versions).find((version)=>version.status==='superseded');if(rollback)node.append(button(`ย้อนกลับเป็น V${rollback.version}`,()=>detailAction(buildAdapterRollbackRequest(clientId,rollback.adapterVersionId),`ย้อนกลับเป็น V${rollback.version} สำหรับเหตุการณ์ใหม่แล้ว`,{confirmTitle:'ยืนยันการย้อนกลับ',confirmMessage:'มีผลกับเหตุการณ์ใหม่เท่านั้น ไม่แก้ไขประวัติที่ประมวลผลแล้ว'}),'secondary'));
      }else node.append(element('p','care-ops__meta',readOnly?'ไม่พบ Adapter binding ในประวัติของระบบเชื่อมต่อนี้':'ยังไม่มี Field Picker Adapter ที่เปิดใช้งาน — canonical client เดิมยังทำงานตามปกติ'));
      if(readOnly)return node;
      const sample=state.detail.adapterSample;
      if(!sample){node.append(element('div','care-ops__notice','ข้อมูลตัวอย่างจะใช้เพื่อจับคู่เท่านั้น และจะยังไม่ถูกบันทึกเป็นข้อมูลสุขภาพ'),button('รับข้อมูลตัวอย่าง',()=>detailAction(buildAdapterCaptureRequest(clientId),'เปิดช่วงรอรับข้อมูลตัวอย่าง 30 นาทีแล้ว'),''));return node;}
      if(sample.status==='waiting'){node.append(element('div','care-ops__adapter-waiting','รอรับข้อมูลตัวอย่าง'),element('p','care-ops__meta',`ระบบนี้เท่านั้นที่ส่งตัวอย่างได้ · หมดเวลา ${formatDate(sample.captureExpiresAt)}`),element('div','care-ops__notice','ข้อมูลที่รับในช่วงนี้จะถูกใช้เพื่อจับคู่เท่านั้น ไม่สร้างข้อมูลสุขภาพ ไม่เรียนรู้ผู้พัก และไม่ส่ง LINE'),button('เริ่มช่วงรับตัวอย่างใหม่',()=>detailAction(buildAdapterCaptureRequest(clientId),'เริ่มช่วงรอรับข้อมูลตัวอย่างใหม่แล้ว'),'secondary'));return node;}
      if(sample.status!=='captured'){node.append(element('p','care-ops__meta','ไม่มีข้อมูลตัวอย่างที่พร้อมใช้'),button('รับข้อมูลตัวอย่างใหม่',()=>detailAction(buildAdapterCaptureRequest(clientId),'เปิดช่วงรอรับข้อมูลตัวอย่างแล้ว'),''));return node;}
      const reusable=safeArray(sample.reusableAdapters);if(!active&&reusable.length&&!state.detail.adapterReuseDismissed){const reuseBox=element('div','care-ops__adapter-preview');reuseBox.append(element('h4','','พี่หมอพบการจับคู่ข้อมูลที่ใช้งานอยู่แล้ว'));reusable.forEach((adapter)=>{const card=element('div','care-ops__adapter-unused');card.append(element('strong','',`${adapter.displayName} V${adapter.version}`),element('div','care-ops__meta',`ใช้กับ ${adapter.bindingCount||1} ระบบเชื่อมต่อ · ตรวจพบรูปแบบข้อมูลตรงกัน`),button('ใช้รูปแบบนี้',()=>detailAction(buildAdapterReuseRequest(clientId,sample.sampleId,adapter.adapterVersionId),`ใช้ ${adapter.displayName} V${adapter.version} แล้ว`),''));reuseBox.append(card);});reuseBox.append(button('รับข้อมูลตัวอย่างเพื่อตรวจสอบ',()=>{state.detail.adapterReuseDismissed=true;renderIntegrationDetail();},'secondary'));node.append(reuseBox);}
      const selections=ensureAdapterSelections(sample);
      node.append(element('div','care-ops__notice',`ตัวอย่างจะถูกล้างภายใน 24 ชั่วโมง · ${sample.discoveredFieldCount||0} ค่า · ไม่เก็บ credential หรือ header`));
      const picker=element('div','care-ops__adapter-picker');let lastSection='';
      safeArray(sample.targetFields).forEach((target)=>{if(target.section!==lastSection){picker.append(element('h4','',target.section));lastSection=target.section;}
        const options=[{value:'',label:target.required?'กรุณาเลือกข้อมูล':'ไม่รับข้อมูล'}];safeArray(sample.fields).filter((field)=>field.selectable).forEach((field)=>options.push({value:field.locatorKey,label:`${field.valuePreview}${field.unitPreview?` ${field.unitPreview}`:''}`}));
        const current=Array.isArray(selections[target.id])?selections[target.id]:[selections[target.id]||''];const field=selectField(`${target.label}${target.required?' *':target.stronglyRecommended?' (แนะนำ)':''}`,options,current[0]);field.label.classList.add('care-ops__adapter-field');field.control.addEventListener('change',()=>{selections[target.id]=target.id==='subject.displayName'?[field.control.value||'',current[1]||'']:field.control.value||null;state.detail.adapterPreview=null;});
        const chosen=sample.fields.find((item)=>item.locatorKey===field.control.value);const detail=element('details','care-ops__adapter-source');detail.append(element('summary','','รายละเอียด'),element('div','',chosen?.sourcePath||'ยังไม่ได้เลือก'));field.label.append(detail);
        if(target.id==='subject.displayName'){const familyName=selectField('นามสกุล (ถ้าระบบต้นทางแยกช่อง)',options,current[1]||'');familyName.control.addEventListener('change',()=>{selections[target.id]=[field.control.value||'',familyName.control.value||''];state.detail.adapterPreview=null;});field.label.append(familyName.label);}
        picker.append(field.label);
      });node.append(picker);
      const selectedKeys=Object.values(selections).flatMap((value)=>Array.isArray(value)?value:[value]);const unused=safeArray(sample.fields).filter((field)=>field.selectable&&!selectedKeys.includes(field.locatorKey));const extras=element('details','care-ops__advanced');extras.append(element('summary','','ข้อมูลอื่นจากระบบต้นทาง (ไม่รับข้อมูลโดยค่าเริ่มต้น)'));unused.slice(0,50).forEach((field)=>extras.append(element('div','care-ops__adapter-unused',field.valuePreview)));node.append(extras);
      const actions=element('div','care-ops__actions');actions.append(button('รับข้อมูลตัวอย่างใหม่',()=>detailAction(buildAdapterCaptureRequest(clientId),'เปิดช่วงรอรับข้อมูลตัวอย่างใหม่แล้ว'),'secondary'));
      actions.append(button('ทดสอบการแปลง',async()=>{const dialog=doc.getElementById('integrationClientDetailDialog');setBusy(dialogParts(dialog).body,true);try{state.detail.adapterPreview=await send(buildAdapterPreviewRequest(clientId,sample.sampleId,adapterRulesFromSelection(sample,selections)));renderIntegrationDetail();}catch(error){showDialogError(dialog,errorMessage(error));setBusy(dialogParts(dialog).body,false);}},''));node.append(actions);
      if(state.detail.adapterPreview?.valid){const value=state.detail.adapterPreview.preview;const measurementLabels=new Map(safeArray(sample.targetFields).filter((target)=>target.measurementType).map((target)=>[target.measurementType,target.label]));const previewBox=element('div','care-ops__adapter-preview');previewBox.append(element('h4','','ตัวอย่างข้อมูลใน PHIMOR'),element('strong','',value.residentDisplayName),element('div','',`วันที่รายงาน ${formatDateOnly(value.careDate)}`),element('div','',`เวลาบันทึก ${formatDate(value.recordedAt)}`),element('div','',`เวลายืนยัน ${formatDate(value.finalizedAt)}`),element('div','',`ผู้ยืนยัน ${value.finalizedBy}`));safeArray(value.observations).forEach((item)=>previewBox.append(element('div','',`${measurementLabels.get(item.measurementType)||'สัญญาณชีพ'}: ${item.numericValue} ${item.sourceUnit}`)));if(value.generalReport)previewBox.append(element('div','',`รายงานทั่วไป: ${value.generalReport}`));node.append(previewBox,button('ยืนยันและเปิดใช้งาน',async()=>{if(!(await confirmAction('ยืนยันและเปิดใช้งาน',active?'ระบบจะสร้าง Adapter เวอร์ชันใหม่ และเวอร์ชันเดิมยังทำงานจนกว่าจะยืนยันสำเร็จ':'ข้อมูลใหม่จะใช้ mapping ที่ยืนยันแล้วเท่านั้น')))return;const dialog=doc.getElementById('integrationClientDetailDialog');setBusy(dialogParts(dialog).body,true);try{const draft=await send(buildAdapterDraftRequest(clientId,sample.sampleId,adapterRulesFromSelection(sample,selections)));await send(buildAdapterActivateRequest(clientId,sample.sampleId,draft.adapter.adapterProfileId));state.feedback={tone:'success',text:`เปิดใช้งาน Adapter Version ${draft.adapter.version} แล้ว`};await refreshIntegrationDetail();}catch(error){showDialogError(dialog,errorMessage(error));setBusy(dialogParts(dialog).body,false);}},''));}
      return node;
    }
    function pager(pagination, onPage) {
      const actions = element('div', 'care-ops__pager');
      const previous = button('ก่อนหน้า', () => onPage(pagination.page - 1), 'secondary'); previous.disabled = pagination.page <= 1;
      const next = button('ถัดไป', () => onPage(pagination.page + 1), 'secondary'); next.disabled = pagination.page >= pagination.totalPages;
      actions.append(previous, element('span', 'care-ops__meta', `หน้า ${pagination.page} / ${Math.max(1, pagination.totalPages)} · ${pagination.total} รายการ`), next); return actions;
    }
    async function loadResidentOptions(externalCenterId) {
      const token=++residentOptionsGeneration;
      const detailClientId=state.detail?.integrationClientId;
      const mapping = state.detail?.centerMappings.find((item) => item.externalCenterId === externalCenterId && item.status === 'active');
      if (!mapping) { if (state.detail) state.detail.residentOptions = []; renderIntegrationDetail(); return; }
      try {
        const result = await send(buildResidentOptionsRequest(mapping.centerId));
        if(token!==residentOptionsGeneration||state.detail?.integrationClientId!==detailClientId)return;
        state.detail.residentOptions = safeArray(result.residents); state.detail.residentCenterId = mapping.centerId; renderIntegrationDetail();
      } catch (error) { if(token!==residentOptionsGeneration||state.detail?.integrationClientId!==detailClientId)return;const dialog = doc.getElementById('integrationClientDetailDialog'); showDialogError(dialog, errorMessage(error)); }
    }
    function renderIntegrationDetail() {
      const dialog = doc.getElementById('integrationClientDetailDialog'); if (!dialog || !state.detail) return;
      const { live, body } = dialogParts(dialog); live.textContent = ''; live.className = 'care-ops__dialog-live';
      if (state.detail.loading) return body.replaceChildren(element('div', 'care-ops__spinner', 'กำลังโหลดการตั้งค่า…'));
      if (state.detail.error) return body.replaceChildren(element('div', 'care-ops__error', state.detail.error));
      const client = state.detail.client; const clientId = client.integrationClientId;
      const readOnly = client.status === 'revoked';
      const info = section('1. ข้อมูลระบบเชื่อมต่อ');
      const infoGrid = element('div', 'care-ops__integration-grid');
      [['ชื่อ',client.displayName],['Client code',client.clientCode],['Source system',client.sourceSystem],['Organization',client.organization?.displayName || client.organizationName || '-']]
        .forEach(([label,value]) => { const box=element('div');box.append(element('strong','',label),element('div','care-ops__meta',value||'-'));infoGrid.append(box); }); info.append(infoGrid);

      const status = section('2. สถานะ'); const statusActions = element('div', 'care-ops__actions'); status.append(statusBadge(client.status));
      if (readOnly) status.append(element('div','care-ops__archive-notice','การเชื่อมต่อนี้ถูกยุติแล้ว ระบบจะไม่รับข้อมูลใหม่จาก Credential เดิม ข้อมูลการตั้งค่าและประวัติยังคงเก็บไว้เพื่อการตรวจสอบ'),element('p','care-ops__meta',`เพิกถอนเมื่อ ${formatDate(client.revokedAt)}`));
      if (client.status === 'active') statusActions.append(button('ระงับการใช้งาน', () => detailAction(buildClientStatusRequest(clientId,'suspended'),'ระงับระบบเชื่อมต่อแล้ว',{confirmTitle:'ระงับการใช้งาน',confirmMessage:'Credential และ mapping จะยังคงอยู่ แต่ระบบจะปฏิเสธข้อมูลใหม่จนกว่าจะเปิดใช้งานอีกครั้ง'})));
      if (client.status === 'suspended') statusActions.append(button('เปิดใช้งาน', () => detailAction(buildClientStatusRequest(clientId,'active'),'เปิดใช้งานระบบเชื่อมต่อแล้ว',{confirmTitle:'เปิดใช้งานระบบเชื่อมต่อ',confirmMessage:'ระบบภายนอกจะเริ่มยืนยันตัวตนและส่ง event ตาม scope ที่กำหนดได้'}),''));
      if (!readOnly) statusActions.append(button('เพิกถอนระบบเชื่อมต่อ', () => revokeIntegrationClient(clientId),'danger'));
      status.append(statusActions);

      const scopes = section('3. ศูนย์ที่อนุญาต', 'เลือกได้เฉพาะศูนย์ใน Organization เดียวกัน');
      const allowedCenterIds = new Set(safeArray(client.centers).map((item) => item.centerId));
      const organizationCenters = state.centers.filter((item) => item.organizationId === client.organizationId);
      const centerSelect = selectField('เพิ่ม Center scope', [{value:'',label:'เลือกศูนย์'}, ...organizationCenters.filter((item)=>!allowedCenterIds.has(item.centerId)).map((item)=>({value:item.centerId,label:`${item.name || 'ไม่ระบุชื่อ'} · ${item.status || '-'}`,disabled:item.status!=='active'}))]);
      const addCenter = button('เพิ่ม Center scope', async () => { if (!centerSelect.control.value) return showDialogError(dialog,'กรุณาเลือกศูนย์'); await detailAction(buildCenterScopeRequest(clientId,centerSelect.control.value,true),'เพิ่ม Center scope แล้ว'); });
      if(!readOnly)scopes.append(centerSelect.label, addCenter);
      safeArray(client.centers).forEach((item) => { const row=element('div','care-ops__managed-row');row.append(element('div','',item.name||'ไม่ระบุชื่อศูนย์'));if(!readOnly)row.append(button('นำออก',()=>detailAction(buildCenterScopeRequest(clientId,item.centerId,false),'นำ Center scope ออกแล้ว',{confirmTitle:'นำ Center scope ออก',confirmMessage:'ระบบจะหยุดรับ event ใหม่ของศูนย์นี้ ข้อมูลเดิมจะไม่ถูกลบ'}),'secondary'));scopes.append(row); });

      const events = section('4. Event ที่อนุญาต', 'เลือกเฉพาะ event type ที่ PHIMOR รองรับ');
      SUPPORTED_EVENT_TYPES.forEach((eventType) => {
        const enabled=safeArray(client.eventScopes).includes(eventType);if(readOnly&&!enabled)return;
        const row=element('div','care-ops__managed-row');row.append(element('code','',eventType));
        if(!readOnly)row.append(button(enabled?'นำออก':'เพิ่ม',()=>detailAction(
          buildEventScopeRequest(clientId,eventType,!enabled),`${enabled?'นำ':'เพิ่ม'} Event scope ${eventType} แล้ว`,
          enabled?{confirmTitle:'นำ Event scope ออก',confirmMessage:'ระบบจะปฏิเสธ event ประเภทนี้จาก client นี้'}:{}
        ),enabled?'secondary':''));
        events.append(row);
      });

      const credentials = section('5. Credential', 'ระบบแสดงเฉพาะ prefix และข้อมูลการใช้งาน Credential เดิมไม่สามารถเปิดดูซ้ำได้ หากปิดหน้าต่างก่อนบันทึก กรุณาหมุน Credential ใหม่');
      const activeCredentials = safeArray(client.credentials).filter((item)=>item.status==='active');
      if (!activeCredentials.length && client.status !== 'revoked') credentials.append(button('ออก Credential', async () => { const result=await detailAction(buildCredentialRequest(clientId,'issue'),'ออก Credential ใหม่แล้ว');if(result?.token)openSecretModal(result.token,result.credential); },''));
      safeArray(client.credentials).forEach((credential) => { const row=element('div','care-ops__credential-row');const meta=element('div');meta.append(element('strong','',`pim_int_${credential.publicPrefix}.••••`),element('div','care-ops__meta',`${credential.status} · ออก ${formatDate(credential.createdAt)} · เพิกถอน ${credential.revokedAt?formatDate(credential.revokedAt):'-'} · ใช้ล่าสุด ${credential.lastUsedAt?formatDate(credential.lastUsedAt):'ยังไม่เคยใช้'}`));row.append(meta);if(!readOnly&&credential.status==='active'){const actions=element('div','care-ops__actions');actions.append(button('หมุน Credential',async()=>{const result=await detailAction(buildCredentialRequest(clientId,'rotate',credential.credentialId),'หมุน Credential แล้ว',{confirmTitle:'หมุน Credential',confirmMessage:'หลังหมุน Credential ค่าเดิมจะไม่สามารถใช้งานได้อีก'});if(result?.token)openSecretModal(result.token,result.credential);}),button('เพิกถอน Credential',()=>detailAction(buildCredentialRequest(clientId,'revoke',credential.credentialId),'เพิกถอน Credential แล้ว',{confirmTitle:'เพิกถอน Credential',confirmMessage:'Credential นี้จะใช้งานไม่ได้ทันที'}),'danger'));row.append(actions);}credentials.append(row); });

      const policy = section('6. การระบุตัวตนอัตโนมัติ', 'กำหนดจาก Integration Client โดย backend เป็นผู้บังคับใช้');
      const currentPolicy = client.identityResolutionPolicy || {};
      const mode = selectField('วิธีจับคู่ผู้พัก', Object.entries(IDENTITY_POLICY_LABELS.identityResolutionMode).map(([value,label])=>({value,label})), currentPolicy.identityResolutionMode);
      const unresolved = selectField('เมื่อจับคู่ไม่ได้', Object.entries(IDENTITY_POLICY_LABELS.unresolvedEventPolicy).map(([value,label])=>({value,label})), currentPolicy.unresolvedEventPolicy);
      const group = selectField('ก่อนรับข้อมูล ต้องมีกลุ่มครอบครัว', Object.entries(IDENTITY_POLICY_LABELS.familyGroupRequirement).map(([value,label])=>({value,label})), currentPolicy.familyGroupRequirement);
      const warning = element('div','care-ops__warning','ระบบใช้เฉพาะชื่อ–นามสกุลเต็มที่ตรงกัน ไม่ใช้ห้อง โทรศัพท์ การจับคู่คล้าย หรือ AI เมื่อเรียนรู้สำเร็จ รหัสภายนอกจะเป็นข้อมูลอ้างอิงหลัก ข้อมูลที่ตีตกแล้วไม่สามารถกู้คืนจาก PHIMOR ได้ หากต้องการข้อมูลย้อนหลัง ต้องให้ระบบต้นทางส่งใหม่หลังแก้ไข');
      if(readOnly)policy.append(element('div','care-ops__meta',`วิธีจับคู่ผู้พัก: ${IDENTITY_POLICY_LABELS.identityResolutionMode[currentPolicy.identityResolutionMode]||'-'}`),element('div','care-ops__meta',`เมื่อจับคู่ไม่ได้: ${IDENTITY_POLICY_LABELS.unresolvedEventPolicy[currentPolicy.unresolvedEventPolicy]||'-'}`),element('div','care-ops__meta',`Family Group: ${IDENTITY_POLICY_LABELS.familyGroupRequirement[currentPolicy.familyGroupRequirement]||'-'}`));
      else policy.append(mode.label,unresolved.label,group.label,warning,button('บันทึกนโยบาย',()=>detailAction(buildIdentityPolicyRequest(clientId,{identityResolutionMode:mode.control.value,unresolvedEventPolicy:unresolved.control.value,familyGroupRequirement:group.control.value}),'บันทึกนโยบายการระบุตัวตนแล้ว',{confirmTitle:'ยืนยันนโยบายการรับข้อมูล',confirmMessage:'นโยบายนี้มีผลกับ event ใหม่ ข้อมูลที่ถูกตีตกจะไม่ถูกเก็บใน PHIMOR'}),''));

      const adapterSection=renderAdapterSection(clientId,{readOnly});
      const centerMappings = section('8. การจับคู่ที่ระบบเรียนรู้แล้ว · ศูนย์', 'การเชื่อมรหัสศูนย์ภายนอก: รหัสที่เรียนรู้แล้วเป็นข้อมูลอ้างอิงหลัก การแก้ไขใช้ขั้นสูงโดยปิดรายการเดิมก่อน');
      const centerSearch=input('ค้นหา External Center ID',{maxLength:120,value:state.detail.centerSearch||'',placeholder:'ค้นหารหัสศูนย์ภายนอก'});centerSearch.control.addEventListener('change',()=>{state.detail.centerSearch=centerSearch.control.value.slice(0,120);refreshIntegrationDetail({centerPage:1});});centerMappings.append(centerSearch.label);
      const centerMapForm = element('div','care-ops__inline-form'); const externalCenter = input('External Center ID',{required:true,maxLength:160,placeholder:'VENDOR_CENTER_01'});
      const scopedCenter = selectField('PHIMOR Center',[{value:'',label:'เลือกศูนย์'},...safeArray(client.centers).map((item)=>({value:item.centerId,label:item.name||'ไม่ระบุชื่อ',disabled:item.status!=='active'}))]);
      centerMapForm.append(externalCenter.label,scopedCenter.label,button('เพิ่มการเชื่อมรหัสศูนย์',async()=>{if(!externalCenter.control.value||!scopedCenter.control.value)return showDialogError(dialog,'กรุณากรอกรหัสภายนอกและเลือกศูนย์');await detailAction(buildCenterMappingRequest(clientId,externalCenter.control.value,scopedCenter.control.value),'เพิ่มการเชื่อมรหัสศูนย์แล้ว');},''));const centerAdvanced=element('details','care-ops__advanced');centerAdvanced.append(element('summary','','ขั้นสูง / แก้ไขข้อยกเว้น'),centerMapForm);if(!readOnly)centerMappings.append(centerAdvanced);
      safeArray(state.detail.centerMappings).forEach((item)=>{const row=element('div','care-ops__managed-row');const meta=element('div');const source=item.mappingSource==='learned_automatically'?'เรียนรู้อัตโนมัติ':'ผู้ดูแลกำหนด';meta.append(element('strong','',item.externalCenterId),element('div','care-ops__meta',`${item.centerName||'ไม่ระบุศูนย์'} · ${item.status} · ${source} · สร้าง ${formatDate(item.createdAt)} · ใช้ล่าสุด ${formatDate(item.lastUsedAt||item.updatedAt)}${item.deactivatedAt?` · ปิด ${formatDate(item.deactivatedAt)}`:''}`));row.append(meta);if(!readOnly&&item.status==='active')row.append(button('ปิดการเชื่อม',()=>detailAction(buildDeactivateCenterMappingRequest(clientId,item.externalCenterId),'ปิดการเชื่อมรหัสศูนย์แล้ว',{confirmTitle:'ปิดการเชื่อมรหัสศูนย์',confirmMessage:'event ใหม่จากรหัสศูนย์นี้จะไม่ผ่านการตรวจสอบ'}),'secondary'));centerMappings.append(row);});
      if(state.detail.centerPagination)centerMappings.append(pager(state.detail.centerPagination,(page)=>refreshIntegrationDetail({centerPage:page})));

      const subjectMappings = section('9. การจับคู่ที่ระบบเรียนรู้แล้ว · ผู้พัก', 'การเชื่อมรหัสผู้พักภายนอก: ระบบเรียนรู้จากชื่อ–นามสกุลเต็มที่ตรงกันเท่านั้น ไม่ใช้ห้อง โทรศัพท์ หรือ AI');
      const subjectSearch=input('ค้นหา External Resident ID',{maxLength:120,value:state.detail.subjectSearch||'',placeholder:'ค้นหารหัสผู้พักภายนอก'});subjectSearch.control.addEventListener('change',()=>{state.detail.subjectSearch=subjectSearch.control.value.slice(0,120);refreshIntegrationDetail({subjectPage:1});});subjectMappings.append(subjectSearch.label);
      const activeMappings=safeArray(state.detail.centerMappings).filter((item)=>item.status==='active');
      const extCenterSelect=selectField('External Center ID',[{value:'',label:'เลือกการเชื่อมศูนย์'},...activeMappings.map((item)=>({value:item.externalCenterId,label:`${item.externalCenterId} → ${item.centerName||'ศูนย์'}`}))],state.detail.selectedExternalCenter||'');
      extCenterSelect.control.addEventListener('change',()=>{state.detail.selectedExternalCenter=extCenterSelect.control.value;loadResidentOptions(extCenterSelect.control.value);});
      const externalResident=input('External Resident ID',{required:true,maxLength:160,placeholder:'VENDOR_RESIDENT_01'});
      const residentSelect=selectField('PHIMOR Resident',[{value:'',label:'เลือกผู้พัก'},...safeArray(state.detail.residentOptions).map((item)=>({value:item.residentId,label:`${item.displayName}${item.room?` · ห้อง ${item.room}`:''}${item.careProfileLinked?'':' · Care Profile ยังไม่พร้อม'}`,disabled:!item.careProfileLinked}))]);
      const subjectForm=element('div','care-ops__inline-form');subjectForm.append(extCenterSelect.label,externalResident.label,residentSelect.label,button('เพิ่มการเชื่อมรหัสผู้พัก',async()=>{if(!extCenterSelect.control.value||!externalResident.control.value||!residentSelect.control.value)return showDialogError(dialog,'กรุณาเลือกศูนย์ กรอกรหัสผู้พัก และเลือกผู้พักใน PHIMOR');await detailAction(buildSubjectMappingRequest(clientId,extCenterSelect.control.value,externalResident.control.value,residentSelect.control.value),'เพิ่มการเชื่อมรหัสผู้พักแล้ว');},''));const subjectAdvanced=element('details','care-ops__advanced');subjectAdvanced.append(element('summary','','ขั้นสูง / แก้ไขข้อยกเว้น'),subjectForm);if(!readOnly)subjectMappings.append(subjectAdvanced);
      safeArray(state.detail.subjectMappings).forEach((item)=>{const row=element('div','care-ops__managed-row');const meta=element('div');const source=item.mappingSource==='learned_automatically'?'เรียนรู้อัตโนมัติ':'ผู้ดูแลกำหนด';meta.append(element('strong','',`${item.externalCenterId} · ${item.externalResidentId}`),element('div','care-ops__meta',`${item.centerName||'ไม่ระบุศูนย์'} · ${item.residentDisplayName||'ยังไม่เชื่อมผู้พัก'}${item.room?` · ห้อง ${item.room}`:''} · ${item.mappingStatus} · ${source} · Care Profile ${item.careProfileReady?'พร้อม':'ยังไม่พร้อม'} · ใช้ล่าสุด ${formatDate(item.lastUsedAt||item.updatedAt)}`));row.append(meta);if(!readOnly&&item.mappingStatus!=='inactive')row.append(button('ปิดการเชื่อม',()=>detailAction(buildDeactivateSubjectMappingRequest(clientId,item.externalCenterId,item.externalResidentId),'ปิดการเชื่อมรหัสผู้พักแล้ว',{confirmTitle:'ปิดการเชื่อมรหัสผู้พัก',confirmMessage:'การเชื่อมนี้จะไม่ใช้กับ event ใหม่ ข้อมูลประวัติเดิมจะไม่ถูกลบ'}),'secondary'));subjectMappings.append(row);});
      if(state.detail.subjectPagination)subjectMappings.append(pager(state.detail.subjectPagination,(page)=>refreshIntegrationDetail({subjectPage:page})));

      const readiness=section('10. ความพร้อมใช้งาน','รายการนี้เป็นข้อมูลช่วยตรวจสอบ สิทธิ์จริงยังบังคับจาก status, scope นโยบาย และ mapping ที่ backend');readiness.append(renderReadiness(client.readiness));
      body.replaceChildren(info,status,scopes,events,credentials,policy,adapterSection,centerMappings,subjectMappings,readiness);
    }
    function renderIntegrations() {
      const archived=state.integrationView==='archived';
      const viewNav=element('div','care-ops__directory-view');
      const switchView=(view)=>{if(state.integrationView===view)return;state.integrationView=view;state.integrationSearch='';state.integrationStatus='';state.integrationPage=1;load({tabs:['integrations']});};
      const currentButton=button('ระบบเชื่อมต่อ',()=>switchView('current'),archived?'secondary':'');currentButton.setAttribute('aria-pressed',String(!archived));
      const archiveButton=button('ประวัติการเชื่อมต่อ',()=>switchView('archived'),archived?'':'secondary');archiveButton.setAttribute('aria-pressed',String(archived));
      viewNav.append(currentButton,archiveButton);
      const heading=element('div','care-ops__directory-heading');heading.append(element('h3','',archived?'ประวัติการเชื่อมต่อ':'ระบบเชื่อมต่อ'),element('p','care-ops__meta',archived?'ระบบที่เพิกถอนแล้ว ข้อมูลเดิมยังคงเก็บไว้เพื่อการตรวจสอบ':'ระบบที่เปิดใช้งานหรือระงับชั่วคราวและยังเกี่ยวข้องกับการใช้งานปัจจุบัน'));
      const header = element('div','care-ops__directory-tools');
      const search = input('ค้นหาระบบเชื่อมต่อ',{maxLength:120,value:state.integrationSearch,placeholder:'ชื่อ, client code หรือ source system'});
      const statusFilter=archived?null:selectField('สถานะ',[{value:'',label:'ทั้งหมด'},{value:'active',label:'ใช้งาน'},{value:'suspended',label:'ระงับ'}],state.integrationStatus);
      header.append(search.label);if(statusFilter)header.append(statusFilter.label);if(!archived)header.append(button('+ เพิ่มระบบเชื่อมต่อ',openCreateClient,''));
      const list=element('div','care-ops__list');
      if(!state.integrations.length)list.append(element('div','care-ops__empty',archived?'ยังไม่มีประวัติการเชื่อมต่อที่ตรงกับเงื่อนไข':'ไม่พบระบบเชื่อมต่อที่ตรงกับเงื่อนไข'));
      state.integrations.forEach((client)=>{const card=itemCard(client.displayName||client.clientCode||'Integration',`${client.organizationName||'ไม่ระบุ Organization'} · ${client.clientCode}`);card.append(statusBadge(client.status));const grid=element('div','care-ops__integration-grid');const values=[['Source system',client.sourceSystem||'-'],[archived?'ศูนย์ที่เคยอนุญาต':'ศูนย์ที่อนุญาต',String(client.allowedCenterCount||0)],[archived?'Event scopes เดิม':'Event ที่อนุญาต',String(client.allowedEventCount||0)],['ใช้ล่าสุด',client.lastUsedAt?formatDate(client.lastUsedAt):'ยังไม่เคยใช้'],['Mapping',`ศูนย์ ${client.mappingReadiness?.activeCenters||0} · ผู้พัก ${client.mappingReadiness?.mappedResidents||0}`],['คำเตือน',String(client.warningCount||0)]];if(archived)values.splice(4,0,['เพิกถอนเมื่อ',formatDate(client.revokedAt)]);else values.splice(3,0,['Credential พร้อมใช้',String(client.activeCredentialCount||0)]);values.forEach(([label,value])=>{const box=element('div');box.append(element('strong','',label),element('div','care-ops__meta',value));grid.append(box)});const readiness=element('p','care-ops__meta',archived?'สถานะ: เพิกถอนแล้ว':`ความพร้อม: ${client.readiness?.label||'ตั้งค่ายังไม่ครบ'}`);const actions=element('div','care-ops__actions');actions.append(button(archived?'ดูรายละเอียด':'จัดการระบบเชื่อมต่อ',()=>openIntegrationDetail(client.integrationClientId),''));card.append(grid,readiness,actions);list.append(card)});
      search.control.addEventListener('change',()=>{state.integrationSearch=search.control.value.slice(0,120);state.integrationPage=1;load({tabs:['integrations']})});
      if(statusFilter)statusFilter.control.addEventListener('change',()=>{state.integrationStatus=statusFilter.control.value;state.integrationPage=1;load({tabs:['integrations']})});
      const page=state.integrationPagination||{page:1,totalPages:0,total:0};
      const pageControls=pager(page,(next)=>{state.integrationPage=next;load({tabs:['integrations']})});
      content.replaceChildren(viewNav,heading,header,list,pageControls);
    }
    async function startMapping(item) {
      const token = generation; state.feedback = null; state.mapping = { key:`${item.integrationClientId}:${item.externalCenterId}:${item.externalResidentId}`, loading:true, residents:[], selected:null, error:null }; render();
      try {
        const result = await send(buildResidentOptionsRequest(item.centerId));
        if (token !== generation || !state.mapping) return;
        state.mapping.loading = false; state.mapping.residents = safeArray(result?.residents); render();
      } catch (error) { if (token === generation && state.mapping) { state.mapping.loading = false; state.mapping.error = errorMessage(error); render(); } }
    }
    function renderPending() {
      if (!state.pending.length) return renderEmpty('ไม่มีผู้พักรอเชื่อม');
      const list = element('div', 'care-ops__list');
      state.pending.forEach((item) => {
        const key = `${item.integrationClientId}:${item.externalCenterId}:${item.externalResidentId}`;
        const client = state.integrations.find((entry) => entry.integrationClientId === item.integrationClientId);
        const center = state.centers.find((entry) => entry.centerId === item.centerId);
        const card = itemCard(item.displayName || 'ไม่ระบุชื่อจากระบบต้นทาง', `${client?.displayName || item.integrationClientId} · ${center?.name || item.centerId}`);
        card.append(element('div', 'care-ops__meta', `รหัสผู้พักภายนอก ${item.externalResidentId}${item.room ? ` · ห้อง ${item.room}` : ''}`));
        card.append(element('div', 'care-ops__meta', `ข้อมูลรอประมวลผล ${Number(item.eventCount) || 0} รายการ · พบครั้งแรก ${formatDate(item.firstReceivedAt)}`));
        const actions = element('div', 'care-ops__actions'); actions.append(button('เชื่อมผู้พัก', () => startMapping(item))); card.append(actions);
        if (state.mapping?.key === key) {
          const mapping = element('div', 'care-ops__mapping');
          mapping.append(element('strong', '', 'เลือกผู้พักในศูนย์เดียวกันอย่างชัดเจน'));
          if (state.mapping.loading) mapping.append(element('p', 'care-ops__meta', 'กำลังโหลดรายชื่อ…'));
          else if (state.mapping.error) mapping.append(element('p', 'care-ops__error', state.mapping.error));
          else {
            const select = element('select'); select.setAttribute('aria-label', 'เลือกผู้พักที่ต้องการเชื่อม');
            const placeholder = element('option', '', 'กรุณาเลือกผู้พัก'); placeholder.value = ''; select.append(placeholder);
            state.mapping.residents.forEach((resident) => {
              const option = element('option', '', `${resident.displayName}${resident.room ? ` · ห้อง ${resident.room}` : ''}${resident.careProfileLinked ? '' : ' · ยังไม่ผูก Care Profile'}`);
              option.value = resident.residentId; option.disabled = !resident.careProfileLinked; select.append(option);
            });
            select.value = state.mapping.selected || '';
            select.addEventListener('change', () => { state.mapping.selected = select.value || null; state.mapping.error = null; render(); }); mapping.append(select);
            const chosen = state.mapping.residents.find((resident) => resident.residentId === state.mapping.selected);
            if (chosen) {
              const identities = element('div', 'care-ops__mapping-identities');
              const externalIdentity = element('section', 'care-ops__identity');
              externalIdentity.append(element('strong', '', 'ข้อมูลจากระบบภายนอก'), element('div', 'care-ops__meta', `${client?.displayName || 'ระบบเชื่อมต่อ'} · ${center?.name || 'ไม่ระบุศูนย์'}`), element('div', '', item.externalResidentId), element('div', '', `${item.displayName || 'ไม่ระบุชื่อ'}${item.room ? ` · ห้อง ${item.room}` : ''}`));
              const phimorIdentity = element('section', 'care-ops__identity');
              phimorIdentity.append(element('strong', '', 'กำลังจะเชื่อมกับ'), element('div', 'care-ops__meta', 'ผู้พักในพี่หมอ'), element('div', '', `${chosen.displayName}${chosen.room ? ` · ห้อง ${chosen.room}` : ''}`), element('div', 'care-ops__meta', center?.name || 'ไม่ระบุศูนย์'));
              identities.append(externalIdentity, phimorIdentity); mapping.append(identities);
            }
            const mapActions = element('div', 'care-ops__actions');
            mapActions.append(button('ยกเลิก', () => { state.mapping = null; render(); }));
            mapActions.append(button('ยืนยันเชื่อมผู้พัก', async () => {
              if (!state.mapping?.selected) { state.mapping.error = 'กรุณาเลือกผู้พักที่ผูก Care Profile แล้ว'; render(); return; }
              const chosen = state.mapping.residents.find((resident) => resident.residentId === state.mapping.selected);
              const approved = await confirmAction('ยืนยันเชื่อมผู้พัก', mappingConfirmationMessage(item, chosen, client, center));
              if (!approved) return;
              try { await send(buildMappingRequest(item, state.mapping.selected)); state.mapping = null; state.feedback = { tone:'success', text:'เชื่อมผู้พักแล้ว และนำข้อมูลที่รอดำเนินการกลับมาประมวลผล' }; await load(); }
              catch (error) { if (state.mapping) state.mapping.error = errorMessage(error); render(); }
            }, '')); mapping.append(mapActions);
          }
          card.append(mapping);
        }
        list.append(card);
      }); content.replaceChildren(list);
    }
    function renderGroups() {
      if (!state.operational.length) return renderEmpty('ยังไม่มีสถานะการตรวจสอบกลุ่ม LINE');
      const list = element('div', 'care-ops__list');
      state.operational.forEach((item) => {
        const client = state.integrations.find((entry) => entry.integrationClientId === item.integrationClientId);
        const center = state.centers.find((entry) => entry.centerId === item.centerId);
        const card = itemCard(`${client?.displayName || item.integrationClientId} · ${center?.name || item.centerId}`, `ผู้พักภายนอก ${item.externalResidentId}`);
        const eventDescriptor = EVENT_STATUS_LABELS[item.eventStatus] || null;
        if (eventDescriptor) {
          card.append(element('span', `care-ops__status care-ops__status--${eventDescriptor[2]}`, `${eventDescriptor[0]} · ${eventDescriptor[1]}`));
          const reasonCode = safeText(item.lastErrorCode || item.error?.code);
          if (reasonCode) card.append(element('p', 'care-ops__meta', `เหตุผล: ${REJECTION_REASON_LABELS[reasonCode] || 'ไม่สามารถประมวลผล event นี้ได้'} (${reasonCode})`));
        }
        const descriptor = GROUP_LABELS[item.groupReconciliationStatus] || null;
        if (descriptor) {
          const status = element('span', `care-ops__status${descriptor[2] ? ` care-ops__status--${descriptor[2]}` : ''}`, `${descriptor[0]} · ${descriptor[1]}`); card.append(status);
          const groups = element('dl', 'care-ops__group-ids');
          groups.append(element('dt', '', 'Group ID ที่ระบบต้นทางแจ้ง'), element('dd', '', truncateGroupId(item.expectedLineGroupId) || 'ไม่ได้ระบุ'), element('dt', '', 'Group ID ที่พี่หมอยืนยัน'), element('dd', '', truncateGroupId(item.verifiedLineGroupId) || 'ยังไม่มี'));
          card.append(groups);
        }
        if (item.groupReconciliationStatus === 'group_binding_missing') {
          card.append(element('p', 'care-ops__meta', 'ให้ครอบครัวเชิญ PHIMOR OA เข้ากลุ่มและทำขั้นตอนผูกกลุ่มใน PHIMOR ก่อนตรวจสอบอีกครั้ง ระบบจะไม่สร้าง GroupBinding จากค่าที่ vendor ส่งมา'));
        }
        if (['group_binding_missing', 'group_binding_mismatch'].includes(item.groupReconciliationStatus)) {
          const actions = element('div', 'care-ops__actions'); actions.append(button('ตรวจสอบอีกครั้ง', async () => {
            state.feedback = null;
            try { await send(buildReconcileRequest(item.integrationEventId)); state.feedback = { tone:'success', text:'ตรวจสอบกลุ่ม LINE อีกครั้งแล้ว' }; await load(); }
            catch (error) { state.feedback = { tone:'error', text:errorMessage(error) }; render(); }
          })); card.append(actions);
        }
        list.append(card);
      }); content.replaceChildren(list);
    }
    function renderIdentityAlerts() {
      if (!state.identityAlerts.length) return renderEmpty('ไม่มีรายการที่ต้องตรวจสอบ');
      const list=element('div','care-ops__list');
      state.identityAlerts.forEach((item)=>{
        const client=state.integrations.find((entry)=>entry.integrationClientId===item.integrationClientId);
        const card=itemCard('พบชื่อ–นามสกุลซ้ำ ไม่สามารถจับคู่อัตโนมัติได้',`${client?.displayName||item.sourceSystemDisplayName||'ระบบเชื่อมต่อ'} · สถานะ ${item.status==='open'?'เปิดอยู่':item.status==='resolved'?'แก้ไขแล้ว':'ปิดการแจ้งเตือน'}`);
        card.append(element('div','care-ops__meta',`ชื่อจากระบบภายนอก: ${item.normalizedDisplayName||'ไม่ระบุชื่อ'}`));
        const centers=element('ul','care-ops__safe-list');safeArray(item.candidateCenterNames,20).forEach((name)=>centers.append(element('li','',name)));card.append(element('strong','','พบใน:'),centers);
        card.append(element('p','care-ops__meta','อาจเป็นคนเดียวกันหรือคนละคน ระบบยังไม่ได้บันทึกข้อมูลหรือส่งแจ้งเตือน โปรดติดต่อทีมงานผู้ดูแลระบบ'));
        card.append(element('div','care-ops__warning','Event รายการนี้ถูกตีตกแล้ว หากต้องการข้อมูลรายการเดิม ต้องให้ระบบต้นทางส่งใหม่หลังแก้ไขการเชื่อม'));
        card.append(element('div','care-ops__meta',`พบ ${item.occurrenceCount||1} ครั้ง · ล่าสุด ${formatDate(item.lastSeenAt)}`));
        if(item.status==='open'){const actions=element('div','care-ops__actions');actions.append(button('ทำเครื่องหมายว่าแก้ไขแล้ว',async()=>{await send(buildAlertStatusRequest(item.alertId,'resolved'));state.feedback={tone:'success',text:'อัปเดตสถานะรายการตรวจสอบแล้ว'};await load();}),button('ปิดการแจ้งเตือน',async()=>{await send(buildAlertStatusRequest(item.alertId,'dismissed'));state.feedback={tone:'success',text:'ปิดการแจ้งเตือนแล้ว'};await load();},'secondary'));card.append(actions);}
        list.append(card);
      });content.replaceChildren(list);
    }
    function renderOverview() {
      const summary = element('div', 'care-ops__summary');
      const values = [[state.organizations.length, 'Organizations'], [state.centers.length, 'Centers']];
      if (state.loadedTabs.has('integrations')) values.push([state.integrations.length, 'Integrations']);
      if (state.loadedTabs.has('pending')) values.push([state.pending.length, 'รอเชื่อมผู้พัก']);
      values
        .forEach(([value, label]) => { const box = element('div'); box.append(element('strong', '', String(value)), element('span', 'care-ops__meta', label)); summary.append(box); });
      const list = element('div', 'care-ops__list');
      state.organizations.forEach((organization) => {
        const centers = state.centers.filter((center) => center.organizationId === organization.organizationId);
        list.append(itemCard(organization.displayName, `${organization.organizationType || '-'} · ${organization.status || '-'} · ${centers.map((center) => center.name).join(', ') || 'ยังไม่มีศูนย์'}`));
      });
      if(state.foundationBounded?.organizationsTruncated||state.foundationBounded?.centersTruncated)list.prepend(element('div','care-ops__notice','แสดงรายการตั้งค่าแบบจำกัดจำนวน กรุณาใช้หน้าค้นหาเฉพาะงานเพื่อดูรายการเพิ่มเติม'));
      content.replaceChildren(summary, list);
    }
    function render() {
      tabs.forEach((tab) => {
        const available = state.availableTabs.includes(tab.dataset.careOpsTab);
        tab.hidden = !available;
        tab.setAttribute('aria-selected', String(available && tab.dataset.careOpsTab === state.activeTab));
      });
      if (state.loading) return content.replaceChildren(element('div', 'care-ops__spinner', 'กำลังโหลดข้อมูลงานระบบ…'));
      if (state.error) {
        const error = element('div', 'care-ops__error', state.error); const retry = button('ลองอีกครั้ง', () => load()); content.replaceChildren(error, retry); return;
      }
      ({ overview:renderOverview, capabilities:renderCapabilities, integrations:renderIntegrations, pending:renderPending, groups:renderGroups, alerts:renderIdentityAlerts }[state.activeTab] || renderOverview)();
      if (state.feedback) {
        const feedback = element('div', `care-ops__feedback care-ops__feedback--${state.feedback.tone}`, state.feedback.text);
        feedback.setAttribute('role', 'status'); content.prepend(feedback);
      }
    }
    async function load({ tabs:requestedTabs, force=false } = {}) {
      const requested = safeArray(requestedTabs?.length ? requestedTabs : state.availableTabs)
        .filter((tab) => state.availableTabs.includes(tab));
      const needsFoundation = requested.some((tab) => ['overview','capabilities','integrations','pending','groups','alerts'].includes(tab));
      const needsCapabilities = requested.includes('capabilities');
      const needsIntegrations = requested.some((tab) => ['integrations','pending','groups','alerts'].includes(tab));
      const needsPending = requested.includes('pending');
      const needsOperational = requested.includes('groups');
      const needsAlerts = requested.includes('alerts');
      const fetchFoundation = needsFoundation && (force || !state.foundationLoaded
        || (needsCapabilities && !state.foundationCapabilitiesLoaded));
      const token = ++generation; state.loading = true; state.error = null; render();
      try {
        const directoryLimit=requested.includes('integrations')?20:100;
        const [foundationResult, pendingResult, operationalResult, alertResult, integrationResult] = await Promise.all([
          fetchFoundation ? request(`/api/admin/platform/operations-foundation?includeCapabilities=${needsCapabilities?'1':'0'}&limit=200&centerLimit=500`, { method:'GET' }) : Promise.resolve(null),
          needsPending ? request('/api/admin/platform/pending-subjects?limit=100', { method:'GET' }) : Promise.resolve(null),
          needsOperational ? request('/api/admin/platform/integration-events/status?limit=100', { method:'GET' }) : Promise.resolve(null),
          needsAlerts ? request('/api/admin/platform/integration-identity-alerts?limit=100', { method:'GET' }) : Promise.resolve(null),
          needsIntegrations ? send(buildIntegrationDirectoryRequest({search:requested.includes('integrations')?state.integrationSearch:'',status:requested.includes('integrations')?state.integrationStatus:'',view:requested.includes('integrations')?state.integrationView:'current',page:requested.includes('integrations')?state.integrationPage:1,limit:directoryLimit})) : Promise.resolve(null),
        ]);
        const organizations = fetchFoundation ? safeArray(foundationResult?.organizations) : state.organizations;
        const organizationNames=new Map(organizations.map((item)=>[item.organizationId,item.displayName]));
        const centers = fetchFoundation ? safeArray(foundationResult?.centers).map((center)=>({
          ...center,organizationName:organizationNames.get(center.organizationId)||'ไม่ระบุ Organization',
        })) : state.centers;
        const capabilityGroups = fetchFoundation&&needsCapabilities
          ? centers.map((center)=>[center.centerId,safeArray(center.capabilities)]) : null;
        const integrations = needsIntegrations ? safeArray(integrationResult?.items) : state.integrations;
        if (token !== generation) return { ignored:true, stale:true };
        Object.assign(state, { organizations, centers, integrations, loading:false, error:null });
        if(fetchFoundation){state.foundationLoaded=true;state.foundationBounded=foundationResult?.bounded||null;if(needsCapabilities)state.foundationCapabilitiesLoaded=true;}
        if(needsIntegrations&&integrationResult?.pagination)state.integrationPagination=integrationResult.pagination;
        if (capabilityGroups) state.capabilities = new Map(capabilityGroups);
        if (needsPending) state.pending = safeArray(pendingResult?.items);
        if (needsOperational) state.operational = safeArray(operationalResult?.items);
        if (needsAlerts) state.identityAlerts = safeArray(alertResult?.items);
        requested.forEach((tab) => state.loadedTabs.add(tab));
        render();
        return state;
      } catch (error) { if (token === generation) { state.loading = false; state.error = errorMessage(error); render(); } return { status:'unavailable' }; }
    }
    function setTab(tab) { if (!state.availableTabs.includes(tab)) return; state.activeTab = tab; state.mapping = null; render(); }
    function setAvailableTabs(availableTabs, preferred) {
      const normalized = safeArray(availableTabs).filter((tab) => tabs.some((button) => button.dataset.careOpsTab === tab));
      state.availableTabs = normalized.length ? normalized : tabs.map((tab) => tab.dataset.careOpsTab);
      state.activeTab = state.availableTabs.includes(preferred) ? preferred
        : state.availableTabs.includes(state.activeTab) ? state.activeTab : state.availableTabs[0];
      state.mapping = null; render(); return state.activeTab;
    }
    tabs.forEach((tab) => tab.addEventListener('click', () => setTab(tab.dataset.careOpsTab)));
    if (doc.defaultView && !doc.defaultView.__phimorIntegrationSecretCleanupBound) {
      doc.defaultView.addEventListener('pagehide', () => oneTimeSecret.clear());
      doc.defaultView.__phimorIntegrationSecretCleanupBound = true;
    }
    return { load, render, setTab, setAvailableTabs,
      snapshot:() => ({ ...state, capabilities:new Map(state.capabilities), loadedTabs:new Set(state.loadedTabs) }) };
  }
  return { CAPABILITY_LABELS, SUPPORTED_EVENT_TYPES, CLIENT_STATUS_LABELS, GROUP_LABELS, IDENTITY_POLICY_LABELS,
    EVENT_STATUS_LABELS, REJECTION_REASON_LABELS, buildResidentOptionsRequest, buildMappingRequest,
    buildCapabilityRequest, buildReconcileRequest, normalizeClientCode, buildCreateClientRequest,
    buildClientStatusRequest, buildIntegrationDirectoryRequest, buildCenterScopeRequest, buildEventScopeRequest, buildCredentialRequest,
    buildCenterMappingListRequest, buildCenterMappingRequest, buildDeactivateCenterMappingRequest,
    buildSubjectMappingListRequest, buildSubjectMappingRequest, buildDeactivateSubjectMappingRequest,
    buildIdentityPolicyRequest, buildAlertStatusRequest,ADAPTER_EVENT_TYPE,buildAdapterCaptureRequest,
    buildAdapterSampleRequest,buildAdapterStatusRequest,buildAdapterPreviewRequest,buildAdapterDraftRequest,buildAdapterActivateRequest,
    buildAdapterReuseRequest,buildAdapterRollbackRequest,buildAdapterNoticeRequest,
    createOneTimeSecretState, truncateGroupId, mappingConfirmationMessage, createController };
}));
