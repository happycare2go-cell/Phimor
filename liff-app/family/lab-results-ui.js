(function initFamilyLabResultsUI(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhimorFamilyLabResultsUI = api;
}(typeof window !== 'undefined' ? window : globalThis, function familyLabResultsUIFactory() {
  const HISTORY_LIMIT = 10;
  const TREND_LIMIT = 20;
  const SAFE_TREND_MESSAGE = 'ไม่สามารถเปรียบเทียบแนวโน้มได้อย่างปลอดภัย';
  const TREND_REASON_LABELS = Object.freeze({
    ANALYTE_IDENTITY_UNVERIFIED: 'ยังยืนยันไม่ได้ว่าเป็นรายการตรวจเดียวกัน',
    NON_NUMERIC_RESULT: 'ผลตรวจนี้ไม่ใช่ค่าตัวเลขที่นำมาเปรียบเทียบได้',
    SPECIMEN_TIME_MISSING: 'บางผลตรวจไม่มีวันเวลาเก็บสิ่งส่งตรวจ',
    SPECIMEN_MISMATCH: 'ชนิดตัวอย่างแตกต่างกัน',
    METHOD_MISMATCH: 'วิธีตรวจแตกต่างกัน',
    UNIT_INCOMPATIBLE: 'หน่วยของผลตรวจไม่สามารถเปรียบเทียบกันได้',
    AMBIGUOUS_OBSERVATION: 'พบรายการที่อาจซ้ำกัน จึงยังเปรียบเทียบไม่ได้',
    INSUFFICIENT_CONFIRMED_HISTORY: 'ข้อมูลย้อนหลังที่ยืนยันแล้วยังไม่เพียงพอ',
  });
  const DIRECTION_LABELS = Object.freeze({
    increased: 'เพิ่มขึ้น',
    decreased: 'ลดลง',
    unchanged: 'ใกล้เคียงเดิม / ไม่เปลี่ยนแปลง',
  });

  function safeText(value, fallback = '') {
    return typeof value === 'string' ? value : fallback;
  }

  function safeArray(value, limit = 100) {
    return Array.isArray(value) ? value.slice(0, limit) : [];
  }

  function formatDate(value, fallback = 'ไม่ระบุวันที่') {
    if (!value) return fallback;
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback
      : parsed.toLocaleString('th-TH', {
        dateStyle: 'medium', timeStyle: 'short', timeZone: 'Asia/Bangkok',
      });
  }

  function reportDate(report) {
    return report?.specimenCollectedAt || report?.reportedAt || report?.confirmedAt || null;
  }

  function reportPlace(report) {
    return safeText(report?.hospitalName) || safeText(report?.laboratoryName) || 'ไม่ระบุสถานพยาบาล/ห้องปฏิบัติการ';
  }

  function observationIdentity(observation) {
    if (!observation || typeof observation !== 'object') return null;
    if (safeText(observation.loincCode) && safeText(observation.loincVerificationSource)
      && safeText(observation.loincVerifiedAt)) {
      return { loincCode: observation.loincCode };
    }
    if (safeText(observation.comparisonKey)) return { comparisonKey: observation.comparisonKey };
    return null;
  }

  function identityQuery(identity) {
    if (identity?.loincCode) return `loincCode=${encodeURIComponent(identity.loincCode)}`;
    if (identity?.comparisonKey) return `comparisonKey=${encodeURIComponent(identity.comparisonKey)}`;
    return '';
  }

  function buildHistoryRequest(careProfileId, cursor = null) {
    const query = new URLSearchParams({ limit: String(HISTORY_LIMIT) });
    if (cursor) query.set('cursor', cursor);
    return {
      path: `/api/care-profile/${encodeURIComponent(careProfileId)}/lab-reports?${query}`,
      options: { method: 'GET' },
    };
  }

  function buildDetailRequest(careProfileId, reportId) {
    return {
      path: `/api/care-profile/${encodeURIComponent(careProfileId)}/lab-reports/${encodeURIComponent(reportId)}`,
      options: { method: 'GET' },
    };
  }

  function buildTrendRequest(careProfileId, identity) {
    return {
      path: `/api/care-profile/${encodeURIComponent(careProfileId)}/lab-trends?${identityQuery(identity)}&limit=${TREND_LIMIT}`,
      options: { method: 'GET' },
    };
  }

  function buildExplanationRequest(careProfileId, identity) {
    return {
      path: `/api/care-profile/${encodeURIComponent(careProfileId)}/lab-explanations`,
      options: { method: 'POST', body: JSON.stringify({ identity }) },
    };
  }

  function projectHistoryReport(report) {
    if (!report || typeof report.reportId !== 'string' || report.status !== 'confirmed') return null;
    return {
      reportId: report.reportId, status: 'confirmed',
      laboratoryName: safeText(report.laboratoryName) || null,
      hospitalName: safeText(report.hospitalName) || null,
      specimenCollectedAt: safeText(report.specimenCollectedAt) || null,
      reportedAt: safeText(report.reportedAt) || null,
      confirmedAt: safeText(report.confirmedAt) || null,
    };
  }

  function projectObservation(observation) {
    if (!observation || typeof observation.observationId !== 'string') return null;
    return {
      observationId: observation.observationId,
      analyteNameSource: safeText(observation.analyteNameSource) || null,
      sourceValueText: safeText(observation.sourceValueText) || null,
      sourceUnit: safeText(observation.sourceUnit) || null,
      referenceRangeText: safeText(observation.referenceRangeText) || null,
      abnormalFlagSource: safeText(observation.abnormalFlagSource) || null,
      specimenSource: safeText(observation.specimenSource) || null,
      methodSource: safeText(observation.methodSource) || null,
      valueType: safeText(observation.valueType) || null,
      numericValue: Number.isFinite(observation.numericValue) ? observation.numericValue : null,
      textValue: safeText(observation.textValue) || null,
      loincCode: safeText(observation.loincCode) || null,
      loincVerificationSource: safeText(observation.loincVerificationSource) || null,
      loincVerifiedAt: safeText(observation.loincVerifiedAt) || null,
      comparisonKey: safeText(observation.comparisonKey) || null,
    };
  }

  function projectConfirmedDetail(report) {
    const projected = projectHistoryReport(report);
    if (!projected) return null;
    return {
      ...projected,
      observations: safeArray(report.observations).map(projectObservation).filter(Boolean),
    };
  }

  function mergeReports(existing, incoming) {
    const seen = new Set();
    return [...safeArray(existing), ...safeArray(incoming)].map(projectHistoryReport).filter((report) => {
      if (!report || seen.has(report.reportId)) return false;
      seen.add(report.reportId); return true;
    });
  }

  function safeError(error) {
    return Object.freeze({
      errorCode: safeText(error?.errorCode, 'LAB_REQUEST_FAILED'),
      status: Number.isInteger(error?.status) ? error.status : 0,
      retryAfterSeconds: Number.isFinite(error?.retryAfterSeconds)
        ? Math.max(0, Math.ceil(error.retryAfterSeconds)) : 0,
    });
  }

  function freshState(profileId = null) {
    return {
      profileId, opened: false, reports: [], nextCursor: null,
      historyLoading: false, historyError: null,
      selectedReport: null, detailLoading: false, detailError: null,
      selectedObservationId: null, trend: null, trendLoading: false, trendError: null,
      explanation: null, explanationLoading: false, explanationError: null,
    };
  }

  function createSession({ request, onChange = () => {} }) {
    if (typeof request !== 'function') throw new TypeError('request is required');
    let state = freshState();
    let generation = 0;
    let historyRevision = 0;
    let detailRevision = 0;
    let trendRevision = 0;
    let explanationRevision = 0;
    const snapshot = () => ({
      ...state, reports: [...state.reports],
      selectedReport: state.selectedReport ? { ...state.selectedReport } : null,
    });
    const notify = () => onChange(snapshot());
    const send = (descriptor) => request(descriptor.path, descriptor.options);
    const isCurrent = (token, profileId) => token === generation && state.profileId === profileId;

    function clearSelection() {
      detailRevision += 1; trendRevision += 1; explanationRevision += 1;
      state.selectedReport = null; state.detailLoading = false; state.detailError = null;
      state.selectedObservationId = null; state.trend = null; state.trendLoading = false; state.trendError = null;
      state.explanation = null; state.explanationLoading = false; state.explanationError = null;
    }

    async function loadHistory({ append = false } = {}) {
      if (!state.profileId || state.historyLoading) return { ignored: true };
      const cursor = append ? state.nextCursor : null;
      if (append && !cursor) return { ignored: true };
      const token = generation; const profileId = state.profileId; const requestRevision = ++historyRevision;
      state.historyLoading = true; state.historyError = null; notify();
      try {
        const response = await send(buildHistoryRequest(profileId, cursor));
        if (!isCurrent(token, profileId) || requestRevision !== historyRevision) return { ignored: true, stale: true };
        const incoming = safeArray(response?.items).filter((report) => report?.status === 'confirmed');
        state.reports = mergeReports(append ? state.reports : [], incoming);
        state.nextCursor = safeText(response?.nextCursor) || null;
        return response;
      } catch (error) {
        if (isCurrent(token, profileId) && requestRevision === historyRevision) state.historyError = safeError(error);
        return { status: 'unavailable', ...safeError(error) };
      } finally {
        if (isCurrent(token, profileId) && requestRevision === historyRevision) {
          state.historyLoading = false; notify();
        }
      }
    }

    async function selectReport(reportId) {
      if (!state.profileId || typeof reportId !== 'string') return { ignored: true };
      clearSelection();
      const token = generation; const profileId = state.profileId; const requestRevision = ++detailRevision;
      state.detailLoading = true; notify();
      try {
        const report = await send(buildDetailRequest(profileId, reportId));
        if (!isCurrent(token, profileId) || requestRevision !== detailRevision) return { ignored: true, stale: true };
        if (!report || report.status !== 'confirmed') {
          state.detailError = safeError({ errorCode: 'CONFIRMED_REPORT_NOT_FOUND' });
          return { status: 'unavailable', errorCode: 'CONFIRMED_REPORT_NOT_FOUND' };
        }
        state.selectedReport = projectConfirmedDetail(report);
        return state.selectedReport;
      } catch (error) {
        if (isCurrent(token, profileId) && requestRevision === detailRevision) state.detailError = safeError(error);
        return { status: 'unavailable', ...safeError(error) };
      } finally {
        if (isCurrent(token, profileId) && requestRevision === detailRevision) {
          state.detailLoading = false; notify();
        }
      }
    }

    function selectedObservation(observationId) {
      return safeArray(state.selectedReport?.observations)
        .find((observation) => observation?.observationId === observationId) || null;
    }

    async function loadTrend(observationId) {
      const observation = selectedObservation(observationId);
      if (!state.profileId || !observation || state.trendLoading) return { ignored: true };
      trendRevision += 1; explanationRevision += 1;
      state.selectedObservationId = observationId;
      state.trend = null; state.trendError = null; state.explanation = null; state.explanationError = null;
      const identity = observationIdentity(observation);
      if (!identity) {
        state.trend = {
          status: 'not_comparable', reasonCode: 'ANALYTE_IDENTITY_UNVERIFIED',
          message: SAFE_TREND_MESSAGE, observations: [], direction: null,
        };
        notify(); return state.trend;
      }
      const token = generation; const profileId = state.profileId; const requestRevision = trendRevision;
      state.trendLoading = true; notify();
      try {
        const trend = await send(buildTrendRequest(profileId, identity));
        if (!isCurrent(token, profileId) || requestRevision !== trendRevision) return { ignored: true, stale: true };
        state.trend = trend && (trend.status === 'available' || trend.status === 'not_comparable')
          ? trend : { status: 'not_comparable', reasonCode: 'ANALYTE_IDENTITY_UNVERIFIED', message: SAFE_TREND_MESSAGE, observations: [] };
        return state.trend;
      } catch (error) {
        if (isCurrent(token, profileId) && requestRevision === trendRevision) state.trendError = safeError(error);
        return { status: 'unavailable', ...safeError(error) };
      } finally {
        if (isCurrent(token, profileId) && requestRevision === trendRevision) {
          state.trendLoading = false; notify();
        }
      }
    }

    async function generateExplanation(observationId = state.selectedObservationId) {
      const observation = selectedObservation(observationId);
      if (!state.profileId || !observation || state.explanationLoading) return { ignored: true };
      const identity = observationIdentity(observation);
      state.selectedObservationId = observationId;
      state.explanation = null; state.explanationError = null;
      if (!identity) {
        state.explanationError = safeError({ errorCode: 'ANALYTE_IDENTITY_UNVERIFIED' });
        notify(); return { status: 'unavailable', errorCode: 'ANALYTE_IDENTITY_UNVERIFIED' };
      }
      const token = generation; const profileId = state.profileId; const requestRevision = ++explanationRevision;
      state.explanationLoading = true; notify();
      try {
        const explanation = await send(buildExplanationRequest(profileId, identity));
        if (!isCurrent(token, profileId) || requestRevision !== explanationRevision) return { ignored: true, stale: true };
        if (explanation?.status === 'answer' || explanation?.status === 'escalation') {
          state.explanation = explanation;
        } else {
          state.explanationError = safeError({
            errorCode: explanation?.errorCode || 'LAB_EXPLANATION_UNAVAILABLE',
          });
        }
        return explanation;
      } catch (error) {
        if (isCurrent(token, profileId) && requestRevision === explanationRevision) {
          state.explanationError = safeError(error);
        }
        return { status: 'unavailable', ...safeError(error) };
      } finally {
        if (isCurrent(token, profileId) && requestRevision === explanationRevision) {
          state.explanationLoading = false; notify();
        }
      }
    }

    return {
      snapshot,
      setProfile(profileId) {
        const normalized = typeof profileId === 'string' && profileId ? profileId : null;
        if (state.profileId === normalized) return false;
        generation += 1; historyRevision += 1; detailRevision += 1; trendRevision += 1; explanationRevision += 1;
        state = freshState(normalized);
        notify(); return true;
      },
      async open() {
        if (!state.profileId) { state.historyError = safeError({ errorCode: 'CARE_PROFILE_REQUIRED' }); notify(); return { ignored: true }; }
        state.opened = true; notify();
        if (!state.reports.length) return loadHistory();
        return snapshot();
      },
      close() { state.opened = false; clearSelection(); notify(); },
      loadHistory,
      loadMore() { return loadHistory({ append: true }); },
      selectReport,
      closeReport() { clearSelection(); notify(); },
      loadTrend,
      generateExplanation,
    };
  }

  function appendText(doc, parent, tag, className, value) {
    const element = doc.createElement(tag);
    if (className) element.className = className;
    element.textContent = safeText(value);
    parent.appendChild(element);
    return element;
  }

  function clearNode(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  function displayValue(value, fallback = 'ไม่ระบุในรายงาน') {
    if (value === null || value === undefined || value === '') return fallback;
    return String(value);
  }

  function renderHistory(doc, container, reports, onOpen) {
    clearNode(container);
    safeArray(reports).forEach((report) => {
      const card = doc.createElement('article'); card.className = 'lab-report-card';
      const heading = appendText(doc, card, 'h4', 'lab-report-card__place', reportPlace(report));
      heading.setAttribute?.('aria-label', `ผลตรวจจาก ${reportPlace(report)}`);
      appendText(doc, card, 'p', 'lab-report-card__date', `วันที่เก็บตัวอย่าง/รายงาน: ${formatDate(reportDate(report))}`);
      appendText(doc, card, 'span', 'lab-status lab-status--confirmed', 'ยืนยันแล้ว');
      const button = appendText(doc, card, 'button', 'btn btn-outline lab-report-open', 'ดูรายละเอียดผลตรวจ');
      button.type = 'button'; button.addEventListener('click', () => onOpen(report.reportId));
      container.appendChild(card);
    });
  }

  function renderObservation(doc, container, observation, actions) {
    const card = doc.createElement('article'); card.className = 'lab-observation';
    appendText(doc, card, 'h5', 'lab-observation__name', displayValue(observation.analyteNameSource));
    const result = doc.createElement('dl'); result.className = 'lab-observation__facts';
    const fact = (label, value, className = '') => {
      const row = doc.createElement('div'); row.className = `lab-observation__fact ${className}`.trim();
      appendText(doc, row, 'dt', '', label); appendText(doc, row, 'dd', '', displayValue(value)); result.appendChild(row);
    };
    fact('ผลตามต้นฉบับ', observation.sourceValueText);
    fact('หน่วย', observation.sourceUnit);
    fact('ช่วงอ้างอิง', observation.referenceRangeText);
    if (observation.abnormalFlagSource) {
      fact('ธงจากแหล่งข้อมูล', `ตามรายงานต้นฉบับ: ${observation.abnormalFlagSource}`, 'lab-observation__fact--flag');
    }
    if (observation.specimenSource) fact('ชนิดตัวอย่าง', observation.specimenSource);
    if (observation.methodSource) fact('วิธีตรวจ', observation.methodSource);
    card.appendChild(result);
    const actionRow = doc.createElement('div'); actionRow.className = 'lab-observation__actions';
    const trendButton = appendText(doc, actionRow, 'button', 'btn btn-outline', 'ดูแนวโน้มอย่างปลอดภัย');
    trendButton.type = 'button'; trendButton.addEventListener('click', () => actions.onTrend(observation.observationId));
    const explainButton = appendText(doc, actionRow, 'button', 'btn btn-primary', 'ให้พี่หมอช่วยอธิบาย');
    explainButton.type = 'button'; explainButton.addEventListener('click', () => actions.onExplain(observation.observationId));
    actionRow.querySelectorAll?.('button').forEach((button) => { button.disabled = actions.disabled; });
    if (!actionRow.querySelectorAll) { trendButton.disabled = actions.disabled; explainButton.disabled = actions.disabled; }
    card.appendChild(actionRow); container.appendChild(card);
  }

  function renderTrend(doc, container, trend, selectedName) {
    clearNode(container);
    if (!trend) return;
    container.hidden = false;
    appendText(doc, container, 'h5', 'lab-subsection-title', `แนวโน้ม: ${safeText(trend.sourceDisplayName, selectedName || 'รายการตรวจ')}`);
    if (trend.status !== 'available') {
      appendText(doc, container, 'p', 'lab-safe-unavailable', SAFE_TREND_MESSAGE);
      appendText(doc, container, 'p', 'lab-safe-reason', TREND_REASON_LABELS[trend.reasonCode] || 'ข้อมูลยังไม่เพียงพอสำหรับการเปรียบเทียบ');
      return;
    }
    appendText(doc, container, 'p', 'lab-trend-direction', `ทิศทางของค่า: ${DIRECTION_LABELS[trend.direction] || 'ไม่ระบุ'}`);
    const list = doc.createElement('ol'); list.className = 'lab-trend-list';
    safeArray(trend.observations, 50).forEach((point) => {
      const item = doc.createElement('li');
      appendText(doc, item, 'time', 'lab-trend-list__date', formatDate(point.specimenCollectedAt));
      appendText(doc, item, 'span', 'lab-trend-list__value', `${displayValue(point.sourceValueText)} ${safeText(point.sourceUnit)}`.trim());
      if (point.referenceRangeText) appendText(doc, item, 'span', 'lab-trend-list__range', `ช่วงอ้างอิงตามรายงาน: ${point.referenceRangeText}`);
      list.appendChild(item);
    });
    container.appendChild(list);
    if (trend.rangesDiffer) appendText(doc, container, 'p', 'lab-range-caveat', 'ช่วงอ้างอิงของแต่ละรายงานแตกต่างกัน โปรดพิจารณาตามแหล่งที่มา');
  }

  function renderStringList(doc, parent, heading, values) {
    const safeValues = safeArray(values, 30).filter((value) => typeof value === 'string' && value);
    if (!safeValues.length) return;
    appendText(doc, parent, 'h6', 'lab-explanation__heading', heading);
    const list = doc.createElement('ul'); list.className = 'lab-explanation__list';
    safeValues.forEach((value) => appendText(doc, list, 'li', '', value)); parent.appendChild(list);
  }

  function renderExplanation(doc, container, explanation) {
    clearNode(container);
    if (!explanation) return;
    container.hidden = false;
    appendText(doc, container, 'h5', 'lab-subsection-title', 'คำอธิบายจากพี่หมอ Plus');
    if (explanation.status === 'escalation') {
      appendText(doc, container, 'p', 'lab-explanation__safety', safeText(explanation.message, 'กรุณาติดต่อบริการฉุกเฉินหรือสถานพยาบาลทันที'));
      return;
    }
    appendText(doc, container, 'h6', 'lab-explanation__heading', 'สรุป');
    appendText(doc, container, 'p', '', safeText(explanation.summary));
    appendText(doc, container, 'h6', 'lab-explanation__heading', 'รายการตรวจนี้วัดอะไร');
    appendText(doc, container, 'p', '', safeText(explanation.testExplanation));
    const facts = safeArray(explanation.confirmedFacts, 50).map((fact) => {
      if (!fact || typeof fact !== 'object') return '';
      return `${formatDate(fact.observedAt)} · ${displayValue(fact.analyteNameSource)} · ${displayValue(fact.sourceValueText)} ${safeText(fact.sourceUnit)}`.trim();
    }).filter(Boolean);
    renderStringList(doc, container, 'ข้อมูลที่ยืนยันแล้ว', facts);
    if (explanation.trendExplanation) {
      appendText(doc, container, 'h6', 'lab-explanation__heading', 'แนวโน้ม');
      appendText(doc, container, 'p', '', explanation.trendExplanation);
    }
    if (explanation.rangeCaveat) {
      appendText(doc, container, 'h6', 'lab-explanation__heading', 'ข้อควรทราบเรื่องช่วงอ้างอิง');
      appendText(doc, container, 'p', '', explanation.rangeCaveat);
    }
    renderStringList(doc, container, 'คำถามที่อาจถามแพทย์', explanation.questionsForClinician);
    if (explanation.safetyNotice) appendText(doc, container, 'p', 'lab-explanation__safety', explanation.safetyNotice);
    if (explanation.disclaimer) appendText(doc, container, 'p', 'lab-explanation__disclaimer', explanation.disclaimer);
  }

  function errorView(error, area) {
    const code = error?.errorCode || '';
    if (/^(?:PLUS_|NO_PLUS_|ENTITLEMENT_|INTERNAL_ENTITLEMENT)/.test(code) && code !== 'PLUS_RATE_LIMITED') {
      return { kind: 'plus', message: 'การช่วยอธิบายผลตรวจใช้สิทธิ์พี่หมอ Plus' };
    }
    if (code === 'PLUS_RATE_LIMITED') {
      const wait = error?.retryAfterSeconds ? ` ลองใหม่ในอีก ${error.retryAfterSeconds} วินาที` : '';
      return { kind: 'rate', message: `เรียกใช้ระบบช่วยอธิบายถี่เกินไป${wait}` };
    }
    if (code === 'CARE_PROFILE_REQUIRED') return { kind: 'profile', message: 'กรุณาเลือก Care Profile ก่อนดูผลตรวจ' };
    if (error?.status === 401 || error?.status === 403 || code === 'ACCESS_DENIED') {
      return { kind: 'access', message: 'ไม่สามารถเข้าถึงผลตรวจของ Care Profile นี้ได้' };
    }
    if (code === 'ANALYTE_IDENTITY_UNVERIFIED') {
      return { kind: 'identity', message: `${SAFE_TREND_MESSAGE} เนื่องยังยืนยันรายการตรวจไม่ได้` };
    }
    return {
      kind: 'unavailable',
      message: area === 'explanation'
        ? 'ตอนนี้พี่หมอยังช่วยอธิบายผลตรวจไม่ได้ กรุณาลองใหม่ภายหลัง'
        : 'โหลดข้อมูลผลตรวจไม่สำเร็จ กรุณาลองใหม่',
    };
  }

  function createController({ doc, session, getCurrentProfile, onPrepareQuestions = null, onUpgradeRequired = null }) {
    const panel = doc.getElementById('labResultsPanel');
    const patient = doc.getElementById('labResultsPatient');
    const entry = doc.getElementById('labResultsEntry');
    const workspace = doc.getElementById('labResultsWorkspace');
    const close = doc.getElementById('labResultsClose');
    const live = doc.getElementById('labResultsLive');
    const history = doc.getElementById('labHistoryList');
    const historyActions = doc.getElementById('labHistoryActions');
    const detail = doc.getElementById('labReportDetail');
    const trendBox = doc.getElementById('labTrendResult');
    const explanationBox = doc.getElementById('labExplanationResult');

    function renderError(parent, error, area, retry) {
      if (!error) return;
      const view = errorView(error, area);
      appendText(doc, parent, 'p', `lab-error lab-error--${view.kind}`, view.message);
      if (view.kind === 'plus' && typeof onUpgradeRequired === 'function') {
        const upgrade = appendText(doc, parent, 'button', 'btn btn-gold lab-retry', 'ดูพี่หมอ Plus — 59 บาท / 30 วัน');
        upgrade.type = 'button'; upgrade.addEventListener('click', onUpgradeRequired); return;
      }
      if (retry) {
        const button = appendText(doc, parent, 'button', 'btn btn-outline lab-retry', 'ลองใหม่');
        button.type = 'button'; button.addEventListener('click', retry);
      }
    }

    function selectedName(state) {
      return safeArray(state.selectedReport?.observations)
        .find((observation) => observation?.observationId === state.selectedObservationId)?.analyteNameSource || '';
    }

    function render(state) {
      const profile = getCurrentProfile();
      const profileId = profile?.profile?.care_profile_id || null;
      panel.hidden = !profileId;
      patient.textContent = profileId
        ? `Care Profile ที่เลือก: ${safeText(profile?.profile?.patient_name, 'ผู้รับการดูแล')}` : '';
      workspace.hidden = !state.opened;
      entry.hidden = state.opened;
      entry.disabled = !profileId;
      close.disabled = state.historyLoading || state.detailLoading;

      clearNode(live);
      if (state.historyLoading && !state.reports.length) appendText(doc, live, 'p', 'lab-loading', 'กำลังโหลดผลตรวจที่ยืนยันแล้ว...');
      renderError(live, state.historyError, 'history', () => session.loadHistory());

      renderHistory(doc, history, state.reports, (reportId) => session.selectReport(reportId));
      if (!state.historyLoading && !state.historyError && !state.reports.length && state.opened) {
        appendText(doc, history, 'p', 'lab-empty', 'ยังไม่มีผลตรวจที่ยืนยันแล้ว');
      }
      clearNode(historyActions);
      if (state.nextCursor) {
        const more = appendText(doc, historyActions, 'button', 'btn btn-outline lab-load-more', state.historyLoading ? 'กำลังโหลด...' : 'โหลดผลตรวจเพิ่ม');
        more.type = 'button'; more.disabled = state.historyLoading; more.addEventListener('click', () => session.loadMore());
      }

      clearNode(detail); clearNode(trendBox); clearNode(explanationBox);
      detail.hidden = !(state.detailLoading || state.detailError || state.selectedReport);
      trendBox.hidden = true; explanationBox.hidden = true;
      if (state.detailLoading) appendText(doc, detail, 'p', 'lab-loading', 'กำลังโหลดรายละเอียดผลตรวจ...');
      renderError(detail, state.detailError, 'detail', null);
      if (state.selectedReport) {
        const back = appendText(doc, detail, 'button', 'lab-detail-back', '← กลับไปประวัติผลตรวจ');
        back.type = 'button'; back.addEventListener('click', () => session.closeReport());
        appendText(doc, detail, 'h4', 'lab-detail-title', 'รายละเอียดผลตรวจที่ยืนยันแล้ว');
        appendText(doc, detail, 'p', 'lab-detail-meta', `${reportPlace(state.selectedReport)} · ${formatDate(reportDate(state.selectedReport))}`);
        const observations = doc.createElement('div'); observations.className = 'lab-observations';
        safeArray(state.selectedReport.observations).forEach((observation) => renderObservation(doc, observations, observation, {
          disabled: state.trendLoading || state.explanationLoading,
          onTrend: (id) => session.loadTrend(id), onExplain: (id) => session.generateExplanation(id),
        }));
        if (!safeArray(state.selectedReport.observations).length) appendText(doc, observations, 'p', 'lab-empty', 'ไม่พบรายการผลตรวจที่ยืนยัน');
        detail.appendChild(observations);
        renderTrend(doc, trendBox, state.trend, selectedName(state));
        if (state.trendLoading) {
          trendBox.hidden = false;
          appendText(doc, trendBox, 'p', 'lab-loading', 'กำลังตรวจสอบว่าเปรียบเทียบแนวโน้มได้หรือไม่...');
        }
        renderError(trendBox, state.trendError, 'trend', () => session.loadTrend(state.selectedObservationId));
        if (state.trendError) trendBox.hidden = false;
        renderExplanation(doc, explanationBox, state.explanation);
        if (state.explanationLoading) {
          explanationBox.hidden = false;
          appendText(doc, explanationBox, 'p', 'lab-loading', 'พี่หมอกำลังช่วยอธิบายจากข้อมูลที่ยืนยันแล้ว...');
        }
        renderError(explanationBox, state.explanationError, 'explanation', () => session.generateExplanation());
        if (state.explanationError) explanationBox.hidden = false;
        detail.appendChild(trendBox); detail.appendChild(explanationBox);
        if (typeof onPrepareQuestions === 'function') {
          const prepare = appendText(doc, detail, 'button', 'btn btn-outline lab-prepare-questions', 'เตรียมคำถามสำหรับพบแพทย์');
          prepare.type = 'button'; prepare.addEventListener('click', onPrepareQuestions);
        }
      }
    }

    entry.addEventListener('click', () => session.open());
    close.addEventListener('click', () => session.close());
    return { render };
  }

  return {
    HISTORY_LIMIT, TREND_LIMIT, SAFE_TREND_MESSAGE, TREND_REASON_LABELS, DIRECTION_LABELS,
    safeText, formatDate, reportDate, reportPlace, observationIdentity, identityQuery,
    buildHistoryRequest, buildDetailRequest, buildTrendRequest, buildExplanationRequest,
    projectHistoryReport, projectObservation, projectConfirmedDetail, mergeReports,
    safeError, errorView, createSession, appendText, renderHistory,
    renderObservation, renderTrend, renderExplanation, createController,
  };
}));
