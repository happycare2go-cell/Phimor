const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

process.env.NODE_ENV = 'test';

const db = require('../backend/db');
const { createLabResultService } = require('../backend/services/labResultService');
const { LabDomainError, normalizeObservation } = require('../backend/domain/lab');

function fixture({ failEventType = null, serviceOverrides = {} } = {}) {
  let sequence = 0;
  let state = { reports: [], observations: [], sources: [], events: [] };
  const locks = new Map();
  const timestamp = () => `2026-08-26T00:00:${String(sequence).padStart(2, '0')}.000Z`;
  const clone = (value) => structuredClone(value);
  const rowObservation = (reportId, value, observationId) => ({
    observation_id: observationId, report_id: reportId,
    source_ordinal: value.sourceOrdinal, analyte_name_source: value.analyteNameSource,
    source_value_text: value.sourceValueText, value_type: value.valueType,
    numeric_value: value.numericValue, text_value: value.textValue,
    source_unit: value.sourceUnit, reference_range_text: value.referenceRangeText,
    reference_low: value.referenceLow, reference_high: value.referenceHigh,
    abnormal_flag_source: value.abnormalFlagSource, specimen_source: value.specimenSource,
    method_source: value.methodSource, loinc_code: value.loincCode,
    loinc_verification_source: value.loincVerificationSource,
    loinc_verified_by: value.loincVerifiedBy, loinc_verified_at: value.loincVerifiedAt,
    ucum_unit: value.ucumUnit, normalized_numeric_value: value.normalizedNumericValue,
    unit_normalization_source: value.unitNormalizationSource,
    comparison_key: value.comparisonKey, source_page: value.sourcePage,
    source_region: value.sourceRegion, extraction_confidence: value.extractionConfidence,
    created_at: timestamp(), updated_at: timestamp(),
  });
  const rowSource = (reportId, value, sourceId) => ({
    source_id: sourceId, report_id: reportId, source_kind: value.sourceKind,
    pending_card_id: value.pendingCardId, source_reference: value.sourceReference,
    content_sha256: value.contentSha256, mime_type: value.mimeType,
    byte_size: value.byteSize, page_number: value.pageNumber,
    storage_status: value.storageStatus, retention_until: value.retentionUntil,
    purged_at: value.purgedAt, created_at: timestamp(),
  });
  const repository = {
    async createReport(record) {
      if (state.reports.some((row) => row.report_group_id === record.report_group_id
        && row.version_no === record.version_no)) {
        const error = new Error('unique'); error.code = '23505'; throw error;
      }
      const row = {
        ...clone(record), status: 'draft', confirmed_by_actor_type: null,
        confirmed_by_actor_id: null, confirmed_at: null, voided_at: null,
        void_reason: null, created_at: timestamp(), updated_at: timestamp(),
        database_now: timestamp(),
      };
      state.reports.push(row); return clone(row);
    },
    async insertObservations(reportId, observations, makeId) {
      const rows = observations.map((value) => rowObservation(reportId, value, makeId()));
      state.observations.push(...rows); return clone(rows);
    },
    async insertSources(reportId, sources, makeId) {
      const rows = sources.map((value) => rowSource(reportId, value, makeId()));
      state.sources.push(...rows); return clone(rows);
    },
    async insertEvent(record) {
      if (record.event_type === failEventType) throw new Error('injected event failure');
      const duplicate = record.idempotency_key && state.events.find((row) => row.idempotency_key === record.idempotency_key);
      if (duplicate) return null;
      const row = { ...clone(record), occurred_at: timestamp() };
      state.events.push(row); return clone(row);
    },
    async findReport(reportId) { return clone(state.reports.find((row) => row.report_id === reportId) || null); },
    async findReportForUpdate(reportId) { return this.findReport(reportId); },
    async findLatestVersionForUpdate(groupId) {
      return clone(state.reports.filter((row) => row.report_group_id === groupId)
        .sort((a, b) => b.version_no - a.version_no)[0] || null);
    },
    async listObservations(reportId) {
      return clone(state.observations.filter((row) => row.report_id === reportId)
        .sort((a, b) => a.source_ordinal - b.source_ordinal));
    },
    async listSources(reportId) { return clone(state.sources.filter((row) => row.report_id === reportId)); },
    async listEvents(reportId) {
      return clone(state.events.filter((row) => row.report_id === reportId)
        .sort((a, b) => b.occurred_at.localeCompare(a.occurred_at)));
    },
    async updateDraftReport(record) {
      const index = state.reports.findIndex((row) => row.report_id === record.report_id && row.status === 'draft');
      if (index < 0) return null;
      state.reports[index] = {
        ...state.reports[index], appointment_id: record.appointment_id,
        laboratory_name: record.laboratory_name, hospital_name: record.hospital_name,
        specimen_collected_at: record.specimen_collected_at, reported_at: record.reported_at,
        retention_until: record.retention_until, updated_at: timestamp(),
      };
      return clone(state.reports[index]);
    },
    async replaceObservations(reportId, observations, makeId) {
      state.observations = state.observations.filter((row) => row.report_id !== reportId);
      return this.insertObservations(reportId, observations, makeId);
    },
    async replaceSources(reportId, sources, makeId) {
      state.sources = state.sources.filter((row) => row.report_id !== reportId);
      return this.insertSources(reportId, sources, makeId);
    },
    async confirmReport(reportId, actor) {
      const index = state.reports.findIndex((row) => row.report_id === reportId && row.status === 'draft');
      if (index < 0) return null;
      state.reports[index] = {
        ...state.reports[index], status: 'confirmed',
        confirmed_by_actor_type: actor.actorType, confirmed_by_actor_id: actor.actorId,
        confirmed_at: timestamp(), updated_at: timestamp(),
      };
      return clone(state.reports[index]);
    },
    async voidReport(reportId, reason) {
      const index = state.reports.findIndex((row) => row.report_id === reportId && row.status === 'confirmed');
      if (index < 0) return null;
      state.reports[index] = {
        ...state.reports[index], status: 'voided', voided_at: timestamp(),
        void_reason: reason, updated_at: timestamp(),
      };
      return clone(state.reports[index]);
    },
    async listReports({ careProfileId, includeDrafts, includeHistory, cursor, limit }) {
      let rows = state.reports.filter((row) => row.care_profile_id === careProfileId);
      if (!includeHistory) {
        const latestAuthoritative = new Map();
        for (const row of rows.filter((item) => ['confirmed', 'voided'].includes(item.status))) {
          const old = latestAuthoritative.get(row.report_group_id);
          if (!old || row.version_no > old.version_no) latestAuthoritative.set(row.report_group_id, row);
        }
        rows = [...latestAuthoritative.values()].filter((row) => row.status === 'confirmed')
          .concat(includeDrafts ? rows.filter((row) => row.status === 'draft') : []);
      } else rows = rows.filter((row) => row.status !== 'draft' || includeDrafts);
      rows = rows.filter((row) => includeHistory || row.status !== 'voided').map((row) => ({
        ...row, is_authoritative: row.status === 'confirmed'
          && !state.reports.some((item) => item.report_group_id === row.report_group_id
            && ['confirmed', 'voided'].includes(item.status) && item.version_no > row.version_no),
        sort_time: row.specimen_collected_at || row.reported_at || row.created_at,
      })).sort((a, b) => b.sort_time.localeCompare(a.sort_time) || b.report_id.localeCompare(a.report_id));
      if (cursor) rows = rows.filter((row) => row.sort_time < cursor.sortTime
        || (row.sort_time === cursor.sortTime && row.report_id < cursor.reportId));
      return clone(rows.slice(0, limit + 1));
    },
  };

  async function authorize({ lineUserId, careProfileId }) {
    if (careProfileId !== 'CP-1') throw new LabDomainError('ACCESS_DENIED');
    const access = {
      'U-OWNER': { principalType: 'family_owner', role: 'owner', permissions: ['*'] },
      'U-EDIT': { principalType: 'family_caregiver', role: 'caregiver', permissions: ['view', 'edit_profile'] },
      'U-VIEW': { principalType: 'family_caregiver', role: 'caregiver', permissions: ['view'] },
      'U-CENTER-STAFF': { principalType: 'center_staff', role: 'staff', permissions: ['view'] },
      'U-CENTER-MANAGER': { principalType: 'center_staff', role: 'manager', permissions: ['view', 'edit_profile'] },
      'U-CENTER-OWNER': { principalType: 'center_staff', role: 'owner', permissions: ['view', 'edit_profile'] },
      'U-PHARM': { principalType: 'pharmacist', role: 'pharmacist', permissions: [] },
    }[lineUserId];
    if (!access || lineUserId === 'U-REVOKED') throw new LabDomainError('ACCESS_DENIED');
    return access;
  }

  async function transaction(lockKey, callback) {
    const previous = locks.get(lockKey) || Promise.resolve();
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    locks.set(lockKey, previous.then(() => gate));
    await previous;
    const snapshot = clone(state);
    try { return await callback(); } catch (error) { state = snapshot; throw error; } finally { release(); }
  }

  const service = createLabResultService({
    repository, authorizeCareProfileAccess: authorize, withTransaction: transaction,
    idFactory: (prefix) => `${prefix}-${String(++sequence).padStart(4, '0')}`,
    ...serviceOverrides,
  });
  return { service, state: () => clone(state) };
}

function draftInput(overrides = {}) {
  return {
    laboratoryName: 'ห้องปฏิบัติการตัวอย่าง', hospitalName: 'โรงพยาบาลตัวอย่าง',
    specimenCollectedAt: '2026-08-20T02:00:00.000Z',
    observations: [
      { analyteNameSource: 'Glucose', sourceValueText: '110', valueType: 'numeric', numericValue: 110, sourceUnit: 'mg/dL' },
      { analyteNameSource: 'Appearance', sourceValueText: 'Clear', valueType: 'text', textValue: 'Clear' },
    ],
    sources: [{ sourceKind: 'manual', sourceReference: 'manual-entry-1', storageStatus: 'not_retained' }],
    ...overrides,
  };
}

test('numeric and text observations require mutually exclusive typed values', () => {
  assert.throws(() => normalizeObservation({ analyteNameSource:'A', sourceValueText:'1', valueType:'numeric', textValue:'1' }), /รายการ|ข้อมูล/);
  assert.throws(() => normalizeObservation({ analyteNameSource:'A', sourceValueText:'x', valueType:'text', numericValue:1, textValue:'x' }), /รายการ|ข้อมูล/);
  assert.equal(normalizeObservation({ analyteNameSource:'A', sourceValueText:'1', valueType:'numeric', numericValue:'1' }).numericValue, 1);
});

test('missing optional medical fields remain null and are never inferred', async () => {
  const { service } = fixture();
  const report = await service.createDraft({
    careProfileId:'CP-1', lineUserId:'U-OWNER',
    input:{ observations:[{analyteNameSource:'Hb',sourceValueText:'12',valueType:'numeric',numericValue:12}] },
  });
  assert.equal(report.laboratoryName, null);
  assert.equal(report.observations[0].sourceUnit, null);
  assert.equal(report.observations[0].referenceRangeText, null);
  assert.equal(report.observations[0].abnormalFlagSource, null);
  assert.equal(report.observations[0].loincCode, null);
});

test('Family owner creates a draft with ordered observations and source provenance', async () => {
  const { service } = fixture();
  const report = await service.createDraft({ careProfileId:'CP-1', lineUserId:'U-OWNER', input:draftInput() });
  assert.equal(report.status, 'draft');
  assert.deepEqual(report.observations.map((item) => item.sourceOrdinal), [1, 2]);
  assert.equal(report.sources[0].sourceReference, 'manual-entry-1');
  assert.equal(report.sources[0].storageStatus, 'not_retained');
  assert.equal(report.events[0].eventType, 'draft_created');
  assert.equal('createdByActorId' in report, false);
});

test('source input rejects raw Base64 and unsupported payload fields', async () => {
  const { service } = fixture();
  await assert.rejects(service.createDraft({
    careProfileId:'CP-1', lineUserId:'U-OWNER',
    input:draftInput({ sources:[{sourceKind:'manual',base64:'SECRET'}] }),
  }), (error) => error.code === 'UNSUPPORTED_FIELD');
});

test('appointment and pending-card provenance links must belong to the same Care Profile', async () => {
  const { service } = fixture({serviceOverrides:{
    findAppointment:async({appointmentId,careProfileId})=>appointmentId==='APT-OWN'&&careProfileId==='CP-1',
    findPendingCardCareProfile:async(cardId)=>cardId==='CARD-OWN'?'CP-1':'CP-OTHER',
  }});
  await assert.rejects(service.createDraft({
    careProfileId:'CP-1',lineUserId:'U-OWNER',input:draftInput({appointmentId:'APT-OTHER'}),
  }),(error)=>error.code==='APPOINTMENT_NOT_FOUND');
  await assert.rejects(service.createDraft({
    careProfileId:'CP-1',lineUserId:'U-OWNER',input:draftInput({
      sources:[{sourceKind:'pending_card',pendingCardId:'CARD-OTHER',storageStatus:'not_retained'}],
    }),
  }),(error)=>error.code==='SOURCE_REFERENCE_INVALID');
  const own=await service.createDraft({
    careProfileId:'CP-1',lineUserId:'U-OWNER',input:draftInput({
      appointmentId:'APT-OWN',
      sources:[{sourceKind:'pending_card',pendingCardId:'CARD-OWN',storageStatus:'not_retained'}],
    }),
  });
  assert.equal(own.appointmentId,'APT-OWN');assert.equal(own.sources[0].pendingCardId,'CARD-OWN');
});

test('source-region accepts coordinate metadata only and cannot hide document payloads', () => {
  assert.throws(()=>normalizeObservation({
    analyteNameSource:'A',sourceValueText:'1',valueType:'numeric',numericValue:1,
    sourceRegion:{base64:'SECRET'},
  }),(error)=>error.code==='INVALID_OBSERVATION');
  assert.deepEqual(normalizeObservation({
    analyteNameSource:'A',sourceValueText:'1',valueType:'numeric',numericValue:1,
    sourceRegion:{x:1,y:2,width:3,height:4,page:1},
  }).sourceRegion,{x:1,y:2,width:3,height:4,page:1});
});

test('LOINC provenance is allowlisted and verifier identity is derived by the backend', async () => {
  const { service, state } = fixture();
  const coded={
    analyteNameSource:'Glucose',sourceValueText:'110',valueType:'numeric',numericValue:110,
    loincCode:'2345-7',loincVerificationSource:'source_document',
  };
  await assert.rejects(service.createDraft({
    careProfileId:'CP-1',lineUserId:'U-OWNER',input:{observations:[{
      ...coded,loincVerifiedBy:'U-ATTACKER',loincVerifiedAt:'2000-01-01T00:00:00Z',
    }]},
  }),(error)=>error.code==='UNSUPPORTED_FIELD');
  await assert.rejects(service.createDraft({
    careProfileId:'CP-1',lineUserId:'U-OWNER',input:{observations:[{
      ...coded,loincVerificationSource:'ai_generated',
    }]},
  }),(error)=>error.code==='INVALID_OBSERVATION');
  const report=await service.createDraft({
    careProfileId:'CP-1',lineUserId:'U-OWNER',input:{observations:[coded]},
  });
  const stored=state().observations.find((row)=>row.report_id===report.reportId);
  assert.equal(stored.loinc_verified_by,'U-OWNER');assert.ok(stored.loinc_verified_at);
  assert.equal('loincVerifiedBy' in report.observations[0],false);
});

test('edit_profile caregiver can create, update and confirm a draft', async () => {
  const { service } = fixture();
  const draft = await service.createDraft({ careProfileId:'CP-1', lineUserId:'U-EDIT', input:draftInput() });
  const updated = await service.updateDraft({
    careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-EDIT', patch:{laboratoryName:'Lab B'},
  });
  assert.equal(updated.laboratoryName, 'Lab B');
  const confirmed = await service.confirmDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-EDIT' });
  assert.equal(confirmed.status, 'confirmed');
  assert.equal(confirmed.confirmedByActorType, 'family_caregiver');
});

test('view-only and revoked caregivers cannot create or confirm drafts', async () => {
  const { service } = fixture();
  await assert.rejects(service.createDraft({ careProfileId:'CP-1', lineUserId:'U-VIEW', input:draftInput() }), (error) => error.code === 'ACCESS_DENIED');
  await assert.rejects(service.createDraft({ careProfileId:'CP-1', lineUserId:'U-REVOKED', input:draftInput() }), (error) => error.code === 'ACCESS_DENIED');
  const draft = await service.createDraft({ careProfileId:'CP-1', lineUserId:'U-OWNER', input:draftInput() });
  await assert.rejects(service.confirmDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-VIEW' }), (error) => error.code === 'ACCESS_DENIED');
});

test('center staff may capture/edit draft but only owner or manager may confirm', async () => {
  const { service } = fixture();
  const draft = await service.createDraft({ careProfileId:'CP-1', lineUserId:'U-CENTER-STAFF', centerId:'C-1', input:draftInput() });
  await service.updateDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-CENTER-STAFF', centerId:'C-1', patch:{hospitalName:'Center Hospital'} });
  await assert.rejects(service.confirmDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-CENTER-STAFF', centerId:'C-1' }), (error) => error.code === 'ACCESS_DENIED');
  assert.equal((await service.confirmDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-CENTER-MANAGER', centerId:'C-1' })).status, 'confirmed');
});

test('center owner can confirm while pharmacist and cross-profile callers are denied ordinary Lab CRUD', async () => {
  const { service } = fixture();
  const draft = await service.createDraft({ careProfileId:'CP-1', lineUserId:'U-CENTER-OWNER', input:draftInput() });
  assert.equal((await service.confirmDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-CENTER-OWNER' })).status, 'confirmed');
  await assert.rejects(service.listReports({ careProfileId:'CP-1', lineUserId:'U-PHARM' }), (error) => error.code === 'ACCESS_DENIED');
  await assert.rejects(service.listReports({ careProfileId:'CP-OTHER', lineUserId:'U-OWNER' }), (error) => error.code === 'ACCESS_DENIED');
});

test('confirmation requires valid observations and derives actor/source server-side', async () => {
  const { service } = fixture();
  const empty = await service.createDraft({ careProfileId:'CP-1', lineUserId:'U-OWNER', input:{} });
  await assert.rejects(service.confirmDraft({ careProfileId:'CP-1', reportId:empty.reportId, lineUserId:'U-OWNER' }), (error) => error.code === 'CONFIRMATION_REQUIRES_OBSERVATIONS');
  const draft = await service.createDraft({ careProfileId:'CP-1', lineUserId:'U-OWNER', input:draftInput() });
  const confirmed = await service.confirmDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER' });
  assert.equal(confirmed.confirmedByActorType, 'family_owner');
  assert.equal(confirmed.events[0].actorType, 'family_owner');
  assert.equal(JSON.stringify(confirmed).includes('U-OWNER'), false);
});

test('confirmation and audit event are transactional on failure', async () => {
  const { service, state } = fixture({ failEventType:'confirmed' });
  const draft = await service.createDraft({ careProfileId:'CP-1', lineUserId:'U-OWNER', input:draftInput() });
  await assert.rejects(service.confirmDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER' }));
  assert.equal(state().reports.find((row) => row.report_id === draft.reportId).status, 'draft');
});

test('double confirmation and ordinary edits of confirmed content are rejected', async () => {
  const { service } = fixture();
  const draft = await service.createDraft({ careProfileId:'CP-1', lineUserId:'U-OWNER', input:draftInput() });
  await service.confirmDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER' });
  await assert.rejects(service.confirmDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER' }), (error) => error.code === 'REPORT_NOT_DRAFT');
  await assert.rejects(service.updateDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER', patch:{laboratoryName:'overwrite'} }), (error) => error.code === 'REPORT_NOT_DRAFT');
});

test('semantically unchanged draft update creates no lifecycle event or timestamp write', async () => {
  const { service, state } = fixture();
  const draft = await service.createDraft({ careProfileId:'CP-1', lineUserId:'U-OWNER', input:draftInput() });
  const before = state().reports.find((row) => row.report_id === draft.reportId).updated_at;
  const eventCount = state().events.length;
  const unchanged = await service.updateDraft({
    careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER',
    patch:{laboratoryName:'ห้องปฏิบัติการตัวอย่าง'},
  });
  assert.equal(unchanged.updatedAt, before);
  assert.equal(state().events.length, eventCount);
});

test('correction creates an incremented draft version and leaves prior confirmed version unchanged', async () => {
  const { service, state } = fixture();
  const draft = await service.createDraft({ careProfileId:'CP-1', lineUserId:'U-OWNER', input:draftInput() });
  const confirmed = await service.confirmDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER' });
  const correction = await service.createCorrectionDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER', reason:'แก้ค่าที่บันทึกผิด' });
  assert.equal(correction.status, 'draft');
  assert.equal(correction.reportGroupId, confirmed.reportGroupId);
  assert.equal(correction.versionNo, 2);
  assert.equal(correction.supersedesReportId, confirmed.reportId);
  const prior = state().reports.find((row) => row.report_id === confirmed.reportId);
  assert.equal(prior.status, 'confirmed'); assert.equal(prior.laboratory_name, confirmed.laboratoryName);
});

test('concurrent correction requests serialize and only one next version is created', async () => {
  const { service, state } = fixture();
  const draft = await service.createDraft({ careProfileId:'CP-1', lineUserId:'U-OWNER', input:draftInput() });
  await service.confirmDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER' });
  const results = await Promise.allSettled([
    service.createCorrectionDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER', reason:'A' }),
    service.createCorrectionDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER', reason:'B' }),
  ]);
  assert.equal(results.filter((item) => item.status === 'fulfilled').length, 1);
  assert.equal(results.filter((item) => item.status === 'rejected').length, 1);
  assert.equal(state().reports.filter((row) => row.version_no === 2).length, 1);
});

test('void requires reason, preserves history and excludes voided report from normal list', async () => {
  const { service, state } = fixture();
  const draft = await service.createDraft({ careProfileId:'CP-1', lineUserId:'U-OWNER', input:draftInput() });
  await service.confirmDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER' });
  await assert.rejects(service.voidReport({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-VIEW', reason:'ไม่มีสิทธิ์' }), (error)=>error.code==='ACCESS_DENIED');
  await assert.rejects(service.voidReport({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER', reason:'' }));
  const result = await service.voidReport({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER', reason:'เอกสารผิดคน' });
  assert.equal(result.status, 'voided'); assert.equal(result.events.some((event) => event.eventType === 'voided'), true);
  assert.equal((await service.listReports({ careProfileId:'CP-1', lineUserId:'U-OWNER' })).items.length, 0);
  assert.equal((await service.listReports({ careProfileId:'CP-1', lineUserId:'U-OWNER', includeHistory:true })).items.length, 1);
  assert.equal(state().observations.length, 2);
});

test('normal list selects only the latest confirmed correction version', async () => {
  const { service } = fixture();
  const first=await service.createDraft({careProfileId:'CP-1',lineUserId:'U-OWNER',input:draftInput()});
  await service.confirmDraft({careProfileId:'CP-1',reportId:first.reportId,lineUserId:'U-OWNER'});
  const second=await service.createCorrectionDraft({careProfileId:'CP-1',reportId:first.reportId,lineUserId:'U-OWNER',reason:'แก้ไข'});
  await service.updateDraft({careProfileId:'CP-1',reportId:second.reportId,lineUserId:'U-OWNER',patch:{laboratoryName:'เวอร์ชันใหม่'}});
  await service.confirmDraft({careProfileId:'CP-1',reportId:second.reportId,lineUserId:'U-OWNER'});
  const normal=await service.listReports({careProfileId:'CP-1',lineUserId:'U-OWNER'});
  assert.equal(normal.items.length,1);assert.equal(normal.items[0].versionNo,2);
  const history=await service.listReports({careProfileId:'CP-1',lineUserId:'U-OWNER',includeHistory:true});
  assert.deepEqual(history.items.map((item)=>item.versionNo).sort(),[1,2]);
});

test('voiding the latest correction never resurrects V1 and duplicate void appends one event', async () => {
  const { service, state } = fixture();
  const first = await service.createDraft({ careProfileId:'CP-1', lineUserId:'U-OWNER', input:draftInput() });
  await service.confirmDraft({ careProfileId:'CP-1', reportId:first.reportId, lineUserId:'U-OWNER' });
  const second = await service.createCorrectionDraft({
    careProfileId:'CP-1', reportId:first.reportId, lineUserId:'U-OWNER', reason:'แก้ไขค่า',
  });
  await service.confirmDraft({ careProfileId:'CP-1', reportId:second.reportId, lineUserId:'U-OWNER' });
  const once = await service.voidReport({
    careProfileId:'CP-1', reportId:second.reportId, lineUserId:'U-OWNER', reason:'ฉบับแก้ไขไม่ถูกต้อง',
  });
  const twice = await service.voidReport({
    careProfileId:'CP-1', reportId:second.reportId, lineUserId:'U-OWNER', reason:'retry',
  });
  assert.equal(once.status, 'voided'); assert.equal(twice.status, 'voided');
  assert.equal((await service.listReports({ careProfileId:'CP-1', lineUserId:'U-OWNER' })).items.length, 0);
  const history = await service.listReports({ careProfileId:'CP-1', lineUserId:'U-OWNER', includeHistory:true });
  assert.deepEqual(history.items.map((item) => [item.versionNo, item.status, item.isCurrent]), [
    [2, 'voided', false], [1, 'confirmed', false],
  ]);
  assert.equal(state().events.filter((event) => event.report_id === second.reportId
    && event.event_type === 'voided').length, 1);
});

test('Center-authored Lab correction and void remain manager/owner-only across the correction lifecycle', async () => {
  db.resetAll();
  await db.Residents.insert({ resident_id:'RES-1', care_profile_id:'CP-1', center_id:'CTR-1', status:'active' });
  for (const [staffId, lineUserId, role] of [
    ['STF-1', 'U-CENTER-STAFF', 'staff'], ['STF-2', 'U-CENTER-MANAGER', 'manager'],
    ['STF-3', 'U-CENTER-OWNER', 'owner'],
  ]) await db.CenterStaff.insert({ staff_id:staffId, line_user_id:lineUserId, center_id:'CTR-1', role, status:'active' });
  const { service } = fixture();
  const draft = await service.createDraft({
    careProfileId:'CP-1', lineUserId:'U-CENTER-STAFF', centerId:'CTR-1', input:draftInput(),
  });
  await service.confirmDraft({
    careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-CENTER-MANAGER', centerId:'CTR-1',
  });
  await assert.rejects(service.createCorrectionDraft({
    careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER', reason:'ไม่ควรผ่าน',
  }), { code:'ACCESS_DENIED' });
  const correction = await service.createCorrectionDraft({
    careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-CENTER-MANAGER', centerId:'CTR-1', reason:'แก้ไข',
  });
  await assert.rejects(service.confirmDraft({
    careProfileId:'CP-1', reportId:correction.reportId, lineUserId:'U-OWNER',
  }), { code:'ACCESS_DENIED' });
  await service.confirmDraft({
    careProfileId:'CP-1', reportId:correction.reportId, lineUserId:'U-CENTER-MANAGER', centerId:'CTR-1',
  });
  assert.equal((await service.voidReport({
    careProfileId:'CP-1', reportId:correction.reportId, lineUserId:'U-CENTER-OWNER',
    centerId:'CTR-1', reason:'ยกเลิก',
  })).status, 'voided');
});

test('draft visibility is restricted while confirmed reads are available to view-only caregiver', async () => {
  const { service } = fixture();
  const draft = await service.createDraft({ careProfileId:'CP-1', lineUserId:'U-OWNER', input:draftInput() });
  assert.equal((await service.listReports({ careProfileId:'CP-1', lineUserId:'U-OWNER', includeDrafts:true })).items.length, 1);
  assert.equal((await service.listReports({ careProfileId:'CP-1', lineUserId:'U-VIEW', includeDrafts:true })).items.length, 0);
  assert.equal((await service.listReports({ careProfileId:'CP-1', lineUserId:'U-VIEW', includeDrafts:true, includeHistory:true })).items.length, 0);
  await assert.rejects(service.getReport({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-VIEW' }), (error) => error.code === 'REPORT_NOT_FOUND');
  await service.confirmDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER' });
  assert.equal((await service.getReport({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-VIEW' })).status, 'confirmed');
});

test('Lab list pagination uses an opaque stable cursor', async () => {
  const { service } = fixture();
  for (let index = 0; index < 3; index += 1) {
    const draft = await service.createDraft({ careProfileId:'CP-1', lineUserId:'U-OWNER', input:draftInput({specimenCollectedAt:`2026-08-${20 + index}T00:00:00Z`}) });
    await service.confirmDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER' });
  }
  const first = await service.listReports({ careProfileId:'CP-1', lineUserId:'U-OWNER', limit:2 });
  assert.equal(first.items.length, 2); assert.ok(first.nextCursor); assert.doesNotMatch(first.nextCursor, /LABR/);
  const second = await service.listReports({ careProfileId:'CP-1', lineUserId:'U-OWNER', limit:2, cursor:first.nextCursor });
  assert.equal(second.items.length, 1); assert.equal(second.nextCursor, null);
});

test('lifecycle event metadata contains no raw Lab values and API projections omit LINE IDs', async () => {
  const { service, state } = fixture();
  const draft = await service.createDraft({ careProfileId:'CP-1', lineUserId:'U-OWNER', input:draftInput() });
  await service.updateDraft({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER', patch:{laboratoryName:'SECRET LAB VALUE'} });
  const serializedEvents = JSON.stringify(state().events);
  assert.doesNotMatch(serializedEvents, /SECRET LAB VALUE|Glucose|110|mg\/dL/);
  const response = JSON.stringify(await service.getReport({ careProfileId:'CP-1', reportId:draft.reportId, lineUserId:'U-OWNER' }));
  assert.doesNotMatch(response, /U-OWNER|lineUserId|phone|emergency_contact/i);
});

test('Lab foundation imports no AI, medication, appointment, Health History or Care Profile write service', () => {
  for (const file of ['domain/lab.js', 'services/labRepository.js', 'services/labResultService.js', 'routes/labs.js']) {
    const source = fs.readFileSync(path.resolve(__dirname, '..', 'backend', file), 'utf8');
    assert.doesNotMatch(source, /Gemini|generative|aiProvider|MedicationSnapshots\.(?:insert|update)|Medications\.(?:insert|update)|Appointments\.(?:insert|update)|careProfileHealthHistoryService|CareProfiles\.update|localStorage|sessionStorage/i);
  }
});
