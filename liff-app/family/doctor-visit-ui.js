(function initDoctorVisitUI(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhimorDoctorVisitUI = api;
}(typeof window !== 'undefined' ? window : globalThis, function doctorVisitUIFactory() {
  const ITEM_KINDS = Object.freeze([
    ['doctor_guidance', 'คำแนะนำจากแพทย์'],
    ['medication_statement', 'ข้อมูลเกี่ยวกับยา'],
    ['lab_follow_up', 'ติดตามผลตรวจ'],
    ['next_appointment', 'นัดหมายครั้งถัดไป'],
    ['test_or_monitoring', 'การตรวจ/ติดตาม'],
    ['lifestyle_or_care_instruction', 'การดูแล/พฤติกรรม'],
    ['question_response', 'คำตอบจากแพทย์'],
    ['other', 'อื่น ๆ'],
  ]);

  function safeText(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
  }

  function requestFor(careProfileId, suffix = '', method = 'GET', body) {
    return {
      path: `/api/care-profile/${encodeURIComponent(careProfileId)}/doctor-visits${suffix}`,
      options: {
        method,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      },
    };
  }

  function buildListRequest(careProfileId) {
    return requestFor(careProfileId, '?includeDrafts=true&includeHistory=true&limit=20');
  }
  function buildCreateRequest(careProfileId, body) { return requestFor(careProfileId, '/drafts', 'POST', body); }
  function buildDetailRequest(careProfileId, recordId) { return requestFor(careProfileId, `/${encodeURIComponent(recordId)}`); }
  function buildUpdateRequest(careProfileId, recordId, body) { return requestFor(careProfileId, `/${encodeURIComponent(recordId)}/draft`, 'PATCH', body); }
  function buildOrganizeRequest(careProfileId, recordId) { return requestFor(careProfileId, `/${encodeURIComponent(recordId)}/organize`, 'POST', {}); }
  function buildConfirmRequest(careProfileId, recordId) { return requestFor(careProfileId, `/${encodeURIComponent(recordId)}/confirm`, 'POST', {}); }

  function cleanItem(item = {}, index = 0) {
    const kind = ITEM_KINDS.some(([value]) => value === item.kind) ? item.kind : 'other';
    return {
      sourceOrdinal: index + 1,
      kind,
      sourceSupport: safeText(item.sourceSupport),
      summary: safeText(item.summary),
      dueAt: safeText(item.dueAt) || null,
      uncertainty: safeText(item.uncertainty) || null,
    };
  }

  function createSession({ request, onChange = () => {} }) {
    let profileId = null;
    let records = [];
    let selected = null;
    let busy = false;
    let errorCode = null;
    let generation = 0;
    let reviewNotice = '';
    const snapshot = () => ({ profileId, records: [...records], selected, busy, errorCode, reviewNotice });
    const notify = () => onChange(snapshot());
    const send = async (descriptor) => request(descriptor.path, descriptor.options);

    async function guarded(work) {
      if (!profileId || busy) return { ignored: true };
      const token = generation;
      const expectedProfile = profileId;
      busy = true; errorCode = null; notify();
      try {
        const isCurrent = () => token === generation && expectedProfile === profileId;
        const result = await work(expectedProfile, isCurrent);
        if (token !== generation || expectedProfile !== profileId) return { ignored: true, stale: true };
        return result;
      } catch (error) {
        if (token === generation && expectedProfile === profileId) errorCode = error?.errorCode || 'DOCTOR_VISIT_REQUEST_FAILED';
        return { status: 'unavailable', errorCode };
      } finally {
        if (token === generation && expectedProfile === profileId) { busy = false; notify(); }
      }
    }

    async function refresh() {
      return guarded(async (id, isCurrent) => {
        const result = await send(buildListRequest(id));
        if (!isCurrent()) return { ignored: true, stale: true };
        records = Array.isArray(result.items) ? result.items : [];
        notify();
        return result;
      });
    }

    return {
      snapshot,
      async setProfile(nextProfileId) {
        generation += 1;
        profileId = nextProfileId || null;
        records = []; selected = null; errorCode = null; reviewNotice = ''; busy = false;
        notify();
        if (profileId) return refresh();
        return null;
      },
      newDraft() {
        selected = {
          status: 'draft', visitRecordId: null, appointmentId: null, visitAt: null,
          hospitalName: '', department: '', doctorName: '', sourceText: '',
          structuredSummary: '', items: [], followUpSuggestions: [],
        };
        reviewNotice = ''; errorCode = null; notify();
      },
      close() { selected = null; reviewNotice = ''; errorCode = null; notify(); },
      async open(recordId) {
        return guarded(async (id, isCurrent) => {
          const result = await send(buildDetailRequest(id, recordId));
          if (!isCurrent()) return { ignored: true, stale: true };
          selected = result;
          reviewNotice = ''; notify(); return selected;
        });
      },
      async save(input) {
        return guarded(async (id, isCurrent) => {
          const body = { ...input, items: (input.items || []).map(cleanItem) };
          const saved = selected?.visitRecordId
            ? await send(buildUpdateRequest(id, selected.visitRecordId, body))
            : await send(buildCreateRequest(id, body));
          if (!isCurrent()) return { ignored: true, stale: true };
          selected = saved;
          const result = await send(buildListRequest(id));
          if (!isCurrent()) return { ignored: true, stale: true };
          records = result.items || [];
          notify(); return selected;
        });
      },
      async organize(input) {
        const saved = await this.save(input);
        if (!saved || saved.status === 'unavailable' || !selected?.visitRecordId) return saved;
        return guarded(async (id, isCurrent) => {
          const result = await send(buildOrganizeRequest(id, selected.visitRecordId));
          if (!isCurrent()) return { ignored: true, stale: true };
          if (result.status === 'unavailable') { errorCode = result.errorCode; return result; }
          selected = result.record;
          reviewNotice = safeText(result.reviewNotice);
          notify(); return result;
        });
      },
      async confirm(input) {
        const saved = await this.save(input);
        if (!saved || saved.status === 'unavailable' || !selected?.visitRecordId) return saved;
        return guarded(async (id, isCurrent) => {
          const confirmed = await send(buildConfirmRequest(id, selected.visitRecordId));
          if (!isCurrent()) return { ignored: true, stale: true };
          selected = confirmed;
          const result = await send(buildListRequest(id));
          if (!isCurrent()) return { ignored: true, stale: true };
          records = result.items || [];
          notify(); return selected;
        });
      },
      refresh,
    };
  }

  function appendText(doc, parent, tag, className, value) {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    element.textContent = safeText(value);
    parent.appendChild(element);
    return element;
  }

  function clear(node) { while (node.firstChild) node.removeChild(node.firstChild); }

  function formatDate(value) {
    if (!value) return 'ไม่ระบุวันพบแพทย์';
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? 'ไม่ระบุวันพบแพทย์'
      : parsed.toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' });
  }

  function createController({ doc, session, getCurrentProfile, onUpgradeRequired = null }) {
    const panel = doc.getElementById('doctorVisitPanel');
    const list = doc.getElementById('doctorVisitList');
    const editor = doc.getElementById('doctorVisitEditor');
    const status = doc.getElementById('doctorVisitEditorStatus');
    const source = doc.getElementById('doctorVisitSourceText');
    const summary = doc.getElementById('doctorVisitSummary');
    const itemsBox = doc.getElementById('doctorVisitItems');
    const appointment = doc.getElementById('doctorVisitAppointment');
    const visitAt = doc.getElementById('doctorVisitAt');
    const hospital = doc.getElementById('doctorVisitHospital');
    const department = doc.getElementById('doctorVisitDepartment');
    const doctor = doc.getElementById('doctorVisitDoctor');
    const saveButton = doc.getElementById('doctorVisitSave');
    const aiButton = doc.getElementById('doctorVisitOrganize');
    const confirmButton = doc.getElementById('doctorVisitConfirm');
    const notice = doc.getElementById('doctorVisitReviewNotice');
    const suggestions = doc.getElementById('doctorVisitSuggestions');
    let itemDrafts = [];

    function inputValue() {
      return {
        appointmentId: appointment.value || null,
        visitAt: visitAt.value ? new Date(visitAt.value).toISOString() : null,
        hospitalName: hospital.value || null,
        department: department.value || null,
        doctorName: doctor.value || null,
        sourceText: source.value,
        structuredSummary: summary.value || null,
        items: itemDrafts,
      };
    }

    function renderItems(readOnly) {
      clear(itemsBox);
      itemDrafts.forEach((item, index) => {
        const card = doc.createElement('div'); card.className = 'doctor-visit-item';
        const select = doc.createElement('select'); select.disabled = readOnly;
        ITEM_KINDS.forEach(([value, label]) => {
          const option = doc.createElement('option'); option.value = value; option.textContent = label;
          option.selected = value === item.kind; select.appendChild(option);
        });
        select.addEventListener('change', () => { itemDrafts[index].kind = select.value; });
        card.appendChild(select);
        const support = appendText(doc, card, 'textarea', '', item.sourceSupport); support.value = item.sourceSupport; support.disabled = readOnly; support.placeholder = 'ข้อความต้นทางที่รองรับรายการนี้';
        support.addEventListener('input', () => { itemDrafts[index].sourceSupport = support.value; });
        const itemSummary = appendText(doc, card, 'textarea', '', item.summary); itemSummary.value = item.summary; itemSummary.disabled = readOnly; itemSummary.placeholder = 'สรุปข้อมูลที่บันทึกไว้';
        itemSummary.addEventListener('input', () => { itemDrafts[index].summary = itemSummary.value; });
        const uncertainty = appendText(doc, card, 'input', '', ''); uncertainty.value = item.uncertainty || ''; uncertainty.disabled = readOnly; uncertainty.placeholder = 'ส่วนที่ยังไม่ชัดเจน (ถ้ามี)';
        uncertainty.addEventListener('input', () => { itemDrafts[index].uncertainty = uncertainty.value || null; });
        if (!readOnly) {
          const remove = appendText(doc, card, 'button', 'doctor-visit-item-remove', 'ลบรายการนี้'); remove.type = 'button';
          remove.addEventListener('click', () => { itemDrafts.splice(index, 1); renderItems(false); });
        }
        itemsBox.appendChild(card);
      });
    }

    function render(state) {
      panel.hidden = !state.profileId;
      clear(list);
      if (!state.records.length) appendText(doc, list, 'div', 'doctor-visit-empty', 'ยังไม่มีบันทึกจากการพบแพทย์');
      state.records.forEach((record) => {
        const button = doc.createElement('button'); button.type = 'button'; button.className = 'doctor-visit-list-item';
        const top = doc.createElement('div'); top.className = 'doctor-visit-list-item__top';
        appendText(doc, top, 'span', '', formatDate(record.visitAt));
        appendText(doc, top, 'span', `doctor-visit-status doctor-visit-status--${record.status}`,
          record.status === 'draft' ? 'รอตรวจสอบ' : record.status === 'confirmed' ? 'ยืนยันแล้ว' : 'ยกเลิกแล้ว');
        button.appendChild(top);
        appendText(doc, button, 'div', 'doctor-visit-list-item__summary', safeText(record.structuredSummary, record.hospitalName || 'เปิดดูรายละเอียด'));
        button.addEventListener('click', () => session.open(record.visitRecordId)); list.appendChild(button);
      });

      const record = state.selected;
      editor.hidden = !record;
      if (!record) return;
      const readOnly = record.status !== 'draft';
      status.textContent = readOnly ? 'ยืนยันแล้ว' : 'รอตรวจสอบ';
      status.className = `doctor-visit-status doctor-visit-status--${record.status}`;
      source.value = safeText(record.sourceText); summary.value = safeText(record.structuredSummary);
      visitAt.value = record.visitAt ? new Date(record.visitAt).toISOString().slice(0, 16) : '';
      hospital.value = safeText(record.hospitalName); department.value = safeText(record.department); doctor.value = safeText(record.doctorName);
      clear(appointment);
      const emptyOption = doc.createElement('option'); emptyOption.value = ''; emptyOption.textContent = 'ไม่เชื่อมกับนัดหมาย'; appointment.appendChild(emptyOption);
      const profile = getCurrentProfile();
      (Array.isArray(profile?.upcomingAppointments) ? profile.upcomingAppointments : []).forEach((item) => {
        const option = doc.createElement('option'); option.value = item.appointment_id || item.appointmentId;
        option.textContent = `${safeText(item.hospital, 'นัดหมาย')} · ${formatDate(item.datetime)}`;
        option.selected = option.value === record.appointmentId; appointment.appendChild(option);
      });
      source.disabled = readOnly; summary.disabled = readOnly; appointment.disabled = readOnly;
      visitAt.disabled = readOnly; hospital.disabled = readOnly; department.disabled = readOnly; doctor.disabled = readOnly;
      itemDrafts = (record.items || []).map(cleanItem); renderItems(readOnly);
      saveButton.hidden = readOnly; aiButton.hidden = readOnly; confirmButton.hidden = readOnly;
      saveButton.disabled = state.busy; aiButton.disabled = state.busy; confirmButton.disabled = state.busy;
      notice.textContent = state.reviewNotice || (state.errorCode
        ? 'ระบบช่วยจัดระเบียบยังไม่พร้อม คุณยังตรวจสอบและบันทึกด้วยตนเองได้'
        : 'ข้อมูลนี้บันทึกโดยผู้ดูแล/ครอบครัวจากการพบแพทย์ โปรดตรวจสอบเอกสารต้นทางเมื่อจำเป็น');
      clear(suggestions);
      if (readOnly && Array.isArray(record.followUpSuggestions) && record.followUpSuggestions.length) {
        appendText(doc, suggestions, 'h5', '', 'สิ่งที่อาจต้องตรวจสอบต่อ');
        const ul = doc.createElement('ul');
        record.followUpSuggestions.forEach((item) => appendText(doc, ul, 'li', '', item.label));
        suggestions.appendChild(ul); suggestions.hidden = false;
      } else suggestions.hidden = true;
    }

    doc.getElementById('doctorVisitNew').addEventListener('click', () => session.newDraft());
    doc.getElementById('doctorVisitRefresh').addEventListener('click', () => session.refresh());
    doc.getElementById('doctorVisitClose').addEventListener('click', () => session.close());
    doc.getElementById('doctorVisitAddItem').addEventListener('click', () => {
      itemDrafts.push(cleanItem({
        kind: 'other', sourceSupport: source.value, summary: '', uncertainty: null,
      }, itemDrafts.length)); renderItems(false);
    });
    saveButton.addEventListener('click', () => session.save(inputValue()));
    async function organizeCurrent() {
      const result = await session.organize(inputValue());
      if (result?.status === 'unavailable'
          && /^(?:PLUS_|NO_PLUS_|ENTITLEMENT_|INTERNAL_ENTITLEMENT)/.test(result.errorCode || '')
          && typeof onUpgradeRequired === 'function') onUpgradeRequired();
      return result;
    }
    aiButton.addEventListener('click', organizeCurrent);
    confirmButton.addEventListener('click', () => session.confirm(inputValue()));
    return { render, organizeCurrent };
  }

  return {
    ITEM_KINDS, requestFor, buildListRequest, buildCreateRequest, buildDetailRequest,
    buildUpdateRequest, buildOrganizeRequest, buildConfirmRequest, cleanItem,
    createSession, createController,
  };
}));
