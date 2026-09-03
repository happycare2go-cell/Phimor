const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  PREFLIGHT_MAX_WEB_SEARCH_CALLS,
  validateArguments, evidenceMismatchCode, safeFailure, runPharmacistAIContractPreflight,
} = require('../backend/scripts/preflight-pharmacist-ai-contracts');

function assistantFixture() {
  const general = { text:'เภสัชกรควรตรวจสอบข้อมูลที่ยังขาดก่อนตอบ', sourceCategory:'general_ai_knowledge' };
  return {
    caseSummary:'สรุปข้อมูลสังเคราะห์สำหรับตรวจสอบสัญญา',
    recordedFacts:[],
    relevantMedicationContext:[
      { text:'มี amlodipine ในรายการยาที่บันทึก', sourceCategory:'medication_snapshot' },
      { text:'มี simvastatin ในรายการยาที่บันทึก', sourceCategory:'medication_snapshot' },
    ],
    medicationChanges:[], questionsToAsk:[general], safetyConsiderations:[general],
    responseGuidance:[general], escalationConsiderations:[],
    missingInformation:['ไม่มีอาการหรือผลตรวจในข้อมูลสังเคราะห์'],
    draftResponseForPharmacistReview:'ข้อมูลนี้เป็นร่างสำหรับเภสัชกรตรวจสอบ และควรยืนยันข้อมูลที่ยังขาดก่อนตอบ',
    disclaimer:'เภสัชกรต้องตรวจสอบก่อนใช้งาน',
  };
}

function planFixture() {
  return {
    researchNeeded:true,
    clinicalQuestions:['ข้อพิจารณาทั่วไปเมื่อใช้ amlodipine ร่วมกับ simvastatin'],
    researchTopics:[{
      type:'drug_interaction', question:'Authoritative co-administration considerations',
      deidentifiedSearchTerms:['amlodipine simvastatin official drug information'],
    }],
    missingInformation:['ไม่มีข้อมูลอาการหรือผลตรวจเฉพาะบุคคล'], urgentSafetyFlags:[],
  };
}

function evidenceFixture() {
  return {
    findings:[{
      topicType:'drug_interaction', summary:'แหล่งข้อมูลทางการระบุประเด็นที่เภสัชกรควรทบทวน',
      citationUrls:['https://www.fda.gov/synthetic-reference'], conflictDetected:false,
      limitation:'เป็นข้อมูลทั่วไปและไม่ใช่ข้อสรุปเฉพาะบุคคล',
    }],
    limitations:[],
  };
}

function synthesisFixture() {
  return {
    caseSummary:'ทบทวนข้อมูลสังเคราะห์เรื่องการใช้ยาร่วมกัน',
    questionThemes:['การใช้ยาร่วมกัน'], recordedFacts:[],
    relevantMedicationContext:[
      { text:'มี amlodipine ในบริบทสังเคราะห์', sourceCategory:'medication_snapshot' },
      { text:'มี simvastatin ในบริบทสังเคราะห์', sourceCategory:'medication_snapshot' },
    ],
    medicationChanges:[], missingInformation:['ไม่มีข้อมูลอาการหรือผลตรวจเฉพาะบุคคล'],
    questionsToAsk:['ควรยืนยันรายการยาและข้อมูลที่ยังขาดก่อนสรุป'],
    keyClinicalIssues:[{
      text:'มีประเด็นจากหลักฐานที่เภสัชกรควรประเมิน', importance:'important',
      basis:'external_evidence', evidenceRefs:['SRC-1'],
    }],
    interactionReview:[{
      drugs:['amlodipine','simvastatin'], finding:'มีประเด็นที่ควรประเมินจากข้อมูลทางการ',
      clinicalSignificance:'unknown', patientRelevance:'พบชื่อยาทั้งสองในบริบทสังเคราะห์',
      evidenceRefs:['SRC-1'], limitation:'ไม่มีข้อมูลเฉพาะบุคคล',
    }],
    guidelineReview:[],
    pharmacistRecommendations:[{
      text:'เภสัชกรควรตรวจสอบหลักฐานและบริบทก่อนตอบ', basis:'external_evidence', evidenceRefs:['SRC-1'],
    }],
    safetyConsiderations:[], escalationConsiderations:[],
    research:{ performed:true, topics:['drug_interaction'], sources:[], limitations:[] },
    draftResponseForPharmacistReview:'ข้อมูลนี้เป็นร่างสำหรับเภสัชกรตรวจสอบหลักฐานและบริบทก่อนตอบ',
    disclaimer:'เภสัชกรเป็นผู้ตรวจสอบและตัดสินใจขั้นสุดท้าย',
  };
}

function mockProvider() {
  return {
    async generateStructured(options) {
      let value;
      let metadata={
        usage:{ inputTokens:10, outputTokens:5, totalTokens:15, reasoningTokens:1 },
        webSearchCalls:0, sources:[],
      };
      if (options.task==='pharmacist_assistance') value=assistantFixture();
      else if (options.task==='pharmacist_clinical_research_plan') value=planFixture();
      else if (options.task==='pharmacist_clinical_web_evidence') {
        value=evidenceFixture();
        metadata={...metadata,webSearchCalls:1,sources:[{
          url:'https://www.fda.gov/synthetic-reference',title:'Official synthetic reference',publishedAt:null,
        }]};
      } else value=synthesisFixture();
      options.onMetadata?.(metadata);
      return options.outputSchema(value);
    },
  };
}

test('pharmacist contract preflight refuses all operator-supplied input',()=>{
  assert.equal(PREFLIGHT_MAX_WEB_SEARCH_CALLS,4);
  assert.throws(()=>validateArguments(['patient text']),{code:'PREFLIGHT_ARGUMENTS_NOT_ALLOWED'});
  assert.doesNotThrow(()=>validateArguments([]));
});

test('pharmacist contract preflight failure output keeps only safe web metadata',()=>{
  const error=Object.assign(new Error('private provider details'),{
    code:'PREFLIGHT_WEB_EVIDENCE_SOURCE_NOT_VERIFIED',
    safeMetadata:{ webSearchCalls:1, sources:[{ url:'https://www.fda.gov/safe', title:'private title' }] },
  });
  const result=safeFailure('sol_web_evidence_contract','gpt-5.6-sol',error);
  assert.deepEqual(result,{
    capability:'sol_web_evidence_contract', status:'FAIL', model:'gpt-5.6-sol',
    errorCode:'PREFLIGHT_WEB_EVIDENCE_SOURCE_NOT_VERIFIED', validationStage:null,
    webSearchCalls:1, sourceDomains:['www.fda.gov'],
  });
  assert.doesNotMatch(JSON.stringify(result),/private provider details|private title|\/safe/);
});

test('preflight distinguishes provider schema rejection without exposing provider response',()=>{
  const result=safeFailure('sol_clinical_synthesis_contract','gpt-5.6-sol',Object.assign(
    new Error('raw provider response'),
    { code:'AI_INVALID_RESPONSE', status:400, validationStage:'provider_schema_or_parse' },
  ));
  assert.equal(result.errorCode,'PREFLIGHT_PROVIDER_SCHEMA_REJECTED');
  assert.equal(result.validationStage,'provider_schema_or_parse');
  assert.doesNotMatch(JSON.stringify(result),/raw provider response/);
});

test('preflight safely distinguishes incomplete provider output without exposing response content',()=>{
  const result=safeFailure('sol_clinical_synthesis_contract','gpt-5.6-sol',Object.assign(
    new Error('private partial output'),
    {
      code:'AI_INVALID_RESPONSE', validationStage:'provider_schema_or_parse',
      providerFailureKind:'provider_response_incomplete',
    },
  ));
  assert.equal(result.errorCode,'PREFLIGHT_PROVIDER_RESPONSE_INCOMPLETE');
  assert.equal(result.validationStage,'provider_schema_or_parse');
  assert.doesNotMatch(JSON.stringify(result),/private partial output/);
});

test('pharmacist contract preflight classifies citation mismatch without returning URLs',()=>{
  const metadata={ sources:[{ url:'https://www.fda.gov/authoritative-source' }] };
  assert.equal(evidenceMismatchCode({ findings:[] },metadata),'PREFLIGHT_WEB_EVIDENCE_CITATIONS_EMPTY');
  assert.equal(evidenceMismatchCode({ findings:[{ citationUrls:['https://example.com/invented'] }] },metadata),'PREFLIGHT_WEB_EVIDENCE_DOMAIN_NOT_VERIFIED');
  assert.equal(evidenceMismatchCode({ findings:[{ citationUrls:['https://fda.gov/different-path'] }] },metadata),'PREFLIGHT_WEB_EVIDENCE_PATH_NOT_VERIFIED');
});

test('pharmacist contract preflight runs exact assistant, planner, evidence and synthesis validators',async()=>{
  const lines=[];
  const result=await runPharmacistAIContractPreflight({
    env:{
      OPENAI_API_KEY:'test-only-key', AI_PROVIDER_PHARMACIST:'openai',
      AI_PROVIDER_CLINICAL_RESEARCH:'openai', AI_MODEL_PHARMACIST:'gpt-5.6-terra',
      AI_MODEL_CLINICAL_RESEARCH:'gpt-5.6-sol', AI_MAX_RETRIES:'0',
    },
    createProvider:()=>mockProvider(), write:(line)=>lines.push(line),
  });
  assert.deepEqual(result.map((item)=>item.capability),[
    'terra_pharmacist_assistant_contract','sol_research_plan_contract',
    'sol_web_evidence_contract','sol_clinical_synthesis_contract',
  ]);
  assert.ok(result.every((item)=>item.status==='PASS'));
  assert.equal(result[2].webSearchCalls,1);
  assert.deepEqual(result[2].sourceDomains,['www.fda.gov']);
  const output=lines.join('\n');
  assert.doesNotMatch(output,/test-only-key|amlodipine|simvastatin|draftResponse|privateClinicalContext/);
});

test('pharmacist contract preflight is synthetic-only and imports no database or LINE modules',()=>{
  const root=path.resolve(__dirname,'..');
  const source=fs.readFileSync(path.join(root,'backend','scripts','preflight-pharmacist-ai-contracts.js'),'utf8');
  const packageJson=require('../backend/package.json');
  assert.equal(packageJson.scripts['preflight:pharmacist-ai-contracts'],'node scripts/preflight-pharmacist-ai-contracts.js');
  assert.doesNotMatch(source,/require\(['"]\.\.\/db|databaseQuery|CareProfiles|Residents|LINE_USER|lineClient|sendMessage/);
  assert.doesNotMatch(source,/process\.argv\.slice\([^)]*\).*deidentifiedSummary/s);
  assert.match(source,/validateArguments\(process\.argv\.slice\(2\)\)/);
});
