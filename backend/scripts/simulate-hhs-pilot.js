const LOCAL_HOSTS = new Set(['127.0.0.1', 'localhost', '::1', '[::1]']);

function clone(value) { return JSON.parse(JSON.stringify(value)); }

function finalizedEvent({ eventId, recordId, shiftCode, shiftLabel, recordedAt, finalizedAt,
  residentExternalId = 'pilot-resident-10025', centerExternalId = 'pilot-branch-01',
  expectedLineGroupId = 'Cfictionalpilotfamilygroup' }) {
  return {
    schema_version:'1.0', event_id:eventId, event_type:'care.daily_report.finalized',
    occurred_at:finalizedAt,
    subject:{
      center_external_id:centerExternalId, resident_external_id:residentExternalId,
      expected_line_group_id:expectedLineGroupId,
      display:{ first_name:'สมใจ', last_name:'ใจดี', room:'A-201' },
    },
    data:{
      external_record_id:recordId, care_date:'2026-08-27',
      shift:{ code:shiftCode, source_label:shiftLabel },
      observations:[
        { type:'temperature', value:36.6, unit:'Cel' },
        { type:'blood_pressure_systolic', value:128, unit:'mm[Hg]' },
        { type:'blood_pressure_diastolic', value:76, unit:'mm[Hg]' },
        { type:'pulse', value:72, unit:'/min' },
        { type:'spo2', value:97, unit:'%' },
      ],
      care_items:[{ item_type:'symptom_note', value_type:'text', value:'ข้อความตัวอย่างที่ผู้จัดการตรวจสอบแล้ว' }],
      recorded_by:{ external_staff_id:'pilot-staff-417', display_name:'ผู้ดูแลตัวอย่าง' },
      finalized_by:{ external_staff_id:'pilot-manager-02', display_name:'ผู้จัดการตัวอย่าง' },
      recorded_at:recordedAt, finalized_at:finalizedAt,
    },
  };
}

function buildScenarios() {
  const day = finalizedEvent({
    eventId:'pilot-day-final-20260827', recordId:'pilot-daily-day-20260827', shiftCode:'day', shiftLabel:'D',
    recordedAt:'2026-08-27T19:55:00+07:00', finalizedAt:'2026-08-27T20:05:00+07:00',
  });
  const night = finalizedEvent({
    eventId:'pilot-night-final-20260827', recordId:'pilot-daily-night-20260827', shiftCode:'night', shiftLabel:'N',
    recordedAt:'2026-08-28T07:45:00+07:00', finalizedAt:'2026-08-28T08:00:00+07:00',
  });
  const pending = finalizedEvent({
    eventId:'pilot-pending-subject-20260827', recordId:'pilot-daily-pending-20260827', shiftCode:'day', shiftLabel:'D',
    recordedAt:'2026-08-27T19:55:00+07:00', finalizedAt:'2026-08-27T20:05:00+07:00', residentExternalId:'pilot-resident-not-mapped',
  });
  const mismatch = finalizedEvent({
    eventId:'pilot-group-mismatch-20260827', recordId:'pilot-daily-mismatch-20260827', shiftCode:'day', shiftLabel:'D',
    recordedAt:'2026-08-27T19:55:00+07:00', finalizedAt:'2026-08-27T20:05:00+07:00', expectedLineGroupId:'Cfictionaldifferentgroup',
  });
  const invalidCenter = finalizedEvent({
    eventId:'pilot-invalid-center-20260827', recordId:'pilot-daily-invalid-center-20260827', shiftCode:'day', shiftLabel:'D',
    recordedAt:'2026-08-27T19:55:00+07:00', finalizedAt:'2026-08-27T20:05:00+07:00', centerExternalId:'pilot-branch-not-mapped',
  });
  const invalidPayload = clone(day);
  invalidPayload.event_id = 'pilot-invalid-payload-20260827';
  invalidPayload.data.external_record_id = 'pilot-daily-invalid-payload-20260827';
  invalidPayload.data.observations[0].unit = 'invented-unit';
  const standaloneVital = {
    schema_version:'1.0', event_id:'pilot-standalone-vital-20260827', event_type:'care.vitals.recorded',
    occurred_at:'2026-08-27T07:30:00+07:00',
    subject:{ center_external_id:'pilot-branch-01', resident_external_id:'pilot-resident-10025', display:{ first_name:'สมใจ', last_name:'ใจดี', room:'A-201' } },
    recorder:{ external_staff_id:'pilot-staff-417', display_name:'ผู้ดูแลตัวอย่าง' },
    data:{ external_record_id:'pilot-vital-20260827', observations:[{ type:'pulse', value:72, unit:'/min' }] },
  };
  return [
    { key:'day', label:'A. Day finalized event', payload:day },
    { key:'duplicate-day', label:'B. Duplicate Day event', payload:clone(day) },
    { key:'night', label:'C. Night finalized event', payload:night },
    { key:'pending-subject', label:'D. Pending subject event', payload:pending },
    { key:'group-mismatch', label:'E. Group mismatch event', payload:mismatch },
    { key:'invalid-credential', label:'F. Invalid credential', payload:clone(day), invalidCredential:true },
    { key:'invalid-center', label:'G. Invalid Center', payload:invalidCenter },
    { key:'invalid-payload', label:'H. Invalid payload', payload:invalidPayload },
    { key:'standalone-vital', label:'I. Standalone Vital', payload:standaloneVital },
  ];
}

function assertLocalTarget(value) {
  const target = new URL(value);
  if (!LOCAL_HOSTS.has(target.hostname) || !['http:', 'https:'].includes(target.protocol)) {
    throw new Error('Simulator --send is restricted to localhost/loopback targets');
  }
  return target.origin;
}

function selectedScenarios(all, argument) {
  if (!argument || argument === 'all') return all;
  const keys = new Set(argument.split(',').map((item) => item.trim()).filter(Boolean));
  const selected = all.filter((scenario) => keys.has(scenario.key));
  if (!selected.length || selected.length !== keys.size) throw new Error('Unknown --scenario key');
  return selected;
}

async function sendScenarios({ baseUrl, token, scenarios, fetchImpl = fetch }) {
  const origin = assertLocalTarget(baseUrl);
  if (!token || token.length < 20) throw new Error('Set HHS_PILOT_SIMULATOR_TOKEN to a local/test credential');
  const results = [];
  for (const scenario of scenarios) {
    const authorization = scenario.invalidCredential ? 'Bearer invalid-local-credential' : `Bearer ${token}`;
    const response = await fetchImpl(`${origin}/api/integrations/v1/events`, {
      method:'POST', headers:{ 'Content-Type':'application/json', Authorization:authorization },
      body:JSON.stringify(scenario.payload),
    });
    const body = await response.json().catch(() => ({}));
    results.push({ key:scenario.key, httpStatus:response.status, status:body.status || null, errorCode:body.error?.code || null });
  }
  return results;
}

function parseArguments(argv) {
  const valueAfter = (name) => { const index = argv.indexOf(name); return index >= 0 ? argv[index + 1] : null; };
  return { send:argv.includes('--send'), baseUrl:valueAfter('--base-url') || 'http://127.0.0.1:3000', scenario:valueAfter('--scenario') || 'all' };
}

async function main() {
  const args = parseArguments(process.argv.slice(2));
  const scenarios = selectedScenarios(buildScenarios(), args.scenario);
  if (!args.send) {
    process.stdout.write(`${JSON.stringify({ mode:'print-only', scenarios }, null, 2)}\n`);
    return;
  }
  const results = await sendScenarios({ baseUrl:args.baseUrl, token:process.env.HHS_PILOT_SIMULATOR_TOKEN, scenarios });
  for (const result of results) process.stdout.write(`${result.key}: HTTP ${result.httpStatus} ${result.status || '-'} ${result.errorCode || '-'}\n`);
}

if (require.main === module) main().catch((error) => { process.stderr.write(`Simulator stopped: ${error.message}\n`); process.exitCode = 1; });

module.exports = { buildScenarios, assertLocalTarget, selectedScenarios, sendScenarios, finalizedEvent };
