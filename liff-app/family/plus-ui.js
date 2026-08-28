(function initPlusUIModule(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhimorPlusUI = api;
}(typeof window !== 'undefined' ? window : globalThis, function plusUIFactory() {
  const browserRoot = typeof window !== 'undefined' ? window : null;
  const QUICK_ACTIONS = Object.freeze([
    { id: 'profile-summary', label: 'สรุป Care Profile', question: 'ช่วยสรุปข้อมูล Care Profile นี้', purposeHint: 'care_profile_summary' },
    { id: 'current-medication', label: 'ยาปัจจุบัน', question: 'ตอนนี้มียาอะไรบ้าง', purposeHint: 'medication_summary' },
    { id: 'medication-instructions', label: 'ยากินอย่างไร', question: 'ยาที่บันทึกไว้กินอย่างไร', purposeHint: 'medication_instructions' },
    { id: 'medication-diff', label: 'ยาเปลี่ยนจากครั้งก่อน', question: 'รอบล่าสุดเปลี่ยนยาอะไร', purposeHint: 'medication_diff' },
    { id: 'appointments', label: 'นัดหมาย', question: 'มีนัดอะไรต่อไป', purposeHint: 'appointment_summary' },
    { id: 'prepare', label: 'เตรียมก่อนพบแพทย์', question: 'ช่วยเตรียมคำถามก่อนไปพบแพทย์', purposeHint: 'doctor_visit_preparation', requiresAppointment: true },
    { id: 'doctor-questions', label: 'ถามหมออะไรดี', doctorQuestions: true },
  ]);

  function isInternalEntitlement(value) {
    return Boolean(value && value.status === 'active' && value.plus === true
      && ['internal', 'promotion', 'payment'].includes(value.source));
  }

  function safeText(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
  }

  function safeList(value) {
    return Array.isArray(value) ? value.filter((item) => typeof item === 'string').slice(0, 30) : [];
  }

  function safeQuestionList(value) {
    return Array.isArray(value) ? value.filter((item) => item && typeof item === 'object'
      && typeof item.question === 'string').slice(0, 8).map((item, index) => ({
      id: safeText(item.id, `Q${index + 1}`), category: safeText(item.category, 'clarification'),
      question: item.question, rationale: safeText(item.rationale),
    })) : [];
  }

  function safeMissingInformation(value) {
    if (!Array.isArray(value)) return [];
    return value.slice(0, 20).map((item) => {
      if (typeof item === 'string') return item;
      return item && typeof item.label === 'string' ? item.label : '';
    }).filter(Boolean);
  }

  function responseToViewModel(response = {}) {
    if (response.status === 'questions') {
      return {
        kind: 'doctor-questions', title: safeText(response.title, 'คำถามที่อยากถามคุณหมอ'),
        summary: safeText(response.summary), questions: safeQuestionList(response.questions),
        keyPoints: [], missingInformation: safeMissingInformation(response.missingInformation),
        safetyNotice: safeText(response.safetyNotice), disclaimer: safeText(response.disclaimer), retryable: false,
      };
    }
    if (response.status === 'answer') {
      return {
        kind: 'answer', title: 'คำอธิบายจากพี่หมอ', summary: safeText(response.data?.summary, 'ไม่พบข้อมูลที่สามารถสรุปได้'),
        keyPoints: safeList(response.data?.keyPoints), missingInformation: safeList(response.data?.missingInformation),
        questions: [], safetyNotice: '', disclaimer: safeText(response.data?.disclaimer), retryable: false,
      };
    }
    if (response.status === 'escalation' && response.type === 'pharmacist') {
      return {
        kind: 'pharmacist', title: 'เรื่องยา พี่หมอไม่เดา',
        summary: 'คำถามนี้ควรให้เภสัชกรหรือแพทย์ช่วยตรวจสอบเพื่อความชัดเจน',
        keyPoints: [], questions: [], missingInformation: [], safetyNotice: '', disclaimer: safeText(response.message), retryable: false,
      };
    }
    if (response.status === 'escalation') {
      return {
        kind: 'medical', title: 'ควรปรึกษาบุคลากรทางการแพทย์',
        summary: safeText(response.message, 'คำถามนี้ควรได้รับการประเมินจากแพทย์หรือบุคลากรทางการแพทย์'),
        keyPoints: [], questions: [], missingInformation: [], safetyNotice: '', disclaimer: '', retryable: false,
      };
    }
    if (response.status === 'needs_review') {
      return {
        kind: 'needs_review', title: 'พี่หมอยังไม่มั่นใจว่าคำถามนี้ควรตอบในรูปแบบไหน',
        summary: 'ลองถามใหม่ให้สั้นและชัดขึ้น หรือเลือกหัวข้อด้านบน', keyPoints: [], questions: [], missingInformation: [], safetyNotice: '', disclaimer: '', retryable: true,
      };
    }
    if (response.status === 'unavailable'
      && /^(?:PLUS_|NO_PLUS_|ENTITLEMENT_|INTERNAL_ENTITLEMENT)/.test(safeText(response.errorCode))) {
      return {
        kind: 'unavailable', title: 'ฟีเจอร์นี้ใช้สิทธิ์พี่หมอ Plus',
        summary: 'บัญชีนี้ยังไม่มีสิทธิ์ใช้ระบบช่วยเตรียมคำถาม',
        keyPoints: [], questions: [], missingInformation: [], safetyNotice: '', disclaimer: '', retryable: false,
      };
    }
    return {
      kind: 'unavailable', title: 'ตอนนี้พี่หมอยังช่วยอธิบายไม่ได้',
      summary: 'กรุณาลองใหม่อีกครั้งภายหลัง', keyPoints: [], questions: [], missingInformation: [], safetyNotice: '', disclaimer: '', retryable: true,
    };
  }

  function formatDoctorQuestionsForCopy(view) {
    const questions = safeQuestionList(view?.questions);
    if (!questions.length) return '';
    return [
      'คำถามที่อยากถามคุณหมอ', '',
      ...questions.map((item, index) => `${index + 1}. ${item.question}`),
      '', 'ข้อมูลจากพี่หมอใช้เพื่อช่วยเตรียมคำถาม ไม่ใช่การวินิจฉัยหรือคำแนะนำให้ปรับยา',
    ].join('\n');
  }

  function appendTextElement(doc, parent, tag, className, text) {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    element.textContent = safeText(text);
    parent.appendChild(element);
    return element;
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function renderResponse(doc, container, response, { pharmacistUrl = '', copyText = null } = {}) {
    clearNode(container);
    const view = responseToViewModel(response);
    const card = doc.createElement('div');
    card.className = `plus-response plus-response--${view.kind}`;
    appendTextElement(doc, card, 'h4', 'plus-response__title', view.title);
    appendTextElement(doc, card, 'p', 'plus-response__summary', view.summary);
    if (view.questions?.length) {
      const list = doc.createElement('ol');
      list.className = 'plus-doctor-questions';
      view.questions.forEach((item) => {
        const listItem = doc.createElement('li');
        appendTextElement(doc, listItem, 'div', 'plus-doctor-question__text', item.question);
        if (item.rationale) appendTextElement(doc, listItem, 'p', 'plus-doctor-question__rationale', item.rationale);
        list.appendChild(listItem);
      });
      card.appendChild(list);
      const copyButton = appendTextElement(doc, card, 'button', 'btn btn-outline plus-copy-questions', 'คัดลอกคำถามทั้งหมด');
      copyButton.type = 'button';
      copyButton.addEventListener('click', () => {
        if (typeof copyText === 'function') copyText(formatDoctorQuestionsForCopy(view));
      });
      if (typeof copyText !== 'function') copyButton.disabled = true;
    }
    if (view.keyPoints.length) {
      const list = doc.createElement('ul');
      list.className = 'plus-response__list';
      view.keyPoints.forEach((item) => appendTextElement(doc, list, 'li', '', item));
      card.appendChild(list);
    }
    if (view.missingInformation.length) {
      appendTextElement(doc, card, 'div', 'plus-response__section-label', 'ข้อมูลที่ยังไม่พบ');
      const list = doc.createElement('ul');
      list.className = 'plus-response__list plus-response__list--missing';
      view.missingInformation.forEach((item) => appendTextElement(doc, list, 'li', '', item));
      card.appendChild(list);
    }
    if (view.safetyNotice) appendTextElement(doc, card, 'p', 'plus-response__safety', view.safetyNotice);
    if (view.disclaimer) appendTextElement(doc, card, 'p', 'plus-response__disclaimer', view.disclaimer);
    if (view.kind === 'pharmacist') {
      const button = appendTextElement(doc, card, 'button', 'btn btn-outline plus-pharmacist-button', 'ปรึกษาเภสัชกร');
      button.type = 'button';
      if (pharmacistUrl && browserRoot) button.addEventListener('click', () => browserRoot.open(pharmacistUrl, '_blank', 'noopener'));
      else {
        button.disabled = true;
        button.title = 'ช่องทางปรึกษาเภสัชกรยังไม่เปิดในรอบทดสอบนี้';
      }
    }
    container.appendChild(card);
    return view;
  }

  function buildAskRequest(careProfileId, question, purposeHint = null) {
    return {
      path: `/api/plus/care-profiles/${encodeURIComponent(careProfileId)}/ask`,
      body: { question, ...(purposeHint ? { purposeHint } : {}) },
    };
  }

  function buildPreparationRequest(careProfileId, appointmentId) {
    return {
      path: `/api/plus/care-profiles/${encodeURIComponent(careProfileId)}/appointments/${encodeURIComponent(appointmentId)}/prepare`,
      body: {},
    };
  }

  function buildDoctorQuestionRequest(careProfileId, appointmentId = null, focus = '') {
    return {
      path: `/api/care-profile/${encodeURIComponent(careProfileId)}/doctor-questions`,
      body: {
        ...(appointmentId ? { appointmentId } : {}),
        ...(focus ? { focus } : {}),
      },
    };
  }

  function createSession({ send, onChange = () => {} }) {
    let profileId = null;
    let messages = [];
    let busy = false;
    let lastRequest = null;
    let generation = 0;
    const snapshot = () => ({ profileId, messages: [...messages], busy, lastRequest });
    const notify = () => onChange(snapshot());
    return {
      snapshot,
      setProfile(nextProfileId) {
        if (profileId === nextProfileId) return false;
        generation += 1;
        profileId = nextProfileId || null;
        messages = [];
        lastRequest = null;
        busy = false;
        notify();
        return true;
      },
      clear() { messages = []; lastRequest = null; notify(); },
      async submit(request, userText) {
        if (busy || !profileId) return { ignored: true };
        const requestGeneration = generation;
        const requestProfileId = profileId;
        busy = true;
        lastRequest = request;
        messages.push({ role: 'user', text: safeText(userText) });
        notify();
        try {
          const response = await send(request);
          if (generation !== requestGeneration || profileId !== requestProfileId) return { ignored: true, stale: true };
          messages.push({ role: 'assistant', response });
          return response;
        } finally {
          if (generation === requestGeneration && profileId === requestProfileId) {
            busy = false;
            notify();
          }
        }
      },
      async retry() {
        if (!lastRequest || busy || !profileId) return { ignored: true };
        return this.submit(lastRequest, 'ลองอีกครั้ง');
      },
    };
  }

  function createController({ doc, request, getCurrentProfile, pharmacistUrl = '', copyText = null }) {
    const panel = doc.getElementById('plusPanel');
    const messages = doc.getElementById('plusMessages');
    const input = doc.getElementById('plusQuestion');
    const sendButton = doc.getElementById('plusSendButton');
    const retryButton = doc.getElementById('plusRetryButton');
    const loading = doc.getElementById('plusLoading');
    const appointmentPicker = doc.getElementById('plusAppointmentPicker');
    const quickActions = Array.from(doc.querySelectorAll('[data-plus-action]'));
    let entitled = false;

    function renderState(state) {
      clearNode(messages);
      state.messages.forEach((message) => {
        if (message.role === 'user') appendTextElement(doc, messages, 'div', 'plus-bubble plus-bubble--user', message.text);
        else {
          const bubble = doc.createElement('div');
          bubble.className = 'plus-bubble plus-bubble--assistant';
          renderResponse(doc, bubble, message.response, { pharmacistUrl, copyText });
          messages.appendChild(bubble);
        }
      });
      loading.hidden = !state.busy;
      sendButton.disabled = state.busy;
      quickActions.forEach((button) => { button.disabled = state.busy; });
      const last = [...state.messages].reverse().find((message) => message.role === 'assistant');
      retryButton.hidden = state.busy || !last || !responseToViewModel(last.response).retryable;
    }

    const session = createSession({
      send: async ({ path, body }) => request(path, { method: 'POST', body: JSON.stringify(body) }),
      onChange: renderState,
    });

    function syncVisibility() {
      const profile = getCurrentProfile();
      panel.hidden = !(entitled && profile?.profile?.care_profile_id);
    }

    function renderAppointmentPicker() {
      clearNode(appointmentPicker);
      const profile = getCurrentProfile();
      const appointments = Array.isArray(profile?.upcomingAppointments) ? profile.upcomingAppointments : [];
      appointmentPicker.hidden = false;
      if (!appointments.length) {
        appendTextElement(doc, appointmentPicker, 'p', 'plus-empty', 'ยังไม่มีนัดหมายที่กำลังจะถึง');
        return;
      }
      appendTextElement(doc, appointmentPicker, 'p', 'plus-picker-title', 'เลือกนัดหมายที่ต้องการเตรียมข้อมูล');
      appointments.forEach((appointment) => {
        const button = doc.createElement('button');
        button.type = 'button';
        button.className = 'plus-appointment-option';
        const when = appointment.datetime ? new Date(appointment.datetime).toLocaleString('th-TH', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok' }) : 'ยังไม่ระบุวันเวลา';
        button.textContent = `${safeText(appointment.hospital, 'ไม่ระบุสถานที่')} · ${when}`;
        button.addEventListener('click', async () => {
          appointmentPicker.hidden = true;
          await session.submit(buildPreparationRequest(profile.profile.care_profile_id, appointment.appointment_id), 'เตรียมก่อนพบแพทย์');
        });
        appointmentPicker.appendChild(button);
      });
    }

    async function runQuickAction(actionId) {
      const action = QUICK_ACTIONS.find((item) => item.id === actionId);
      const profile = getCurrentProfile();
      if (!action || !profile) return;
      if (action.requiresAppointment) return renderAppointmentPicker();
      appointmentPicker.hidden = true;
      if (action.doctorQuestions) {
        const appointment = Array.isArray(profile.upcomingAppointments) ? profile.upcomingAppointments[0] : null;
        const appointmentId = appointment?.appointment_id || appointment?.appointmentId || null;
        return session.submit(
          buildDoctorQuestionRequest(profile.profile.care_profile_id, appointmentId), action.label
        );
      }
      return session.submit(buildAskRequest(profile.profile.care_profile_id, action.question, action.purposeHint), action.label);
    }

    quickActions.forEach((button) => button.addEventListener('click', () => runQuickAction(button.dataset.plusAction)));
    sendButton.addEventListener('click', async () => {
      const profile = getCurrentProfile();
      const question = input.value.trim();
      if (!profile || !question || session.snapshot().busy) return;
      input.value = '';
      appointmentPicker.hidden = true;
      await session.submit(buildAskRequest(profile.profile.care_profile_id, question), question);
    });
    retryButton.addEventListener('click', () => session.retry());

    return {
      session,
      async checkVisibility() {
        try { entitled = isInternalEntitlement(await request('/api/plus/entitlement')); }
        catch (_) { entitled = false; }
        if (!entitled) session.clear();
        syncVisibility();
        return entitled;
      },
      setProfile(profile) {
        appointmentPicker.hidden = true;
        session.setProfile(profile?.profile?.care_profile_id || null);
        syncVisibility();
      },
      runQuickAction,
    };
  }

  return {
    QUICK_ACTIONS, isInternalEntitlement, responseToViewModel, renderResponse,
    formatDoctorQuestionsForCopy, buildAskRequest, buildPreparationRequest,
    buildDoctorQuestionRequest, createSession, createController,
  };
}));
