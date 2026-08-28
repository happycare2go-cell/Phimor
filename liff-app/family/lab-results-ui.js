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

  function toDateTimeLocalValue(value) {
    if (!value) return '';
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) return '';
    const local = new Date(parsed.getTime() - parsed.getTimezoneOffset() * 60000);
    return local.toISOString().slice(0, 16);
  }
  function buildCorrectionRequest(careProfileId,reportId,reason){return{path:`/api/care-profile/${encodeURIComponent(careProfileId)}/lab-reports/${encodeURIComponent(reportId)}/corrections`,options:{method:'POST',body:JSON.stringify({reason})}};}
  function buildVoidRequest(careProfileId,reportId,reason){return{path:`/api/care-profile/${encodeURIComponent(careProfileId)}/lab-reports/${encodeURIComponent(reportId)}/void`,options:{method:'POST',body:JSON.stringify({reason})}};}
  function buildDraftUpdateRequest(careProfileId,reportId,patch){return{path:`/api/care-profile/${encodeURIComponent(careProfileId)}/lab-reports/${encodeURIComponent(reportId)}/draft`,options:{method:'PATCH',body:JSON.stringify(patch)}};}
  function buildDraftConfirmRequest(careProfileId,reportId){return{path:`/api/care-profile/${encodeURIComponent(careProfileId)}/lab-reports/${encodeURIComponent(reportId)}/confirm`,options:{method:'POST',body:JSON.stringify({})}};}

  function projectHistoryReport(report) {
    if (!report || typeof report.reportId !== 'string' || report.status !== 'confirmed') return null;
    return {
      reportId: report.reportId, status: 'confirmed',
      laboratoryName: safeText(report.laboratoryName) || null,
      hospitalName: safeText(report.hospitalName) || null,
      specimenCollectedAt: safeText(report.specimenCollectedAt) || null,
      reportedAt: safeText(report.reportedAt) || null,
      confirmedAt: safeText(report.confirmedAt) || null,
      versionNo:Number.isFinite(Number(report.versionNo))?Number(report.versionNo):1,
      isCurrent:report.isCurrent!==false,
      mutationCapabilities:{canCreateCorrection:report.mutationCapabilities?.canCreateCorrection===true,canVoid:report.mutationCapabilities?.canVoid===true},
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

  function projectCorrectionDraft(report) {
    if (!report || typeof report.reportId !== 'string' || report.status !== 'draft') return null;
    return {
      reportId: report.reportId, status: 'draft',
      laboratoryName: safeText(report.laboratoryName) || '',
      hospitalName: safeText(report.hospitalName) || '',
      specimenCollectedAt: safeText(report.specimenCollectedAt) || null,
      reportedAt: safeText(report.reportedAt) || null,
      observations: safeArray(report.observations).map(projectObservation).filter(Boolean),
    };
  }

  function correctionDraftPatch(draft) {
    return {
      laboratoryName: safeText(draft?.laboratoryName) || null,
      hospitalName: safeText(draft?.hospitalName) || null,
      specimenCollectedAt: safeText(draft?.specimenCollectedAt) || null,
      reportedAt: safeText(draft?.reportedAt) || null,
      observations: safeArray(draft?.observations, 100).map((observation,index) => {
        const sourceValueText=safeText(observation?.sourceValueText);
        const numeric=/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)$/.test(sourceValueText.trim())?Number(sourceValueText):null;
        return {
        sourceOrdinal:index+1,
        analyteNameSource: safeText(observation?.analyteNameSource),
        sourceValueText,
        valueType:numeric===null?'text':'numeric',numericValue:numeric,textValue:numeric===null?sourceValueText:null,
        sourceUnit: safeText(observation?.sourceUnit) || null,
        referenceRangeText: safeText(observation?.referenceRangeText) || null,
        abnormalFlagSource: safeText(observation?.abnormalFlagSource) || null,
        specimenSource: safeText(observation?.specimenSource) || null,
        methodSource: safeText(observation?.methodSource) || null,
      };}),
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
      actionNotice:null, correctionDraft:null, correctionBusy:false, correctionError:null,
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
      correctionDraft: state.correctionDraft ? {
        ...state.correctionDraft,
        observations: safeArray(state.correctionDraft.observations).map((item) => ({ ...item })),
      } : null,
    });
    const notify = () => onChange(snapshot());
    const send = (descriptor) => request(descriptor.path, descriptor.options);
    const isCurrent = (token, profileId) => token === generation && state.profileId === profileId;

    function clearSelection() {
      detailRevision += 1; trendRevision += 1; explanationRevision += 1;
      state.selectedReport = null; state.detailLoading = false; state.detailError = null;
      state.correctionDraft = null; state.correctionBusy = false; state.correctionError = null;
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

    async function mutate(kind,reportId,reason){
      if(!state.profileId||state.detailLoading||state.correctionBusy)return{ignored:true};
      const token=generation;const profileId=state.profileId;const requestRevision=++detailRevision;
      state.detailLoading=true;state.detailError=null;state.actionNotice=null;notify();
      try{
        const result=await send(kind==='correction'?buildCorrectionRequest(profileId,reportId,reason):buildVoidRequest(profileId,reportId,reason));
        if(!isCurrent(token,profileId)||requestRevision!==detailRevision)return{ignored:true,stale:true};
        state.selectedReport=kind==='void'?null:state.selectedReport;
        if(kind==='correction'){
          state.correctionDraft=projectCorrectionDraft(result);
          if(!state.correctionDraft)throw Object.assign(new Error('INVALID_CORRECTION_DRAFT'),{errorCode:'INVALID_CORRECTION_DRAFT'});
          state.selectedReport=null;
        }
        state.actionNotice=kind==='correction'?'สร้างฉบับแก้ไขแล้ว กรุณาตรวจข้อมูลก่อนยืนยัน':'ยกเลิกรายการแล้ว ประวัติเดิมยังถูกเก็บไว้';
        await loadHistory();return result;
      }catch(error){if(isCurrent(token,profileId)&&requestRevision===detailRevision)state.detailError=safeError(error);throw error;}
      finally{if(isCurrent(token,profileId)&&requestRevision===detailRevision){state.detailLoading=false;notify();}}
    }

    async function saveCorrection(draft,{confirm=false}={}){
      if(!state.profileId||!state.correctionDraft||state.correctionBusy)return{ignored:true};
      const token=generation;const profileId=state.profileId;const reportId=state.correctionDraft.reportId;
      state.correctionBusy=true;state.correctionError=null;notify();
      try{
        const updated=await send(buildDraftUpdateRequest(profileId,reportId,correctionDraftPatch(draft)));
        if(!isCurrent(token,profileId)||state.correctionDraft?.reportId!==reportId)return{ignored:true,stale:true};
        const projected=projectCorrectionDraft(updated);
        if(!projected)throw Object.assign(new Error('INVALID_CORRECTION_DRAFT'),{errorCode:'INVALID_CORRECTION_DRAFT'});
        state.correctionDraft=projected;
        if(!confirm){state.actionNotice='บันทึกฉบับรอตรวจแล้ว';return updated;}
        const confirmed=await send(buildDraftConfirmRequest(profileId,reportId));
        if(!isCurrent(token,profileId)||state.correctionDraft?.reportId!==reportId)return{ignored:true,stale:true};
        state.correctionBusy=false;state.correctionDraft=null;state.actionNotice='ยืนยันผลตรวจฉบับแก้ไขแล้ว';
        await loadHistory();return confirmed;
      }catch(error){
        if(isCurrent(token,profileId)&&state.correctionDraft?.reportId===reportId)state.correctionError=safeError(error);
        throw error;
      }finally{
        if(isCurrent(token,profileId)&&state.correctionDraft?.reportId===reportId){state.correctionBusy=false;notify();}
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
      createCorrection:(reportId,reason)=>mutate('correction',reportId,reason),
      voidReport:(reportId,reason)=>mutate('void',reportId,reason),
      saveCorrection:(draft)=>saveCorrection(draft),
      confirmCorrection:(draft)=>saveCorrection(draft,{confirm:true}),
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

  function renderCorrectionEditor(doc, container, draft, { busy = false, error = null, onSave, onConfirm } = {}) {
    const form = doc.createElement('form'); form.className = 'lab-correction-editor';
    appendText(doc, form, 'h4', 'lab-detail-title', 'ตรวจฉบับแก้ไข');
    appendText(doc, form, 'p', 'lab-correction-editor__note', 'ตรวจข้อมูลให้ถูกต้องก่อนยืนยัน ฉบับเดิมจะยังคงอยู่ในประวัติ');
    const field = (labelText, name, value, type = 'text', maxLength = 500) => {
      const label = doc.createElement('label'); label.className = 'lab-correction-field';
      appendText(doc, label, 'span', '', labelText);
      const input = doc.createElement('input'); input.type = type; input.name = name;
      input.value = type === 'datetime-local' ? toDateTimeLocalValue(value) : safeText(value);
      if (maxLength) input.maxLength = maxLength; input.disabled = busy; label.appendChild(input); form.appendChild(label);
      return input;
    };
    const hospital = field('โรงพยาบาล', 'hospitalName', draft.hospitalName);
    const laboratory = field('ห้องปฏิบัติการ', 'laboratoryName', draft.laboratoryName);
    const collected = field('วันเวลาเก็บตัวอย่าง', 'specimenCollectedAt', draft.specimenCollectedAt, 'datetime-local', 0);
    const reported = field('วันเวลารายงานผล', 'reportedAt', draft.reportedAt, 'datetime-local', 0);
    const observations = doc.createElement('div'); observations.className = 'lab-correction-observations';
    safeArray(draft.observations).forEach((observation, index) => {
      const card = doc.createElement('fieldset'); card.className = 'lab-correction-observation'; card.disabled = busy;
      appendText(doc, card, 'legend', '', `รายการตรวจ ${index + 1}`);
      const observationField = (labelText, name, value) => {
        const label = doc.createElement('label'); label.className = 'lab-correction-field';
        appendText(doc, label, 'span', '', labelText);
        const input = doc.createElement('input'); input.type = 'text'; input.name = name; input.value = safeText(value); input.maxLength = 500;
        label.appendChild(input); card.appendChild(label); return input;
      };
      const inputs = {
        analyteNameSource: observationField('รายการตรวจ', 'analyteNameSource', observation.analyteNameSource),
        sourceValueText: observationField('ผลตามต้นฉบับ', 'sourceValueText', observation.sourceValueText),
        sourceUnit: observationField('หน่วย', 'sourceUnit', observation.sourceUnit),
        referenceRangeText: observationField('ช่วงอ้างอิง', 'referenceRangeText', observation.referenceRangeText),
        abnormalFlagSource: observationField('ธงจากแหล่งข้อมูล', 'abnormalFlagSource', observation.abnormalFlagSource),
        specimenSource: observationField('ชนิดตัวอย่าง', 'specimenSource', observation.specimenSource),
        methodSource: observationField('วิธีตรวจ', 'methodSource', observation.methodSource),
      };
      card.__draftInputs = inputs; observations.appendChild(card);
    });
    form.appendChild(observations);
    if (error) {
      const view = errorView(error, 'correction');
      appendText(doc, form, 'p', `lab-error lab-error--${view.kind}`, view.message);
    }
    const payload = () => ({
      hospitalName: hospital.value, laboratoryName: laboratory.value,
      specimenCollectedAt: collected.value || null, reportedAt: reported.value || null,
      observations: Array.from(observations.children || []).map((card) => Object.fromEntries(
        Object.entries(card.__draftInputs || {}).map(([key, input]) => [key, input.value])
      )),
    });
    const actions = doc.createElement('div'); actions.className = 'lab-correction-editor__actions';
    const save = appendText(doc, actions, 'button', 'btn btn-outline', busy ? 'กำลังบันทึก...' : 'บันทึกฉบับรอตรวจ');
    save.type = 'button'; save.disabled = busy; save.addEventListener('click', () => onSave(payload()));
    const confirm = appendText(doc, actions, 'button', 'btn btn-primary', busy ? 'กำลังยืนยัน...' : 'ยืนยันฉบับแก้ไข');
    confirm.type = 'button'; confirm.disabled = busy; confirm.addEventListener('click', () => onConfirm(payload()));
    form.appendChild(actions); container.appendChild(form);
    return form;
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
        : area === 'correction'
          ? 'ดำเนินการไม่สำเร็จ กรุณาตรวจข้อมูลแล้วลองอีกครั้ง'
          : 'โหลดข้อมูลผลตรวจไม่สำเร็จ กรุณาลองใหม่',
    };
  }

  function createController({ doc, session, getCurrentProfile, onPrepareQuestions = null, onUpgradeRequired = null, actionDialog = null }) {
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
      if(state.actionNotice)appendText(doc,live,'p','lab-action-notice',state.actionNotice);
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
      detail.hidden = !(state.detailLoading || state.detailError || state.selectedReport || state.correctionDraft);
      trendBox.hidden = true; explanationBox.hidden = true;
      if (state.detailLoading) appendText(doc, detail, 'p', 'lab-loading', 'กำลังโหลดรายละเอียดผลตรวจ...');
      renderError(detail, state.detailError, 'detail', null);
      if (state.correctionDraft) {
        renderCorrectionEditor(doc, detail, state.correctionDraft, {
          busy: state.correctionBusy, error: state.correctionError,
          onSave: (draft) => session.saveCorrection(draft),
          onConfirm: (draft) => session.confirmCorrection(draft),
        });
      }
      if (state.selectedReport) {
        const back = appendText(doc, detail, 'button', 'lab-detail-back', '← กลับไปประวัติผลตรวจ');
        back.type = 'button'; back.addEventListener('click', () => session.closeReport());
        appendText(doc, detail, 'h4', 'lab-detail-title', 'รายละเอียดผลตรวจที่ยืนยันแล้ว');
        appendText(doc, detail, 'p', 'lab-detail-meta', `${reportPlace(state.selectedReport)} · ${formatDate(reportDate(state.selectedReport))}`);
        if(state.selectedReport.mutationCapabilities?.canCreateCorrection||state.selectedReport.mutationCapabilities?.canVoid){
          const actionRow=doc.createElement('div');actionRow.className='lab-record-actions';
          if(state.selectedReport.mutationCapabilities.canCreateCorrection){const correction=appendText(doc,actionRow,'button','btn btn-outline','สร้างฉบับแก้ไข');correction.type='button';correction.addEventListener('click',()=>runMutation('correction',state.selectedReport));}
          if(state.selectedReport.mutationCapabilities.canVoid){const voidButton=appendText(doc,actionRow,'button','btn lab-record-void','ยกเลิกรายการ');voidButton.type='button';voidButton.addEventListener('click',()=>runMutation('void',state.selectedReport));}
          detail.appendChild(actionRow);
        }
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

    function runMutation(kind,report){if(!actionDialog)return null;const correction=kind==='correction';return actionDialog.open({
      title:correction?'สร้างฉบับแก้ไข':'ยกเลิกผลตรวจรายการนี้?',
      explanation:correction?'ระบบจะสร้างฉบับใหม่ให้ตรวจแก้ไข โดยเก็บผลตรวจฉบับเดิมไว้':'รายการจะไม่ถูกใช้เป็นข้อมูลปัจจุบันอีกต่อไป แต่ประวัติเดิมจะยังถูกเก็บไว้',
      confirmLabel:correction?'สร้างฉบับแก้ไข':'ยืนยันยกเลิกรายการ',danger:!correction,
      reasonRequired:correction?'กรุณาระบุเหตุผลที่สร้างฉบับแก้ไข':'กรุณาระบุเหตุผลที่ยกเลิกรายการ',
      onConfirm:(reason)=>correction?session.createCorrection(report.reportId,reason):session.voidReport(report.reportId,reason),
    });}

    entry.addEventListener('click', () => session.open());
    close.addEventListener('click', () => session.close());
    return { render };
  }

  return {
    HISTORY_LIMIT, TREND_LIMIT, SAFE_TREND_MESSAGE, TREND_REASON_LABELS, DIRECTION_LABELS,
    safeText, formatDate, reportDate, reportPlace, observationIdentity, identityQuery,
    buildHistoryRequest, buildDetailRequest, buildTrendRequest, buildExplanationRequest,
    buildCorrectionRequest,buildVoidRequest,buildDraftUpdateRequest,buildDraftConfirmRequest,
    projectHistoryReport, projectObservation, projectConfirmedDetail,projectCorrectionDraft,correctionDraftPatch, mergeReports,
    safeError, errorView, createSession, appendText, renderHistory,renderCorrectionEditor,
    renderObservation, renderTrend, renderExplanation, createController,
  };
}));
