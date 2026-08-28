(function attachCenterCareUI(globalScope) {
  'use strict';

  const CAPABILITIES = Object.freeze({ vital: 'vital_signs_v1', daily: 'daily_care_v1' });
  const VITAL_FIELDS = Object.freeze([
    ['temperature', 'temperature', 'Cel'],
    ['systolic', 'blood_pressure_systolic', 'mm[Hg]'],
    ['diastolic', 'blood_pressure_diastolic', 'mm[Hg]'],
    ['pulse', 'pulse', '/min'],
    ['spo2', 'spo2', '%'],
    ['respiratoryRate', 'respiratory_rate', '/min'],
    ['bloodGlucose', 'blood_glucose', 'mg/dL', 'glucoseContext'],
    ['weight', 'weight', 'kg'],
  ]);
  const SHIFT_LABELS = Object.freeze({ day:'กลางวัน', night:'กลางคืน', morning:'เช้า', evening:'เย็น', other:'อื่น ๆ' });
  const DAILY_TEXT_FIELDS = Object.freeze([
    ['nutrition', 'nutrition'], ['sleep', 'sleep_rest'],
    ['urination', 'urination'], ['activity', 'activity'], ['mood', 'mood_behavior'],
    ['generalCondition', 'general_condition'], ['symptomNote', 'symptom_note'],
  ]);

  class CenterCareUiError extends Error {
    constructor(code, message) { super(message); this.name = 'CenterCareUiError'; this.code = code; }
  }

  function cleanText(value) { return String(value ?? '').trim(); }

  function parseNumber(value, label) {
    const raw = cleanText(value);
    if (!raw) return null;
    const numeric = Number(raw);
    if (!Number.isFinite(numeric)) throw new CenterCareUiError('INVALID_NUMBER', `${label} ต้องเป็นตัวเลข`);
    return numeric;
  }

  function occurredAtIso(value) {
    const raw = cleanText(value);
    if (!raw) throw new CenterCareUiError('OCCURRED_AT_REQUIRED', 'กรุณาระบุวันและเวลาที่บันทึก');
    const date = new Date(raw);
    if (!Number.isFinite(date.getTime())) throw new CenterCareUiError('INVALID_OCCURRED_AT', 'วันและเวลาไม่ถูกต้อง');
    return date.toISOString();
  }

  function buildVitalObservations(values = {}) {
    const labels = {
      temperature: 'อุณหภูมิ', systolic: 'ความดันตัวบน', diastolic: 'ความดันตัวล่าง',
      pulse: 'ชีพจร', spo2: 'ออกซิเจนปลายนิ้ว', respiratoryRate: 'อัตราการหายใจ',
      bloodGlucose:'น้ำตาลในเลือด', weight:'น้ำหนัก',
    };
    const observations = [];
    for (const [field, measurementType, sourceUnit, contextField] of VITAL_FIELDS) {
      const numericValue = parseNumber(values[field], labels[field]);
      if (numericValue === null) continue;
      const observation = { measurementType, numericValue, sourceUnit, sourceValueText:cleanText(values[field]) };
      if (contextField) observation.context = cleanText(values[contextField]) || 'unspecified';
      observations.push(observation);
    }
    if (!observations.length) throw new CenterCareUiError('VITAL_REQUIRED', 'กรุณากรอกสัญญาณชีพอย่างน้อย 1 รายการ');
    return observations;
  }

  function buildDailyItems(values = {}) {
    const items = [];
    const shift = buildShift(values);
    if (shift) items.push({ itemType:'shift', valueType:'text', textValue:shift.sourceLabel, sourceValueText:shift.sourceLabel });
    const fluid = parseNumber(values.fluid, 'ปริมาณน้ำดื่ม');
    if (fluid !== null) items.push({ itemType:'fluid_intake', valueType:'numeric', numericValue:fluid, sourceUnit:'mL', sourceValueText:cleanText(values.fluid) });
    const bowelCount = parseNumber(values.bowelCount, 'จำนวนครั้งการขับถ่าย');
    if (bowelCount !== null) items.push({ itemType:'bowel_movement', valueType:'numeric', numericValue:bowelCount, sourceUnit:'times', sourceValueText:cleanText(values.bowelCount) });
    for (const [field, itemType] of DAILY_TEXT_FIELDS) {
      const textValue = cleanText(values[field]);
      if (textValue) items.push({ itemType, valueType:'text', textValue, sourceValueText:textValue });
    }
    if (!items.length) throw new CenterCareUiError('DAILY_ITEM_REQUIRED', 'กรุณากรอกข้อมูลการดูแลอย่างน้อย 1 รายการ');
    return items;
  }

  function buildShift(values = {}) {
    const code = cleanText(values.shift);
    if (!code) return null;
    return { code, sourceLabel:SHIFT_LABELS[code] || cleanText(values.shiftSourceLabel) || code };
  }

  function buildOptionalDailyVitals(values = {}) {
    const mapped = {
      temperature:values.dailyTemperature, systolic:values.dailySystolic,
      diastolic:values.dailyDiastolic, pulse:values.dailyPulse,
      spo2:values.dailySpo2, respiratoryRate:values.dailyRespiratoryRate,
      bloodGlucose:values.dailyBloodGlucose, glucoseContext:values.dailyGlucoseContext,
      weight:values.dailyWeight,
    };
    if (!Object.values(mapped).some((value) => cleanText(value))) return null;
    return { occurredAt:occurredAtIso(values.occurredAt), observations:buildVitalObservations(mapped) };
  }

  function finalizationNotice(result = {}) {
    const state = result?.notification?.notificationStatus;
    if (state === 'queued' || state === 'duplicate') return 'ยืนยันรายงานแล้ว ระบบนำรายงานเข้าคิวแจ้งครอบครัว';
    if (state === 'recipient_missing') return 'ยืนยันรายงานแล้ว แต่ยังไม่พบช่องทางแจ้งครอบครัว';
    return 'ยืนยันรายงานแล้ว แต่การนำเข้าคิวแจ้งครอบครัวยังไม่สำเร็จ';
  }

  function createController({ api } = {}) {
    if (typeof api !== 'function') throw new Error('api is required');
    let revision = 0;
    let context = null;
    let sending = false;

    function configure(next = null) {
      revision += 1;
      sending = false;
      if (!next) { context = null; return null; }
      const residents = Array.isArray(next.residents) ? next.residents
        .filter((resident) => resident && resident.resident_id)
        .map((resident) => ({ residentId:String(resident.resident_id), careProfileId:resident.care_profile_id?String(resident.care_profile_id):null,
          name:String(resident.full_name || 'ผู้รับการดูแล'), room:resident.room ? String(resident.room) : null })) : [];
      context = {
        centerId:cleanText(next.centerId), role:cleanText(next.role), residents,
        capabilities:{
          [CAPABILITIES.vital]:next.capabilities?.[CAPABILITIES.vital] === true,
          [CAPABILITIES.daily]:next.capabilities?.[CAPABILITIES.daily] === true,
        },
      };
      return snapshot();
    }

    function snapshot() {
      return context ? { ...context, residents:context.residents.map((resident) => ({ ...resident })), capabilities:{...context.capabilities}, revision, sending } : null;
    }

    function requireContext(capability, residentId) {
      if (!context?.centerId || !context.capabilities[capability]) throw new CenterCareUiError('CAPABILITY_UNAVAILABLE', 'ศูนย์นี้ยังไม่ได้เปิดใช้ความสามารถนี้');
      const resident = context.residents.find((item) => item.residentId === cleanText(residentId));
      if (!resident) throw new CenterCareUiError('RESIDENT_REQUIRED', 'กรุณาเลือกผู้รับการดูแล');
      if (sending) throw new CenterCareUiError('REQUEST_IN_PROGRESS', 'กำลังบันทึก กรุณารอสักครู่');
      return resident;
    }

    async function submit(kind, values) {
      const capability = kind === 'vital' ? CAPABILITIES.vital : CAPABILITIES.daily;
      requireContext(capability, values.residentId);
      const requestRevision = revision;
      const centerId = context.centerId;
      const residentId = cleanText(values.residentId);
      const body = kind === 'vital'
        ? { occurredAt:occurredAtIso(values.occurredAt), observations:buildVitalObservations(values) }
        : { occurredAt:occurredAtIso(values.occurredAt), careDate:cleanText(values.occurredAt).slice(0, 10),
          shift:buildShift(values), items:buildDailyItems(values) };
      if (kind === 'daily') {
        const vitalSigns = buildOptionalDailyVitals(values);
        if (vitalSigns && !context.capabilities[CAPABILITIES.vital]) throw new CenterCareUiError('CAPABILITY_UNAVAILABLE', 'ศูนย์นี้ยังไม่ได้เปิดใช้การบันทึกสัญญาณชีพ');
        if (vitalSigns) body.vitalSigns = vitalSigns;
      }
      sending = true;
      try {
        const path = kind === 'vital'
          ? `/api/center/${encodeURIComponent(centerId)}/residents/${encodeURIComponent(residentId)}/vital-signs`
          : values.resubmitReportId
            ? `/api/center/${encodeURIComponent(centerId)}/daily-care/${encodeURIComponent(cleanText(values.resubmitReportId))}/resubmit`
            : `/api/center/${encodeURIComponent(centerId)}/residents/${encodeURIComponent(residentId)}/daily-care`;
        const result = await api(path, { method:'POST', body:JSON.stringify(body) });
        if (requestRevision !== revision) return { stale:true };
        return { stale:false, result };
      } catch (error) {
        if (requestRevision !== revision) return { stale:true };
        throw error;
      } finally {
        if (requestRevision === revision) sending = false;
      }
    }

    async function workflowRequest(path, options = {}) {
      if (!context?.centerId || !context.capabilities[CAPABILITIES.daily]) {
        throw new CenterCareUiError('CAPABILITY_UNAVAILABLE', 'ศูนย์นี้ยังไม่ได้เปิดใช้ความสามารถนี้');
      }
      const requestRevision = revision;
      const result = await api(`/api/center/${encodeURIComponent(context.centerId)}${path}`, options);
      return requestRevision === revision ? { stale:false, result } : { stale:true };
    }

    function listDailyWorkflow(status) {
      return workflowRequest(`/daily-care/review?status=${encodeURIComponent(status)}`);
    }

    function finalizeDaily(reportId) {
      if (!['owner','manager'].includes(context?.role)) throw new CenterCareUiError('REVIEW_ROLE_REQUIRED', 'เฉพาะเจ้าของหรือผู้จัดการที่ยืนยันรายงานได้');
      return workflowRequest(`/daily-care/${encodeURIComponent(cleanText(reportId))}/finalize`, { method:'POST', body:'{}' });
    }

    function returnDaily(reportId, reason) {
      if (!['owner','manager'].includes(context?.role)) throw new CenterCareUiError('REVIEW_ROLE_REQUIRED', 'เฉพาะเจ้าของหรือผู้จัดการที่ส่งกลับแก้ไขได้');
      const cleanReason = cleanText(reason);
      if (!cleanReason) throw new CenterCareUiError('RETURN_REASON_REQUIRED', 'กรุณาระบุสิ่งที่ต้องแก้ไข');
      return workflowRequest(`/daily-care/${encodeURIComponent(cleanText(reportId))}/return`, {
        method:'POST', body:JSON.stringify({ reason:cleanReason }),
      });
    }

    function listVitalHistory(residentId='') {
      if(!context?.centerId||!context.capabilities[CAPABILITIES.vital])throw new CenterCareUiError('CAPABILITY_UNAVAILABLE','ศูนย์นี้ยังไม่ได้เปิดใช้ความสามารถนี้');
      const query=residentId?`?residentId=${encodeURIComponent(cleanText(residentId))}`:'';
      return centerRequest(`/vital-signs/history${query}`);
    }

    function voidVital(vitalSetId,reason){
      if(!['owner','manager'].includes(context?.role))throw new CenterCareUiError('REVIEW_ROLE_REQUIRED','เฉพาะเจ้าของหรือผู้จัดการที่ยกเลิกรายการได้');
      const cleanReason=cleanText(reason);if(!cleanReason)throw new CenterCareUiError('VOID_REASON_REQUIRED','กรุณาระบุเหตุผลที่ยกเลิกรายการ');
      return centerRequest(`/vital-signs/${encodeURIComponent(cleanText(vitalSetId))}/void`,{method:'POST',body:JSON.stringify({reason:cleanReason})});
    }

    function createDailyCorrection(reportId,reason){
      if(!['owner','manager'].includes(context?.role))throw new CenterCareUiError('REVIEW_ROLE_REQUIRED','เฉพาะเจ้าของหรือผู้จัดการที่สร้างฉบับแก้ไขได้');
      const cleanReason=cleanText(reason);if(!cleanReason)throw new CenterCareUiError('CORRECTION_REASON_REQUIRED','กรุณาระบุเหตุผลที่สร้างฉบับแก้ไข');
      return workflowRequest(`/daily-care/${encodeURIComponent(cleanText(reportId))}/corrections`,{method:'POST',body:JSON.stringify({reason:cleanReason})});
    }

    function voidDaily(reportId,reason){
      if(!['owner','manager'].includes(context?.role))throw new CenterCareUiError('REVIEW_ROLE_REQUIRED','เฉพาะเจ้าของหรือผู้จัดการที่ยกเลิกรายการได้');
      const cleanReason=cleanText(reason);if(!cleanReason)throw new CenterCareUiError('VOID_REASON_REQUIRED','กรุณาระบุเหตุผลที่ยกเลิกรายการ');
      return workflowRequest(`/daily-care/${encodeURIComponent(cleanText(reportId))}/void`,{method:'POST',body:JSON.stringify({reason:cleanReason})});
    }

    function centerRequest(path,options={}){
      if(!context?.centerId)throw new CenterCareUiError('CENTER_REQUIRED','กรุณาเลือกศูนย์');
      const requestRevision=revision;return api(`/api/center/${encodeURIComponent(context.centerId)}${path}`,options)
        .then((result)=>requestRevision===revision?{stale:false,result}:{stale:true},(error)=>{if(requestRevision!==revision)return{stale:true};throw error;});
    }

    function labRequest(residentId,suffix='',options={}){
      const resident=context?.residents.find((item)=>item.residentId===cleanText(residentId));
      if(!resident?.careProfileId)throw new CenterCareUiError('CARE_PROFILE_REQUIRED','ผู้รับการดูแลยังไม่มี Care Profile');
      const requestRevision=revision;
      const path=`/api/care-profile/${encodeURIComponent(resident.careProfileId)}/lab-reports${suffix}${suffix.includes('?')?'&':'?'}centerId=${encodeURIComponent(context.centerId)}`;
      return api(path,options).then((result)=>requestRevision===revision?{stale:false,result}:{stale:true},(error)=>{if(requestRevision!==revision)return{stale:true};throw error;});
    }

    function listLabHistory(residentId){return labRequest(residentId,'?includeHistory=true&limit=20');}
    function createLabCorrection(residentId,reportId,reason){if(!['owner','manager'].includes(context?.role))throw new CenterCareUiError('REVIEW_ROLE_REQUIRED','เฉพาะเจ้าของหรือผู้จัดการที่สร้างฉบับแก้ไขได้');const cleanReason=cleanText(reason);if(!cleanReason)throw new CenterCareUiError('CORRECTION_REASON_REQUIRED','กรุณาระบุเหตุผลที่สร้างฉบับแก้ไข');return labRequest(residentId,`/${encodeURIComponent(reportId)}/corrections`,{method:'POST',body:JSON.stringify({reason:cleanReason})});}
    function voidLab(residentId,reportId,reason){if(!['owner','manager'].includes(context?.role))throw new CenterCareUiError('REVIEW_ROLE_REQUIRED','เฉพาะเจ้าของหรือผู้จัดการที่ยกเลิกรายการได้');const cleanReason=cleanText(reason);if(!cleanReason)throw new CenterCareUiError('VOID_REASON_REQUIRED','กรุณาระบุเหตุผลที่ยกเลิกรายการ');return labRequest(residentId,`/${encodeURIComponent(reportId)}/void`,{method:'POST',body:JSON.stringify({reason:cleanReason})});}

    return {
      configure, clear:() => configure(null), snapshot,
      submitVital:(values) => submit('vital', values),
      submitDaily:(values) => submit('daily', values),
      listDailyWorkflow, finalizeDaily, returnDaily,
      listVitalHistory,voidVital,createDailyCorrection,voidDaily,listLabHistory,createLabCorrection,voidLab,
    };
  }

  function valuesFromForm(form) {
    return Object.fromEntries(new globalScope.FormData(form).entries());
  }

  function localDateTimeValue(date = new Date()) {
    const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return shifted.toISOString().slice(0, 16);
  }

  function mount({ root, api, notify = () => {}, onVisibility = () => {}, onOpenLabDraft = () => {} } = {}) {
    if (!root) throw new Error('root is required');
    const controller = createController({ api });
    root.innerHTML = `
      <section class="center-care" aria-labelledby="centerCareHeading">
        <div class="center-care__intro">
          <p class="center-care__eyebrow">บันทึก ณ จุดดูแล</p>
          <h2 id="centerCareHeading">บันทึกข้อมูลการดูแล</h2>
          <p>เลือกผู้รับการดูแลและบันทึกข้อมูลตามที่วัดหรือสังเกตได้ ระบบไม่แปลผลทางการแพทย์จากหน้านี้</p>
        </div>
        <p id="centerCareUnavailable" class="center-care__state" role="status" hidden>ศูนย์นี้ยังไม่ได้เปิดใช้การบันทึกข้อมูลการดูแล</p>
        <section id="centerLabHistory" class="center-care__panel center-care__history" aria-labelledby="centerLabHistoryHeading">
          <div class="center-care__review-heading"><div><p class="center-care__eyebrow">ประวัติข้อมูลทางคลินิก</p><h3 id="centerLabHistoryHeading">ผลตรวจ Lab ที่ยืนยันแล้ว</h3></div><button type="button" class="btn btn-outline center-care__refresh" data-refresh-history="lab">รีเฟรช</button></div>
          <label>ผู้รับการดูแล<select id="centerLabResident" class="center-care__resident"></select></label>
          <p class="center-care__hint">การแก้ไขจะสร้างฉบับใหม่ ประวัติเดิมยังคงอยู่</p><div class="center-care__history-list" role="list"></div><p class="center-care__history-status" role="status" aria-live="polite"></p>
        </section>
        <section id="centerVitalHistory" class="center-care__panel center-care__history" aria-labelledby="centerVitalHistoryHeading" hidden>
          <div class="center-care__review-heading"><div><p class="center-care__eyebrow">ประวัติการบันทึก</p><h3 id="centerVitalHistoryHeading">ประวัติสัญญาณชีพล่าสุด</h3></div><button type="button" class="btn btn-outline center-care__refresh" data-refresh-history="vital">รีเฟรช</button></div>
          <p class="center-care__hint">รายการที่ยกเลิกยังอยู่ในประวัติ แต่ไม่แสดงเป็นข้อมูลปัจจุบันของครอบครัว</p><div class="center-care__history-list" role="list"></div><p class="center-care__history-status" role="status" aria-live="polite"></p>
        </section>
        <section id="centerDailyHistory" class="center-care__panel center-care__history" aria-labelledby="centerDailyHistoryHeading" hidden>
          <div class="center-care__review-heading"><div><p class="center-care__eyebrow">ประวัติฉบับยืนยัน</p><h3 id="centerDailyHistoryHeading">รายงานที่ยืนยันแล้ว</h3></div><button type="button" class="btn btn-outline center-care__refresh" data-refresh-history="daily">รีเฟรช</button></div>
          <p class="center-care__hint">สร้างฉบับแก้ไขโดยไม่เขียนทับรายงานเดิม</p><div class="center-care__history-list" role="list"></div><p class="center-care__history-status" role="status" aria-live="polite"></p>
        </section>
        <section id="centerDailyReview" class="center-care__panel center-care__review" aria-labelledby="centerDailyReviewHeading" hidden>
          <div class="center-care__review-heading"><div><p class="center-care__eyebrow">Manager review</p><h3 id="centerDailyReviewHeading">รายงานรอตรวจ</h3></div><button type="button" class="btn btn-outline center-care__refresh">รีเฟรช</button></div>
          <p class="center-care__hint">ตรวจข้อมูลก่อนยืนยัน รายงานที่ยังไม่ยืนยันจะไม่ถูกแจ้งให้ครอบครัว</p>
          <div class="center-care__review-list" role="list"></div>
          <p class="center-care__review-status" role="status" aria-live="polite"></p>
        </section>
        <section id="centerDailyReturned" class="center-care__panel center-care__review" aria-labelledby="centerDailyReturnedHeading" hidden>
          <h3 id="centerDailyReturnedHeading">รายงานที่ส่งกลับแก้ไข</h3>
          <p class="center-care__hint">แก้ไขจากข้อมูลต้นฉบับแล้วส่งให้ผู้จัดการตรวจอีกครั้ง</p>
          <div class="center-care__review-list" role="list"></div>
        </section>
        <form id="centerVitalForm" class="center-care__panel" novalidate>
          <h3>สัญญาณชีพ</h3>
          <p class="center-care__hint">กรอกเฉพาะค่าที่วัดได้จริง อย่างน้อย 1 รายการ</p>
          <label>ผู้รับการดูแล<select name="residentId" class="center-care__resident" required></select></label>
          <label>วันและเวลาที่วัด<input name="occurredAt" type="datetime-local" required></label>
          <div class="center-care__grid">
            <label>อุณหภูมิ (°C)<input name="temperature" type="number" inputmode="decimal" step="0.1"></label>
            <label>ความดันตัวบน (mmHg)<input name="systolic" type="number" inputmode="numeric" step="1"></label>
            <label>ความดันตัวล่าง (mmHg)<input name="diastolic" type="number" inputmode="numeric" step="1"></label>
            <label>ชีพจร (ครั้ง/นาที)<input name="pulse" type="number" inputmode="numeric" step="1"></label>
            <label>ออกซิเจนปลายนิ้ว (%)<input name="spo2" type="number" inputmode="decimal" step="0.1"></label>
            <label>อัตราการหายใจ (ครั้ง/นาที)<input name="respiratoryRate" type="number" inputmode="numeric" step="1"></label>
            <label>น้ำตาลในเลือด (mg/dL)<input name="bloodGlucose" type="number" inputmode="decimal" step="0.1"></label>
            <label>บริบทน้ำตาล<select name="glucoseContext"><option value="unspecified">ไม่ระบุ</option><option value="fasting">อดอาหาร</option><option value="before_meal">ก่อนอาหาร</option><option value="after_meal">หลังอาหาร</option><option value="random">สุ่มเวลา</option></select></label>
            <label>น้ำหนัก (kg)<input name="weight" type="number" inputmode="decimal" step="0.1"></label>
          </div>
          <button class="btn btn-primary center-care__submit" type="submit">บันทึกสัญญาณชีพ</button>
          <p class="center-care__form-status" role="status" aria-live="polite"></p>
        </form>
        <form id="centerDailyForm" class="center-care__panel" novalidate>
          <input name="resubmitReportId" type="hidden">
          <h3>รายงานการดูแลประจำวัน</h3>
          <p class="center-care__hint">บันทึกตามสิ่งที่ดูแลหรือสังเกตได้ โดยไม่สรุปวินิจฉัย</p>
          <label>ผู้รับการดูแล<select name="residentId" class="center-care__resident" required></select></label>
          <label>วันและเวลาที่บันทึก<input name="occurredAt" type="datetime-local" required></label>
          <label>ช่วงเวร<select name="shift"><option value="">ไม่ระบุ</option><option value="day">กลางวัน</option><option value="night">กลางคืน</option><option value="morning">เช้า</option><option value="evening">เย็น</option><option value="other">อื่น ๆ</option></select></label>
          <fieldset class="center-care__vitals" data-daily-vitals>
            <legend>สัญญาณชีพที่วัดพร้อมรายงาน (ถ้ามี)</legend>
            <div class="center-care__grid">
              <label>อุณหภูมิ (°C)<input name="dailyTemperature" type="number" inputmode="decimal" step="0.1"></label>
              <label>ความดันตัวบน (mmHg)<input name="dailySystolic" type="number" inputmode="numeric" step="1"></label>
              <label>ความดันตัวล่าง (mmHg)<input name="dailyDiastolic" type="number" inputmode="numeric" step="1"></label>
              <label>ชีพจร (ครั้ง/นาที)<input name="dailyPulse" type="number" inputmode="numeric" step="1"></label>
              <label>ออกซิเจนปลายนิ้ว (%)<input name="dailySpo2" type="number" inputmode="decimal" step="0.1"></label>
              <label>อัตราการหายใจ (ครั้ง/นาที)<input name="dailyRespiratoryRate" type="number" inputmode="numeric" step="1"></label>
              <label>น้ำตาลในเลือด (mg/dL)<input name="dailyBloodGlucose" type="number" inputmode="decimal" step="0.1"></label>
              <label>บริบทน้ำตาล<select name="dailyGlucoseContext"><option value="unspecified">ไม่ระบุ</option><option value="fasting">อดอาหาร</option><option value="before_meal">ก่อนอาหาร</option><option value="after_meal">หลังอาหาร</option><option value="random">สุ่มเวลา</option></select></label>
              <label>น้ำหนัก (kg)<input name="dailyWeight" type="number" inputmode="decimal" step="0.1"></label>
            </div>
          </fieldset>
          <label>อาหาร<textarea name="nutrition" maxlength="1000" placeholder="เช่น รับประทานอาหารได้ครึ่งจาน"></textarea></label>
          <label>น้ำดื่ม (มล.)<input name="fluid" type="number" inputmode="decimal" step="1"></label>
          <label>การนอน<textarea name="sleep" maxlength="1000"></textarea></label>
          <label>การขับถ่าย (ครั้ง)<input name="bowelCount" type="number" inputmode="numeric" min="0" step="1"></label>
          <label>การปัสสาวะ<textarea name="urination" maxlength="1000"></textarea></label>
          <label>กิจกรรม<textarea name="activity" maxlength="1000"></textarea></label>
          <label>อารมณ์<textarea name="mood" maxlength="1000"></textarea></label>
          <label>สภาพทั่วไป<textarea name="generalCondition" maxlength="1000"></textarea></label>
          <label>อาการที่สังเกต<textarea name="symptomNote" maxlength="1000"></textarea></label>
          <button class="btn btn-primary center-care__submit" type="submit">บันทึกรายงานประจำวัน</button>
          <p class="center-care__form-status" role="status" aria-live="polite"></p>
        </form>
      </section>`;

    const vitalForm = root.querySelector('#centerVitalForm');
    const dailyForm = root.querySelector('#centerDailyForm');
    const unavailable = root.querySelector('#centerCareUnavailable');
    const reviewSection = root.querySelector('#centerDailyReview');
    const returnedSection = root.querySelector('#centerDailyReturned');
    const labHistorySection=root.querySelector('#centerLabHistory');
    const vitalHistorySection=root.querySelector('#centerVitalHistory');
    const dailyHistorySection=root.querySelector('#centerDailyHistory');
    const actionDialog=globalScope.PhimorClinicalActionDialog?.createDialog({doc:globalScope.document});
    let reviewItems = [];
    let returnedItems = [];
    let labHistoryItems=[];let vitalHistoryItems=[];let dailyHistoryItems=[];

    function escapeHtml(value) {
      return String(value ?? '').replace(/[&<>"']/g, (character) => ({
        '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
      })[character]);
    }

    const itemLabels = Object.freeze({
      shift:'ช่วงเวร', nutrition:'อาหาร', fluid_intake:'น้ำดื่ม', sleep_rest:'การนอน',
      bowel_movement:'การขับถ่าย', urination:'การปัสสาวะ', activity:'กิจกรรม',
      mood_behavior:'อารมณ์', general_condition:'สภาพทั่วไป', symptom_note:'อาการที่สังเกต',
    });
    const vitalLabels = Object.freeze({
      temperature:'อุณหภูมิ', blood_pressure_systolic:'ความดันตัวบน',
      blood_pressure_diastolic:'ความดันตัวล่าง', pulse:'ชีพจร', spo2:'SpO₂',
      respiratory_rate:'อัตราการหายใจ', blood_glucose:'น้ำตาลในเลือด', weight:'น้ำหนัก',
    });

    function factualValue(item) {
      const value = item.sourceValueText ?? item.textValue ?? item.numericValue
        ?? (typeof item.booleanValue === 'boolean' ? (item.booleanValue ? 'มี' : 'ไม่มี') : null);
      return value === null || value === undefined || value === '' ? 'ไม่ระบุ'
        : `${value}${item.sourceUnit ? ` ${item.sourceUnit}` : ''}`;
    }

    function versionStatus(item){if(item.status==='voided')return'ยกเลิกแล้ว';if(item.status==='changes_requested')return'ส่งกลับแก้ไข';if(item.status==='submitted'||item.status==='draft')return'รอตรวจ';return item.isCurrent===false?'ฉบับก่อนหน้า':'ฉบับปัจจุบัน';}
    function mutationButtons(item,kind,residentId=''){
      const caps=item.mutationCapabilities||{};if(!caps.canCreateCorrection&&!caps.canVoid)return'';
      return `<div class="center-care__review-actions">${caps.canCreateCorrection?`<button type="button" class="btn btn-outline" data-clinical-action="correct-${kind}" data-resident-id="${escapeHtml(residentId)}" data-record-id="${escapeHtml(item.reportId||item.dailyReportId||'')}">สร้างฉบับแก้ไข</button>`:''}${caps.canVoid?`<button type="button" class="btn center-care__void" data-clinical-action="void-${kind}" data-resident-id="${escapeHtml(residentId)}" data-record-id="${escapeHtml(item.reportId||item.dailyReportId||item.vitalSetId||'')}">ยกเลิกรายการ</button>`:''}</div>`;
    }

    function renderLabHistory(){const list=labHistorySection.querySelector('.center-care__history-list');const residentId=root.querySelector('#centerLabResident').value;
      list.innerHTML=labHistoryItems.length?labHistoryItems.map((report)=>`<article class="center-care__review-card" role="listitem"><div class="center-care__review-title"><strong>${escapeHtml(report.hospitalName||report.laboratoryName||'ผลตรวจ Lab')}</strong><span class="center-care__status">${escapeHtml(versionStatus(report))}</span></div><p>${escapeHtml(report.specimenCollectedAt?new Date(report.specimenCollectedAt).toLocaleString('th-TH'):'ไม่ระบุวันที่')}</p>${mutationButtons(report,'lab',residentId)}</article>`).join(''):'<p class="center-care__empty">ยังไม่มีผลตรวจที่ยืนยันแล้ว</p>';}
    function renderVitalHistory(){const list=vitalHistorySection.querySelector('.center-care__history-list');list.innerHTML=vitalHistoryItems.length?vitalHistoryItems.map((set)=>{const values=(set.observations||[]).map((observation)=>`<li><strong>${escapeHtml(vitalLabels[observation.measurementType]||'ค่าที่บันทึก')}:</strong> ${escapeHtml(`${observation.sourceValueText??observation.numericValue}${observation.sourceUnit?` ${observation.sourceUnit}`:''}`)}</li>`).join('');return`<article class="center-care__review-card" role="listitem"><div class="center-care__review-title"><strong>${escapeHtml(set.careRecipientName||'ผู้รับการดูแล')}</strong><span class="center-care__status">${set.status==='voided'?'ยกเลิกแล้ว':'ฉบับปัจจุบัน'}</span></div><p>${escapeHtml(new Date(set.occurredAt).toLocaleString('th-TH'))}${set.sourceType==='external_integration'?' · ข้อมูลจากระบบศูนย์':''}</p><ul>${values}</ul>${mutationButtons(set,'vital')}</article>`;}).join(''):'<p class="center-care__empty">ยังไม่มีสัญญาณชีพ</p>';}
    function renderDailyHistory(){const list=dailyHistorySection.querySelector('.center-care__history-list');list.innerHTML=dailyHistoryItems.length?dailyHistoryItems.map((report)=>{const shift=report.shift?.sourceLabel||SHIFT_LABELS[report.shift?.code]||report.shift?.code||'ไม่ระบุเวร';return`<article class="center-care__review-card" role="listitem"><div class="center-care__review-title"><strong>${escapeHtml(report.careRecipientName||'ผู้รับการดูแล')}</strong><span class="center-care__status">${escapeHtml(versionStatus(report))}</span></div><p>${escapeHtml(shift)} • ${escapeHtml(report.careDate||'ไม่ระบุวันที่')}${report.sourceType==='external_integration'?' · ข้อมูลจากระบบศูนย์':''}</p>${mutationButtons(report,'daily')}</article>`;}).join(''):'<p class="center-care__empty">ยังไม่มีรายงานที่ยืนยันแล้ว</p>';}

    async function refreshLabHistory(){const residentId=root.querySelector('#centerLabResident').value;const status=labHistorySection.querySelector('.center-care__history-status');labHistoryItems=[];if(!residentId){renderLabHistory();return;}status.textContent='กำลังโหลดผลตรวจ...';try{const response=await controller.listLabHistory(residentId);if(response.stale)return;labHistoryItems=response.result?.items||[];renderLabHistory();status.textContent='';}catch(error){status.textContent=error?.message||'โหลดผลตรวจไม่สำเร็จ กรุณาลองใหม่';}}
    async function refreshVitalHistory(){const status=vitalHistorySection.querySelector('.center-care__history-status');status.textContent='กำลังโหลดประวัติ...';try{const response=await controller.listVitalHistory();if(response.stale)return;vitalHistoryItems=response.result?.items||[];renderVitalHistory();status.textContent='';}catch(error){status.textContent=error?.message||'โหลดประวัติไม่สำเร็จ กรุณาลองใหม่';}}
    async function refreshDailyHistory(){const status=dailyHistorySection.querySelector('.center-care__history-status');status.textContent='กำลังโหลดรายงาน...';try{const [finalized,voided]=await Promise.all([controller.listDailyWorkflow('finalized'),controller.listDailyWorkflow('voided')]);if(finalized.stale||voided.stale)return;dailyHistoryItems=[...(finalized.result?.items||[]),...(voided.result?.items||[])].sort((a,b)=>String(b.finalizedAt||b.occurredAt).localeCompare(String(a.finalizedAt||a.occurredAt)));renderDailyHistory();status.textContent='';}catch(error){status.textContent=error?.message||'โหลดรายงานไม่สำเร็จ กรุณาลองใหม่';}}

    function renderWorkflowCard(report, mode) {
      const date = report.careDate || (report.occurredAt ? new Date(report.occurredAt).toLocaleDateString('th-TH') : 'ไม่ระบุวันที่');
      const shift = report.shift?.sourceLabel || report.shift?.code || 'ไม่ระบุเวร';
      const items = (report.items || []).map((item) => `<li><strong>${escapeHtml(itemLabels[item.itemType] || item.itemType)}:</strong> ${escapeHtml(factualValue(item))}</li>`).join('');
      const vitalRows = (report.vitalSigns || []).flatMap((set) => set.observations || [])
        .map((observation) => `<li><strong>${escapeHtml(vitalLabels[observation.measurementType] || observation.measurementType)}:</strong> ${escapeHtml(`${observation.sourceValueText ?? observation.numericValue}${observation.sourceUnit ? ` ${observation.sourceUnit}` : ''}`)}</li>`).join('');
      const managerActions = mode === 'review' ? `<div class="center-care__review-actions">
        <button type="button" class="btn btn-outline" data-care-action="return" data-report-id="${escapeHtml(report.dailyReportId)}">ส่งกลับแก้ไข</button>
        <button type="button" class="btn btn-primary" data-care-action="finalize" data-report-id="${escapeHtml(report.dailyReportId)}">ยืนยันและส่งครอบครัว</button>
      </div>` : `<button type="button" class="btn btn-outline" data-care-action="edit-returned" data-report-id="${escapeHtml(report.dailyReportId)}">แก้ไขและส่งตรวจใหม่</button>`;
      return `<article class="center-care__review-card" role="listitem">
        <div class="center-care__review-title"><strong>${escapeHtml(report.careRecipientName || 'ผู้รับการดูแล')}</strong>${report.room ? `<span>ห้อง ${escapeHtml(report.room)}</span>` : ''}</div>
        <p>${escapeHtml(shift)} • ${escapeHtml(date)}</p>
        ${report.recorderDisplayName ? `<p>ผู้บันทึก: ${escapeHtml(report.recorderDisplayName)}</p>` : ''}
        ${mode === 'returned' && report.returnReason ? `<p class="center-care__return-reason">สิ่งที่ต้องแก้ไข: ${escapeHtml(report.returnReason)}</p>` : ''}
        ${vitalRows ? `<h4>สัญญาณชีพ</h4><ul>${vitalRows}</ul>` : ''}
        ${items ? `<h4>การดูแลประจำวัน</h4><ul>${items}</ul>` : ''}
        ${managerActions}
      </article>`;
    }

    function renderWorkflow(section, items, mode) {
      const list = section.querySelector('.center-care__review-list');
      list.innerHTML = items.length ? items.map((item) => renderWorkflowCard(item, mode)).join('')
        : '<p class="center-care__empty">ยังไม่มีรายการ</p>';
    }

    async function refreshWorkflow() {
      const state = controller.snapshot();
      reviewItems = []; returnedItems = [];
      if (!state?.capabilities?.[CAPABILITIES.daily]) {
        reviewSection.hidden = true; returnedSection.hidden = true; return;
      }
      reviewSection.hidden = !['owner','manager'].includes(state.role);
      returnedSection.hidden = false;
      const status = reviewSection.querySelector('.center-care__review-status');
      status.textContent = reviewSection.hidden ? '' : 'กำลังโหลดรายงานรอตรวจ...';
      const [reviewResponse, returnedResponse] = await Promise.all([
        reviewSection.hidden ? Promise.resolve(null) : controller.listDailyWorkflow('submitted'),
        controller.listDailyWorkflow('changes_requested'),
      ]);
      if (reviewResponse?.stale || returnedResponse?.stale) return;
      reviewItems = reviewResponse?.result?.items || [];
      returnedItems = returnedResponse?.result?.items || [];
      if (!reviewSection.hidden) renderWorkflow(reviewSection, reviewItems, 'review');
      renderWorkflow(returnedSection, returnedItems, 'returned');
      returnedSection.hidden = returnedItems.length === 0;
      status.textContent = '';
    }

    function populateReturned(report) {
      dailyForm.reset();
      dailyForm.elements.resubmitReportId.value = report.dailyReportId;
      dailyForm.elements.residentId.value = report.residentId || '';
      dailyForm.elements.occurredAt.value = report.occurredAt ? localDateTimeValue(new Date(report.occurredAt)) : localDateTimeValue();
      dailyForm.elements.shift.value = report.shift?.code || '';
      const fieldByType = {nutrition:'nutrition',fluid_intake:'fluid',sleep_rest:'sleep',bowel_movement:'bowelCount',
        urination:'urination',activity:'activity',mood_behavior:'mood',general_condition:'generalCondition',symptom_note:'symptomNote'};
      for (const item of report.items || []) {
        const field = fieldByType[item.itemType]; if (field && dailyForm.elements[field]) dailyForm.elements[field].value = item.textValue ?? item.numericValue ?? '';
      }
      const vitalField = {temperature:'dailyTemperature',blood_pressure_systolic:'dailySystolic',blood_pressure_diastolic:'dailyDiastolic',
        pulse:'dailyPulse',spo2:'dailySpo2',respiratory_rate:'dailyRespiratoryRate',blood_glucose:'dailyBloodGlucose',weight:'dailyWeight'};
      for (const observation of (report.vitalSigns || []).flatMap((set) => set.observations || [])) {
        const field = vitalField[observation.measurementType]; if (field) dailyForm.elements[field].value = observation.sourceValueText ?? observation.numericValue ?? '';
        if (observation.measurementType === 'blood_glucose') dailyForm.elements.dailyGlucoseContext.value = observation.context || 'unspecified';
      }
      dailyForm.querySelector('.center-care__submit').textContent = 'แก้ไขและส่งตรวจอีกครั้ง';
      dailyForm.scrollIntoView({ behavior:'smooth', block:'start' });
    }

    function resetForms() {
      for (const form of [vitalForm, dailyForm]) {
        form.reset();
        form.querySelector('[name="occurredAt"]').value = localDateTimeValue();
        form.querySelector('.center-care__form-status').textContent = '';
        form.querySelector('.center-care__submit').disabled = false;
      }
      dailyForm.querySelector('.center-care__submit').textContent = 'ส่งรายงานให้ผู้จัดการตรวจ';
    }

    async function runClinicalAction(button){
      if(!actionDialog)return;
      const action=button.dataset.clinicalAction;const recordId=button.dataset.recordId;const residentId=button.dataset.residentId||'';
      const correction=action.startsWith('correct-');const kind=action.split('-').at(-1);
      return actionDialog.open({title:correction?'สร้างฉบับแก้ไข':kind==='lab'?'ยกเลิกผลตรวจรายการนี้?':kind==='vital'?'ยกเลิกสัญญาณชีพรายการนี้?':'ยกเลิกรายงานการดูแลรายการนี้?',
        explanation:correction?'ระบบจะสร้างฉบับใหม่ให้ตรวจ โดยเก็บฉบับเดิมไว้ในประวัติ':'รายการจะไม่ถูกใช้เป็นข้อมูลปัจจุบันอีกต่อไป แต่ประวัติเดิมจะยังถูกเก็บไว้',
        confirmLabel:correction?'สร้างฉบับแก้ไข':'ยืนยันยกเลิกรายการ',danger:!correction,
        reasonRequired:correction?'กรุณาระบุเหตุผลที่สร้างฉบับแก้ไข':'กรุณาระบุเหตุผลที่ยกเลิกรายการ',
        onConfirm:async(reason)=>{
          let response;
          if(kind==='lab')response=correction?await controller.createLabCorrection(residentId,recordId,reason):await controller.voidLab(residentId,recordId,reason);
          else if(kind==='vital')response=await controller.voidVital(recordId,reason);
          else response=correction?await controller.createDailyCorrection(recordId,reason):await controller.voidDaily(recordId,reason);
          if(response.stale)return response;
          if(kind==='lab'){await refreshLabHistory();if(correction)onOpenLabDraft({residentId,report:response.result});}
          if(kind==='vital'){await refreshVitalHistory();const status=vitalHistorySection.querySelector('.center-care__history-status');status.textContent='ยกเลิกรายการแล้ว ';const recordNew=globalScope.document.createElement('button');recordNew.type='button';recordNew.className='btn btn-outline center-care__record-new';recordNew.textContent='บันทึกค่าใหม่';recordNew.addEventListener('click',()=>{vitalForm.reset();vitalForm.elements.occurredAt.value=localDateTimeValue();vitalForm.scrollIntoView({behavior:'smooth',block:'start'});});status.appendChild(recordNew);}
          if(kind==='daily'){await Promise.all([refreshWorkflow(),refreshDailyHistory()]);if(correction)notify('สร้างฉบับรอตรวจแล้ว ผู้จัดการสามารถตรวจ ส่งกลับแก้ไข หรือยืนยันฉบับใหม่ได้');}
          if(!correction)notify('ยกเลิกรายการแล้ว ประวัติเดิมยังถูกเก็บไว้');return response;
        }});
    }

    function renderResidents(residents) {
      root.querySelectorAll('.center-care__resident').forEach((select) => {
        select.replaceChildren();
        const prompt = globalScope.document.createElement('option');
        prompt.value = ''; prompt.textContent = residents.length ? 'เลือกผู้รับการดูแล' : 'ยังไม่มีผู้รับการดูแล';
        select.appendChild(prompt);
        for (const resident of residents) {
          const option = globalScope.document.createElement('option');
          option.value = resident.residentId;
          option.textContent = `${resident.name}${resident.room ? ` · ห้อง ${resident.room}` : ''}`;
          select.appendChild(option);
        }
        select.disabled = !residents.length;
      });
    }

    function setContext(next) {
      const state = controller.configure(next);
      resetForms();
      renderResidents(state?.residents || []);
      const vitalEnabled = state?.capabilities?.[CAPABILITIES.vital] === true;
      const dailyEnabled = state?.capabilities?.[CAPABILITIES.daily] === true;
      vitalForm.hidden = !vitalEnabled;
      dailyForm.hidden = !dailyEnabled;
      labHistorySection.hidden=!(state?.residents||[]).some((resident)=>resident.careProfileId);
      vitalHistorySection.hidden=!vitalEnabled;dailyHistorySection.hidden=!dailyEnabled;
      dailyForm.querySelector('[data-daily-vitals]').hidden = !vitalEnabled;
      unavailable.hidden = vitalEnabled || dailyEnabled;
      onVisibility(vitalEnabled || dailyEnabled || !labHistorySection.hidden);
      Promise.all([refreshWorkflow(),labHistorySection.hidden?null:refreshLabHistory(),vitalEnabled?refreshVitalHistory():null,dailyEnabled?refreshDailyHistory():null]).catch(() => {
        reviewSection.querySelector('.center-care__review-status').textContent = 'โหลดรายงานรอตรวจไม่สำเร็จ กรุณาลองใหม่';
      });
    }

    function clear() {
      controller.clear();
      resetForms(); renderResidents([]);
      vitalForm.hidden = true; dailyForm.hidden = true; unavailable.hidden = false;
      reviewItems = []; returnedItems = []; reviewSection.hidden = true; returnedSection.hidden = true;
      labHistoryItems=[];vitalHistoryItems=[];dailyHistoryItems=[];labHistorySection.hidden=true;vitalHistorySection.hidden=true;dailyHistorySection.hidden=true;
      onVisibility(false);
    }

    async function submit(form, operation, successMessage) {
      const button = form.querySelector('.center-care__submit');
      const status = form.querySelector('.center-care__form-status');
      button.disabled = true; status.textContent = 'กำลังบันทึก...';
      try {
        const response = await operation(valuesFromForm(form));
        if (response.stale) return;
        form.querySelectorAll('input:not([name="occurredAt"]), textarea').forEach((field) => { field.value = ''; });
        status.textContent = successMessage; notify(successMessage);
        if(form===dailyForm)await Promise.all([refreshWorkflow(),refreshDailyHistory()]);
        if(form===vitalForm)await refreshVitalHistory();
      } catch (error) {
        status.textContent = error?.message || 'บันทึกไม่สำเร็จ กรุณาลองใหม่';
      } finally {
        button.disabled = false;
      }
    }

    vitalForm.addEventListener('submit', (event) => { event.preventDefault(); submit(vitalForm, controller.submitVital, 'บันทึกสัญญาณชีพแล้ว'); });
    dailyForm.addEventListener('submit', (event) => {
      event.preventDefault();
      const resubmitting = Boolean(dailyForm.elements.resubmitReportId.value);
      submit(dailyForm, controller.submitDaily, resubmitting
        ? 'แก้ไขและส่งรายงานให้ผู้จัดการตรวจอีกครั้งแล้ว'
        : 'ส่งรายงานให้ผู้จัดการตรวจแล้ว ยังไม่มีการแจ้งครอบครัว');
    });
    reviewSection.querySelector('.center-care__refresh').addEventListener('click', () => refreshWorkflow().catch(() => {
      reviewSection.querySelector('.center-care__review-status').textContent = 'รีเฟรชไม่สำเร็จ กรุณาลองใหม่';
    }));
    reviewSection.addEventListener('click', async (event) => {
      const button = event.target.closest('[data-care-action]'); if (!button) return;
      const reportId = button.dataset.reportId; button.disabled = true;
      try {
        if (button.dataset.careAction === 'finalize') {
          if (!globalScope.confirm('ยืนยันรายงานนี้และนำเข้าคิวแจ้งครอบครัวใช่หรือไม่')) return;
          const response = await controller.finalizeDaily(reportId); if (response.stale) return;
          notify(finalizationNotice(response.result));
        } else {
          const reason = globalScope.prompt('ระบุสิ่งที่ต้องแก้ไข'); if (!reason) return;
          const response = await controller.returnDaily(reportId, reason); if (response.stale) return;
          notify('ส่งรายงานกลับให้แก้ไขแล้ว ยังไม่มีการแจ้งครอบครัว');
        }
        await Promise.all([refreshWorkflow(),refreshDailyHistory()]);
      } catch (error) { notify(error?.message || 'ดำเนินการไม่สำเร็จ'); }
      finally { button.disabled = false; }
    });
    returnedSection.addEventListener('click', (event) => {
      const button = event.target.closest('[data-care-action="edit-returned"]'); if (!button) return;
      const report = returnedItems.find((item) => item.dailyReportId === button.dataset.reportId);
      if (report) populateReturned(report);
    });
    root.addEventListener('click',(event)=>{const button=event.target.closest?.('[data-clinical-action]');if(button)runClinicalAction(button);});
    root.querySelectorAll('[data-refresh-history]').forEach((button)=>button.addEventListener('click',()=>{
      const kind=button.dataset.refreshHistory;if(kind==='lab')refreshLabHistory();else if(kind==='vital')refreshVitalHistory();else refreshDailyHistory();
    }));
    root.querySelector('#centerLabResident').addEventListener('change',refreshLabHistory);
    clear();
    return { setContext, clear, snapshot:controller.snapshot };
  }

  const api = { CAPABILITIES, CenterCareUiError, buildVitalObservations, buildShift,
    buildDailyItems, buildOptionalDailyVitals, finalizationNotice, occurredAtIso, createController, mount };
  globalScope.PhimorCenterCareUI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
