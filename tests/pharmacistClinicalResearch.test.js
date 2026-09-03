const test = require('node:test');
const assert = require('node:assert/strict');
const {
  validateResearchPlan, validateWebEvidence, validateClinicalSynthesis,
  RESEARCH_PLANNER_INSTRUCTIONS, CLINICAL_SYNTHESIS_INSTRUCTIONS,
} = require('../backend/providers/pharmacistClinicalResearch');
const {
  createPharmacistClinicalResearchService, assertGroundedSynthesis,
} = require('../backend/services/pharmacistClinicalResearchService');
const { AIProviderError, AI_ERROR_CODES } = require('../backend/providers/aiErrors');

function context(overrides = {}) {
  return {
    context:{
      contextType:'pharmacist_clinical_research', contextVersion:'consultation-clinical-research-context-v1',
      contextTimestamp:'2026-09-03T00:00:00Z', state:'active',
      triage:{ action:'pharmacist_consultation_eligible', category:'drug_interaction', reasonCode:null },
      conversation:{
        initialQuestion:'ยาสองตัวนี้กินพร้อมกันได้ไหม',
        messages:[{ role:'customer', text:'ฉันใช้ Drug A และ Drug B', sequence:1, createdAt:'2026-09-03T00:00:00Z', sourceCategory:'consultation_message' }],
        conversationTruncated:false, analyzedMessageCount:2, totalMessageCount:2, analyzedThroughSequence:1,
      },
      recordedFacts:[],
      currentMedications:[
        { name:'Drug A', source:'medication_snapshot' },
        { name:'Drug B', source:'medication_snapshot' },
      ],
      medicationChanges:[], vitalFacts:[], confirmedLabs:[], appointments:[],
      missingInformation:['DRUG_ALLERGIES_NOT_RECORDED', 'CONFIRMED_LAB_MISSING'],
      ...overrides.context,
    },
    privacy:{
      blockedTerms:['ผู้ป่วย ทดสอบ', 'CP-PRIVATE', 'CASE-PRIVATE', 'U-PRIVATE'],
      conversationTexts:['ฉันใช้ Drug A และ Drug B'],
      ...overrides.privacy,
    },
    careProfileId:'CP-PRIVATE', pharmacistId:'PH-1',
  };
}

function plan(overrides = {}) {
  return {
    researchNeeded:true,
    clinicalQuestions:['ประเมินหลักฐาน interaction'],
    researchTopics:[{
      type:'drug_interaction', question:'Drug A and Drug B interaction evidence',
      deidentifiedSearchTerms:['Drug A Drug B interaction official label'],
    }],
    missingInformation:['ข้อมูลการทำงานของไต'], urgentSafetyFlags:[],
    ...overrides,
  };
}

function evidence() {
  return {
    findings:[{
      topicType:'drug_interaction', summary:'หลักฐานระบุประเด็นที่เภสัชกรควรประเมิน',
      citationUrls:['https://www.fda.gov/drug-a-label'], conflictDetected:false,
      limitation:'ต้องประเมินความเกี่ยวข้องกับผู้ใช้จากข้อมูลที่ยืนยันแล้ว',
    }],
    limitations:[],
  };
}

function synthesis({ withEvidence = true, overrides = {} } = {}) {
  const refs = withEvidence ? ['SRC-1'] : [];
  return {
    caseSummary:'ผู้ใช้สอบถามเรื่องการใช้ยาร่วมกัน',
    questionThemes:['การใช้ยาร่วมกัน'],
    recordedFacts:[{ text:'ผู้ใช้ถามเรื่องยาร่วมกัน', sourceCategory:'consultation_message' }],
    relevantMedicationContext:[
      { text:'มี Drug A ในรายการยาปัจจุบัน', sourceCategory:'medication_snapshot' },
      { text:'มี Drug B ในรายการยาปัจจุบัน', sourceCategory:'medication_snapshot' },
    ],
    medicationChanges:[],
    missingInformation:['ยังไม่มีข้อมูลการแพ้ยาที่บันทึกไว้'],
    questionsToAsk:['มีอาการผิดปกติหลังใช้ยาหรือไม่'],
    keyClinicalIssues:[{
      text:withEvidence ? 'มีหลักฐานที่ควรประเมินเพิ่มเติม' : 'ควรตรวจสอบรายละเอียดการใช้ยา',
      importance:'important', basis:withEvidence ? 'external_evidence' : 'general_professional_knowledge', evidenceRefs:refs,
    }],
    interactionReview:[{
      drugs:['Drug A', 'Drug B'], finding:'มีประเด็นที่ควรประเมินจากหลักฐาน',
      clinicalSignificance:'unknown', patientRelevance:'ผู้ใช้มีชื่อยาทั้งสองในรายการยาปัจจุบัน',
      evidenceRefs:refs, limitation:'ยังขาดข้อมูลผู้ใช้บางส่วน',
    }],
    guidelineReview:[],
    pharmacistRecommendations:[{
      text:'ควรตรวจสอบแหล่งข้อมูลและข้อมูลผู้ใช้ก่อนตอบ',
      basis:withEvidence ? 'external_evidence' : 'general_professional_knowledge', evidenceRefs:refs,
    }],
    safetyConsiderations:[], escalationConsiderations:[],
    research:{ performed:withEvidence, topics:['drug_interaction'], sources:[], limitations:[] },
    draftResponseForPharmacistReview:'จากข้อมูลที่มี ควรตรวจสอบรายละเอียดเพิ่มเติมก่อนให้คำตอบ',
    disclaimer:'เป็นข้อมูลช่วยประกอบการทบทวนของเภสัชกร ไม่ใช่คำสั่งรักษา',
    ...overrides,
  };
}

function provider({ planValue = plan(), evidenceValue = evidence(), synthesisValue = synthesis(), failWeb = null, inspect = null } = {}) {
  return {
    async generateStructured(options) {
      inspect?.(options);
      if (options.task === 'pharmacist_clinical_research_plan') {
        options.onMetadata?.({ usage:{ inputTokens:10, outputTokens:5, totalTokens:15, reasoningTokens:2 }, webSearchCalls:0, sources:[] });
        return planValue;
      }
      if (options.task === 'pharmacist_clinical_web_evidence') {
        if (failWeb) throw failWeb;
        options.onMetadata?.({
          usage:{ inputTokens:20, outputTokens:8, totalTokens:28, reasoningTokens:4 }, webSearchCalls:1,
          sources:[{ url:'https://www.fda.gov/drug-a-label', title:'Official label', publishedAt:null }],
        });
        return evidenceValue;
      }
      options.onMetadata?.({ usage:{ inputTokens:30, outputTokens:12, totalTokens:42, reasoningTokens:6 }, webSearchCalls:0, sources:[] });
      return synthesisValue;
    },
  };
}

function service(overrides = {}) {
  const generate = createPharmacistClinicalResearchService({
    flags:{ consultation:{ clinicalResearch:true } },
    pilotConfig:{ emergencyEnabled:true, mode:'controlled_live', pilotUsers:['U-PHARM'] },
    config:{ ai:{
      provider:'openai', clinicalResearchModel:'gpt-test', clinicalResearchReasoningEffort:'high',
      clinicalAllowedDomains:['fda.gov', 'who.int'], timeoutMs:1000, clinicalResearchTimeoutMs:90000,
    } },
    contextBuilder:async () => context(),
    provider:provider(),
    recordAudit:async () => ({ recorded:true }),
    ...overrides,
  });
  return (input) => generate({ safetyAcknowledged:true, ...input });
}

test('clinical research runs planner, deidentified web evidence, synthesis and aggregates every call', async () => {
  const calls = [];
  let audit;
  const result = await service({
    provider:provider({ inspect:(options) => calls.push(options) }),
    recordAudit:async (value) => { audit = value; return { recorded:true }; },
  })({ caseId:'CASE-PRIVATE', pharmacistLineUserId:'U-PHARM', now:new Date('2026-09-03T00:00:00Z') });
  assert.equal(result.status, 'available');
  assert.equal(result.analysis.research.performed, true);
  assert.equal(result.analysis.research.sources.length, 1);
  assert.equal(result.analysis.draftResponseForPharmacistReview.length > 0, true);
  assert.deepStrictEqual(calls.map((item) => item.task), [
    'pharmacist_clinical_research_plan', 'pharmacist_clinical_web_evidence',
    'pharmacist_clinical_research_synthesis',
  ]);
  assert.deepStrictEqual(calls.map((item)=>item.timeoutMs),[90000,90000,90000]);
  assert.equal(calls[0].webSearch, undefined);
  assert.equal(calls[2].webSearch, undefined);
  assert.deepStrictEqual(calls[1].webSearch, { allowedDomains:['fda.gov', 'who.int'], maxCalls:4, country:'TH' });
  const webBody = JSON.stringify({ context:calls[1].context, input:calls[1].input });
  assert.doesNotMatch(webBody, /ผู้ป่วย ทดสอบ|CP-PRIVATE|CASE-PRIVATE|U-PRIVATE|ฉันใช้ Drug A และ Drug B/);
  assert.deepStrictEqual({
    inputTokens:audit.inputTokens, outputTokens:audit.outputTokens,
    totalTokens:audit.totalTokens, reasoningTokens:audit.reasoningTokens,
    webSearchCalls:audit.webSearchCalls, sourceCount:audit.sourceCount,
  }, { inputTokens:60, outputTokens:25, totalTokens:85, reasoningTokens:12, webSearchCalls:1, sourceCount:1 });
  assert.equal(audit.researchPerformed, true);
  assert.equal(audit.resultStatus, 'needs_review');
  assert.doesNotMatch(JSON.stringify(audit), /Drug A|ผู้ป่วย|draftResponse|conversation|searchTerms/);
});

test('clinical research requires explicit pharmacist acknowledgment before provider execution', async () => {
  let providerCalls = 0;
  const generate = createPharmacistClinicalResearchService({
    flags:{ consultation:{ clinicalResearch:true } },
    pilotConfig:{ emergencyEnabled:true, mode:'controlled_live', pilotUsers:['U-PHARM'] },
    config:{ ai:{ provider:'openai', clinicalResearchModel:'gpt-test' } },
    contextBuilder:async () => context(),
    provider:{ interpretDocument:async () => { providerCalls += 1; return {}; } },
    recordAudit:async () => ({ recorded:true }),
  });
  await assert.rejects(
    generate({ caseId:'CASE-PRIVATE', pharmacistLineUserId:'U-PHARM' }),
    (error) => error.code === 'CLINICAL_RESEARCH_ACK_REQUIRED',
  );
  assert.equal(providerCalls, 0);
});

test('planner may skip web research while token usage and zero search/source counts remain authoritative', async () => {
  let audit;
  const noResearchPlan = plan({ researchNeeded:false, researchTopics:[] });
  const result = await service({
    provider:provider({ planValue:noResearchPlan, synthesisValue:synthesis({ withEvidence:false }) }),
    recordAudit:async (value) => { audit = value; return { recorded:true }; },
  })({ caseId:'CASE-PRIVATE', pharmacistLineUserId:'U-PHARM', now:new Date('2026-09-03T00:00:00Z') });
  assert.equal(result.analysis.research.performed, false);
  assert.equal(audit.researchPerformed, false);
  assert.equal(audit.webSearchCalls, 0);
  assert.equal(audit.sourceCount, 0);
  assert.equal(audit.inputTokens, 40);
  assert.equal(audit.outputTokens, 17);
});

test('privacy-rejected plan never enables web search and analysis reports the limitation', async () => {
  const calls = [];
  const unsafePlan = plan({ researchTopics:[{
    type:'drug_interaction', question:'CP-PRIVATE Drug A interaction',
    deidentifiedSearchTerms:['ผู้ป่วย ทดสอบ Drug A'],
  }] });
  const result = await service({
    provider:provider({ planValue:unsafePlan, synthesisValue:synthesis({ withEvidence:false }), inspect:(options) => calls.push(options.task) }),
  })({ caseId:'CASE-PRIVATE', pharmacistLineUserId:'U-PHARM', now:new Date('2026-09-03T00:00:00Z') });
  assert.deepStrictEqual(calls, ['pharmacist_clinical_research_plan', 'pharmacist_clinical_research_synthesis']);
  assert.match(result.analysis.research.limitations.join(' '), /RESEARCH_QUERY_PRIVACY_REJECTED/);
});

test('web search failure stays an evidence limitation and never becomes a no-interaction claim', async () => {
  const result = await service({
    provider:provider({
      failWeb:new AIProviderError(AI_ERROR_CODES.AI_TIMEOUT, 'private timeout'),
      synthesisValue:synthesis({ withEvidence:false }),
    }),
  })({ caseId:'CASE-PRIVATE', pharmacistLineUserId:'U-PHARM', now:new Date('2026-09-03T00:00:00Z') });
  assert.equal(result.status, 'available');
  assert.equal(result.analysis.research.performed, false);
  assert.match(result.analysis.research.limitations.join(' '), /RESEARCH_TEMPORARILY_UNAVAILABLE/);
  assert.doesNotMatch(JSON.stringify(result), /no interaction|ไม่มี interaction/i);
});

test('disabled flag fails before context/provider and dedicated audit failure returns a safe unavailable state', async () => {
  let contextCalls = 0;
  let providerCalls = 0;
  let auditCalls = 0;
  const disabled = createPharmacistClinicalResearchService({
    flags:{ consultation:{ clinicalResearch:false } },
    contextBuilder:async () => { contextCalls += 1; },
    provider:{ async generateStructured() { providerCalls += 1; } },
    recordAudit:async () => { auditCalls += 1; return { recorded:true }; },
  });
  await assert.rejects(disabled({ caseId:'CASE-PRIVATE', pharmacistLineUserId:'U-PHARM' }), (error) => error.code === 'CLINICAL_RESEARCH_DISABLED');
  assert.equal(contextCalls, 0);
  assert.equal(providerCalls, 0);
  assert.equal(auditCalls, 0);
  const auditFailure = await service({ recordAudit:async () => ({ recorded:false }) })({
    caseId:'CASE-PRIVATE', pharmacistLineUserId:'U-PHARM', now:new Date('2026-09-03T00:00:00Z'),
  });
  assert.deepStrictEqual(auditFailure, {
    status:'unavailable', errorCode:'AI_AUDIT_WRITE_FAILED',
    message:'ระบบวิเคราะห์บทสนทนายังไม่พร้อม กรุณาดำเนินการสนทนาด้วยตนเอง',
  });
});

test('deidentified pilot uses only reviewed summary context and never auto-loads Care Profile', async () => {
  let contextCalls=0, accessCalls=0, audit;
  const deidentifiedSummary='ผู้ใหญ่ใช้ Drug A และ Drug B และต้องการให้เภสัชกรตรวจข้อมูลการใช้ร่วมกัน';
  const result=await service({
    pilotConfig:{emergencyEnabled:true,mode:'deidentified_pilot',pilotUsers:['U-PHARM']},
    contextBuilder:async()=>{contextCalls+=1;throw new Error('must not load private context');},
    accessChecker:async()=>{accessCalls+=1;return {pharmacistId:'PH-1',state:'active',databaseNow:'2026-09-03T00:00:00Z'};},
    recordAudit:async(value)=>{audit=value;return {recorded:true};},
  })({caseId:'CASE-PRIVATE',pharmacistLineUserId:'U-PHARM',deidentifiedSummary,privacyReviewed:true});
  assert.equal(result.status,'available');
  assert.equal(result.mode,'deidentified_pilot');
  assert.equal(contextCalls,0);assert.equal(accessCalls,1);
  assert.equal(audit.careProfileId,null);
  assert.equal(audit.contextVersion,'consultation-clinical-research-deidentified-pilot-v1');
  assert.doesNotMatch(JSON.stringify(audit),/Drug A|Drug B|ผู้ใหญ่|ต้องการ/);
});

test('pilot allowlist and privacy gate fail before provider or automatic context', async () => {
  let providerCalls=0,contextCalls=0,accessCalls=0;
  const make=(pilotConfig)=>createPharmacistClinicalResearchService({
    flags:{consultation:{clinicalResearch:true}},pilotConfig,
    config:{ai:{provider:'openai',clinicalResearchModel:'gpt-test',clinicalResearchReasoningEffort:'high',clinicalAllowedDomains:['fda.gov'],timeoutMs:1000}},
    provider:{async generateStructured(){providerCalls+=1;}},
    contextBuilder:async()=>{contextCalls+=1;},accessChecker:async()=>{accessCalls+=1;},
  });
  await assert.rejects(make({emergencyEnabled:true,mode:'deidentified_pilot',pilotUsers:[]})({
    caseId:'CASE-PRIVATE',pharmacistLineUserId:'U-PHARM',safetyAcknowledged:true,
    privacyReviewed:true,deidentifiedSummary:'ข้อมูลทั่วไปที่ไม่มีตัวระบุบุคคลโดยตรงสำหรับทดสอบระบบ',
  }),(error)=>error.code==='CLINICAL_RESEARCH_NOT_ALLOWED');
  await assert.rejects(make({emergencyEnabled:true,mode:'deidentified_pilot',pilotUsers:['U-PHARM']})({
    caseId:'CASE-PRIVATE',pharmacistLineUserId:'U-PHARM',safetyAcknowledged:true,
    privacyReviewed:true,deidentifiedSummary:'ชื่อผู้ป่วย: สมชาย ใจดี ใช้ยาตามข้อมูลที่บันทึก',
  }),(error)=>error.code==='DEIDENTIFIED_SUMMARY_PRIVACY_REJECTED');
  assert.equal(providerCalls,0);assert.equal(contextCalls,0);assert.equal(accessCalls,0);
});

test('clinical contracts reject forbidden auto-send, hallucinated evidence and unsupported no-interaction claims', () => {
  assert.ok(validateResearchPlan(plan()));
  assert.ok(validateWebEvidence(evidence()));
  assert.throws(() => validateClinicalSynthesis({ ...synthesis(), sendToCustomer:true }, { allowedEvidenceRefs:['SRC-1'] }));
  assert.throws(() => validateClinicalSynthesis(synthesis({
    overrides:{ pharmacistRecommendations:[{ text:'claim', basis:'external_evidence', evidenceRefs:['SRC-HALLUCINATED'] }] },
  }), { allowedEvidenceRefs:['SRC-1'] }));
  assert.throws(() => validateClinicalSynthesis(synthesis({
    overrides:{ interactionReview:[{
      drugs:['Drug A', 'Drug B'], finding:'ไม่พบ interaction', clinicalSignificance:'unknown',
      patientRelevance:'recorded', evidenceRefs:['SRC-1'], limitation:'none',
    }] },
  }), { allowedEvidenceRefs:['SRC-1'] }));
});

test('clinical grounding rejects invented medication, allergy and renal facts', () => {
  assert.throws(() => assertGroundedSynthesis(synthesis({
    overrides:{ relevantMedicationContext:[{ text:'มี Drug C ในรายการยา', sourceCategory:'medication_snapshot' }] },
  }), context().context), (error) => error.code === AI_ERROR_CODES.AI_INVALID_RESPONSE);
  assert.throws(() => assertGroundedSynthesis(synthesis({
    overrides:{ recordedFacts:[{ text:'ไม่มีประวัติแพ้ยา', sourceCategory:'care_profile' }] },
  }), context().context), (error) => error.code === AI_ERROR_CODES.AI_INVALID_RESPONSE);
  assert.throws(() => assertGroundedSynthesis(synthesis({
    overrides:{ recordedFacts:[{ text:'ค่า eGFR 72', sourceCategory:'lab_result' }] },
  }), context().context), (error) => error.code === AI_ERROR_CODES.AI_INVALID_RESPONSE);
});

test('antimicrobial guideline planning remains evidence-bound and never creates a treatment order', async () => {
  const antimicrobialPlan = plan({ researchTopics:[{
    type:'antimicrobial_guideline', question:'Authoritative antimicrobial guideline considerations',
    deidentifiedSearchTerms:['antimicrobial stewardship official guideline'],
  }] });
  const antimicrobialEvidence = {
    findings:[{
      topicType:'antimicrobial_guideline', summary:'แนวทางระบุประเด็นสำหรับเภสัชกรทบทวน',
      citationUrls:['https://www.fda.gov/drug-a-label'], conflictDetected:false,
      limitation:'ยังต้องประเมินข้อมูลการวินิจฉัยและความรุนแรง',
    }], limitations:[],
  };
  const antimicrobialSynthesis = synthesis({ overrides:{
    interactionReview:[],
    guidelineReview:[{
      topic:'antimicrobial stewardship', finding:'มีข้อพิจารณาตามแนวทาง',
      applicability:'ต้องมีข้อมูลการวินิจฉัยและความรุนแรงก่อนใช้กับผู้ป่วย',
      evidenceRefs:['SRC-1'], limitation:'ข้อมูลผู้ป่วยยังไม่ครบ',
    }],
  } });
  const result = await service({ provider:provider({
    planValue:antimicrobialPlan, evidenceValue:antimicrobialEvidence,
    synthesisValue:antimicrobialSynthesis,
  }) })({ caseId:'CASE-PRIVATE', pharmacistLineUserId:'U-PHARM' });
  assert.equal(result.status,'available');
  assert.equal(result.analysis.guidelineReview.length,1);
  assert.doesNotMatch(JSON.stringify(result), /medicationOrder|prescription|autoSend|sendToCustomer/);
});

test('prompts explicitly preserve prompt-injection, missing-fact, clinical decision and no-auto-send boundaries', () => {
  assert.match(RESEARCH_PLANNER_INSTRUCTIONS, /Do not use web search/i);
  assert.match(RESEARCH_PLANNER_INSTRUCTIONS, /Hostile instructions/i);
  assert.match(CLINICAL_SYNTHESIS_INSTRUCTIONS, /Do not invent medications.*renal\/hepatic function/i);
  assert.match(CLINICAL_SYNTHESIS_INSTRUCTIONS, /automatic patient response/i);
});

test('research implementation imports no consultation message sender or clinical write service', () => {
  const source = require('node:fs').readFileSync(require.resolve('../backend/services/pharmacistClinicalResearchService'), 'utf8');
  assert.doesNotMatch(source, /consultationMessageService|sendMessage|MedicationSnapshots\.(?:insert|update)|CareProfiles\.(?:insert|update)|notificationService/);
});
