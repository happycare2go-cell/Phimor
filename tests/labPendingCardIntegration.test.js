const { test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

process.env.NODE_ENV = 'test';

const db = require('../backend/db');
const centerService = require('../backend/services/centerService');
const cardService = require('../backend/services/cardService');
const aiProvider = require('../backend/providers/aiProvider');

function labClassifier(overrides = {}) {
  return {
    documentType: 'medical', documentSubtype: 'lab_report', unrelatedNote: '',
    nameGuess: 'สมศรี ใจดี', nameConfidence: 0.99,
    appointment: null, medications: [], doctorNote: null, ...overrides,
  };
}

function candidate() {
  return {
    report: { laboratoryName: 'Lab ทดสอบ', hospitalName: 'รพ.ทดสอบ' },
    observations: [{ sourceOrdinal: 1, analyteNameSource: 'Glucose', sourceValueText: '100', valueType: 'numeric', numericValue: 100, textValue: null }],
    uncertainFields: [],
  };
}

function fakeIngestion(overrides = {}) {
  const calls = [];
  const report = { reportId: 'LABR-1', status: 'draft', ...candidate().report, observations: candidate().observations, sources: [] };
  return {
    calls,
    async extractDraftCandidate(input) { calls.push({ operation: 'extract', input }); return candidate(); },
    async ensureDraftForPendingCard(input) { calls.push({ operation: 'ensure', input }); return { ok: true, created: true, report, careProfileId: 'CP-1' }; },
    async getReview(input) { calls.push({ operation: 'get', input }); return { ok: true, card: { cardId: input.cardId, residentId: 'RES-1', documentSubtype: 'lab_report', status: 'pending' }, labDraft: report, imageBase64: null }; },
    async updateReview(input) {
      calls.push({ operation: 'update', input });
      await db.PendingCards.update((item) => item.card_id === input.cardId, { lab_extraction_status: 'reviewed' });
      return { ok: true, report: { ...report, ...input.labReport } };
    },
    async confirmReview(input) { calls.push({ operation: 'confirm', input }); return { ok: true, careProfileId: 'CP-1', report: { ...report, status: 'confirmed' } }; },
    ...overrides,
  };
}

async function setup() {
  const center = await centerService.createCenter({ name: 'ศูนย์ Lab', ownerLineId: 'U-OWNER' });
  const { resident } = await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });
  await db.CareProfiles.insert({ care_profile_id: 'CP-1', owner_line_id: 'U-FAMILY', patient_name: 'สมศรี ใจดี', status: 'linked' });
  await db.Residents.update((item) => item.resident_id === resident.resident_id, { care_profile_id: 'CP-1' });
  return { center, resident };
}

beforeEach(() => {
  db.resetAll();
  aiProvider.clearMockQueue();
});

test('explicit Lab subtype invokes dedicated extraction and creates a draft-only Pending Card path', async () => {
  const { center } = await setup();
  const ingestion = fakeIngestion();
  cardService.setLabDocumentIngestionServiceForTests(ingestion);
  aiProvider.queueMockResponse(labClassifier());
  const result = await cardService.handleIncomingPhoto({
    centerId: center.center_id, imageBuffer: Buffer.from('synthetic-lab'), submittedBy: 'U-OWNER',
  });
  assert.equal(result.rejected, false);
  assert.equal(result.card.document_subtype, 'lab_report');
  assert.deepEqual(ingestion.calls.map((call) => call.operation), ['extract', 'ensure']);
  assert.equal(result.card.status, 'pending');
  assert.equal(result.card.confirmed_at, null);
});

test('medication and appointment documents remain on the legacy document path', async () => {
  const { center } = await setup();
  const ingestion = fakeIngestion();
  cardService.setLabDocumentIngestionServiceForTests(ingestion);
  aiProvider.queueMockResponse({
    documentType: 'medical', documentSubtype: 'medication', nameGuess: 'สมศรี ใจดี', nameConfidence: 0.9,
    appointment: null, medications: [{ name: 'Metformin', dose: '500 mg' }], doctorNote: null,
  });
  const result = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('med'), submittedBy: 'U-OWNER' });
  assert.equal(result.card.document_subtype, 'medication');
  assert.equal(ingestion.calls.length, 0);
});

test('Lab AI failure leaves an unconfirmed reviewable Pending Card and no confirmed clinical writes', async () => {
  const { center } = await setup();
  const ingestion = fakeIngestion({
    async extractDraftCandidate() { throw Object.assign(new Error('private'), { code: 'AI_TIMEOUT' }); },
  });
  cardService.setLabDocumentIngestionServiceForTests(ingestion);
  aiProvider.queueMockResponse(labClassifier());
  const result = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('lab'), submittedBy: 'U-OWNER' });
  assert.equal(result.labExtractionFailed, true);
  assert.equal(result.card.status, 'pending');
  assert.equal((await db.Appointments.findAll()).length, 0);
  assert.equal((await db.Medications.findAll()).length, 0);
});

test('Lab confirmation delegates to Lab 1A and never creates medication or appointment records', async () => {
  const { center } = await setup();
  const ingestion = fakeIngestion();
  cardService.setLabDocumentIngestionServiceForTests(ingestion);
  aiProvider.queueMockResponse(labClassifier());
  const { card } = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('lab'), submittedBy: 'U-OWNER' });
  await cardService.patchCard(card.card_id, { labReport: { ...candidate().report, observations: candidate().observations } }, 'U-OWNER');
  const result = await cardService.confirmCard(card.card_id, 'U-OWNER', 'ผู้จัดการ');
  assert.equal(result.ok, true);
  assert.equal(result.labReport.status, 'confirmed');
  assert.equal(ingestion.calls.filter((call) => call.operation === 'confirm').length, 1);
  assert.equal((await db.Appointments.findAll()).length, 0);
  assert.equal((await db.Medications.findAll()).length, 0);
  assert.equal((await db.MedicationSnapshots.findAll()).length, 0);
  const saved = await db.PendingCards.findOne((item) => item.card_id === card.card_id);
  assert.equal(saved.status, 'confirmed');
});

test('owner or manager cannot confirm an untouched Lab AI draft through the generic card path', async () => {
  const { center } = await setup();
  const ingestion = fakeIngestion();
  cardService.setLabDocumentIngestionServiceForTests(ingestion);
  aiProvider.queueMockResponse(labClassifier());
  const { card } = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('lab'), submittedBy: 'U-OWNER' });
  await cardService.getCardForEdit(card.card_id, 'U-OWNER');
  const result = await cardService.confirmCard(card.card_id, 'U-OWNER', 'ผู้จัดการ');
  assert.equal(result.ok, false);
  assert.equal(result.requiresReview, true);
  assert.match(result.reason, /หน้าตรวจสอบผล Lab/);
  assert.equal(ingestion.calls.filter((call) => call.operation === 'confirm').length, 0);
  assert.equal((await db.PendingCards.findOne((item) => item.card_id === card.card_id)).status, 'pending');
});

test('ordinary center staff can review a Lab draft but Lab 1A remains confirmation authority', async () => {
  const { center } = await setup();
  await db.CenterStaff.insert({ staff_id: 'STAFF-1', center_id: center.center_id, line_user_id: 'U-STAFF', role: 'staff', status: 'active' });
  const ingestion = fakeIngestion();
  cardService.setLabDocumentIngestionServiceForTests(ingestion);
  aiProvider.queueMockResponse(labClassifier());
  const { card } = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('lab'), submittedBy: 'U-STAFF' });
  const review = await cardService.getCardForEdit(card.card_id, 'U-STAFF');
  assert.equal(review.labDraft.status, 'draft');
  const confirmation = await cardService.confirmCard(card.card_id, 'U-STAFF', 'พนักงาน');
  assert.equal(confirmation.ok, false);
  assert.equal(confirmation.forbidden, true);
  assert.equal(ingestion.calls.filter((call) => call.operation === 'confirm').length, 0);
});

test('resident uncertainty does not attach a Lab draft until a human selects a resident', async () => {
  const center = await centerService.createCenter({ name: 'ศูนย์ Lab', ownerLineId: 'U-OWNER' });
  await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี ใจดี' });
  await centerService.addResident({ centerId: center.center_id, fullName: 'สมศรี รักดี' });
  const ingestion = fakeIngestion();
  cardService.setLabDocumentIngestionServiceForTests(ingestion);
  aiProvider.queueMockResponse(labClassifier({ nameGuess: 'สมศรี', nameConfidence: 0.4 }));
  const result = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer: Buffer.from('lab'), submittedBy: 'U-OWNER' });
  assert.equal(result.needsSelection, true);
  assert.equal(ingestion.calls.filter((call) => call.operation === 'ensure').length, 0);
});
