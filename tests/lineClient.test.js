const test=require('node:test');
const assert=require('node:assert/strict');

process.env.NODE_ENV='test';

const {
  lineGroupMemberFetchTimeout,createGroupMemberUserIdLister,
}=require('../backend/providers/lineClient');

function response(body,{ok=true,status=200}={}) {
  return {ok,status,async json(){return body;}};
}

test('LINE group-member timeout configuration is bounded with a safe default',()=>{
  assert.equal(lineGroupMemberFetchTimeout(undefined),5000);
  assert.equal(lineGroupMemberFetchTimeout('10'),250);
  assert.equal(lineGroupMemberFetchTimeout('7000'),7000);
  assert.equal(lineGroupMemberFetchTimeout('99999'),15000);
  assert.equal(lineGroupMemberFetchTimeout('invalid'),5000);
});

test('LINE group-member listing paginates under one deadline and deduplicates identities',async()=>{
  const calls=[];
  const lister=createGroupMemberUserIdLister({
    env:{LINE_CHANNEL_ACCESS_TOKEN:'server-secret',LINE_GROUP_MEMBER_FETCH_TIMEOUT_MS:'5000'},
    fetchImpl:async(url,options)=>{
      calls.push({url,options});
      return calls.length===1
        ?response({memberIds:['U-A','U-B'],next:'NEXT'})
        :response({memberIds:['U-B','U-C']});
    },
  });
  const result=await lister('GROUP-PRIVATE');
  assert.deepEqual(result,{available:true,userIds:['U-A','U-B','U-C']});
  assert.equal(calls.length,2);
  assert.equal(calls[0].options.signal,calls[1].options.signal);
  assert.match(calls[1].url,/start=NEXT/);
});

test('LINE group-member non-200 response is unavailable without leaking identities or token',async()=>{
  const lister=createGroupMemberUserIdLister({
    env:{LINE_CHANNEL_ACCESS_TOKEN:'server-secret'},fetchImpl:async()=>response({}, {ok:false,status:503}),
  });
  const result=await lister('GROUP-PRIVATE');
  assert.deepEqual(result,{available:false,userIds:[],status:503,errorCode:'LINE_GROUP_MEMBER_HTTP_ERROR'});
  assert.doesNotMatch(JSON.stringify(result),/GROUP-PRIVATE|server-secret/);
});

test('LINE group-member timeout aborts the in-flight request and emits only safe metadata',async()=>{
  const logs=[];
  const lister=createGroupMemberUserIdLister({
    env:{LINE_CHANNEL_ACCESS_TOKEN:'server-secret',LINE_GROUP_MEMBER_FETCH_TIMEOUT_MS:'250'},
    operationalLogger:(...values)=>logs.push(values.join(' ')),
    setTimer:(callback)=>{queueMicrotask(callback);return 1;},clearTimer:()=>{},
    fetchImpl:async(_url,{signal})=>new Promise((_resolve,reject)=>{
      signal.addEventListener('abort',()=>reject(Object.assign(new Error('GROUP-PRIVATE token server-secret'),{name:'AbortError'})),{once:true});
    }),
  });
  const result=await lister('GROUP-PRIVATE');
  assert.deepEqual(result,{available:false,userIds:[],errorCode:'LINE_GROUP_MEMBER_TIMEOUT'});
  assert.equal(logs.length,1);
  assert.match(logs[0],/line_group_member_list_failed|LINE_GROUP_MEMBER_TIMEOUT/);
  assert.doesNotMatch(logs[0],/GROUP-PRIVATE|server-secret|token/);
});

test('LINE group-member abort/provider failure remains a bounded safe unavailable result',async()=>{
  for(const failure of [
    Object.assign(new Error('private abort detail'),{name:'AbortError'}),
    Object.assign(new Error('private transport detail'),{code:'ECONNRESET'}),
  ]) {
    const logs=[];
    const lister=createGroupMemberUserIdLister({
      env:{LINE_CHANNEL_ACCESS_TOKEN:'server-secret'},
      fetchImpl:async()=>{throw failure;},operationalLogger:(...values)=>logs.push(values.join(' ')),
    });
    const result=await lister('GROUP-PRIVATE');
    assert.equal(result.available,false);assert.deepEqual(result.userIds,[]);
    assert.match(result.errorCode,/^LINE_GROUP_MEMBER_(?:TIMEOUT|UNAVAILABLE)$/);
    assert.doesNotMatch(JSON.stringify(result)+logs.join(' '),/GROUP-PRIVATE|server-secret|private .* detail/);
  }
});
