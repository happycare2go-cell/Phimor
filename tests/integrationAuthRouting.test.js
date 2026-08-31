process.env.NODE_ENV='test';
process.env.ALLOW_INSECURE_LINE_HEADER='true';
process.env.LINE_LOGIN_CHANNEL_ID='';

const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const http=require('node:http');
const path=require('node:path');

const app=require('../backend/server');
const {platformService}=require('../backend/services/platformService');
const rateLimiter=require('../backend/utils/rateLimiter');

const VALID_TEST_CREDENTIAL=['pim','int','testprefix.test-secret-value'].join('_');
const LINE_AUTH_COPY=/ไม่พบตัวตนผู้ใช้|เข้าสู่ระบบผ่าน LINE/;

async function jsonRequest(baseUrl,route,{token,body={},extraHeaders={}}={}){
  const headers={'Content-Type':'application/json',...extraHeaders};
  if(token!==undefined)headers.Authorization=`Bearer ${token}`;
  const response=await fetch(`${baseUrl}${route}`,{method:'POST',headers,body:JSON.stringify(body)});
  return {response,body:await response.json()};
}

test('real Express app isolates Integration Bearer authentication from LINE route authentication',async()=>{
  const originalAuthenticate=platformService.authenticateCredential;
  const originalIntegrationService=app.locals.integrationEventService;
  const originalConsoleError=console.error;
  const logs=[];let ingestCalls=0;
  platformService.authenticateCredential=async(token)=>{
    if(token===VALID_TEST_CREDENTIAL)return{
      integrationClientId:'INT-ROUTING-TEST',organizationId:'ORG-ROUTING-TEST',
      sourceSystem:'Routing Test',credentialId:'CRED-ROUTING-TEST',
    };
    throw Object.assign(new Error('credential rejected'),{code:'INVALID_INTEGRATION_TOKEN',status:401});
  };
  app.locals.integrationEventService={async ingest({identity,input}){
    ingestCalls+=1;assert.equal(identity.integrationClientId,'INT-ROUTING-TEST');
    if(!input||Object.keys(input).length===0){
      throw Object.assign(new Error('invalid body'),{code:'INVALID_EVENT_ENVELOPE',status:400});
    }
    return {eventId:input.eventId,status:'processed',duplicate:false};
  }};
  console.error=(...args)=>logs.push(args);
  rateLimiter.reset();
  const server=http.createServer(app);
  await new Promise((resolve)=>server.listen(0,'127.0.0.1',resolve));
  const baseUrl=`http://127.0.0.1:${server.address().port}`;
  try{
    for(const token of [undefined,'garbage','INTK-1234']){
      const result=await jsonRequest(baseUrl,'/api/integrations/v1/events',{token,body:{}});
      assert.equal(result.response.status,401);
      assert.equal(result.body.status,'rejected');
      assert.equal(result.body.error.code,'INVALID_CREDENTIAL');
      assert.doesNotMatch(JSON.stringify(result.body),LINE_AUTH_COPY);
    }
    const lineIdentityOnly=await jsonRequest(baseUrl,'/api/integrations/v1/events',{
      body:{},extraHeaders:{'X-Line-User-Id':'U-LINE-INTERACTIVE'},
    });
    assert.equal(lineIdentityOnly.response.status,401);
    assert.equal(lineIdentityOnly.body.error.code,'INVALID_CREDENTIAL');

    const empty=await jsonRequest(baseUrl,'/api/integrations/v1/events',{
      token:VALID_TEST_CREDENTIAL,body:{},
    });
    assert.equal(empty.response.status,400);
    assert.equal(empty.body.status,'rejected');
    assert.equal(empty.body.error.code,'INVALID_FINALIZED_RECORD');
    assert.doesNotMatch(JSON.stringify(empty.body),LINE_AUTH_COPY);

    const event={schemaVersion:'1.0',eventId:'EV-ROUTING-1',
      eventType:'care.daily_report.finalized',occurredAt:'2026-08-31T00:00:00.000Z'};
    const accepted=await jsonRequest(baseUrl,'/api/integrations/v1/events',{
      token:VALID_TEST_CREDENTIAL,body:event,
    });
    assert.equal(accepted.response.status,202);
    assert.deepEqual(accepted.body,{eventId:'EV-ROUTING-1',status:'processed',duplicate:false});
    assert.equal(ingestCalls,2);

    for(const route of ['/api/care-profile/CP-1/vital-signs','/api/care-profile/CP-1/daily-care']){
      for(const headers of [{},{Authorization:`Bearer ${VALID_TEST_CREDENTIAL}`}]){
        const response=await fetch(`${baseUrl}${route}`,{headers});
        const body=await response.json();
        assert.equal(response.status,401);
        assert.match(JSON.stringify(body),LINE_AUTH_COPY);
      }
    }
    assert.doesNotMatch(JSON.stringify(logs),/test-secret-value|credential rejected|invalid body/);
  }finally{
    await new Promise((resolve)=>server.close(resolve));
    platformService.authenticateCredential=originalAuthenticate;
    if(originalIntegrationService===undefined)delete app.locals.integrationEventService;
    else app.locals.integrationEventService=originalIntegrationService;
    console.error=originalConsoleError;
    rateLimiter.reset();
  }
});

test('server order and Vital/Daily router sources keep authentication domains structurally scoped',()=>{
  const root=path.resolve(__dirname,'..');
  const server=fs.readFileSync(path.join(root,'backend','server.js'),'utf8');
  const vital=fs.readFileSync(path.join(root,'backend','routes','vitalSigns.js'),'utf8');
  const daily=fs.readFileSync(path.join(root,'backend','routes','dailyCare.js'),'utf8');
  const integrationMount=server.indexOf("app.use('/api/integrations/v1', createIntegrationEventsRouter())");
  assert.ok(integrationMount>0);
  assert.ok(integrationMount<server.indexOf("app.use('/api', createVitalSignsRouter())"));
  assert.ok(integrationMount<server.indexOf("app.use('/api', createDailyCareRouter())"));
  assert.doesNotMatch(vital,/router\.use\(requireAuth\)/);
  assert.doesNotMatch(daily,/router\.use\(requireAuth\)/);
  assert.match(vital,/router\.get\('\/care-profile\/:careProfileId\/vital-signs', requireAuth, action/);
  assert.match(vital,/router\.post\('\/center\/:centerId\/residents\/:residentId\/vital-signs', requireAuth, requireCenterStaff/);
  assert.match(daily,/router\.get\('\/care-profile\/:careProfileId\/daily-care',requireAuth,action/);
  assert.match(daily,/router\.post\('\/center\/:centerId\/residents\/:residentId\/daily-care',requireAuth,requireCenterStaff/);
});
