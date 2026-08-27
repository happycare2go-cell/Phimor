(function initCareOperationsUI(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhimorCareOperationsUI = api;
}(typeof window !== 'undefined' ? window : globalThis, function careOperationsFactory() {
  const CAPABILITY_LABELS = Object.freeze({
    vital_signs_v1: 'สัญญาณชีพ', daily_care_v1: 'บันทึกการดูแลประจำวัน',
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
  const safeArray = (value, limit = 250) => (Array.isArray(value) ? value.slice(0, limit) : []);
  const safeText = (value, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
  const formatDate = (value) => {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime())
      ? date.toLocaleString('th-TH', { dateStyle:'medium', timeStyle:'short', timeZone:'Asia/Bangkok' }) : 'ยังไม่มีข้อมูล';
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
    const state = {
      activeTab:'capabilities', loading:false, error:null, organizations:[], centers:[],
      capabilities:new Map(), integrations:[], pending:[], operational:[], mapping:null, feedback:null,
    };
    const send = (descriptor) => request(descriptor.path, descriptor.options);
    const element = (tag, className, text) => {
      const node = doc.createElement(tag); if (className) node.className = className;
      if (text !== undefined) node.textContent = text; return node;
    };
    const button = (label, handler, className = 'secondary') => {
      const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', handler); return node;
    };
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
    function renderIntegrations() {
      if (!state.integrations.length) return renderEmpty('ยังไม่มี External Integration');
      const list = element('div', 'care-ops__list');
      state.integrations.forEach((client) => {
        const card = itemCard(client.displayName || client.clientCode || 'Integration', `${client.organizationName} · ${client.status || '-'}`);
        const grid = element('div', 'care-ops__integration-grid');
        const fields = [
          ['Source system', client.sourceSystem || '-'],
          ['ศูนย์ที่อนุญาต', safeArray(client.centers).map((scope) => scope.center_name || scope.centerId || scope.center_id).filter(Boolean).join(', ') || '-'],
          ['Event ที่อนุญาต', safeArray(client.eventScopes).join(', ') || '-'],
          ['Credential', safeArray(client.credentials).map((credential) => `${credential.status}${credential.lastUsedAt ? ` · ใช้ล่าสุด ${formatDate(credential.lastUsedAt)}` : ''}`).join('\n') || 'ยังไม่มี'],
        ];
        fields.forEach(([label, value]) => { const box = element('div'); box.append(element('strong', '', label), element('div', 'care-ops__meta', value)); grid.append(box); });
        card.append(grid, element('p', 'care-ops__secret-note', 'ระบบไม่แสดง Secret เดิม การออกหรือหมุน Credential ควรทำผ่านขั้นตอนควบคุมแยกต่างหาก'));
        list.append(card);
      }); content.replaceChildren(list);
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
    function renderOverview() {
      const summary = element('div', 'care-ops__summary');
      [[state.organizations.length, 'Organizations'], [state.centers.length, 'Centers'], [state.integrations.length, 'Integrations'], [state.pending.length, 'รอเชื่อมผู้พัก']]
        .forEach(([value, label]) => { const box = element('div'); box.append(element('strong', '', String(value)), element('span', 'care-ops__meta', label)); summary.append(box); });
      const list = element('div', 'care-ops__list');
      state.organizations.forEach((organization) => {
        const centers = state.centers.filter((center) => center.organizationId === organization.organizationId);
        list.append(itemCard(organization.displayName, `${organization.organizationType || '-'} · ${organization.status || '-'} · ${centers.map((center) => center.name).join(', ') || 'ยังไม่มีศูนย์'}`));
      }); content.replaceChildren(summary, list);
    }
    function render() {
      tabs.forEach((tab) => tab.setAttribute('aria-selected', String(tab.dataset.careOpsTab === state.activeTab)));
      if (state.loading) return content.replaceChildren(element('div', 'care-ops__spinner', 'กำลังโหลดข้อมูลงานระบบ…'));
      if (state.error) {
        const error = element('div', 'care-ops__error', state.error); const retry = button('ลองอีกครั้ง', load); content.replaceChildren(error, retry); return;
      }
      ({ overview:renderOverview, capabilities:renderCapabilities, integrations:renderIntegrations, pending:renderPending, groups:renderGroups }[state.activeTab] || renderOverview)();
      if (state.feedback) {
        const feedback = element('div', `care-ops__feedback care-ops__feedback--${state.feedback.tone}`, state.feedback.text);
        feedback.setAttribute('role', 'status'); content.prepend(feedback);
      }
    }
    async function load() {
      const token = ++generation; state.loading = true; state.error = null; render();
      try {
        const [organizationsResult, pendingResult, operationalResult] = await Promise.all([
          request('/api/admin/platform/organizations', { method:'GET' }),
          request('/api/admin/platform/pending-subjects?limit=100', { method:'GET' }),
          request('/api/admin/platform/integration-events/status?limit=100', { method:'GET' }),
        ]);
        const organizations = safeArray(organizationsResult?.organizations);
        const centerGroups = await Promise.all(organizations.map(async (organization) => {
          const result = await request(`/api/admin/platform/organizations/${encodeURIComponent(organization.organizationId)}/centers`, { method:'GET' });
          return safeArray(result?.centers).map((center) => ({ ...center, organizationId:organization.organizationId, organizationName:organization.displayName }));
        }));
        const centers = centerGroups.flat();
        const capabilityGroups = await Promise.all(centers.map(async (center) => {
          const result = await request(`/api/admin/platform/centers/${encodeURIComponent(center.centerId)}/capabilities`, { method:'GET' });
          return [center.centerId, safeArray(result?.capabilities)];
        }));
        const clientGroups = await Promise.all(organizations.map(async (organization) => {
          const result = await request(`/api/admin/platform/organizations/${encodeURIComponent(organization.organizationId)}/integration-clients`, { method:'GET' });
          return safeArray(result?.integrationClients).map((client) => ({ ...client, organizationName:organization.displayName }));
        }));
        const clients = clientGroups.flat();
        const integrations = await Promise.all(clients.map(async (client) => {
          const result = await request(`/api/admin/platform/integration-clients/${encodeURIComponent(client.integrationClientId)}`, { method:'GET' });
          return { ...result.integrationClient, organizationName:client.organizationName };
        }));
        if (token !== generation) return { ignored:true, stale:true };
        Object.assign(state, { organizations, centers, capabilities:new Map(capabilityGroups), integrations,
          pending:safeArray(pendingResult?.items), operational:safeArray(operationalResult?.items), loading:false, error:null }); render();
        return state;
      } catch (error) { if (token === generation) { state.loading = false; state.error = errorMessage(error); render(); } return { status:'unavailable' }; }
    }
    function setTab(tab) { state.activeTab = tab; state.mapping = null; render(); }
    tabs.forEach((tab) => tab.addEventListener('click', () => setTab(tab.dataset.careOpsTab)));
    return { load, render, setTab, snapshot:() => ({ ...state, capabilities:new Map(state.capabilities) }) };
  }
  return { CAPABILITY_LABELS, GROUP_LABELS, EVENT_STATUS_LABELS, REJECTION_REASON_LABELS, buildResidentOptionsRequest, buildMappingRequest, buildCapabilityRequest, buildReconcileRequest, truncateGroupId, mappingConfirmationMessage, createController };
}));
