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
  function createIdempotencyKey(cryptoApi=globalThis.crypto){
    if(cryptoApi&&typeof cryptoApi.randomUUID==='function') return cryptoApi.randomUUID();
    return `msg-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
  function apiErrorCode(error){return safeText(error?.errorCode || error?.code,'REQUEST_FAILED');}

  function createConsoleSession({request,onChange=()=>{},schedule=setTimeout,cancelSchedule=clearTimeout,pollSeconds=5,cryptoApi=globalThis.crypto}={}){
    if(typeof request!=='function') throw new Error('request is required');
    let revision=0; let pollTimer=null; let rateLimitTimer=null;
    let state={
      access:'loading',tab:'queue',collections:{queue:[],active:[],resolved:[],closed:[]},
      queueCursor:null,queueHasMore:false,selectedCase:null,messages:[],lastSequence:0,
      assistant:null,assistantBusy:false,sending:false,acceptingCaseId:null,resolving:false,
      error:null,statusMessage:'',retryAfterSeconds:0,
    };
    const snapshot=()=>({...state,collections:{...state.collections},messages:[...state.messages]});
    const notify=()=>onChange(snapshot());
    const patch=(value)=>{state={...state,...value};notify();};
    const token=()=>revision;
    const current=(value)=>value===revision;
    function stopPolling(){if(pollTimer!==null){cancelSchedule(pollTimer);pollTimer=null;}}
    function schedulePoll(){
      stopPolling();
      if(!state.selectedCase || documentHidden() || effectiveClosed(state.selectedCase)) return;
      pollTimer=schedule(async()=>{pollTimer=null;await pollOnce();schedulePoll();},Math.max(2,Number(pollSeconds)||5)*1000);
    }
    function documentHidden(){return typeof document!=='undefined'&&document.hidden===true;}

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
      revision+=1; stopPolling();
      if(rateLimitTimer!==null){cancelSchedule(rateLimitTimer);rateLimitTimer=null;}
      const requestRevision=token();
      patch({selectedCase:null,messages:[],lastSequence:0,assistant:null,error:null,statusMessage:'กำลังโหลดเคส…',sending:false,resolving:false,retryAfterSeconds:0});
      try{
        const detail=await request(`/api/pharmacist/consultations/${encodeURIComponent(caseId)}`);
        if(!current(requestRevision)) return {ignored:true,stale:true};
        patch({selectedCase:detail,statusMessage:''});
        const result=await request(`/api/pharmacist/consultations/${encodeURIComponent(caseId)}/messages?afterSequence=0&limit=50`);
        if(!current(requestRevision)||state.selectedCase?.caseId!==caseId) return {ignored:true,stale:true};
        const messages=normalizedMessages(result.items);
        patch({messages,lastSequence:Number(result.nextSequence)||messages.at(-1)?.sequence||0});
        schedulePoll(); return {detail,messages};
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
    async function sendMessage(body){
      const text=safeText(body).trim(); const caseId=state.selectedCase?.caseId;
      if(state.sending||state.retryAfterSeconds>0||!caseId||!text||text.length>4000||!canMessage(state.selectedCase))return {ignored:true};
      const requestRevision=token();
      patch({sending:true,error:null,statusMessage:''});
      try{
        const result=await request(`/api/pharmacist/consultations/${encodeURIComponent(caseId)}/messages`,{
          method:'POST',body:JSON.stringify({body:text,idempotencyKey:createIdempotencyKey(cryptoApi)}),
        });
        if(current(requestRevision)&&state.selectedCase?.caseId===caseId){
          const messages=mergeMessages(state.messages,result.message?[result.message]:[]);
          patch({sending:false,messages,lastSequence:messages.at(-1)?.sequence||state.lastSequence});
          await pollOnce();
        } else return {ignored:true,stale:true};
        return result;
      }catch(error){
        if(!current(requestRevision)||state.selectedCase?.caseId!==caseId)return {ignored:true,stale:true};
        const retryAfterSeconds=Math.max(0,Number(error?.retryAfterSeconds)||0);
        const code=apiErrorCode(error),closed=['CONSULTATION_EXPIRED','CONSULTATION_CLOSED'].includes(code);
        patch({sending:false,error:code,retryAfterSeconds,statusMessage:code==='CONSULTATION_RATE_LIMITED'?'ส่งข้อความถี่เกินไป กรุณารอสักครู่':closed?'เคสนี้หมดเวลาปรึกษาแล้ว':'ส่งข้อความไม่สำเร็จ'});
        if(rateLimitTimer!==null)cancelSchedule(rateLimitTimer);
        if(retryAfterSeconds>0)rateLimitTimer=schedule(()=>{rateLimitTimer=null;patch({retryAfterSeconds:0,statusMessage:''});},retryAfterSeconds*1000);
        if(closed)await pollOnce();
        return {error:code};
      }
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
      }catch(error){if(!current(requestRevision)||state.selectedCase?.caseId!==caseId)return {ignored:true,stale:true};patch({resolving:false,error:apiErrorCode(error),statusMessage:'เปลี่ยนสถานะไม่สำเร็จ'});return {error:apiErrorCode(error)};}
    }
    async function generateAssistant(){
      const caseId=state.selectedCase?.caseId;
      if(!caseId||state.assistantBusy||effectiveClosed(state.selectedCase))return {ignored:true};
      const requestRevision=token(); patch({assistantBusy:true,assistant:null,error:null});
      try{
        const result=await request(`/api/pharmacist/consultations/${encodeURIComponent(caseId)}/assistant`,{method:'POST',body:JSON.stringify({refresh:true})});
        if(!current(requestRevision)||state.selectedCase?.caseId!==caseId)return {ignored:true,stale:true};
        patch({assistantBusy:false,assistant:result}); return result;
      }catch(error){
        if(current(requestRevision))patch({assistantBusy:false,assistant:{status:'unavailable'},error:apiErrorCode(error)});
        return {error:apiErrorCode(error)};
      }
    }
    function clearSelection(){revision+=1;stopPolling();patch({selectedCase:null,messages:[],lastSequence:0,assistant:null,statusMessage:''});}
    function handleVisibilityChange(){if(documentHidden())stopPolling();else schedulePoll();}
    return {snapshot,initialize,loadCollection,switchTab,selectCase,acceptCase,pollOnce,sendMessage,resolveCase,generateAssistant,clearSelection,stopPolling,schedulePoll,handleVisibilityChange};
  }

  function clearNode(node){while(node?.firstChild)node.removeChild(node.firstChild);}
  function textElement(doc,parent,tag,className,text){const el=doc.createElement(tag);if(className)el.className=className;el.textContent=safeText(text);parent.appendChild(el);return el;}
  function renderAssistant(doc,container,result={}){
    clearNode(container);
    if(!result || !result.status){
      textElement(doc,container,'p','empty-state','เลือกเคสแล้วกด “สร้างสรุปช่วยตอบ” ระบบจะไม่เรียก AI โดยอัตโนมัติ');return;
    }
    if(result.status!=='available'){
      textElement(doc,container,'p','assistant-unavailable','AI Assistant ไม่พร้อมใช้งานในขณะนี้ คุณยังสามารถตอบผู้ใช้ได้ตามปกติ');return;
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
  function renderMessages(doc,container,messages){
    clearNode(container);safeArray(messages).forEach((item)=>{
      const bubble=doc.createElement('article');bubble.className=`chat-message chat-message--${safeText(item.senderType,'system')}`;
      textElement(doc,bubble,'div','chat-role',item.senderType==='pharmacist'?'เภสัชกร':item.senderType==='customer'?'ผู้ใช้':'ระบบ');
      textElement(doc,bubble,'p','chat-body',item.body);container.appendChild(bubble);
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
      if(Number.isFinite(Number(item.waitingSeconds)))textElement(doc,card,'span','waiting-time',`รอ ${Math.floor(Number(item.waitingSeconds)/60)} นาที`);
      if(!showAccept){card.tabIndex=0;card.setAttribute?.('role','button');card.addEventListener('click',()=>onSelect(item.caseId));card.addEventListener('keydown',(event)=>{if(event.key==='Enter'||event.key===' '){event.preventDefault?.();onSelect(item.caseId);}});}
      if(showAccept){const button=textElement(doc,card,'button','accept-button','รับเคส');button.type='button';button.disabled=acceptingCaseId===item.caseId;
        button.addEventListener('click',(event)=>{event.stopPropagation?.();onAccept(item.caseId);});card.appendChild(button);}
      container.appendChild(card);
    });
  }

  function createController({doc,session}){
    const elements={
      access:doc.getElementById('accessState'),app:doc.getElementById('consoleApp'),list:doc.getElementById('caseList'),
      header:doc.getElementById('caseHeader'),messages:doc.getElementById('chatMessages'),composer:doc.getElementById('messageComposer'),
      send:doc.getElementById('sendMessageButton'),resolve:doc.getElementById('resolveButton'),assistant:doc.getElementById('assistantContent'),
      assistantButton:doc.getElementById('generateAssistantButton'),status:doc.getElementById('statusLive'),loadMore:doc.getElementById('loadMoreButton'),
      assistantRefresh:doc.getElementById('refreshAssistantButton'),
    };
    function render(state){
      elements.access.hidden=state.access==='allowed';elements.app.hidden=state.access!=='allowed';
      elements.access.textContent=accessStateMessage(state.access,state.error);
      elements.status.textContent=state.statusMessage||'';
      doc.querySelectorAll('[data-tab]').forEach((button)=>button.classList?.toggle('active',button.dataset.tab===state.tab));
      renderQueue(doc,elements.list,state.collections[state.tab],{acceptingCaseId:state.acceptingCaseId,showAccept:state.tab==='queue',onSelect:session.selectCase,onAccept:session.acceptCase});
      elements.loadMore.hidden=state.tab!=='queue'||!state.queueHasMore;
      clearNode(elements.header);
      elements.header.className=`case-header${state.selectedCase?` case-header--${effectiveClosed(state.selectedCase)?'closed':state.selectedCase.state}`:''}`;
      if(state.selectedCase){
        textElement(doc,elements.header,'h2','',`เคส ${state.selectedCase.caseId}`);
        textElement(doc,elements.header,'span',`state-chip state-chip--${effectiveClosed(state.selectedCase)?'closed':state.selectedCase.state}`,stateLabel(effectiveClosed(state.selectedCase)?'closed':state.selectedCase.state));
        textElement(doc,elements.header,'span','waiting-chip',waitingOnLabel(state.selectedCase.waitingOn,state.selectedCase.state));
        textElement(doc,elements.header,'span','countdown',formatDuration(state.selectedCase.remainingSeconds));
        if(state.selectedCase.acceptedAt)textElement(doc,elements.header,'small','',`รับเคส: ${new Date(state.selectedCase.acceptedAt).toLocaleString('th-TH')}`);
        if(state.selectedCase.expiresAt)textElement(doc,elements.header,'small','',`หมดเวลา: ${new Date(state.selectedCase.expiresAt).toLocaleString('th-TH')}`);
        if(effectiveClosed(state.selectedCase))textElement(doc,elements.header,'small','closed-reason',closeReasonLabel(state.selectedCase.closeReason));
      }
      renderMessages(doc,elements.messages,state.messages);
      const writable=state.selectedCase&&canMessage(state.selectedCase)&&state.retryAfterSeconds===0;
      elements.composer.disabled=!writable||state.sending;elements.send.disabled=!writable||state.sending||!elements.composer.value.trim();
      elements.resolve.disabled=!writable||state.selectedCase?.state!=='active'||state.resolving;elements.resolve.hidden=!state.selectedCase;
      elements.assistantButton.disabled=!state.selectedCase||effectiveClosed(state.selectedCase)||state.assistantBusy;
      elements.assistantRefresh.disabled=elements.assistantButton.disabled;elements.assistantRefresh.hidden=state.assistant?.status!=='available';
      renderAssistant(doc,elements.assistant,state.assistant);
    }
    session._setRenderer?.(render);
    doc.querySelectorAll('[data-tab]').forEach((button)=>button.addEventListener('click',()=>session.switchTab(button.dataset.tab)));
    const filters=()=>({topicCategory:doc.getElementById('topicFilter').value.trim(),triageCategory:doc.getElementById('triageFilter').value.trim()});
    doc.getElementById('refreshListButton').addEventListener('click',()=>session.loadCollection(session.snapshot().tab,{filters:filters()}));
    elements.loadMore.addEventListener('click',()=>session.loadCollection('queue',{append:true,filters:filters()}));
    elements.composer.addEventListener('input',()=>render(session.snapshot()));
    elements.composer.addEventListener('keydown',(event)=>{if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();elements.send.click();}});
    elements.send.addEventListener('click',async()=>{const value=elements.composer.value;if(!value.trim())return;const result=await session.sendMessage(value);if(!result?.error&&!result?.ignored)elements.composer.value='';render(session.snapshot());});
    elements.resolve.addEventListener('click',()=>session.resolveCase());
    elements.assistantButton.addEventListener('click',()=>session.generateAssistant());
    elements.assistantRefresh.addEventListener('click',()=>session.generateAssistant());
    doc.addEventListener('visibilitychange',session.handleVisibilityChange);
    render(session.snapshot());return {render};
  }

  function createHttpClient({backendUrl,idToken,fetchImpl=fetch}){
    return async function request(path,options={}){
      const response=await fetchImpl(backendUrl+path,{...options,headers:{'Content-Type':'application/json','Authorization':`Bearer ${idToken}`,...(options.headers||{})}});
      let body={};try{body=await response.json();}catch(_){body={};}
      if(!response.ok){const error=new Error('request failed');const rawCode=body.errorCode||body.code||body.error;error.errorCode=rawCode==='pharmacist_access_denied'?'PHARMACIST_ACCESS_DENIED':rawCode||'REQUEST_FAILED';error.status=response.status;error.retryAfterSeconds=Number(response.headers?.get?.('Retry-After'))||0;throw error;}
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
      const session=createConsoleSession({request:createHttpClient({backendUrl,idToken,fetchImpl}),onChange:(state)=>renderer(state)});
      const controller=createController({doc,session});renderer=controller.render;if(typeof onSession==='function')onSession(session);
      await session.initialize();renderer(session.snapshot());return session;
    }catch(error){access.hidden=false;access.textContent=error?.message==='LIFF_ID_PHARMACIST_MISSING'?'ยังไม่ได้ตั้งค่า Pharmacist LIFF กรุณาติดต่อผู้ดูแลระบบ':'ไม่สามารถเปิด Pharmacist Console ได้';return null;}
  }

  return {TABS,SOURCE_LABELS,ASSISTANT_SECTIONS,safeText,safeArray,normalizedMessages,mergeMessages,formatDuration,effectiveClosed,canMessage,sourceLabel,closeReasonLabel,stateLabel,waitingOnLabel,accessStateMessage,createIdempotencyKey,createConsoleSession,renderAssistant,renderMessages,renderQueue,createController,createHttpClient,bootstrap};
}));
