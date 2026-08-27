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
  ]);
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
    };
    const observations = [];
    for (const [field, measurementType, sourceUnit] of VITAL_FIELDS) {
      const numericValue = parseNumber(values[field], labels[field]);
      if (numericValue === null) continue;
      observations.push({ measurementType, numericValue, sourceUnit, sourceValueText:cleanText(values[field]) });
    }
    if (!observations.length) throw new CenterCareUiError('VITAL_REQUIRED', 'กรุณากรอกสัญญาณชีพอย่างน้อย 1 รายการ');
    return observations;
  }

  function buildDailyItems(values = {}) {
    const items = [];
    const shift = cleanText(values.shift);
    if (shift) items.push({ itemType:'shift', valueType:'text', textValue:shift, sourceValueText:shift });
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

  function buildOptionalDailyVitals(values = {}) {
    const mapped = {
      temperature:values.dailyTemperature, systolic:values.dailySystolic,
      diastolic:values.dailyDiastolic, pulse:values.dailyPulse,
      spo2:values.dailySpo2, respiratoryRate:values.dailyRespiratoryRate,
    };
    if (!Object.values(mapped).some((value) => cleanText(value))) return null;
    return { occurredAt:occurredAtIso(values.occurredAt), observations:buildVitalObservations(mapped) };
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
        .map((resident) => ({ residentId:String(resident.resident_id), name:String(resident.full_name || 'ผู้รับการดูแล'), room:resident.room ? String(resident.room) : null })) : [];
      context = {
        centerId:cleanText(next.centerId), residents,
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
        : { occurredAt:occurredAtIso(values.occurredAt), items:buildDailyItems(values) };
      if (kind === 'daily') {
        const vitalSigns = buildOptionalDailyVitals(values);
        if (vitalSigns && !context.capabilities[CAPABILITIES.vital]) throw new CenterCareUiError('CAPABILITY_UNAVAILABLE', 'ศูนย์นี้ยังไม่ได้เปิดใช้การบันทึกสัญญาณชีพ');
        if (vitalSigns) body.vitalSigns = vitalSigns;
      }
      sending = true;
      try {
        const path = kind === 'vital'
          ? `/api/center/${encodeURIComponent(centerId)}/residents/${encodeURIComponent(residentId)}/vital-signs`
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

    return {
      configure, clear:() => configure(null), snapshot,
      submitVital:(values) => submit('vital', values),
      submitDaily:(values) => submit('daily', values),
    };
  }

  function valuesFromForm(form) {
    return Object.fromEntries(new globalScope.FormData(form).entries());
  }

  function localDateTimeValue(date = new Date()) {
    const shifted = new Date(date.getTime() - date.getTimezoneOffset() * 60000);
    return shifted.toISOString().slice(0, 16);
  }

  function mount({ root, api, notify = () => {}, onVisibility = () => {} } = {}) {
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
          </div>
          <button class="btn btn-primary center-care__submit" type="submit">บันทึกสัญญาณชีพ</button>
          <p class="center-care__form-status" role="status" aria-live="polite"></p>
        </form>
        <form id="centerDailyForm" class="center-care__panel" novalidate>
          <h3>รายงานการดูแลประจำวัน</h3>
          <p class="center-care__hint">บันทึกตามสิ่งที่ดูแลหรือสังเกตได้ โดยไม่สรุปวินิจฉัย</p>
          <label>ผู้รับการดูแล<select name="residentId" class="center-care__resident" required></select></label>
          <label>วันและเวลาที่บันทึก<input name="occurredAt" type="datetime-local" required></label>
          <label>ช่วงเวร<select name="shift"><option value="">ไม่ระบุ</option><option value="เช้า">เช้า</option><option value="บ่าย">บ่าย</option><option value="ดึก">ดึก</option></select></label>
          <fieldset class="center-care__vitals" data-daily-vitals>
            <legend>สัญญาณชีพที่วัดพร้อมรายงาน (ถ้ามี)</legend>
            <div class="center-care__grid">
              <label>อุณหภูมิ (°C)<input name="dailyTemperature" type="number" inputmode="decimal" step="0.1"></label>
              <label>ความดันตัวบน (mmHg)<input name="dailySystolic" type="number" inputmode="numeric" step="1"></label>
              <label>ความดันตัวล่าง (mmHg)<input name="dailyDiastolic" type="number" inputmode="numeric" step="1"></label>
              <label>ชีพจร (ครั้ง/นาที)<input name="dailyPulse" type="number" inputmode="numeric" step="1"></label>
              <label>ออกซิเจนปลายนิ้ว (%)<input name="dailySpo2" type="number" inputmode="decimal" step="0.1"></label>
              <label>อัตราการหายใจ (ครั้ง/นาที)<input name="dailyRespiratoryRate" type="number" inputmode="numeric" step="1"></label>
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

    function resetForms() {
      for (const form of [vitalForm, dailyForm]) {
        form.reset();
        form.querySelector('[name="occurredAt"]').value = localDateTimeValue();
        form.querySelector('.center-care__form-status').textContent = '';
        form.querySelector('.center-care__submit').disabled = false;
      }
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
      dailyForm.querySelector('[data-daily-vitals]').hidden = !vitalEnabled;
      unavailable.hidden = vitalEnabled || dailyEnabled;
      onVisibility(vitalEnabled || dailyEnabled);
    }

    function clear() {
      controller.clear();
      resetForms(); renderResidents([]);
      vitalForm.hidden = true; dailyForm.hidden = true; unavailable.hidden = false;
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
      } catch (error) {
        status.textContent = error?.message || 'บันทึกไม่สำเร็จ กรุณาลองใหม่';
      } finally {
        button.disabled = false;
      }
    }

    vitalForm.addEventListener('submit', (event) => { event.preventDefault(); submit(vitalForm, controller.submitVital, 'บันทึกสัญญาณชีพแล้ว'); });
    dailyForm.addEventListener('submit', (event) => { event.preventDefault(); submit(dailyForm, controller.submitDaily, 'บันทึกรายงานประจำวันแล้ว'); });
    clear();
    return { setContext, clear, snapshot:controller.snapshot };
  }

  const api = { CAPABILITIES, CenterCareUiError, buildVitalObservations, buildDailyItems, buildOptionalDailyVitals, occurredAtIso, createController, mount };
  globalScope.PhimorCenterCareUI = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
