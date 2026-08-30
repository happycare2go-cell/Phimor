process.env.NODE_ENV='test';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const db=require('../backend/db');
const {createPlatformService}=require('../backend/services/platformService');
const {createMemoryPlatformRepository}=require('./helpers/platformMemoryRepository');

const adminHtml=fs.readFileSync(path.resolve(__dirname,'..','liff-app','system-admin','index.html'),'utf8');
const careSource=fs.readFileSync(path.resolve(__dirname,'..','liff-app','system-admin','care-operations-ui.js'),'utf8');
const exceptionSource=fs.readFileSync(path.resolve(__dirname,'..','liff-app','system-admin','exception-queue-ui.js'),'utf8');
const centerHtml=fs.readFileSync(path.resolve(__dirname,'..','liff-app','center-admin','index.html'),'utf8');
const centerCare=fs.readFileSync(path.resolve(__dirname,'..','liff-app','center-admin','care-recording-ui.js'),'utf8');
const shellCss=fs.readFileSync(path.resolve(__dirname,'..','liff-app','shared','app-shell.css'),'utf8');

function fixture(){db.resetAll();const repository=createMemoryPlatformRepository();let seq=0;return{repository,service:createPlatformService({repository,idFactory:(prefix)=>`${prefix}-${++seq}`})}}

test('operations foundation batches Organization, Center and capability configuration with explicit bounds',async()=>{
  const {repository,service}=fixture();
  const org=await service.createOrganization({organizationCode:'org-a',displayName:'องค์กรเอ',actorReference:'ADM'});
  await repository.linkCenter({organizationId:org.organizationId,centerId:'CTR-A',actorReference:'ADM'});
  repository.state.organizationCenters[0].center_name='ศูนย์เอ';
  repository.state.capabilities.push({center_id:'CTR-A',capability_key:'daily_care_v1',enabled:true});
  const result=await service.getOperationsFoundation({includeCapabilities:'1',limit:200,centerLimit:500});
  assert.equal(result.organizations.length,1);assert.equal(result.centers.length,1);
  assert.equal(result.centers[0].capabilities.find((item)=>item.capabilityKey==='daily_care_v1').enabled,true);
  assert.equal(result.centers[0].capabilities.find((item)=>item.capabilityKey==='vital_signs_v1').enabled,false);
  assert.deepEqual(result.bounded,{organizationLimit:200,centerLimit:500,organizationsTruncated:false,centersTruncated:false});
  assert.doesNotMatch(JSON.stringify(result),/line_user|group_id|credential|payload|medication|vital_sign_sets|lab/i);
});

test('System Admin destination loading uses bounded projections and removes Organization/Center capability N+1',()=>{
  assert.match(careSource,/\/api\/admin\/platform\/operations-foundation\?includeCapabilities=/);
  assert.doesNotMatch(careSource,/organizations\.map\(async[\s\S]{0,300}organizations\/\$\{encodeURIComponent/);
  assert.doesNotMatch(careSource,/centers\.map\(async[\s\S]{0,300}\/capabilities/);
  assert.match(careSource,/foundationLoaded/);assert.match(careSource,/foundationCapabilitiesLoaded/);
  const destinationFlow=adminHtml.match(/async function onAdminDestination\([\s\S]+?\n    }\n    function initialAdminDestination/)?.[0]||'';
  const overviewBranch=destinationFlow.match(/if\(destination==='overview'\)\{[\s\S]*?\n      }/)?.[0]||'';
  assert.match(overviewBranch,/loadDashboard/);
  assert.match(destinationFlow,/destination==='review'[\s\S]{0,180}ensureExceptionQueueUI/);
  assert.doesNotMatch(overviewBranch,/loadCenters/);
});

test('directory, selected detail, Integration detail, resident options and exception filters ignore stale responses',()=>{
  assert.match(adminHtml,/centerDirectoryRequest/);assert.match(adminHtml,/request!==centerDirectoryRequest/);
  assert.match(adminHtml,/centerDetailRequest/);assert.match(adminHtml,/e\.stale/);
  assert.match(careSource,/detailGeneration/);assert.match(careSource,/residentOptionsGeneration/);
  assert.match(careSource,/token!==residentOptionsGeneration/);
  assert.match(exceptionSource,/requestSequence/);assert.match(exceptionSource,/sequence!==state\.requestSequence/);
  assert.match(centerHtml,/CENTER_CONTEXT_GENERATION/);assert.match(centerHtml,/requestGeneration!==CENTER_CONTEXT_GENERATION/);
});

test('Center destinations load bounded task data while clinical histories remain history-only',()=>{
  assert.match(centerHtml,/destination==='home'/);assert.match(centerHtml,/destination==='record'/);assert.match(centerHtml,/destination==='work'/);
  assert.doesNotMatch(centerHtml,/destination==='home'[\s\S]{0,500}loadCenterAppointments/);
  assert.match(centerCare,/surfaceMode === 'history'[\s\S]{0,220}refreshVitalHistory/);
  assert.match(centerCare,/surfaceMode === 'record'\) return Promise\.resolve/);
  assert.match(centerHtml,/invalidateCenterState\(\)[\s\S]{0,300}residentsCache=\[\]/);
});

test('mobile, desktop and accessibility foundations remain explicit',()=>{
  assert.match(shellCss,/--phimor-mobile-nav-clearance/);assert.match(shellCss,/min-height:\s*100dvh/);
  assert.match(shellCss,/@media \(min-width: 900px\)/);assert.match(shellCss,/focus-visible/);
  assert.match(careSource,/restoreDialogFocus/);assert.match(careSource,/addEventListener\('close'/);
  assert.match(adminHtml,/aria-current|createDestinationRouter/);assert.match(adminHtml,/aria-live="polite"/);
  assert.doesNotMatch(adminHtml+careSource+exceptionSource,/localStorage|sessionStorage/);
});
