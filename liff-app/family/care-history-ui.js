(function initFamilyCareHistoryUI(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhimorFamilyCareHistoryUI = api;
}(typeof window !== 'undefined' ? window : globalThis, function familyCareHistoryFactory() {
  const PAGE_LIMIT = 10;
  const MEASUREMENT_LABELS = Object.freeze({
    temperature:'อุณหภูมิ', blood_pressure_systolic:'ความดันตัวบน', blood_pressure_diastolic:'ความดันตัวล่าง',
    pulse:'ชีพจร', spo2:'SpO₂', respiratory_rate:'อัตราการหายใจ', blood_glucose:'น้ำตาลในเลือด', weight:'น้ำหนัก',
  });
  const GLUCOSE_CONTEXT_LABELS = Object.freeze({ fasting:'ขณะอดอาหาร', before_meal:'ก่อนอาหาร', after_meal:'หลังอาหาร', random:'สุ่มเวลา', unspecified:'ไม่ระบุช่วงเวลา' });
  const DISPLAY_UNIT_LABELS = Object.freeze({ Cel:'°C', 'mm[Hg]':'mmHg' });
  const DAILY_ITEM_LABELS = Object.freeze({
    shift:'ช่วงเวร', nutrition:'อาหาร/โภชนาการ', fluid_intake:'ปริมาณน้ำ', sleep_rest:'การนอน/พักผ่อน',
    bowel_movement:'การขับถ่ายอุจจาระ', urination:'การปัสสาวะ', activity:'กิจกรรม', mood_behavior:'อารมณ์/พฤติกรรม',
    general_condition:'สภาพทั่วไป', symptom_note:'อาการ/บันทึก',
  });
  const safeText = (value, fallback = '') => (typeof value === 'string' && value.trim() ? value.trim() : fallback);
  const safeArray = (value, limit = 200) => (Array.isArray(value) ? value.slice(0, limit) : []);
  function formatDate(value, includeTime = true) {
    const date = value ? new Date(value) : null;
    if (!date || !Number.isFinite(date.getTime())) return 'ไม่ระบุวันเวลา';
    return date.toLocaleString('th-TH', { dateStyle:'medium', ...(includeTime ? { timeStyle:'short' } : {}), timeZone:'Asia/Bangkok' });
  }
  function dateRangeValue(value, end = false) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value || ''))) return null;
    return `${value}T${end ? '23:59:59' : '00:00:00'}+07:00`;
  }
  function buildHistoryRequest(kind, careProfileId, { cursor = null, from = null, to = null } = {}) {
    const endpoint = kind === 'daily' ? 'daily-care' : 'vital-signs';
    const query = new URLSearchParams({ limit:String(PAGE_LIMIT) });
    if (cursor) query.set('cursor', cursor);
    if (from) query.set('from', dateRangeValue(from, false) || from);
    if (to) query.set('to', dateRangeValue(to, true) || to);
    return { path:`/api/care-profile/${encodeURIComponent(careProfileId)}/${endpoint}?${query}`, options:{ method:'GET' } };
  }
  function projectObservation(row) {
    if (!row || !MEASUREMENT_LABELS[row.measurementType]) return null;
    const numeric = row.numericValue === null || row.numericValue === undefined ? null : Number(row.numericValue);
    const sourceValueText = safeText(row.sourceValueText) || (Number.isFinite(numeric) ? String(numeric) : null);
    if (!sourceValueText) return null;
    return {
      measurementType:row.measurementType,
      sourceValueText,
      numericValue:Number.isFinite(numeric) ? numeric : null,
      sourceUnit:safeText(row.sourceUnit) || null,
      canonicalUnit:safeText(row.canonicalUnit) || null,
      context:row.measurementType === 'blood_glucose' && GLUCOSE_CONTEXT_LABELS[row.context] ? row.context : null,
    };
  }
  function projectVitalSet(row) {
    if (!row || row.status !== 'recorded' || typeof row.vitalSetId !== 'string') return null;
    return { vitalSetId:row.vitalSetId, status:'recorded', occurredAt:safeText(row.occurredAt) || null,
      recordedAt:safeText(row.recordedAt) || null, centerName:safeText(row.centerName) || null,
      sourceType:safeText(row.sourceType) || null, observations:safeArray(row.observations).map(projectObservation).filter(Boolean) };
  }
  function projectDailyItem(row) {
    if (!row || !DAILY_ITEM_LABELS[row.itemType] || !['text','numeric','boolean'].includes(row.valueType)) return null;
    let value = safeText(row.sourceValueText);
    if (!value && row.valueType === 'text') value = safeText(row.textValue);
    if (!value && row.valueType === 'numeric' && Number.isFinite(Number(row.numericValue))) value = `${Number(row.numericValue)}${safeText(row.sourceUnit) ? ` ${row.sourceUnit}` : ''}`;
    if (!value && row.valueType === 'boolean' && typeof row.booleanValue === 'boolean') value = row.booleanValue ? 'ใช่' : 'ไม่ใช่';
    return value ? { itemType:row.itemType, value } : null;
  }
  function projectDailyReport(row) {
    if (!row || row.status !== 'finalized' || typeof row.dailyReportId !== 'string') return null;
    return { dailyReportId:row.dailyReportId, status:'finalized', occurredAt:safeText(row.occurredAt) || null,
      careDate:safeText(row.careDate) || null, shift:row.shift && typeof row.shift === 'object'
        ? { code:safeText(row.shift.code) || null, sourceLabel:safeText(row.shift.sourceLabel) || null } : null,
      recordedAt:safeText(row.recordedAt) || null, finalizedAt:safeText(row.finalizedAt) || null,
      sourceType:safeText(row.sourceType) || null, centerName:safeText(row.centerName) || null,
      recorderDisplayName:safeText(row.recorderDisplayName) || null, finalizerDisplayName:safeText(row.finalizerDisplayName) || null,
      items:safeArray(row.items, 30).map(projectDailyItem).filter(Boolean),
      vitalSigns:safeArray(row.vitalSigns, 10).map(projectVitalSet).filter(Boolean) };
  }
  function mergeById(existing, incoming, idKey, projector) {
    const seen = new Set(); return [...safeArray(existing), ...safeArray(incoming)].map(projector).filter((item) => {
      if (!item || seen.has(item[idKey])) return false; seen.add(item[idKey]); return true;
    });
  }
  function safeError(error, fallback) { return { errorCode:safeText(error?.errorCode, fallback), status:Number(error?.status) || 0 }; }
  function freshState(profileId = null) { return { profileId, opened:false, vitals:[], vitalCursor:null, vitalLoading:false, vitalError:null,
    vitalFilter:{ from:null, to:null }, daily:[], dailyCursor:null, dailyLoading:false, dailyError:null,
    selectedDailyId:null, workspace:'overview' }; }
  function createSession({ request, onChange = () => {} }) {
    if (typeof request !== 'function') throw new TypeError('request is required');
    let state = freshState(); let generation = 0; let vitalRevision = 0; let dailyRevision = 0;
    const snapshot = () => ({ ...state, vitals:[...state.vitals], daily:[...state.daily], vitalFilter:{...state.vitalFilter}, selectedDaily:state.daily.find((item) => item.dailyReportId === state.selectedDailyId) || null });
    const notify = () => onChange(snapshot());
    const current = (token, profileId) => token === generation && state.profileId === profileId;
    async function loadVitals({ append = false } = {}) {
      if (!state.profileId || state.vitalLoading || (append && !state.vitalCursor)) return { ignored:true };
      const token = generation; const profileId = state.profileId; const revision = ++vitalRevision;
      state.vitalLoading = true; state.vitalError = null; notify();
      try {
        const response = await request(buildHistoryRequest('vital', profileId, { cursor:append ? state.vitalCursor : null, ...state.vitalFilter }).path, { method:'GET' });
        if (!current(token, profileId) || revision !== vitalRevision) return { ignored:true, stale:true };
        state.vitals = mergeById(append ? state.vitals : [], response?.items, 'vitalSetId', projectVitalSet);
        state.vitalCursor = safeText(response?.nextCursor) || null; return response;
      } catch (error) { if (current(token, profileId) && revision === vitalRevision) state.vitalError = safeError(error, 'VITAL_HISTORY_UNAVAILABLE'); return { status:'unavailable' }; }
      finally { if (current(token, profileId) && revision === vitalRevision) { state.vitalLoading = false; notify(); } }
    }
    async function loadDaily({ append = false } = {}) {
      if (!state.profileId || state.dailyLoading || (append && !state.dailyCursor)) return { ignored:true };
      const token = generation; const profileId = state.profileId; const revision = ++dailyRevision;
      state.dailyLoading = true; state.dailyError = null; notify();
      try {
        const descriptor = buildHistoryRequest('daily', profileId, { cursor:append ? state.dailyCursor : null });
        const response = await request(descriptor.path, descriptor.options);
        if (!current(token, profileId) || revision !== dailyRevision) return { ignored:true, stale:true };
        state.daily = mergeById(append ? state.daily : [], response?.items, 'dailyReportId', projectDailyReport);
        state.dailyCursor = safeText(response?.nextCursor) || null; return response;
      } catch (error) { if (current(token, profileId) && revision === dailyRevision) state.dailyError = safeError(error, 'DAILY_CARE_UNAVAILABLE'); return { status:'unavailable' }; }
      finally { if (current(token, profileId) && revision === dailyRevision) { state.dailyLoading = false; notify(); } }
    }
    return { snapshot,
      setProfile(profileId) { const normalized = safeText(profileId) || null; if (normalized === state.profileId) return false;
        generation += 1; vitalRevision += 1; dailyRevision += 1; state = freshState(normalized); notify(); return true; },
      async open() { state.opened = true; notify(); if (!state.profileId) return { ignored:true }; return Promise.all([loadVitals(), loadDaily()]); },
      loadVitals, loadMoreVitals:() => loadVitals({append:true}), loadDaily, loadMoreDaily:() => loadDaily({append:true}),
      applyVitalFilter(from, to) { state.vitalFilter = { from:safeText(from) || null, to:safeText(to) || null }; state.vitals = []; state.vitalCursor = null; notify(); return loadVitals(); },
      show(workspace) { if (['overview','vitals','daily'].includes(workspace)) { state.workspace = workspace; state.selectedDailyId = null; notify(); } },
      selectDaily(dailyReportId) { state.workspace = 'daily'; state.selectedDailyId = safeText(dailyReportId) || null; notify(); },
    };
  }
  function displayUnit(observation) {
    const sourceUnit = safeText(observation?.sourceUnit) || safeText(observation?.canonicalUnit);
    if (observation?.measurementType === 'pulse' && sourceUnit === '/min') return 'ครั้ง/นาที';
    return DISPLAY_UNIT_LABELS[sourceUnit] || sourceUnit;
  }
  function observationValue(observation) {
    const value = safeText(observation?.sourceValueText, 'ไม่ระบุค่า');
    const unit = displayUnit(observation);
    return `${value}${unit ? `${unit === '%' ? '' : ' '}${unit}` : ''}`;
  }
  function sourceLabel(sourceType) { return sourceType === 'external_integration' ? 'ข้อมูลจากศูนย์ที่ดูแล' : sourceType === 'native_phimor' ? 'บันทึกโดยศูนย์ที่ดูแล' : ''; }
  function shiftLabel(shift) { return ({day:'กลางวัน',night:'กลางคืน'}[safeText(shift?.code)]) || safeText(shift?.sourceLabel) || safeText(shift?.code) || 'ไม่ระบุเวร'; }
  function createController({ doc, session, getCurrentProfile }) {
    const panel = doc.getElementById('familyCareHistoryPanel'); const live = doc.getElementById('familyCareLive');
    const latest = doc.getElementById('familyLatestVital'); const latestDaily = doc.getElementById('familyLatestDaily');
    const workspace = doc.getElementById('familyCareWorkspace'); const title = doc.getElementById('familyCareWorkspaceTitle');
    const list = doc.getElementById('familyCareHistoryList'); const actions = doc.getElementById('familyCareHistoryActions');
    const filters = doc.getElementById('familyVitalFilters'); const fromInput = doc.getElementById('familyVitalFrom'); const toInput = doc.getElementById('familyVitalTo');
    const element = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const actionButton = (text, handler, className = 'btn btn-outline') => { const node = element('button', className, text); node.type = 'button'; node.addEventListener('click', handler); return node; };
    function renderVitalFacts(parent, vitalSet) {
      const observations = safeArray(vitalSet?.observations); if (!observations.length) return parent.append(element('div', 'family-care__empty', 'ไม่มีค่าที่บันทึกไว้ในรายการนี้'));
      const facts = element('dl', 'family-care__facts'); const byType = new Map(observations.map((item) => [item.measurementType, item]));
      const systolic = byType.get('blood_pressure_systolic'); const diastolic = byType.get('blood_pressure_diastolic');
      if (systolic || diastolic) {
        const fact = element('div', 'family-care__fact'); fact.append(element('dt', '', 'ความดันโลหิต'));
        const values = [systolic?.sourceValueText, diastolic?.sourceValueText].filter(Boolean).join('/');
        const unit = displayUnit(systolic || diastolic);
        fact.append(element('dd', '', `${values || 'ไม่ระบุค่า'}${unit ? ` ${unit}` : ''}`)); facts.append(fact);
      }
      observations.filter((item) => !['blood_pressure_systolic','blood_pressure_diastolic'].includes(item.measurementType)).forEach((item) => {
        const fact = element('div', 'family-care__fact'); fact.append(element('dt', '', MEASUREMENT_LABELS[item.measurementType]), element('dd', '', observationValue(item)));
        if (item.measurementType === 'blood_glucose' && item.context) fact.lastChild.append(element('small', '', GLUCOSE_CONTEXT_LABELS[item.context])); facts.append(fact);
      }); parent.append(facts);
    }
    function renderError(parent, error, retry) { if (!error) return; const box = element('div', 'family-care__error', error.status === 401 || error.status === 403 ? 'ไม่สามารถเข้าถึงข้อมูลของ Care Profile นี้ได้' : 'โหลดข้อมูลไม่สำเร็จ'); box.append(actionButton('ลองอีกครั้ง', retry)); parent.append(box); }
    function renderVitalCard(parent, vital, detailed = false) {
      const card = element('article', 'family-care__card'); card.append(element('h4', '', formatDate(vital.occurredAt)));
      card.append(element('div', 'family-care__meta', [vital.centerName, sourceLabel(vital.sourceType)].filter(Boolean).join(' · '))); renderVitalFacts(card, vital); parent.append(card);
      if (detailed) card.setAttribute('aria-label', `สัญญาณชีพ ${formatDate(vital.occurredAt)}`);
    }
    function renderDailySummary(parent, report, detail = false) {
      const card = element('article', detail ? 'family-care__detail' : 'family-care__card');
      card.append(element(detail ? 'h3' : 'h4', '', `${report.careDate ? formatDate(`${report.careDate}T12:00:00+07:00`, false) : formatDate(report.occurredAt, false)} · เวร ${shiftLabel(report.shift)}`));
      card.append(element('div', 'family-care__meta', [report.centerName, report.finalizedAt ? `ยืนยัน ${formatDate(report.finalizedAt)}` : null].filter(Boolean).join(' · ')));
      if (detail) {
        if (report.vitalSigns.length) { card.append(element('h4', 'family-care__detail-section', 'สัญญาณชีพ')); report.vitalSigns.forEach((vital) => renderVitalFacts(card, vital)); }
        if (report.items.length) { card.append(element('h4', 'family-care__detail-section', 'การดูแล')); const items = element('div', 'family-care__items'); report.items.forEach((item) => { const row = element('div', 'family-care__item'); row.append(element('strong', '', DAILY_ITEM_LABELS[item.itemType]), element('span', '', item.value)); items.append(row); }); card.append(items); }
        if (report.recorderDisplayName) card.append(element('p', 'family-care__meta', `ผู้บันทึก: ${report.recorderDisplayName}`));
        if (report.finalizerDisplayName) card.append(element('p', 'family-care__meta', `ผู้ยืนยัน: ${report.finalizerDisplayName}`));
        const back = actionButton('กลับไปรายการบันทึก', () => { session.selectDaily(null); session.show('daily'); }); card.append(back);
      } else card.append(actionButton('ดูรายละเอียด', () => session.selectDaily(report.dailyReportId)));
      parent.append(card);
    }
    function render(state) {
      const profileId = getCurrentProfile()?.profile?.care_profile_id || null; panel.hidden = !profileId;
      live.replaceChildren(); latest.replaceChildren(); latestDaily.replaceChildren(); list.replaceChildren(); actions.replaceChildren();
      if (!profileId) return;
      if ((state.vitalLoading && !state.vitals.length) || (state.dailyLoading && !state.daily.length)) live.append(element('div', 'family-care__loading', 'กำลังโหลดข้อมูลสุขภาพ…'));
      const firstVital = state.vitals[0]; if (firstVital) { latest.append(element('p', 'family-care__meta', formatDate(firstVital.occurredAt))); renderVitalFacts(latest, firstVital); }
      else if (!state.vitalLoading && !state.vitalError) latest.append(element('div', 'family-care__empty', 'ยังไม่มีข้อมูลสัญญาณชีพ'));
      renderError(latest, state.vitalError, () => session.loadVitals());
      const firstDaily = state.daily[0]; if (firstDaily) renderDailySummary(latestDaily, firstDaily);
      else if (!state.dailyLoading && !state.dailyError) latestDaily.append(element('div', 'family-care__empty', 'ยังไม่มีบันทึกการดูแล'));
      renderError(latestDaily, state.dailyError, () => session.loadDaily());
      workspace.hidden = state.workspace === 'overview'; filters.hidden = state.workspace !== 'vitals';
      if (state.workspace === 'vitals') {
        title.textContent = 'ประวัติสัญญาณชีพ'; state.vitals.forEach((vital) => renderVitalCard(list, vital, true));
        if (!state.vitalLoading && !state.vitals.length && !state.vitalError) list.append(element('div', 'family-care__empty', 'ยังไม่มีข้อมูลสัญญาณชีพ'));
        renderError(list, state.vitalError, () => session.loadVitals());
        if (state.vitalCursor) actions.append(actionButton(state.vitalLoading ? 'กำลังโหลด…' : 'โหลดเพิ่ม', () => session.loadMoreVitals()));
      } else if (state.workspace === 'daily') {
        title.textContent = 'บันทึกการดูแล';
        if (state.selectedDaily) renderDailySummary(list, state.selectedDaily, true); else state.daily.forEach((report) => renderDailySummary(list, report));
        if (!state.dailyLoading && !state.daily.length && !state.dailyError) list.append(element('div', 'family-care__empty', 'ยังไม่มีบันทึกการดูแล'));
        renderError(list, state.dailyError, () => session.loadDaily());
        if (!state.selectedDaily && state.dailyCursor) actions.append(actionButton(state.dailyLoading ? 'กำลังโหลด…' : 'โหลดเพิ่ม', () => session.loadMoreDaily()));
      }
    }
    doc.getElementById('familyVitalHistoryButton').addEventListener('click', () => session.show('vitals'));
    doc.getElementById('familyDailyHistoryButton').addEventListener('click', () => session.show('daily'));
    doc.getElementById('familyCareOverviewButton').addEventListener('click', () => session.show('overview'));
    doc.getElementById('familyVitalFilterButton').addEventListener('click', () => session.applyVitalFilter(fromInput.value, toInput.value));
    return { render, open:() => session.open() };
  }
  return { PAGE_LIMIT, MEASUREMENT_LABELS, GLUCOSE_CONTEXT_LABELS, DISPLAY_UNIT_LABELS, DAILY_ITEM_LABELS, buildHistoryRequest, projectObservation, projectVitalSet, projectDailyItem, projectDailyReport, createSession, createController, displayUnit, observationValue, sourceLabel, shiftLabel };
}));
