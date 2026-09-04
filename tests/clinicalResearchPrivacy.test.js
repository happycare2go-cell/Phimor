const test = require('node:test');
const assert = require('node:assert/strict');
const {
  privacyViolation, sanitizeResearchPlan, validateResearchFocus,
  MAX_RESEARCH_FOCUS_CHARS,
} = require('../backend/services/clinicalResearchPrivacy');
const {
  evidenceUrlKey, buildEvidenceBundle, createUsageAccumulator,
} = require('../backend/services/clinicalEvidenceService');

const privacy = {
  blockedTerms:['ผู้ป่วย ทดสอบ', 'CP-PRIVATE', 'RES-PRIVATE', 'CASE-PRIVATE', 'CENTER-PRIVATE'],
  conversationTexts:['ผู้ป่วย ทดสอบบอกว่ากินยานี้แล้วเวียนหัวมาก'],
};

test('research privacy rejects patient, LINE, profile, resident, case, Center, phone, email and copied chat identifiers', () => {
  for (const query of [
    'ผู้ป่วย ทดสอบ drug interaction', 'U0123456789abcdef0123456789abcdef interaction',
    'CP-PRIVATE medicine', 'RES-PRIVATE medicine', 'CASE-PRIVATE guideline',
    'CENTER-PRIVATE guideline', 'โทร 081-234-5678', 'patient@example.com medicine',
    'ผู้ป่วย ทดสอบบอกว่ากินยานี้แล้วเวียนหัวมาก',
  ]) assert.ok(privacyViolation(query, privacy));
  assert.equal(privacyViolation('clarithromycin simvastatin interaction official label', privacy), null);
});

test('privacy gate drops unsafe topic rather than sending it to web research', () => {
  const result = sanitizeResearchPlan({ researchTopics:[
    { type:'drug_interaction', question:'CP-PRIVATE interaction', deidentifiedSearchTerms:['Drug A Drug B'] },
    { type:'adverse_effect', question:'Drug A adverse effects', deidentifiedSearchTerms:['Drug A official label adverse effects'] },
  ] }, privacy);
  assert.equal(result.errorCode, 'RESEARCH_QUERY_PRIVACY_REJECTED');
  assert.equal(result.rejectedTopics.length, 1);
  assert.equal(result.acceptedTopics.length, 1);
  assert.doesNotMatch(JSON.stringify(result.acceptedTopics), /CP-PRIVATE|ผู้ป่วย/);
});

test('research focus is trimmed, bounded, and rejects direct identifiers in deidentified mode',()=>{
  assert.deepStrictEqual(validateResearchFocus('  หลักฐานการใช้ amlodipine ร่วมกับ simvastatin  ',{enforcePrivacy:true}),{
    ok:true,researchFocus:'หลักฐานการใช้ amlodipine ร่วมกับ simvastatin',
  });
  assert.equal(validateResearchFocus('',{enforcePrivacy:true}).errorCode,'CLINICAL_RESEARCH_FOCUS_REQUIRED');
  assert.equal(validateResearchFocus('สั้น',{enforcePrivacy:true}).errorCode,'CLINICAL_RESEARCH_FOCUS_INVALID');
  assert.equal(validateResearchFocus('x'.repeat(MAX_RESEARCH_FOCUS_CHARS+1),{enforcePrivacy:true}).errorCode,'CLINICAL_RESEARCH_FOCUS_INVALID');
  for(const value of ['ตรวจสอบเคส CASE-PRIVATE','ข้อมูลของ patient@example.com','ข้อมูลของ 081-234-5678']){
    assert.equal(validateResearchFocus(value,{enforcePrivacy:true}).errorCode,'CLINICAL_RESEARCH_FOCUS_PRIVACY_REJECTED');
  }
});

test('evidence accepts only actual allowlisted provider citations and preserves unknown publication date', () => {
  const evidence = buildEvidenceBundle({
    findings:[
      { topicType:'drug_interaction', summary:'พบหลักฐานที่ต้องประเมิน', citationUrls:['https://www.fda.gov/a', 'https://invented.example/x'], conflictDetected:false, limitation:null },
      { topicType:'adverse_effect', summary:'uncited model claim', citationUrls:['https://invented.example/x'], conflictDetected:false, limitation:null },
      { topicType:'disease_guideline', summary:'พบข้อมูลไม่สอดคล้องกัน', citationUrls:['https://www.who.int/b'], conflictDetected:true, limitation:'compare sources' },
    ], limitations:[],
  }, { sources:[
    { url:'https://www.fda.gov/a', title:'FDA label', publishedAt:null },
    { url:'https://www.who.int/b', title:'WHO guidance' },
    { url:'https://www.fda.gov/unused', title:'Unused FDA source' },
    { url:'https://blog.example/c', title:'Blog' },
  ] }, { allowedDomains:['fda.gov', 'who.int'], accessedAt:'2026-09-03T00:00:00Z' });
  assert.equal(evidence.sources.length, 2);
  assert.equal(evidence.sources[0].publishedAt, null);
  assert.equal(evidence.findings.length, 2);
  assert.equal(evidence.findings[1].conflictDetected, true);
  assert.match(evidence.limitations.join(' '), /EVIDENCE_WITHOUT_VERIFIED_CITATION_REJECTED/);
  assert.doesNotMatch(JSON.stringify(evidence), /invented\.example|blog\.example|unused/);
});

test('evidence URL matching ignores only non-document URL decoration',()=>{
  assert.equal(
    evidenceUrlKey('https://www.fda.gov/a?setid=1&utm_source=test#section'),
    evidenceUrlKey('https://fda.gov/a?setid=1'),
  );
  assert.notEqual(evidenceUrlKey('https://fda.gov/a'),evidenceUrlKey('https://fda.gov/b'));
  assert.equal(evidenceUrlKey('http://fda.gov/a'),null);
  const evidence=buildEvidenceBundle({
    findings:[{
      topicType:'drug_interaction', summary:'พบหลักฐานที่ต้องประเมิน',
      citationUrls:['https://fda.gov/a?setid=1'], conflictDetected:false, limitation:null,
    }], limitations:[],
  },{ sources:[{
    url:'https://www.fda.gov/a?utm_source=provider&setid=1#source', title:'FDA source',
  }]},{ allowedDomains:['fda.gov'] });
  assert.equal(evidence.findings.length,1);
  assert.equal(evidence.sources.length,1);
});

test('absence of evidence cannot become a no-interaction conclusion', () => {
  const evidence = buildEvidenceBundle({
    findings:[{ topicType:'drug_interaction', summary:'ไม่พบ interaction', citationUrls:['https://www.fda.gov/a'], conflictDetected:false, limitation:null }],
    limitations:[],
  }, { sources:[{ url:'https://www.fda.gov/a', title:'FDA' }] }, { allowedDomains:['fda.gov'] });
  assert.equal(evidence.findings.length, 0);
  assert.match(evidence.limitations.join(' '), /INSUFFICIENT_INTERACTION_EVIDENCE/);
});

test('usage accumulator adds every provider call and preserves missing metadata as null', () => {
  const usage = createUsageAccumulator();
  usage.record({ usage:{ inputTokens:10, outputTokens:5, totalTokens:15, reasoningTokens:2 }, webSearchCalls:0 });
  usage.record({ usage:{ inputTokens:20, outputTokens:8, totalTokens:28, reasoningTokens:4 }, webSearchCalls:2 });
  assert.deepStrictEqual(usage.snapshot(), { inputTokens:30, outputTokens:13, totalTokens:43, reasoningTokens:6, webSearchCalls:2 });
  assert.deepStrictEqual(createUsageAccumulator().snapshot(), { inputTokens:null, outputTokens:null, totalTokens:null, reasoningTokens:null, webSearchCalls:0 });
});
