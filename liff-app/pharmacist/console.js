(function initPharmacistConsole(root, factory) {
  const api=factory();
  if (typeof module!=='undefined' && module.exports) module.exports=api;
  if (root) root.PhimorPharmacistConsole=api;
}(typeof window!=='undefined'?window:globalThis,function pharmacistConsoleFactory(){
  const TABS=Object.freeze(['queue','active','resolved','closed']);
  const SOURCE_LABELS=Object.freeze({
    care_profile:'Care Profile',medication_snapshot:'Medication Snapshot',
    medication_diff:'Medication Diff',appointment:'Appointment',
    consultation_message:'Consultation message',general_ai_knowledge:'General AI guidance',
  });
  const ASSISTANT_SECTIONS=Object.freeze([
    ['recordedFacts','ข้อมูลที่บันทึกไว้'],['relevantMedicationContext','บริบทยาที่เกี่ยวข้อง'],
    ['medicationChanges','การเปลี่ยนแปลงรายการยา'],['missingInformation','ข้อมูลที่ยังขาด'],
    ['questionsToAsk','คำถามที่ควรถามเพิ่ม'],['safetyConsiderations','ประเด็นความปลอดภัย'],
    ['responseGuidance','โครงสร้างประกอบการตอบ'],['escalationConsiderations','ประเด็นพิจารณาส่งต่อ'],
  ]);

  function safeText(value,fallback=''){return typeof value==='string'?value:fallback;}
  function safeArray(value){return Array.isArray(value)?value:[];}
  function normalizedMessages(value){
    const bySequence=new Map();
    safeArray(value).forEach((item)=>{
      const sequence=Number(item?.sequence);
      if(Number.isSafeInteger(sequence)&&sequence>0&&!bySequence.has(sequence)) bySequence.set(sequence,item);
    });
    return [...bySequence.values()].sort((a,b)=>Number(a.sequence)-Number(b.sequence));
  }
  function mergeMessages(current,incoming){return normalizedMessages([...safeArray(current),...safeArray(incoming)]);}
  function formatDuration(seconds){
    const value=Math.max(0,Math.floor(Number(seconds)||0));
    const hours=Math.floor(value/3600); const minutes=Math.floor((value%3600)/60);
    return value<=0?'หมดเวลาแล้ว':`เหลือเวลา ${hours} ชม. ${minutes} นาที`;
  }
  function effectiveClosed(caseDetail={}){
    return caseDetail.effectiveClosed===true || caseDetail.state==='closed' || Number(caseDetail.remainingSeconds)===0;
  }
  function canMessage(caseDetail={}){
    return ['active','resolved'].includes(caseDetail.state) && !effectiveClosed(caseDetail);
  }
  function sourceLabel(category){return SOURCE_LABELS[category]||'ไม่ระบุแหล่งข้อมูล';}
  function closeReasonLabel(value){return value==='expired'?'ปิดอัตโนมัติเมื่อครบเวลาคำปรึกษา':'ปิดเคสแล้ว';}
  function stateLabel(value){return ({queued:'รอเภสัชกร',active:'กำลังปรึกษา',resolved:'ตอบประเด็นหลักแล้ว',closed:'หมดเวลาปรึกษาแล้ว'})[value]||'ไม่ทราบสถานะ';}
  function waitingOnLabel(value,state){if(['queued','resolved','closed'].includes(state))return 'ไม่มีฝ่ายที่กำลังรอคำตอบ';return value==='pharmacist'?'รอเภสัชกรตอบ':value==='customer'?'รอข้อมูลจากผู้ใช้':'ไม่มีฝ่ายที่กำลังรอคำตอบ';}
  function accessStateMessage(access,error){if(access==='allowed')return '';if(access==='loading')return 'กำลังตรวจสอบสิทธิ์…';if(access==='denied')return 'บัญชีนี้ยังไม่มีสิทธิ์ใช้งาน Pharmacist Console กรุณาติดต่อผู้ดูแลระบบ';if(error==='CONSULTATION_DISABLED')return 'ระบบปรึกษาเภสัชกรยังไม่เปิดใช้งาน';return 'ไม่สามารถเชื่อมต่อ Pharmacist Console ได้ กรุณาลองใหม่';}
  function assistantErrorMessage(code){return ({AI_TIMEOUT:'AI Assistant ใช้เวลานานเกินไป กรุณาลองใหม่ คุณยังสามารถตอบผู้ใช้ได้ตามปกติ',AI_RATE_LIMIT:'AI Assistant มีคำขอจำนวนมาก กรุณารอสักครู่แล้วลองใหม่',AI_INVALID_RESPONSE:'AI Assistant ไม่สามารถจัดรูปแบบข้อมูลได้ กรุณาลองใหม่',AI_UNAVAILABLE:'AI Assistant ยังไม่พร้อมใช้งาน คุณยังสามารถตอบผู้ใช้ได้ตามปกติ',AI_PROVIDER_ERROR:'AI Assistant ยังไม่พร้อมใช้งาน คุณยังสามารถตอบผู้ใช้ได้ตามปกติ'})[code]||'AI Assistant ไม่พร้อมใช้งานในขณะนี้ คุณยังสามารถตอบผู้ใช้ได้ตามปกติ';}
  function supportReference(correlationId){return correlationId?` (รหัสอ้างอิง ${correlationId})`:'';}
  function messageSendErrorMessage(code,correlationId=null){if(['CONSULTATION_EXPIRED','CONSULTATION_CLOSED'].includes(code))return 'เคสนี้หมดเวลาหรือปิดแล้ว จึงไม่สามารถส่งข้อความใหม่ได้';if(['CONSULTATION_ACCESS_DENIED','PHARMACIST_INACTIVE','PHARMACIST_LICENSE_NOT_VERIFIED'].includes(code))return 'สิทธิ์เข้าถึงเคสนี้ไม่พร้อมใช้งาน กรุณารีเฟรชหรือติดต่อผู้ดูแลระบบ';if(code==='CONSULTATION_RATE_LIMITED')return 'ส่งข้อความถี่เกินไป กรุณารอสักครู่';if(['CONSULTATION_NOT_ACCEPTED','CONSULTATION_NOT_ACTIVE','INVALID_WAITING_ON_STATE'].includes(code))return 'สถานะเคสยังไม่อนุญาตให้ส่งข้อความ กรุณารีเฟรชเคส';return `ระบบส่งข้อความไม่พร้อมชั่วคราว กรุณาลองใหม่${supportReference(correlationId)}`;}
  function createIdempotencyKey(cryptoApi=globalThis.crypto){
    if(cryptoApi&&typeof cryptoApi.randomUUID==='function') return cryptoApi.randomUUID();
    return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  function apiErrorCode(error){return safeText(error?.errorCode || error?.code,'REQUEST_FAILED');}
  function connectionLabel(status){return ({connecting:'กำลังเชื่อมต่อ…',connected:'เชื่อมต่อแล้ว',reconnecting:'กำลังเชื่อมใหม่…',fallback:'การเชื่อมต่อไม่เสถียร กำลังเชื่อมใหม่…',paused:'พักการเชื่อมต่อ',idle:''})[status]||'';}
  function readState(caseDetail={}){return {selfLastReadSequence:Number(caseDetail.readState?.selfLastReadSequence)||0,otherLastReadSequence:Number(caseDetail.readState?.otherLastReadSequence)||0};}
  function receiptState(message,caseDetail={},actorType='pharmacist'){
    if(message?.pendingState==='sending')return 'sending';
    if(message?.pendingState==='failed')return 'failed';
    if(message?.senderType!==actorType||!Number.isSafeInteger(Number(message?.sequence)))return null;
    return readState(caseDetail).otherLastReadSequence>=Number(message.sequence)?'read':'persisted';
  }
  function latestIncomingSequence(messages,actorType='pharmacist'){return normalizedMessages(messages).filter((item)=>item.senderType!==actorType).at(-1)?.sequence||0;}
  function shouldMarkRead({roomActive=false,documentVisible=false,nearBottom=false,messageVisible=false}={}){return roomActive&&documentVisible&&(nearBottom||messageVisible);}

  function createConsoleSession({request,onChange=()=>{},schedule=setTimeout,cancelSchedule=clearTimeout,pollSeconds=5,cryptoApi=globalThis.crypto,realtimeFactory=null}={}){
    if(typeof request!=='function') throw new Error('request is required');
    let revision=0; let pollTimer=null; let rateLimitTimer=null; let realtime=null; let highestReadRequested=0;
    let state={
      access:'loading',tab:'queue',collections:{queue:[],active:[],resolved:[],closed:[]},
      queueCursor:null,queueHasMore:false,selectedCase:null,roomOpen:false,messages:[],pendingMessages:[],lastSequence:0,beforeSequence:0,hasMoreOlder:false,
      caseContext:null,caseContextLoading:false,
      assistant:null,assistantBusy:false,sending:false,acceptingCaseId:null,resolving:false,
      error:null,statusMessage:'',retryAfterSeconds:0,connectionStatus:'idle',activePanel:null,
    };
    const snapshot=()=>({...state,collections:{...state.collections},messages:[...state.messages],pendingMessages:[...state.pendingMessages]});
    const notify=()=>onChange(snapshot());
    const patch=(value)=>{state={...state,...value};notify();};
    const token=()=>revision;
    const current=(value)=>value===revision;
    function stopPolling(){if(pollTimer!==null){cancelSchedule(pollTimer);pollTimer=null;}}
    function schedulePoll(){
      stopPolling();
      if(!state.selectedCase || documentHidden() || effectiveClosed(state.selectedCase) || state.connectionStatus==='connected') return;
      pollTimer=schedule(async()=>{pollTimer=null;await pollOnce();schedulePoll();},Math.max(2,Number(pollSeconds)||5)*1000);
    }
    function documentHidden(){return typeof document!=='undefined'&&document.hidden===true;}
    async function handleRealtime(event){
      if(!event||event.caseId!==state.selectedCase?.caseId)return;
      if(event.type==='message.created'&&event.message){
        const before=state.messages.length,messages=mergeMessages(state.messages,[event.message]);
        const unread=event.message.senderType==='customer'&&!state.roomOpen?Number(state.selectedCase.unreadCount||0)+Number(messages.length>before):state.selectedCase.unreadCount;
        patch({messages,lastSequence:Math.max(state.lastSequence,Number(event.sequence)||0),selectedCase:{...state.selectedCase,unreadCount:unread}});
      }
      if(event.type==='read.updated'){
        const self=event.reader==='pharmacist',currentRead=readState(state.selectedCase);
        patch({selectedCase:{...state.selectedCase,readState:{selfLastReadSequence:self?Math.max(currentRead.selfLastReadSequence,Number(event.sequence)||0):currentRead.selfLastReadSequence,otherLastReadSequence:self?currentRead.otherLastReadSequence:Math.max(currentRead.otherLastReadSequence,Number(event.sequence)||0)}}});
      }
      if(event.type==='case.updated'&&event.case)patch({selectedCase:{...state.selectedCase,...event.case}});
    }
    function startRealtime(caseId){
      realtime?.stop?.();realtime=null;
      if(typeof realtimeFactory!=='function'||!caseId||effectiveClosed(state.selectedCase)){patch({connectionStatus:effectiveClosed(state.selectedCase)?'idle':'fallback'});schedulePoll();return;}
      realtime=realtimeFactory({onEvent:handleRealtime,onRecover:pollOnce,onStatus:(connectionStatus)=>{patch({connectionStatus});if(connectionStatus==='connected')stopPolling();else schedulePoll();}});
      realtime.connect(caseId);
    }

    async function loadCollection(tab=state.tab,{append=false,filters={}}={}){
      if(!TABS.includes(tab)) return {ignored:true};
      const requestRevision=token();
      const params=new URLSearchParams();
      if(tab==='queue'&&append&&state.queueCursor) params.set('cursor',state.queueCursor);
      if(tab==='queue'&&filters.topicCategory) params.set('topicCategory',filters.topicCategory);
      if(tab==='queue'&&filters.triageCategory) params.set('triageCategory',filters.triageCategory);
      const suffix=params.toString()?`?${params}`:'';
      try{
        const result=await request(`/api/pharmacist/consultations/${tab}${suffix}`);
        if(!current(requestRevision)) return {ignored:true,stale:true};
        const items=safeArray(result.items);
        const collection=append?mergeCases(state.collections[tab],items):items;
        patch({access:'allowed',tab,collections:{...state.collections,[tab]:collection},
          queueCursor:tab==='queue'?(result.nextCursor||null):state.queueCursor,
          queueHasMore:tab==='queue'&&result.hasMore===true,error:null});
        return result;
      }catch(error){
        if(!current(requestRevision)) return {ignored:true,stale:true};
        const code=apiErrorCode(error);
        if(['PHARMACIST_NOT_FOUND','PHARMACIST_INACTIVE','PHARMACIST_LICENSE_NOT_VERIFIED','PHARMACIST_ACCESS_DENIED','UNAUTHENTICATED'].includes(code)) {
          patch({access:'denied',error:code});
        } else patch({access:state.access==='loading'?'error':state.access,error:code,statusMessage:'โหลดข้อมูลไม่สำเร็จ กรุณาลองใหม่'});
        return {error:code};
      }
    }

    function mergeCases(currentCases,incoming){
      const map=new Map(safeArray(currentCases).map((item)=>[item.caseId,item]));
      safeArray(incoming).forEach((item)=>{if(item?.caseId)map.set(item.caseId,item);});
      return [...map.values()];
    }
    async function initialize(){
      const result=await loadCollection('queue');
      if(state.access==='allowed') await loadCollection('active');
      return result;
    }
    async function switchTab(tab){
      if(!TABS.includes(tab)) return {ignored:true};
      patch({tab,error:null}); return loadCollection(tab);
    }
    async function selectCase(caseId){
      revision+=1; stopPolling();realtime?.stop?.();realtime=null;highestReadRequested=0;
      if(rateLimitTimer!==null){cancelSchedule(rateLimitTimer);rateLimitTimer=null;}
      const requestRevision=token();
      patch({selectedCase:null,roomOpen:false,messages:[],pendingMessages:[],lastSequence:0,beforeSequence:0,hasMoreOlder:false,caseContext:null,caseContextLoading:false,assistant:null,error:null,statusMessage:'กำลังโหลดเคส…',sending:false,resolving:false,retryAfterSeconds:0,connectionStatus:'idle',activePanel:null});
      try{
        const detail=await request(`/api/pharmacist/consultations/${encodeURIComponent(caseId)}`);
        if(!current(requestRevision)) return {ignored:true,stale:true};
        patch({selectedCase:detail,roomOpen:true,statusMessage:'',caseContextLoading:!effectiveClosed(detail)});
        const [messagesResult,contextResult]=await Promise.all([
          request(`/api/pharmacist/consultations/${encodeURIComponent(caseId)}/messages?beforeSequence=0&limit=50`),
          effectiveClosed(detail)
            ? Promise.resolve(null)
            : request(`/api/pharmacist/consultations/${encodeURIComponent(caseId)}/context`).catch((error)=>({status:'unavailable',errorCode:apiErrorCode(error)})),
        ]);
        if(!current(requestRevision)||state.selectedCase?.caseId!==caseId) return {ignored:true,stale:true};
        const messages=normalizedMessages(messagesResult.items);
        patch({messages,lastSequence:Number(messagesResult.nextSequence)||messages.at(-1)?.sequence||0,beforeSequence:messages[0]?.sequence||0,hasMoreOlder:messagesResult.hasMoreOlder===true,caseContext:contextResult,caseContextLoading:false});
        startRealtime(caseId);schedulePoll(); return {detail,messages,context:contextResult};
      }catch(error){
        if(current(requestRevision)) patch({error:apiErrorCode(error),statusMessage:'เปิดเคสไม่สำเร็จ'});
        return {error:apiErrorCode(error)};
      }
    }
    async function acceptCase(caseId){
      if(state.acceptingCaseId) return {ignored:true};
      const requestRevision=token();
      patch({acceptingCaseId:caseId,error:null});
      try{
        const detail=await request(`/api/pharmacist/consultations/${encodeURIComponent(caseId)}/accept`,{method:'POST',body:'{}'});
        patch({acceptingCaseId:null});
        if(!current(requestRevision))return {ignored:true,stale:true,detail};
        await Promise.all([loadCollection('queue'),loadCollection('active')]);
        await selectCase(detail.caseId||caseId); return detail;
      }catch(error){
        const code=apiErrorCode(error);
        if(current(requestRevision))patch({acceptingCaseId:null,error:code,statusMessage:code==='CASE_ALREADY_ACCEPTED'?'เคสนี้มีเภสัชกรท่านอื่นรับแล้ว':'รับเคสไม่สำเร็จ'});
        else patch({acceptingCaseId:null});
        if(current(requestRevision)&&code==='CASE_ALREADY_ACCEPTED') await loadCollection('queue');
        return {error:code};
      }
    }
    async function pollOnce(){
      const caseId=state.selectedCase?.caseId;
      if(!caseId) return {ignored:true};
      const requestRevision=token();
      try{
        const [detail,result]=await Promise.all([
          request(`/api/pharmacist/consultations/${encodeURIComponent(caseId)}`),
          request(`/api/pharmacist/consultations/${encodeURIComponent(caseId)}/messages?afterSequence=${state.lastSequence}&limit=50`),
        ]);
        if(!current(requestRevision)||state.selectedCase?.caseId!==caseId)return {ignored:true,stale:true};
        const messages=mergeMessages(state.messages,result.items);
        patch({selectedCase:detail,messages,lastSequence:Number(result.nextSequence)||messages.at(-1)?.sequence||state.lastSequence,error:null});
        return {detail,messages};
      }catch(error){if(current(requestRevision))patch({error:apiErrorCode(error),statusMessage:'อัปเดตข้อความไม่สำเร็จ'});return {error:apiErrorCode(error)};}
    }
    async function loadOlderMessages(){
      const caseId=state.selectedCase?.caseId;if(!caseId||!state.hasMoreOlder)return {ignored:true};
      const requestRevision=token();
      try{
        const result=await request(`/api/pharmacist/consultations/${encodeURIComponent(caseId)}/messages?beforeSequence=${state.beforeSequence||0}&limit=50`);
        if(!current(requestRevision)||state.selectedCase?.caseId!==caseId)return {ignored:true,stale:true};
        const messages=mergeMessages(result.items,state.messages);
        patch({messages,beforeSequence:messages[0]?.sequence||state.beforeSequence,hasMoreOlder:result.hasMoreOlder===true});return result;
      }catch(error){if(current(requestRevision))patch({statusMessage:'โหลดข้อความก่อนหน้าไม่สำเร็จ'});return {error:apiErrorCode(error)};}
    }
    async function sendMessage(body,retryKey=null){
      const text=safeText(body).trim(); const caseId=state.selectedCase?.caseId;
      if(state.sending||state.retryAfterSeconds>0||!caseId||!text||text.length>4000||!canMessage(state.selectedCase))return {ignored:true};
      const requestRevision=token(),key=retryKey||createIdempotencyKey(cryptoApi);
      const pending={clientId:key,body:text,senderType:'pharmacist',createdAt:new Date().toISOString(),pendingState:'sending'};
      patch({sending:true,error:null,statusMessage:'',pendingMessages:[...state.pendingMessages.filter((item)=>item.clientId!==key),pending]});
      try{
        const result=await request(`/api/pharmacist/consultations/${encodeURIComponent(caseId)}/messages`,{
          method:'POST',body:JSON.stringify({body:text,idempotencyKey:key}),
        });
        if(current(requestRevision)&&state.selectedCase?.caseId===caseId){
          const messages=mergeMessages(state.messages,result.message?[result.message]:[]);
          patch({sending:false,pendingMessages:state.pendingMessages.filter((item)=>item.clientId!==key),messages,lastSequence:messages.at(-1)?.sequence||state.lastSequence});
        } else return {ignored:true,stale:true};
        return result;
      }catch(error){
        if(!current(requestRevision)||state.selectedCase?.caseId!==caseId)return {ignored:true,stale:true};
        const retryAfterSeconds=Math.max(0,Number(error?.retryAfterSeconds)||0);
        const code=apiErrorCode(error),closed=['CONSULTATION_EXPIRED','CONSULTATION_CLOSED'].includes(code);
        patch({sending:false,error:code,retryAfterSeconds,pendingMessages:state.pendingMessages.map((item)=>item.clientId===key?{...item,pendingState:'failed'}:item),statusMessage:messageSendErrorMessage(code,error?.correlationId)});
        if(rateLimitTimer!==null)cancelSchedule(rateLimitTimer);
        if(retryAfterSeconds>0)rateLimitTimer=schedule(()=>{rateLimitTimer=null;patch({retryAfterSeconds:0,statusMessage:''});},retryAfterSeconds*1000);
        if(closed)await pollOnce();
        return {error:code};
      }
    }
    function retryMessage(clientId){const item=state.pendingMessages.find((candidate)=>candidate.clientId===clientId&&candidate.pendingState==='failed');return item?sendMessage(item.body,item.clientId):Promise.resolve({ignored:true});}
    async function markRead(sequence){
      const value=Number(sequence),caseId=state.selectedCase?.caseId;
      if(!state.roomOpen||documentHidden()||!caseId||!Number.isSafeInteger(value)||value<=highestReadRequested)return {ignored:true};
      highestReadRequested=value;
      try{
        const result=await request(`/api/pharmacist/consultations/${encodeURIComponent(caseId)}/read`,{method:'POST',body:JSON.stringify({sequence:value})});
        const currentRead=readState(state.selectedCase);patch({selectedCase:{...state.selectedCase,readState:{...currentRead,selfLastReadSequence:Math.max(currentRead.selfLastReadSequence,Number(result.sequence)||0)},unreadCount:0}});return result;
      }catch(error){return {error:apiErrorCode(error)};}
    }
    async function resolveCase(){
      const caseId=state.selectedCase?.caseId;
      if(!caseId||state.resolving||state.selectedCase?.state!=='active'||!canMessage(state.selectedCase))return {ignored:true};
      const requestRevision=token();
      patch({resolving:true});
      try{
        await request(`/api/pharmacist/consultations/${encodeURIComponent(caseId)}/resolve`,{method:'POST',body:'{}'});
        if(!current(requestRevision)||state.selectedCase?.caseId!==caseId)return {ignored:true,stale:true};
        const result=await pollOnce(); patch({resolving:false}); await Promise.all([loadCollection('active'),loadCollection('resolved')]); return result;
      }catch(error){if(!current(requestRevision)||state.selectedCase?.caseId!==caseId)return {ignored:true,stale:true};patch({resolving:false,error:apiErrorCode(error),statusMessage:`เปลี่ยนสถานะไม่สำเร็จ${supportReference(error?.correlationId)}`});return {error:apiErrorCode(error)};}
    }
    async function generateAssistant(){
      const caseId=state.selectedCase?.caseId;
      if(!caseId||state.assistantBusy||effectiveClosed(state.selectedCase))return {ignored:true};
      const requestRevision=token(); patch({assistantBusy:true,assistant:{status:'loading'},error:null});
      try{
        const result=await request(`/api/pharmacist/consultations/${encodeURIComponent(caseId)}/assistant`,{method:'POST',body:JSON.stringify({refresh:true})});
        if(!current(requestRevision)||state.selectedCase?.caseId!==caseId)return {ignored:true,stale:true};
        patch({assistantBusy:false,assistant:result}); return result;
      }catch(error){
        if(current(requestRevision)){const code=apiErrorCode(error);patch({assistantBusy:false,assistant:{status:'unavailable',errorCode:code},error:code});}
        return {error:apiErrorCode(error)};
      }
    }
    function clearSelection(){revision+=1;stopPolling();realtime?.stop?.();realtime=null;patch({selectedCase:null,roomOpen:false,messages:[],pendingMessages:[],lastSequence:0,beforeSequence:0,hasMoreOlder:false,caseContext:null,caseContextLoading:false,assistant:null,statusMessage:'',connectionStatus:'idle',activePanel:null});}
    function setPanel(activePanel){patch({activePanel:activePanel||null});}
    function handleVisibilityChange(){const visible=!documentHidden();realtime?.setVisible?.(visible);if(!visible)stopPolling();else{pollOnce();schedulePoll();}}
    return {snapshot,initialize,loadCollection,switchTab,selectCase,acceptCase,pollOnce,loadOlderMessages,sendMessage,retryMessage,markRead,resolveCase,generateAssistant,clearSelection,setPanel,stopPolling,schedulePoll,handleVisibilityChange};
  }

  function clearNode(node){while(node?.firstChild)node.removeChild(node.firstChild);}
  function textElement(doc,parent,tag,className,text){const el=doc.createElement(tag);if(className)el.className=className;el.textContent=safeText(text);parent.appendChild(el);return el;}
  function formatMessageTime(value){const date=new Date(value);return Number.isNaN(date.getTime())?'':date.toLocaleTimeString('th-TH',{hour:'2-digit',minute:'2-digit'});}
  function messageDateKey(value){const date=new Date(value);return Number.isNaN(date.getTime())?'':`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;}
  function messageDateLabel(value,now=new Date()){const date=new Date(value);if(Number.isNaN(date.getTime()))return '';return messageDateKey(date)===messageDateKey(now)?'วันนี้':date.toLocaleDateString('th-TH',{day:'numeric',month:'short',year:'numeric'});}
  function contextValue(value,fallback='ไม่ระบุ'){if(Array.isArray(value))return value.length?value.join(', '):fallback;if(value===null||value===undefined||value==='')return fallback;return String(value);}
  function renderCaseContext(doc,container,context,{loading=false}={}){
    clearNode(container);
    if(loading){container.hidden=false;textElement(doc,container,'p','case-context__status','กำลังโหลดข้อมูลผู้ติดต่อและ Care Profile…');return;}
    if(!context){container.hidden=true;return;}
    container.hidden=false;
    if(context.status==='unavailable'){
      textElement(doc,container,'p','case-context__status','ข้อมูล Care Profile ไม่พร้อมใช้งาน กรุณาตอบจากข้อมูลในบทสนทนาและสอบถามผู้ใช้เพิ่มเติม');return;
    }
    const contactSection=doc.createElement('section');contactSection.className='case-context__contact';
    textElement(doc,contactSection,'h3','','ผู้ติดต่อผ่าน LINE');
    const contactRow=doc.createElement('div');contactRow.className='case-context__contact-row';
    if(context.contact?.pictureUrl){const image=doc.createElement('img');image.className='case-context__avatar';image.src=context.contact.pictureUrl;image.alt='รูปโปรไฟล์ LINE ของผู้ติดต่อ';image.addEventListener?.('error',()=>{image.hidden=true;});contactRow.appendChild(image);}
    const contactCopy=doc.createElement('div');textElement(doc,contactCopy,'strong','',contextValue(context.contact?.displayName,'ผู้ติดต่อผ่าน LINE'));textElement(doc,contactCopy,'p','case-context__hint','บัญชีผู้ติดต่ออาจเป็นญาติหรือผู้ดูแล ไม่จำเป็นต้องเป็นผู้รับการดูแล');contactRow.appendChild(contactCopy);contactSection.appendChild(contactRow);container.appendChild(contactSection);

    const profile=context.careProfile||{};const profileSection=doc.createElement('section');profileSection.className='case-context__profile';
    textElement(doc,profileSection,'h3','','Care Profile ของผู้รับการดูแล');
    const fields=[['ชื่อ',profile.patientName],['เพศ',profile.gender],['กรุ๊ปเลือด',profile.bloodType],['ส่วนสูง',profile.heightCm===null?null:`${profile.heightCm} ซม.`],['น้ำหนัก',profile.weightKg===null?null:`${profile.weightKg} กก.`],['โรคประจำตัว',profile.chronicConditions],['แพ้ยา',profile.drugAllergies],['แพ้อาหาร',profile.foodAllergies],['ข้อจำกัดการเคลื่อนไหว',profile.mobilityLimitations]];
    const grid=doc.createElement('dl');grid.className='case-context__grid';fields.forEach(([label,value])=>{const item=doc.createElement('div');textElement(doc,item,'dt','',label);textElement(doc,item,'dd','',contextValue(value));grid.appendChild(item);});profileSection.appendChild(grid);container.appendChild(profileSection);

    const medicationSection=doc.createElement('section');medicationSection.className='case-context__medications';textElement(doc,medicationSection,'h3','','ยาปัจจุบันที่บันทึกไว้');
    const medications=safeArray(context.currentMedications);if(!medications.length)textElement(doc,medicationSection,'p','case-context__hint','ยังไม่มีรายการยาปัจจุบัน');else{const list=doc.createElement('ul');medications.forEach((item)=>{const details=[item.dose,item.instruction,item.condition].filter(Boolean).join(' · ');textElement(doc,list,'li','',`${contextValue(item.name)}${details?` — ${details}`:''}`);});medicationSection.appendChild(list);}container.appendChild(medicationSection);

    const appointmentSection=doc.createElement('section');appointmentSection.className='case-context__appointments';textElement(doc,appointmentSection,'h3','','นัดหมายที่กำลังจะมาถึง');
    const appointments=safeArray(context.upcomingAppointments);if(!appointments.length)textElement(doc,appointmentSection,'p','case-context__hint','ยังไม่มีนัดหมายที่กำลังจะมาถึง');else{const list=doc.createElement('ul');appointments.forEach((item)=>{const when=item.datetime?new Date(item.datetime).toLocaleString('th-TH'):'ไม่ระบุเวลา';textElement(doc,list,'li','',`${contextValue(item.hospital)} · ${when}${item.reasonForVisit?` · ${item.reasonForVisit}`:''}`);});appointmentSection.appendChild(list);}container.appendChild(appointmentSection);
    textElement(doc,container,'small','case-context__timestamp',`ข้อมูล Care Profile ณ ${context.generatedAt?new Date(context.generatedAt).toLocaleString('th-TH'):'เวลาที่เปิดเคส'}`);
  }
  function renderAssistant(doc,container,result={}){
    clearNode(container);
    if(!result || !result.status){
      textElement(doc,container,'p','empty-state','เลือกเคสแล้วกด “สร้างสรุปช่วยตอบ” ระบบจะไม่เรียก AI โดยอัตโนมัติ');return;
    }
    if(result.status==='loading'){
      textElement(doc,container,'p','assistant-loading','กำลังจัดเตรียมสรุปเพื่อช่วยเภสัชกร กรุณารอสักครู่…');return;
    }
    if(result.status!=='available'){
      textElement(doc,container,'p','assistant-unavailable',assistantErrorMessage(result.errorCode));return;
    }
    const assistant=result.assistant||{};
    textElement(doc,container,'h3','assistant-summary',safeText(assistant.caseSummary,'ไม่พบข้อมูลสรุป'));
    textElement(doc,container,'p','context-time',`ข้อมูล Care Profile ณ ${safeText(result.contextTimestamp||result.generatedAt,'ไม่ระบุเวลา')}`);
    ASSISTANT_SECTIONS.forEach(([key,label])=>{
      const items=safeArray(assistant[key]);if(!items.length)return;
      const section=doc.createElement('section');section.className=`assistant-section assistant-section--${key}`;
      textElement(doc,section,'h4','',label);const list=doc.createElement('ul');
      items.forEach((item)=>{const li=doc.createElement('li');const value=typeof item==='string'?item:item?.text;textElement(doc,li,'span','assistant-item-text',safeText(value));if(item?.sourceCategory)textElement(doc,li,'span',`source-chip source-chip--${item.sourceCategory}`,sourceLabel(item.sourceCategory));list.appendChild(li);});
      section.appendChild(list);container.appendChild(section);
    });
    if(assistant.disclaimer)textElement(doc,container,'p','assistant-disclaimer',assistant.disclaimer);
  }
  function renderMessages(doc,container,messages,{pendingMessages=[],caseDetail={},onRetry=()=>{},now=new Date()}={}){
    clearNode(container);let currentDate='';
    const persisted=normalizedMessages(messages),latestOwnRead=persisted.filter((item)=>item.senderType==='pharmacist'&&receiptState(item,caseDetail)==='read').at(-1)?.sequence;
    [...persisted,...safeArray(pendingMessages)].forEach((item)=>{
      const key=messageDateKey(item.createdAt);if(key&&key!==currentDate){currentDate=key;textElement(doc,container,'div','chat-date-separator',messageDateLabel(item.createdAt,now));}
      const own=item.senderType==='pharmacist';
      const bubble=doc.createElement('article');bubble.className=`chat-message chat-message--${own?'own':'other'}${item.pendingState?` chat-message--${item.pendingState}`:''}`;bubble.dataset=bubble.dataset||{};
      if(item.sequence)bubble.dataset.sequence=String(item.sequence);bubble.dataset.senderType=item.senderType||'system';
      textElement(doc,bubble,'p','chat-body',item.body);
      const meta=textElement(doc,bubble,'div','chat-message__meta','');textElement(doc,meta,'time','',formatMessageTime(item.createdAt));
      const receipt=receiptState(item,caseDetail);
      if(receipt==='sending')textElement(doc,meta,'span','chat-receipt','กำลังส่ง…');
      if(receipt==='persisted')textElement(doc,meta,'span','chat-receipt','✓');
      if(receipt==='read')textElement(doc,meta,'span','chat-receipt',Number(item.sequence)===Number(latestOwnRead)?'✓✓ อ่านแล้ว':'✓✓');
      if(receipt==='failed'){textElement(doc,meta,'span','chat-receipt chat-receipt--failed','ส่งไม่สำเร็จ');const retry=textElement(doc,meta,'button','chat-retry-message','ลองอีกครั้ง');retry.type='button';retry.addEventListener('click',()=>onRetry(item.clientId));}
      container.appendChild(bubble);
    });
  }
  function renderQueue(doc,container,items,{acceptingCaseId=null,showAccept=false,onSelect=()=>{},onAccept=()=>{}}={}){
    clearNode(container);
    if(!safeArray(items).length){textElement(doc,container,'p','empty-state','ยังไม่มีเคสในรายการ');return;}
    items.forEach((item)=>{
      const card=doc.createElement('article');card.className=`case-card case-card--${safeText(item.state,showAccept?'queued':'active')}`;
      textElement(doc,card,'strong','case-id',item.caseId);
      textElement(doc,card,'span','case-meta',item.queuedAt?new Date(item.queuedAt).toLocaleString('th-TH'):'ไม่ระบุเวลา');
      textElement(doc,card,'span','case-chip',safeText(item.topicCategory,'ไม่ระบุหัวข้อ'));
      textElement(doc,card,'span','case-chip',safeText(item.triageCategory,'ไม่ระบุ triage'));
      if(Number(item.unreadCount)>0)textElement(doc,card,'strong','case-unread',`${Number(item.unreadCount)} ข้อความใหม่`);
      if(Number.isFinite(Number(item.waitingSeconds)))textElement(doc,card,'span','waiting-time',`รอ ${Math.floor(Number(item.waitingSeconds)/60)} นาที`);
      if(!showAccept){card.tabIndex=0;card.setAttribute?.('role','button');card.addEventListener('click',()=>onSelect(item.caseId));card.addEventListener('keydown',(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault?.();onSelect(item.caseId);}});}
      if(showAccept){const button=textElement(doc,card,'button','accept-button','รับเคส');button.type='button';button.disabled=acceptingCaseId===item.caseId;
        button.addEventListener('click',(event)=>{event.stopPropagation?.();onAccept(item.caseId);});card.appendChild(button);}
      container.appendChild(card);
    });
  }
  function renderCaseHeader(doc,container,selectedCase,caseContext=null){
    clearNode(container);container.className=`case-header${selectedCase?` case-header--${effectiveClosed(selectedCase)?'closed':selectedCase.state}`:''}`;
    if(!selectedCase)return;
    textElement(doc,container,'h2','',safeText(caseContext?.careProfile?.patientName,`เคส ${selectedCase.caseId}`));
    textElement(doc,container,'span',`state-chip state-chip--${effectiveClosed(selectedCase)?'closed':selectedCase.state}`,stateLabel(effectiveClosed(selectedCase)?'closed':selectedCase.state));
    textElement(doc,container,'span','waiting-chip',waitingOnLabel(selectedCase.waitingOn,selectedCase.state));
    textElement(doc,container,'span','countdown',formatDuration(selectedCase.remainingSeconds));
    if(selectedCase.topicCategory)textElement(doc,container,'span','sr-only',selectedCase.topicCategory);
    if(selectedCase.triageCategory)textElement(doc,container,'span','sr-only',selectedCase.triageCategory);
    if(selectedCase.initialQuestion)textElement(doc,container,'span','sr-only',`คำถามตั้งต้น: ${selectedCase.initialQuestion}`);
    if(effectiveClosed(selectedCase))textElement(doc,container,'small','closed-reason',closeReasonLabel(selectedCase.closeReason));
  }

  function createController({doc,session}){
    const elements={
      access:doc.getElementById('accessState'),app:doc.getElementById('consoleApp'),list:doc.getElementById('caseList'),
      header:doc.getElementById('caseHeader'),messages:doc.getElementById('chatMessages'),composer:doc.getElementById('messageComposer'),
      context:doc.getElementById('caseContext'),
      send:doc.getElementById('sendMessageButton'),resolve:doc.getElementById('resolveButton'),assistant:doc.getElementById('assistantContent'),
      assistantButton:doc.getElementById('generateAssistantButton'),status:doc.getElementById('statusLive'),loadMore:doc.getElementById('loadMoreButton'),
      assistantRefresh:doc.getElementById('refreshAssistantButton'),
      closeChat:doc.getElementById('closeChatButton'),connection:doc.getElementById('chatConnectionState'),roomActions:doc.getElementById('chatRoomActions'),
      initial:doc.getElementById('chatInitialQuestion'),loadOlder:doc.getElementById('loadOlderMessagesButton'),newMessages:doc.getElementById('newMessagesButton'),closed:doc.getElementById('chatClosedState'),
      contextPanel:doc.getElementById('caseContextPanel'),assistantPanel:doc.getElementById('assistantPanel'),showContext:doc.getElementById('showCaseContextButton'),showAssistant:doc.getElementById('showAssistantButton'),closeContext:doc.getElementById('closeCaseContextButton'),closeAssistant:doc.getElementById('closeAssistantButton'),
    };
    let lastCaseId=null,lastRenderedSequence=0,observer=null;
    const isNearBottom=()=>!elements.messages||elements.messages.scrollHeight-elements.messages.scrollTop-elements.messages.clientHeight<90;
    function markVisible(state){if(!shouldMarkRead({roomActive:state.roomOpen,documentVisible:doc.visibilityState!=='hidden',nearBottom:isNearBottom()}))return;const incoming=latestIncomingSequence(state.messages);if(incoming>0)session.markRead(incoming);}
    function observeIncoming(state){
      observer?.disconnect?.();if(typeof IntersectionObserver!=='function'||!state.roomOpen)return;
      observer=new IntersectionObserver((entries)=>{let highest=0;entries.forEach((entry)=>{if(entry.isIntersecting&&entry.target?.dataset?.senderType==='customer')highest=Math.max(highest,Number(entry.target.dataset.sequence)||0);});if(highest&&shouldMarkRead({roomActive:state.roomOpen,documentVisible:doc.visibilityState!=='hidden',messageVisible:true}))session.markRead(highest);},{root:elements.messages,threshold:.65});
      elements.messages.querySelectorAll?.('[data-sender-type="customer"][data-sequence]')?.forEach?.((node)=>observer.observe(node));
    }
    function render(state){
      const beforeNear=isNearBottom(),beforeHeight=elements.messages?.scrollHeight||0;
      if(lastCaseId!==state.selectedCase?.caseId){elements.composer.value='';lastCaseId=state.selectedCase?.caseId||null;lastRenderedSequence=0;elements.newMessages.hidden=true;}
      elements.access.hidden=state.access==='allowed';elements.app.hidden=state.access!=='allowed';
      elements.access.textContent=accessStateMessage(state.access,state.error);
      elements.status.textContent=state.statusMessage||'';
      doc.body?.classList?.toggle('pharmacist-chat-open',Boolean(state.roomOpen&&state.selectedCase));
      doc.querySelectorAll('[data-tab]').forEach((button)=>button.classList?.toggle('active',button.dataset.tab===state.tab));
      renderQueue(doc,elements.list,state.collections[state.tab],{acceptingCaseId:state.acceptingCaseId,showAccept:state.tab==='queue',onSelect:session.selectCase,onAccept:session.acceptCase});
      elements.loadMore.hidden=state.tab!=='queue'||!state.queueHasMore;
      renderCaseHeader(doc,elements.header,state.selectedCase,state.caseContext);
      renderCaseContext(doc,elements.context,state.caseContext,{loading:state.caseContextLoading});
      renderMessages(doc,elements.messages,state.messages,{pendingMessages:state.pendingMessages,caseDetail:state.selectedCase||{},onRetry:session.retryMessage});
      const writable=state.selectedCase&&canMessage(state.selectedCase)&&state.retryAfterSeconds===0;
      elements.composer.disabled=!writable||state.sending;elements.send.disabled=!writable||state.sending||!elements.composer.value.trim();
      elements.resolve.disabled=!writable||state.selectedCase?.state!=='active'||state.resolving;elements.resolve.hidden=!state.selectedCase;
      elements.composer.parentElement.hidden=!state.selectedCase||!writable;
      elements.closed.hidden=!state.selectedCase||!effectiveClosed(state.selectedCase);
      elements.connection.textContent=connectionLabel(state.connectionStatus);elements.connection.dataset.state=state.connectionStatus;
      elements.roomActions.hidden=!state.selectedCase;elements.initial.hidden=!state.selectedCase?.initialQuestion;elements.initial.textContent=state.selectedCase?.initialQuestion?`คำถามเริ่มต้น\n${state.selectedCase.initialQuestion}`:'';
      elements.loadOlder.hidden=!state.hasMoreOlder;
      elements.contextPanel.hidden=state.activePanel!=='context';elements.assistantPanel.hidden=state.activePanel!=='assistant';
      elements.assistantButton.disabled=!state.selectedCase||effectiveClosed(state.selectedCase)||state.assistantBusy;
      elements.assistantButton.textContent=state.assistantBusy?'กำลังสร้างสรุป…':'สร้างสรุปช่วยตอบ';
      elements.assistantRefresh.disabled=elements.assistantButton.disabled;elements.assistantRefresh.hidden=state.assistant?.status!=='available';
      renderAssistant(doc,elements.assistant,state.assistant);
      const newest=state.messages.at(-1)?.sequence||0;
      if(state.roomOpen&&newest>lastRenderedSequence){if(beforeNear)elements.messages.scrollTop=elements.messages.scrollHeight;else elements.newMessages.hidden=false;lastRenderedSequence=newest;}
      if(state.roomOpen&&beforeHeight&&state.hasMoreOlder&&!beforeNear)elements.messages.scrollTop+=Math.max(0,elements.messages.scrollHeight-beforeHeight);
      observeIncoming(state);markVisible(state);
    }
    session._setRenderer?.(render);
    doc.querySelectorAll('[data-tab]').forEach((button)=>button.addEventListener('click',()=>session.switchTab(button.dataset.tab)));
    const filters=()=>({topicCategory:doc.getElementById('topicFilter').value.trim(),triageCategory:doc.getElementById('triageFilter').value.trim()});
    doc.getElementById('refreshListButton').addEventListener('click',()=>session.loadCollection(session.snapshot().tab,{filters:filters()}));
    elements.loadMore.addEventListener('click',()=>session.loadCollection('queue',{append:true,filters:filters()}));
    elements.composer.addEventListener('input',()=>{elements.composer.style.height='auto';elements.composer.style.height=`${Math.min(120,elements.composer.scrollHeight)}px`;render(session.snapshot());});
    elements.composer.addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();elements.send.click();}});
    elements.send.addEventListener('click',async()=>{const value=elements.composer.value;if(!value.trim())return;const result=await session.sendMessage(value);if(!result?.error&&!result?.ignored)elements.composer.value='';render(session.snapshot());});
    elements.resolve.addEventListener('click',()=>session.resolveCase());
    elements.assistantButton.addEventListener('click',()=>session.generateAssistant());
    elements.assistantRefresh.addEventListener('click',()=>session.generateAssistant());
    elements.closeChat.addEventListener('click',()=>session.clearSelection());
    elements.loadOlder.addEventListener('click',()=>session.loadOlderMessages());
    elements.messages.addEventListener('scroll',()=>{if(isNearBottom()){elements.newMessages.hidden=true;markVisible(session.snapshot());}});
    elements.newMessages.addEventListener('click',()=>{elements.messages.scrollTop=elements.messages.scrollHeight;elements.newMessages.hidden=true;markVisible(session.snapshot());});
    elements.showContext.addEventListener('click',()=>session.setPanel('context'));
    elements.showAssistant.addEventListener('click',()=>session.setPanel('assistant'));
    elements.closeContext.addEventListener('click',()=>session.setPanel(null));
    elements.closeAssistant.addEventListener('click',()=>session.setPanel(null));
    doc.addEventListener('visibilitychange',session.handleVisibilityChange);
    render(session.snapshot());return {render};
  }

  function createHttpClient({backendUrl,idToken,fetchImpl=fetch}){
    return async function request(path,options={}){
      const response=await fetchImpl(backendUrl+path,{...options,headers:{'Content-Type':'application/json','Authorization':`Bearer ${idToken}`,...(options.headers||{})}});
      let body={};try{body=await response.json();}catch(_){body={};}
      if(!response.ok){const error=new Error('request failed');const rawCode=body.errorCode||body.code||body.error;error.errorCode=rawCode==='pharmacist_access_denied'?'PHARMACIST_ACCESS_DENIED':rawCode||'REQUEST_FAILED';error.status=response.status;error.retryAfterSeconds=Number(response.headers?.get?.('Retry-After'))||0;error.correlationId=safeText(body.correlationId)||null;throw error;}
      return body;
    };
  }

  async function bootstrap({root=window,doc=document,fetchImpl=fetch,liffApi=root.liff,onSession=null}={}){
    const access=doc.getElementById('accessState');
    try{
      const backendUrl=root.PhimorRuntimeConfig.requireBackendUrl(root.PHIMOR_PUBLIC_BACKEND_URL);
      const response=await fetchImpl(`${backendUrl}/config/liff`);if(!response.ok)throw new Error('LIFF_RUNTIME_CONFIG_UNAVAILABLE');
      const config=await response.json();root.PhimorRuntimeConfig.assertBackendConfig(backendUrl,config);
      const liffId=config.pharmacistLiffId;
      if(!liffId)throw new Error('LIFF_ID_PHARMACIST_MISSING');
      await liffApi.init({liffId});if(!liffApi.isLoggedIn()){liffApi.login();return null;}
      const idToken=liffApi.getIDToken();if(!idToken)throw new Error('LINE_ID_TOKEN_MISSING');
      let renderer=()=>{};
      const request=createHttpClient({backendUrl,idToken,fetchImpl});
      const realtimeFactory=typeof root.PhimorConsultationRealtime?.createRealtimeClient==='function'
        ? (handlers)=>root.PhimorConsultationRealtime.createRealtimeClient({request,backendUrl,ticketPath:(caseId)=>`/api/pharmacist/consultations/${encodeURIComponent(caseId)}/realtime-ticket`,...handlers})
        : null;
      const session=createConsoleSession({request,realtimeFactory,onChange:(state)=>renderer(state)});
      const controller=createController({doc,session});renderer=controller.render;if(typeof onSession==='function')onSession(session);
      await session.initialize();renderer(session.snapshot());return session;
    }catch(error){access.hidden=false;access.textContent=error?.message==='LIFF_ID_PHARMACIST_MISSING'?'ยังไม่ได้ตั้งค่า Pharmacist LIFF กรุณาติดต่อผู้ดูแลระบบ':'ไม่สามารถเปิด Pharmacist Console ได้';return null;}
  }

  return {TABS,SOURCE_LABELS,ASSISTANT_SECTIONS,safeText,safeArray,normalizedMessages,mergeMessages,formatDuration,effectiveClosed,canMessage,sourceLabel,closeReasonLabel,stateLabel,waitingOnLabel,accessStateMessage,assistantErrorMessage,supportReference,messageSendErrorMessage,createIdempotencyKey,connectionLabel,readState,receiptState,latestIncomingSequence,shouldMarkRead,createConsoleSession,renderCaseContext,renderAssistant,formatMessageTime,messageDateLabel,renderMessages,renderQueue,renderCaseHeader,createController,createHttpClient,bootstrap};
}));
