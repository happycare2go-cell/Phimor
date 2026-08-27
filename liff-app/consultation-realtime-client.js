(function initConsultationRealtimeClient(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PhimorConsultationRealtime=api;
}(typeof window!=='undefined'?window:globalThis,function consultationRealtimeFactory(){
  const EVENT_TYPES=Object.freeze(['connection.ready','message.created','read.updated','case.updated','recovery.required']);
  function safeArray(value){return Array.isArray(value)?value:[];}
  function buildWebSocketUrl(backendUrl,path){
    const url=new URL(path,backendUrl);
    if(url.protocol==='https:')url.protocol='wss:';
    else if(url.protocol==='http:')url.protocol='ws:';
    else throw new Error('UNSAFE_REALTIME_URL');
    url.search='';url.hash='';url.username='';url.password='';
    return url.toString();
  }
  function reconnectDelay(attempt,random=Math.random){
    const base=Math.min(30000,1000*(2**Math.min(5,Math.max(0,attempt))));
    return base+Math.floor(Math.max(0,Math.min(1,Number(random())||0))*250);
  }
  function createRealtimeClient({
    request,backendUrl,ticketPath,WebSocketImpl=globalThis.WebSocket,
    onEvent=()=>{},onRecover=async()=>{},onStatus=()=>{},
    schedule=setTimeout,cancelSchedule=clearTimeout,random=Math.random,
    fallbackPollSeconds=5,
  }={}){
    if(typeof request!=='function'||typeof ticketPath!=='function')throw new Error('realtime request configuration is required');
    let socket=null,reconnectTimer=null,fallbackTimer=null,generation=0,attempt=0;
    let caseId=null,visible=true,stopped=false,status='idle';
    function setStatus(value){if(status===value)return;status=value;onStatus(value);}
    function clearTimers(){if(reconnectTimer!==null)cancelSchedule(reconnectTimer);if(fallbackTimer!==null)cancelSchedule(fallbackTimer);reconnectTimer=null;fallbackTimer=null;}
    function closeSocket(){const active=socket;socket=null;if(active&&active.readyState<2)active.close(1000,'client transition');}
    async function recover(){if(!caseId||stopped||!visible)return;try{await onRecover();}catch(_){/* next recovery cycle retries */}}
    function scheduleFallback(token){
      if(token!==generation||stopped||!visible||status==='connected'||fallbackTimer!==null)return;
      fallbackTimer=schedule(async()=>{fallbackTimer=null;if(token!==generation||status==='connected')return;await recover();scheduleFallback(token);},Math.max(2,Number(fallbackPollSeconds)||5)*1000);
    }
    function scheduleReconnect(token){
      if(token!==generation||stopped||!visible||reconnectTimer!==null)return;
      setStatus('reconnecting');scheduleFallback(token);
      reconnectTimer=schedule(()=>{reconnectTimer=null;connectSocket(token);},reconnectDelay(attempt++,random));
    }
    async function connectSocket(token){
      if(token!==generation||stopped||!visible||!caseId)return;
      if(typeof WebSocketImpl!=='function'){setStatus('fallback');scheduleFallback(token);return;}
      setStatus(attempt?'reconnecting':'connecting');
      try{
        const issued=await request(ticketPath(caseId),{method:'POST',body:'{}'});
        if(token!==generation||stopped||!visible)return;
        if(typeof issued?.ticket!=='string'||!issued.ticket)throw new Error('REALTIME_TICKET_MISSING');
        const next=new WebSocketImpl(buildWebSocketUrl(backendUrl,issued.websocketPath));socket=next;
        next.onopen=()=>{
          if(token!==generation||next!==socket)return;
          setStatus('connecting');
          next.send(JSON.stringify({type:'authenticate',ticket:issued.ticket}));
        };
        next.onmessage=async(event)=>{
          if(token!==generation||next!==socket)return;
          let message;try{message=JSON.parse(event.data);}catch(_){return;}
          if(!EVENT_TYPES.includes(message?.type)||message.caseId!==caseId)return;
          if(message.type==='connection.ready'){
            attempt=0;if(fallbackTimer!==null)cancelSchedule(fallbackTimer);fallbackTimer=null;
            setStatus('connected');await recover();
          }
          if(message.type==='recovery.required')await recover();
          onEvent(message);
        };
        next.onerror=()=>{if(token===generation&&status!=='connected')setStatus('fallback');};
        next.onclose=()=>{if(next===socket)socket=null;if(token===generation&&!stopped&&visible){setStatus('fallback');recover();scheduleReconnect(token);}};
      }catch(_){if(token===generation){setStatus('fallback');recover();scheduleReconnect(token);}}
    }
    function connect(nextCaseId){
      generation+=1;clearTimers();closeSocket();caseId=nextCaseId||null;attempt=0;stopped=false;
      if(!caseId){setStatus('idle');return;}
      connectSocket(generation);
    }
    function setVisible(value){
      visible=value!==false;
      if(!visible){clearTimers();closeSocket();setStatus('paused');return;}
      if(caseId&&!stopped){recover();connectSocket(generation);}
    }
    function stop(){stopped=true;generation+=1;clearTimers();closeSocket();caseId=null;setStatus('idle');}
    function snapshot(){return Object.freeze({caseId,status,visible,connected:status==='connected'});}
    return {connect,setVisible,stop,recover,snapshot};
  }
  return Object.freeze({EVENT_TYPES,safeArray,buildWebSocketUrl,reconnectDelay,createRealtimeClient});
}));
