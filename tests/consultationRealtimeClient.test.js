const test = require('node:test');
const assert = require('node:assert/strict');
const realtime = require('../liff-app/consultation-realtime-client');

test('WebSocket URL contains no bearer ticket, credentials, query or fragment and production uses WSS',()=>{
  const url=realtime.buildWebSocketUrl('https://backend.example/base?old=clinical#message','/api/consultations/realtime');
  assert.equal(url,'wss://backend.example/api/consultations/realtime');
  assert.doesNotMatch(url,/ticket|clinical|message|lineUserId|idToken|SHORT-TICKET/);
  assert.equal(realtime.buildWebSocketUrl('http://127.0.0.1:41755','/api/consultations/realtime'),'ws://127.0.0.1:41755/api/consultations/realtime');
});

test('reconnect backoff is exponential, jitter-bounded and capped',()=>{
  assert.equal(realtime.reconnectDelay(0,()=>0),1000);
  assert.equal(realtime.reconnectDelay(1,()=>0),2000);
  assert.equal(realtime.reconnectDelay(4,()=>1),16250);
  assert.equal(realtime.reconnectDelay(20,()=>0),30000);
});

test('connection.ready performs REST recovery and healthy socket stops fallback polling',async()=>{
  const recoveries=[],statuses=[],events=[],scheduled=[];
  class Socket {
    static OPEN=1;
    constructor(url){this.url=url;this.readyState=0;this.sent=[];Socket.instance=this;}
    send(value){this.sent.push(value);}
    close(){this.readyState=3;}
  }
  const client=realtime.createRealtimeClient({
    request:async()=>({ticket:'SHORT',websocketPath:'/api/consultations/realtime'}),backendUrl:'https://backend.example',ticketPath:(id)=>`/ticket/${id}`,WebSocketImpl:Socket,
    onRecover:async()=>recoveries.push('sync'),onStatus:(status)=>statuses.push(status),onEvent:(event)=>events.push(event),schedule:(fn,ms)=>{scheduled.push({fn,ms});return scheduled.length;},cancelSchedule:()=>{},random:()=>0,
  });
  client.connect('CASE-1');await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(Socket.instance.url,'wss://backend.example/api/consultations/realtime');Socket.instance.readyState=1;Socket.instance.onopen();
  assert.deepEqual(Socket.instance.sent,[JSON.stringify({type:'authenticate',ticket:'SHORT'})]);
  await Socket.instance.onmessage({data:JSON.stringify({type:'connection.ready',caseId:'CASE-1'})});
  assert.equal(client.snapshot().connected,true);assert.deepEqual(recoveries,['sync']);assert.equal(events[0].type,'connection.ready');
  assert.ok(statuses.includes('connected'));
});

test('bus recovery request performs bounded REST catch-up without exposing ticket through the URL',async()=>{
  let recovered=0;
  class Socket {static OPEN=1;constructor(url){this.url=url;this.readyState=1;Socket.instance=this;}send(){}close(){this.readyState=3;}}
  const client=realtime.createRealtimeClient({request:async()=>({ticket:'PRIVATE-TICKET',websocketPath:'/api/consultations/realtime'}),backendUrl:'https://backend.example',ticketPath:()=>'/ticket',WebSocketImpl:Socket,onRecover:async()=>{recovered+=1;},schedule:()=>1,cancelSchedule:()=>{}});
  client.connect('CASE-1');await new Promise((resolve)=>setImmediate(resolve));Socket.instance.onopen();
  await Socket.instance.onmessage({data:JSON.stringify({type:'connection.ready',caseId:'CASE-1'})});
  await Socket.instance.onmessage({data:JSON.stringify({type:'recovery.required',caseId:'CASE-1'})});
  assert.equal(recovered,2);
  assert.doesNotMatch(Socket.instance.url,/PRIVATE-TICKET|ticket=/);
});

test('socket loss retains REST recovery and reconnect path without sending chat over WebSocket',async()=>{
  let recovered=0;const scheduled=[];
  class Socket {static OPEN=1;constructor(){this.readyState=1;Socket.instances=(Socket.instances||[]).concat(this);}close(){this.readyState=3;}}
  const client=realtime.createRealtimeClient({request:async()=>({ticket:'SHORT',websocketPath:'/api/consultations/realtime'}),backendUrl:'https://backend.example',ticketPath:()=>'/ticket',WebSocketImpl:Socket,onRecover:async()=>{recovered+=1;},schedule:(fn,ms)=>{scheduled.push({fn,ms});return scheduled.length;},cancelSchedule:()=>{},random:()=>0});
  client.connect('CASE-1');await new Promise((resolve)=>setImmediate(resolve));
  Socket.instances[0].onclose();await new Promise((resolve)=>setImmediate(resolve));
  assert.equal(recovered,1);assert.ok(scheduled.some((item)=>item.ms===1000));assert.equal(typeof client.send,'undefined');
});
