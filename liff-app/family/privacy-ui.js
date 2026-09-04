(function initFamilyPrivacyUI(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhimorFamilyPrivacyUI = api;
}(typeof window !== 'undefined' ? window : globalThis, function familyPrivacyFactory() {
  const TYPE_LABELS = Object.freeze({
    export:'ขอสำเนาข้อมูล', correct:'ขอแก้ไขข้อมูล', restrict:'ขอจำกัดการใช้ข้อมูล', delete:'ขอลบข้อมูล',
  });
  const TYPE_HELP = Object.freeze({
    export:'ขอให้ทีมงานตรวจสอบและจัดเตรียมสำเนาข้อมูลที่เกี่ยวข้องกับบัญชีของคุณ',
    correct:'แจ้งข้อมูลที่อาจต้องแก้ไข ทีมงานจะตรวจสอบตัวตนและขอบเขตก่อนดำเนินการ',
    restrict:'ขอให้ทีมงานตรวจสอบการจำกัดการใช้ข้อมูลบางส่วนตามขอบเขตที่ได้รับอนุมัติ',
    delete:'ขอให้ทีมงานตรวจสอบการลบข้อมูล ข้อมูลบางส่วนอาจต้องคงไว้ตามวัตถุประสงค์ที่จำเป็นหรือข้อกำหนดที่เกี่ยวข้อง',
  });
  const STATUS_LABELS = Object.freeze({
    pending:['รับคำขอแล้ว','ทีมงานจะตรวจสอบตัวตนและขอบเขตคำขอ'],
    in_progress:['กำลังตรวจสอบ','คำขอกำลังอยู่ในขั้นตอนดำเนินงานแบบควบคุม'],
    completed:['ดำเนินการตามขั้นตอนแล้ว','สถานะนี้ไม่หมายความว่าข้อมูลทุกประเภทถูกลบโดยอัตโนมัติ'],
    rejected:['ไม่สามารถดำเนินการได้','โปรดดูข้อความที่ทีมงานแจ้ง หรือส่งคำขอใหม่เมื่อมีข้อมูลเพิ่มเติม'],
  });
  const safeArray = (value) => Array.isArray(value) ? value.slice(0, 100) : [];
  const safeError = (error) => ({ status:Number(error?.status) || 0, code:String(error?.errorCode || error?.code || 'PRIVACY_REQUEST_FAILED').slice(0, 80) });
  const formatDate = (value) => {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime())
      ? date.toLocaleString('th-TH', { dateStyle:'medium', timeStyle:'short', timeZone:'Asia/Bangkok' }) : 'ยังไม่มีข้อมูล';
  };

  function createSession({ request, onChange = () => {} } = {}) {
    if (typeof request !== 'function') throw new TypeError('request is required');
    let generation = 0;
    const state = { contextId:null, consent:null, requests:[], loading:false, error:null, submitting:false, lastResult:null };
    const snapshot = () => ({ ...state, requests:[...state.requests] });
    const emit = () => onChange(snapshot());
    function setContext(contextId) {
      const normalized = typeof contextId === 'string' ? contextId : null;
      if (state.contextId === normalized) return;
      generation += 1;
      Object.assign(state, { contextId:normalized, consent:null, requests:[], loading:false, error:null, submitting:false, lastResult:null }); emit();
    }
    async function open() {
      const token = ++generation; state.loading = true; state.error = null; emit();
      try {
        const [consent, requestList] = await Promise.all([request('/api/consent/check'), request('/api/data-requests')]);
        if (token !== generation) return { ignored:true, stale:true };
        state.consent = { hasConsent:consent?.hasConsent === true, status:consent?.status || 'not_given', version:consent?.version || null, updatedAt:consent?.updatedAt || null };
        state.requests = safeArray(requestList?.requests); state.loading = false; emit(); return snapshot();
      } catch (error) {
        if (token === generation) { state.loading = false; state.error = safeError(error); emit(); }
        return { status:'unavailable' };
      }
    }
    async function withdraw() {
      if (state.submitting) return { ignored:true };
      const token = generation; state.submitting = true; state.error = null; emit();
      try {
        const result = await request('/api/consent/withdraw', { method:'POST', body:JSON.stringify({ confirmed:true }) });
        if (token !== generation) return { ignored:true, stale:true };
        state.consent = result?.consent || { hasConsent:false, status:'withdrawn' }; state.lastResult = 'consent_withdrawn'; return result;
      } catch (error) { if (token === generation) state.error = safeError(error); return { status:'unavailable' }; }
      finally { if (token === generation) { state.submitting = false; emit(); } }
    }
    async function grant() {
      if (state.submitting) return { ignored:true };
      const token = generation; state.submitting = true; state.error = null; emit();
      try {
        const result = await request('/api/consent', { method:'POST', body:JSON.stringify({ accepted:true }) });
        if (token !== generation) return { ignored:true, stale:true };
        state.consent = result; state.lastResult = 'consent_granted'; return result;
      } catch (error) { if (token === generation) state.error = safeError(error); return { status:'unavailable' }; }
      finally { if (token === generation) { state.submitting = false; emit(); } }
    }
    async function submit({ type, note }) {
      if (state.submitting) return { ignored:true };
      const token = generation; state.submitting = true; state.error = null; emit();
      try {
        const result = await request('/api/data-requests', { method:'POST', body:JSON.stringify({ type, note }) });
        if (token !== generation) return { ignored:true, stale:true };
        state.lastResult = result?.duplicate ? 'duplicate_request' : 'request_created';
        const list = await request('/api/data-requests');
        if (token !== generation) return { ignored:true, stale:true };
        state.requests = safeArray(list?.requests); return result;
      } catch (error) { if (token === generation) state.error = safeError(error); return { status:'unavailable' }; }
      finally { if (token === generation) { state.submitting = false; emit(); } }
    }
    return Object.freeze({ setContext, open, withdraw, grant, submit, snapshot });
  }

  function createController({ doc, session, confirmAction = async () => true, onConsentGranted = async () => {} } = {}) {
    if (!doc || !session) throw new TypeError('doc and session are required');
    const consentBox = doc.getElementById('privacyConsentState');
    const requestList = doc.getElementById('privacyRequestList');
    const live = doc.getElementById('privacyLive');
    const form = doc.getElementById('privacyRequestForm');
    const type = doc.getElementById('privacyRequestType');
    const note = doc.getElementById('privacyRequestNote');
    const help = doc.getElementById('privacyRequestHelp');
    const submitButton = doc.getElementById('privacyRequestSubmit');
    const element = (tag, className, text) => { const node = doc.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
    const button = (label, className, handler) => { const node = element('button', className, label); node.type = 'button'; node.addEventListener('click', handler); return node; };
    function renderConsent(state) {
      consentBox.replaceChildren();
      const active = state.consent?.hasConsent === true;
      const heading = element('div', 'privacy-state__heading', active ? 'ให้ความยินยอมอยู่' : state.consent?.status === 'withdrawn' ? 'ถอนความยินยอมแล้ว' : 'ยังไม่ได้ให้ความยินยอม');
      const detail = element('p', 'privacy-state__detail', active
        ? 'คุณใช้ฟังก์ชันที่อาศัยความยินยอมตามฉบับปัจจุบันได้'
        : 'ข้อมูลเดิมไม่ได้ถูกลบอัตโนมัติ และคุณยังส่งคำขอเกี่ยวกับข้อมูลส่วนบุคคลได้');
      consentBox.append(heading, detail);
      if (state.consent?.version) consentBox.append(element('p', 'privacy-state__meta', `ฉบับความยินยอม ${state.consent.version}`));
      if (state.consent?.privacyNoticeVersion) consentBox.append(element('p', 'privacy-state__meta', `ฉบับประกาศความเป็นส่วนตัว ${state.consent.privacyNoticeVersion}`));
      if (state.consent?.updatedAt) consentBox.append(element('p', 'privacy-state__meta', `อัปเดต ${formatDate(state.consent.updatedAt)}`));
      if (active) consentBox.append(button('ถอนความยินยอม', 'privacy-button privacy-button--danger', async () => {
        const approved = await confirmAction('ถอนความยินยอม', 'การถอนความยินยอมอาจทำให้บางฟังก์ชันที่ต้องใช้ข้อมูลส่วนบุคคลไม่สามารถใช้งานได้ ข้อมูลบางส่วนอาจยังถูกเก็บไว้ตามวัตถุประสงค์ที่จำเป็นหรือข้อกำหนดที่เกี่ยวข้อง');
        if (approved) await session.withdraw();
      }));
      else consentBox.append(button('ให้ความยินยอมอีกครั้ง', 'privacy-button', async () => {
        const approved = await confirmAction('ให้ความยินยอม', 'ยืนยันว่าคุณได้อ่านคำอธิบายการใช้ข้อมูลและต้องการให้ความยินยอมตามฉบับปัจจุบัน');
        if (approved) { const result = await session.grant(); if (result?.hasConsent === true) await onConsentGranted(); }
      }));
    }
    function renderRequests(state) {
      requestList.replaceChildren();
      if (!state.requests.length) { requestList.append(element('div', 'privacy-empty', 'ยังไม่มีคำขอเกี่ยวกับข้อมูลส่วนบุคคล')); return; }
      state.requests.forEach((request) => {
        const card = element('article', 'privacy-request');
        const descriptor = STATUS_LABELS[request.status] || ['อยู่ระหว่างตรวจสอบ','กรุณาติดต่อทีมงานหากต้องการข้อมูลเพิ่มเติม'];
        const top = element('div', 'privacy-request__top');
        top.append(element('strong', '', TYPE_LABELS[request.type] || 'คำขอเกี่ยวกับข้อมูลส่วนบุคคล'), element('span', `privacy-status privacy-status--${request.status || 'unknown'}`, descriptor[0]));
        card.append(top, element('div', 'privacy-request__reference', request.requestReference || 'คำขอที่ยืนยันแล้ว'), element('div', 'privacy-request__date', `ส่งเมื่อ ${formatDate(request.requestedAt)}`), element('p', 'privacy-request__meaning', descriptor[1]));
        if (request.publicNote) card.append(element('p', 'privacy-request__note', `ข้อความจากทีมงาน: ${request.publicNote}`));
        requestList.append(card);
      });
    }
    function render(state) {
      if (state.loading) { live.textContent = 'กำลังโหลดข้อมูลความเป็นส่วนตัว…'; consentBox.replaceChildren(); requestList.replaceChildren(); return; }
      live.textContent = state.error ? 'โหลดหรือบันทึกข้อมูลไม่สำเร็จ กรุณาลองอีกครั้ง' : state.lastResult === 'consent_withdrawn' ? 'ถอนความยินยอมแล้ว'
        : state.lastResult === 'consent_granted' ? 'บันทึกความยินยอมแล้ว' : state.lastResult === 'duplicate_request' ? 'มีคำขอประเภทนี้ที่กำลังดำเนินงานอยู่แล้ว'
          : state.lastResult === 'request_created' ? 'รับคำขอแล้ว' : '';
      renderConsent(state); renderRequests(state); submitButton.disabled = state.submitting; type.disabled = state.submitting; note.disabled = state.submitting;
      help.textContent = TYPE_HELP[type.value] || TYPE_HELP.export;
    }
    type.addEventListener('change', () => { help.textContent = TYPE_HELP[type.value] || TYPE_HELP.export; });
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const approved = await confirmAction(TYPE_LABELS[type.value] || 'ส่งคำขอ', `${TYPE_HELP[type.value] || TYPE_HELP.export}\n\nทีมงานจะตรวจสอบคำขอด้วยกระบวนการที่ได้รับอนุมัติ ไม่ใช่การลบหรือส่งออกอัตโนมัติ`);
      if (!approved) return;
      const result = await session.submit({ type:type.value, note:note.value.trim() });
      if (result?.created) note.value = '';
    });
    return Object.freeze({ render, open:() => session.open() });
  }

  return Object.freeze({ TYPE_LABELS, TYPE_HELP, STATUS_LABELS, formatDate, createSession, createController });
}));
