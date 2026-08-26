(function initFamilyConsultationUI(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PhimorFamilyConsultationUI=api;
}(typeof window!=='undefined'?window:globalThis,function familyConsultationFactory(){
  const COLLECTIONS=Object.freeze(['queued','active','resolved','closed']);
  const COLLECTION_LABELS=Object.freeze({queued:'กำลังรอเภสัชกร',active:'กำลังปรึกษา',resolved:'ตอบประเด็นหลักแล้ว',closed:'ปิดแล้ว'});
  function safeText(value,fallback=''){return typeof value==='string'?value:fallback;}
  function safeArray(value){return Array.isArray(value)?value:[];}
  function createIdempotencyKey(cryptoApi=globalThis.crypto){return cryptoApi?.randomUUID?.()||`consultation-${Date.now()}-${Math.random().toString(16).slice(2)}`;}
  function normalizeMessages(items){const map=new Map();safeArray(items).forEach((item)=>{const sequence=Number(item?.sequence);if(Number.isSafeInteger(sequence)&&sequence>0&&!map.has(sequence))map.set(sequence,item);});return [...map.values()].sort((a,b)=>Number(a.sequence)-Number(b.sequence));}
  function mergeMessages(current,incoming){return normalizeMessages([...safeArray(current),...safeArray(incoming)]);}
  function effectiveClosed(caseDetail={},now=new Date()){
    if(caseDetail.effectiveClosed===true||caseDetail.state==='closed')return true;
    const expires=caseDetail.expiresAt?new Date(caseDetail.expiresAt):null;
    return Boolean(expires&&!Number.isNaN(expires.getTime())&&now.getTime()>=expires.getTime());
  }
  function canMessage(caseDetail,now=new Date()){return ['active','resolved'].includes(caseDetail?.state)&&!effectiveClosed(caseDetail,now);}
  function remainingLabel(caseDetail,now=new Date()){
    if(!caseDetail?.expiresAt)return '';
    const seconds=Math.max(0,Math.floor((new Date(caseDetail.expiresAt).getTime()-now.getTime())/1000));
    if(!seconds)return 'หมดเวลาแล้ว';
    const hours=Math.floor(seconds/3600),minutes=Math.floor((seconds%3600)/60);
    return `เหลือเวลา ${hours} ชม. ${minutes} นาที`;
  }
  function categorizeCases(items){const result={queued:[],active:[],resolved:[],closed:[]};safeArray(items).forEach((item)=>{const state=effectiveClosed(item)?'closed':item.state;if(result[state])result[state].push({...item,state});});return result;}
  function paymentStatusLabel(status){return ({payment_pending:'สแกน QR ด้วยแอปธนาคารเพื่อชำระ 100 บาท',payment_confirming:'กำลังตรวจสอบการชำระเงินกับผู้ให้บริการ',queued:'ชำระเงินแล้ว • รอเภสัชกรรับเคส',failed:'การชำระเงินไม่สำเร็จ กรุณาเริ่มรายการใหม่',expired:'รายการชำระเงินหมดอายุ กรุณาเริ่มรายการใหม่',unavailable:'ระบบชำระเงินยังไม่พร้อมใช้งาน'})[status]||'กำลังเตรียมรายการชำระเงิน';}
  function safePaymentQrUrl(value){if(typeof value!=='string')return null;try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password?url.toString():null;}catch(_){return null;}}
  function renderPaymentQr(element,paymentInstructions){const qr=safePaymentQrUrl(paymentInstructions?.qrImageUrl);if(!element)return qr;if(qr){element.src=qr;element.hidden=false;}else{element.removeAttribute?.('src');element.hidden=true;}return qr;}
  function safeError(error){return safeText(error?.errorCode||error?.code,'REQUEST_FAILED');}
  function createFamilyConsultationSession({request,onChange=()=>{},schedule=setTimeout,cancelSchedule=clearTimeout,pollSeconds=5,cryptoApi=globalThis.crypto,now=()=>new Date(),checkoutAdapter=null,paymentStatusAdapter=null}={}){
    if(typeof request!=='function')throw new Error('request is required');
    let generation=0,pollTimer=null,paymentTimer=null,pollingEnabled=true;
    let state={profileId:null,patientName:'',visible:false,eligibility:null,screen:'overview',question:'',safety:null,termsAccepted:false,paymentStatus:null,paymentOrderId:null,paymentInstructions:null,collections:categorizeCases([]),selectedCase:null,messages:[],nextSequence:0,loading:false,sending:false,statusMessage:'',retryAfterSeconds:0};
    const snapshot=()=>({...state,collections:Object.fromEntries(COLLECTIONS.map((key)=>[key,[...state.collections[key]]])),messages:[...state.messages]});
    const notify=()=>onChange(snapshot());
    const replace=(patch)=>{state={...state,...patch};notify();};
    const current=(token,profileId=state.profileId)=>token===generation&&profileId===state.profileId;
    function stopPolling(){if(pollTimer!==null)cancelSchedule(pollTimer);pollTimer=null;}
    function stopPaymentPolling(){if(paymentTimer!==null)cancelSchedule(paymentTimer);paymentTimer=null;}
    function clearClinicalState(){stopPolling();stopPaymentPolling();generation+=1;state={...state,screen:'overview',question:'',safety:null,termsAccepted:false,paymentStatus:null,paymentOrderId:null,paymentInstructions:null,collections:categorizeCases([]),selectedCase:null,messages:[],nextSequence:0,loading:false,sending:false,statusMessage:'',retryAfterSeconds:0};}
    async function checkEligibility(){
      if(!state.profileId){replace({visible:false,eligibility:null});return {availability:'unavailable'};}
      const token=generation,profileId=state.profileId;
      try{
        const result=await request(`/api/consultations/eligibility?careProfileId=${encodeURIComponent(profileId)}`);
        if(!current(token,profileId))return {ignored:true,stale:true};
        if(result?.availability!=='eligible')stopPolling();
        replace({eligibility:result,visible:result?.availability==='eligible',...(result?.availability==='eligible'?{}:{selectedCase:null,messages:[],nextSequence:0})});
        if(result?.availability==='eligible')await refreshCases();
        return result;
      }catch(error){if(current(token,profileId)){stopPolling();replace({visible:false,eligibility:null,selectedCase:null,messages:[],nextSequence:0,statusMessage:'บริการปรึกษาเภสัชกรยังไม่พร้อมใช้งาน'});}return {error:safeError(error)};}
    }
    async function setProfile(profile){
      const profileId=profile?.profile?.care_profile_id||null,patientName=safeText(profile?.profile?.patient_name,'ผู้รับการดูแล');
      if(profileId===state.profileId)return checkEligibility();
      clearClinicalState();state={...state,profileId,patientName,visible:false,eligibility:null};notify();
      return checkEligibility();
    }
    async function refreshCases(){
      if(!state.profileId||!state.visible)return {ignored:true};
      const token=generation,profileId=state.profileId;
      try{
        const result=await request(`/api/consultations?careProfileId=${encodeURIComponent(profileId)}`);
        if(!current(token,profileId))return {ignored:true,stale:true};
        replace({collections:categorizeCases(result?.items),statusMessage:''});return result;
      }catch(error){if(current(token,profileId)){const denied=safeError(error)==='CONSULTATION_ACCESS_DENIED';if(denied)stopPolling();replace({...(denied?{collections:categorizeCases([]),selectedCase:null,messages:[],nextSequence:0}:{}),statusMessage:denied?'ไม่สามารถเข้าถึงการปรึกษาของ Care Profile นี้ได้':'โหลดรายการคำปรึกษาไม่สำเร็จ'});}return {error:safeError(error)};}
    }
    function openQuestion(){if(!state.visible)return {ignored:true};stopPaymentPolling();replace({screen:'question',question:'',safety:null,termsAccepted:false,paymentStatus:null,paymentOrderId:null,paymentInstructions:null,statusMessage:''});return snapshot();}
    function setQuestion(value){replace({question:safeText(value).slice(0,4000)});}
    async function checkQuestion(){
      const question=state.question.trim();if(!question||state.loading)return {ignored:true};
      const token=generation,profileId=state.profileId;replace({loading:true,statusMessage:''});
      try{
        const result=await request('/api/consultations/safety',{method:'POST',body:JSON.stringify({careProfileId:profileId,question})});
        if(!current(token,profileId))return {ignored:true,stale:true};
        if(result.action==='pharmacist_consultation_eligible'){
          const configured=Boolean(state.eligibility?.termsVersion);
          replace({screen:'eligible',safety:result,termsAccepted:false,statusMessage:configured?'คำถามผ่านขอบเขตสำหรับให้เภสัชกรช่วยประเมิน':'ยังไม่ได้กำหนดเงื่อนไขบริการ จึงยังดำเนินการต่อไม่ได้'});
        }else if(result.action==='emergency_block')replace({screen:'question',safety:result,statusMessage:safeText(result.message,'กรุณาติดต่อบริการฉุกเฉินหรือสถานพยาบาลใกล้ที่สุดทันที')});
        else if(result.action==='medical_escalation')replace({screen:'question',safety:result,statusMessage:'คำถามนี้ควรได้รับการประเมินจากแพทย์หรือบุคลากรทางการแพทย์ที่เหมาะสม'});
        else if(result.action==='out_of_scope')replace({screen:'question',safety:result,statusMessage:'คำถามนี้ไม่เกี่ยวกับยา ความปลอดภัยด้านยา หรือการประเมินของเภสัชกร'});
        else replace({screen:'question',safety:result,statusMessage:'ยังไม่แน่ใจว่าคำถามเกี่ยวข้องกับการปรึกษาเภสัชกร กรุณาระบุชื่อยาหรือประเด็นเรื่องยาให้ชัดขึ้น'});
        return result;
      }catch(error){if(current(token,profileId))replace({statusMessage:'ไม่สามารถตรวจขอบเขตคำถามได้ กรุณาลองใหม่',safety:null});return {error:safeError(error)};}
      finally{if(current(token,profileId))replace({loading:false});}
    }
    function continueEligible(){
      if(state.screen!=='eligible'||state.safety?.action!=='pharmacist_consultation_eligible')return {ignored:true};
      if(!state.eligibility?.termsVersion){replace({statusMessage:'ยังไม่ได้กำหนดเงื่อนไขบริการ จึงยังดำเนินการต่อไม่ได้'});return {ignored:true};}
      replace({screen:'terms',termsAccepted:false,statusMessage:''});return snapshot();
    }
    function acceptTerms(value){replace({termsAccepted:value===true});}
    async function continueToPayment(){
      if(state.screen!=='terms'||!state.termsAccepted||!state.eligibility?.termsVersion||state.loading)return {ignored:true};
      if(typeof checkoutAdapter!=='function'){replace({screen:'payment',paymentStatus:'unavailable',statusMessage:'ระบบชำระเงินกำลังเตรียมเปิดใช้งาน'});return {status:'unavailable'};}
      const token=generation,profileId=state.profileId;
      replace({screen:'payment',paymentStatus:'payment_pending',loading:true});
      try{const result=await checkoutAdapter({careProfileId:profileId,question:state.question,termsVersion:state.eligibility.termsVersion});if(!current(token,profileId))return {ignored:true,stale:true};replace({paymentStatus:result?.status||'payment_confirming',paymentOrderId:result?.orderId||null,paymentInstructions:result?.payment||null,statusMessage:result?.status==='payment_pending'?'สแกน PromptPay QR และรอระบบยืนยันการชำระเงิน':''});if(result?.orderId)schedulePaymentPoll(result.orderId);return result;}
      catch(_){if(current(token,profileId))replace({paymentStatus:'failed',statusMessage:'การชำระเงินไม่สำเร็จ กรุณาลองใหม่ภายหลัง'});return current(token,profileId)?{status:'failed'}:{ignored:true,stale:true};}
      finally{if(current(token,profileId))replace({loading:false});}
    }
    async function pollPaymentStatus(orderId=state.paymentOrderId){
      if(!orderId||orderId!==state.paymentOrderId)return {ignored:true};const token=generation,profileId=state.profileId;
      try{const result=typeof paymentStatusAdapter==='function'?await paymentStatusAdapter({orderId}):await request(`/api/consultations/orders/${encodeURIComponent(orderId)}/status`);if(!current(token,profileId)||state.paymentOrderId!==orderId)return {ignored:true,stale:true};const paymentStatus=result?.status||'payment_confirming',terminal=['queued','failed','expired'].includes(paymentStatus);replace({paymentStatus,paymentInstructions:terminal?null:state.paymentInstructions,statusMessage:paymentStatusLabel(paymentStatus)});if(paymentStatus==='queued'){stopPaymentPolling();await refreshCases();if(!current(token,profileId))return {ignored:true,stale:true};const caseId=result?.caseId||state.collections.queued[0]?.caseId||null;replace({screen:'overview',question:'',safety:null,termsAccepted:false,paymentOrderId:null,paymentInstructions:null,statusMessage:'ชำระเงินแล้ว • รอเภสัชกรรับเคส'});if(caseId)await selectCase(caseId);}else if(!terminal)schedulePaymentPoll(orderId);return result;}catch(error){if(current(token,profileId))replace({statusMessage:'กำลังรอการยืนยันการชำระเงิน'});schedulePaymentPoll(orderId);return {error:safeError(error)};}
    }
    function schedulePaymentPoll(orderId){stopPaymentPolling();if(!pollingEnabled||!orderId||['queued','failed','expired'].includes(state.paymentStatus))return;paymentTimer=schedule(async()=>{paymentTimer=null;await pollPaymentStatus(orderId);},Math.max(2,Number(pollSeconds)||5)*1000);}
    function cancelDraft(){stopPaymentPolling();generation+=1;replace({screen:'overview',question:'',safety:null,termsAccepted:false,paymentStatus:null,paymentOrderId:null,paymentInstructions:null,loading:false,statusMessage:''});}
    async function selectCase(caseId){
      stopPolling();const token=++generation,profileId=state.profileId;replace({selectedCase:null,messages:[],nextSequence:0,statusMessage:'',loading:true});
      try{
        const detail=await request(`/api/consultations/${encodeURIComponent(caseId)}`);if(!current(token,profileId))return {ignored:true,stale:true};
        replace({selectedCase:detail,loading:false});await pollOnce();schedulePoll();return detail;
      }catch(error){if(current(token,profileId)){const denied=safeError(error)==='CONSULTATION_ACCESS_DENIED';if(denied)stopPolling();replace({loading:false,...(denied?{selectedCase:null,messages:[],nextSequence:0}:{}),statusMessage:denied?'ไม่สามารถเข้าถึงการปรึกษานี้ได้':'เปิดการปรึกษาไม่สำเร็จ'});}return {error:safeError(error)};}
    }
    async function pollOnce(){
      const caseId=state.selectedCase?.caseId;if(!caseId)return {ignored:true};const token=generation,profileId=state.profileId;
      try{
        const [detail,result]=await Promise.all([request(`/api/consultations/${encodeURIComponent(caseId)}`),request(`/api/consultations/${encodeURIComponent(caseId)}/messages?afterSequence=${state.nextSequence}&limit=50`)]);
        if(!current(token,profileId)||state.selectedCase?.caseId!==caseId)return {ignored:true,stale:true};
        replace({selectedCase:detail,messages:mergeMessages(state.messages,result?.items),nextSequence:Number(result?.nextSequence)||state.nextSequence,statusMessage:''});return result;
      }catch(error){if(current(token,profileId)){const denied=safeError(error)==='CONSULTATION_ACCESS_DENIED';if(denied)stopPolling();replace({...(denied?{selectedCase:null,messages:[],nextSequence:0}:{}),statusMessage:denied?'สิทธิ์เข้าถึงการปรึกษานี้ไม่พร้อมใช้งาน':'อัปเดตข้อความไม่สำเร็จ'});}return {error:safeError(error)};}
    }
    function schedulePoll(){stopPolling();if(!pollingEnabled||!state.selectedCase||effectiveClosed(state.selectedCase,now()))return;pollTimer=schedule(async()=>{pollTimer=null;await pollOnce();schedulePoll();},Math.max(2,Number(pollSeconds)||5)*1000);}
    function setDocumentVisible(visible){pollingEnabled=visible!==false;if(pollingEnabled){schedulePoll();schedulePaymentPoll(state.paymentOrderId);}else{stopPolling();stopPaymentPolling();}}
    async function sendMessage(body){
      const text=safeText(body).trim();if(state.sending||!text||text.length>4000||!canMessage(state.selectedCase,now()))return {ignored:true};
      const caseId=state.selectedCase.caseId,token=generation,profileId=state.profileId;replace({sending:true,statusMessage:''});
      try{
        const result=await request(`/api/consultations/${encodeURIComponent(caseId)}/messages`,{method:'POST',body:JSON.stringify({body:text,idempotencyKey:createIdempotencyKey(cryptoApi)})});
        if(!current(token,profileId)||state.selectedCase?.caseId!==caseId)return {ignored:true,stale:true};
        replace({messages:mergeMessages(state.messages,result?.message?[result.message]:[]),nextSequence:Math.max(state.nextSequence,Number(result?.message?.sequence)||0)});await pollOnce();return result;
      }catch(error){const code=safeError(error),closed=['CONSULTATION_EXPIRED','CONSULTATION_CLOSED'].includes(code);if(current(token,profileId)){replace({statusMessage:code==='CONSULTATION_RATE_LIMITED'?'ส่งข้อความถี่เกินไป กรุณารอสักครู่':closed?'การปรึกษานี้สิ้นสุดแล้ว':'ส่งข้อความไม่สำเร็จ'});if(closed)await pollOnce();}return {error:code};}
      finally{if(current(token,profileId))replace({sending:false});}
    }
    function unmount(){clearClinicalState();state={...state,profileId:null,patientName:'',visible:false,eligibility:null};notify();}
    return {snapshot,setProfile,checkEligibility,refreshCases,openQuestion,setQuestion,checkQuestion,continueEligible,acceptTerms,continueToPayment,pollPaymentStatus,cancelDraft,selectCase,pollOnce,sendMessage,setDocumentVisible,unmount};
  }
  function clearNode(node){while(node?.firstChild)node.removeChild(node.firstChild);}
  function textElement(doc,parent,tag,className,text){const el=doc.createElement(tag);if(className)el.className=className;el.textContent=safeText(text);parent.appendChild(el);return el;}
  function renderMessages(doc,container,messages){clearNode(container);normalizeMessages(messages).forEach((message)=>{const box=doc.createElement('div');box.className=`consultation-message consultation-message--${message.senderType}`;textElement(doc,box,'span','consultation-message__role',message.senderType==='customer'?'คุณ':message.senderType==='pharmacist'?'เภสัชกร':'ระบบ');textElement(doc,box,'div','consultation-message__body',message.body);container.appendChild(box);});}
  function renderCaseGroups(doc,container,collections,onSelect){clearNode(container);COLLECTIONS.forEach((group)=>{const section=doc.createElement('section');section.className=`consultation-group consultation-group--${group}`;textElement(doc,section,'h4','',COLLECTION_LABELS[group]);const items=safeArray(collections?.[group]);if(!items.length)textElement(doc,section,'p','consultation-help','ยังไม่มีรายการ');items.forEach((item)=>{const button=textElement(doc,section,'button',`consultation-case consultation-case--${group}`,`Consult Case ${safeText(item.caseId).slice(-8)}`);button.type='button';textElement(doc,button,'span','consultation-case__state',COLLECTION_LABELS[group]);const detail=group==='queued'?'ชำระเงินแล้ว • รอเภสัชกรรับเคส':group==='closed'?'หมดเวลาปรึกษาแล้ว • เปิดอ่านย้อนหลังได้':remainingLabel(item);textElement(doc,button,'span','',detail);const timestamp=item.acceptedAt||item.queuedAt;if(timestamp)textElement(doc,button,'span','',`${item.acceptedAt?'รับเคส':'เข้าคิว'} ${new Date(timestamp).toLocaleString('th-TH')}`);button.addEventListener('click',()=>onSelect(item.caseId));});container.appendChild(section);});}
  function createController({doc,session}){
    const el={panel:doc.getElementById('consultationPanel'),patient:doc.getElementById('consultationPatient'),entry:doc.getElementById('consultationEntry'),refresh:doc.getElementById('consultationRefreshButton'),flow:doc.getElementById('consultationFlow'),question:doc.getElementById('consultationQuestion'),check:doc.getElementById('consultationCheckButton'),eligible:doc.getElementById('consultationEligible'),eligibleContinue:doc.getElementById('consultationEligibleContinueButton'),cancel:doc.getElementById('consultationCancelButton'),terms:doc.getElementById('consultationTerms'),termsVersion:doc.getElementById('consultationTermsVersion'),termsCheck:doc.getElementById('consultationTermsCheck'),payment:doc.getElementById('consultationPayment'),paymentQr:doc.getElementById('consultationPaymentQr'),paymentText:doc.getElementById('consultationPaymentText'),continueButton:doc.getElementById('consultationContinueButton'),groups:doc.getElementById('consultationGroups'),chat:doc.getElementById('consultationChat'),header:doc.getElementById('consultationCaseHeader'),messages:doc.getElementById('consultationMessages'),composer:doc.getElementById('consultationMessageComposer'),send:doc.getElementById('consultationSendButton'),live:doc.getElementById('consultationLive')};
    let lastProfileId=null,lastCaseId=null;
    function render(state){
      if(lastProfileId!==state.profileId){el.question.value='';el.composer.value='';lastProfileId=state.profileId;lastCaseId=null;}if(lastCaseId!==state.selectedCase?.caseId){el.composer.value='';lastCaseId=state.selectedCase?.caseId||null;}if(el.question.value!==state.question)el.question.value=state.question;
      el.panel.hidden=!state.visible;el.patient.textContent=state.patientName?`Care Profile ที่เลือก: ${state.patientName}`:'';el.entry.hidden=state.screen!=='overview';el.refresh.hidden=!state.visible;el.flow.hidden=state.screen==='overview';el.question.hidden=state.screen!=='question';el.check.hidden=state.screen!=='question';el.eligible.hidden=state.screen!=='eligible';el.eligibleContinue.disabled=!state.eligibility?.termsVersion;el.cancel.hidden=state.screen==='overview'||state.paymentStatus==='queued';el.terms.hidden=state.screen!=='terms';el.termsVersion.textContent=state.eligibility?.termsVersion?`เงื่อนไขฉบับ ${state.eligibility.termsVersion}`:'';el.payment.hidden=state.screen!=='payment';el.continueButton.disabled=!state.termsAccepted||!state.eligibility?.termsVersion||state.loading;el.termsCheck.checked=state.termsAccepted;el.live.textContent=state.statusMessage;if(el.paymentText)el.paymentText.textContent=paymentStatusLabel(state.paymentStatus);renderPaymentQr(el.paymentQr,state.paymentInstructions);renderCaseGroups(doc,el.groups,state.collections,(id)=>session.selectCase(id));
      const selected=state.selectedCase;el.chat.hidden=!selected;el.chat.className=`consultation-chat${selected?` consultation-chat--${effectiveClosed(selected)?'closed':selected.state}`:''}`;if(selected){clearNode(el.header);textElement(doc,el.header,'h4','',`Consult Case ${safeText(selected.caseId).slice(-8)}`);if(selected.initialQuestion)textElement(doc,el.header,'p','consultation-initial-question',`คำถามตั้งต้น: ${selected.initialQuestion}`);if(selected.state==='queued')textElement(doc,el.header,'p','consultation-help','ชำระเงินแล้ว • รอเภสัชกรรับเคส ระยะเวลา 24 ชั่วโมงจะเริ่มเมื่อเภสัชกรรับเคส');else if(selected.state==='resolved')textElement(doc,el.header,'p','consultation-help','เภสัชกรตอบประเด็นหลักแล้ว คุณยังสามารถถามต่อเกี่ยวกับเคสนี้ได้จนถึงเวลาสิ้นสุด');else if(effectiveClosed(selected))textElement(doc,el.header,'p','consultation-help','หมดเวลาปรึกษาแล้ว ครบระยะเวลา 24 ชั่วโมงของ Consult Case นี้ ข้อความเดิมยังอ่านย้อนหลังได้');else textElement(doc,el.header,'p','consultation-help',`เภสัชกรรับเคส ${new Date(selected.acceptedAt).toLocaleString('th-TH')} • ห้องปรึกษานี้เปิดถึง ${new Date(selected.expiresAt).toLocaleString('th-TH')} • ${remainingLabel(selected)}`);renderMessages(doc,el.messages,state.messages);el.composer.disabled=state.sending||!canMessage(selected);el.send.disabled=state.sending||!canMessage(selected)||!el.composer.value.trim();}
    }
    el.entry.addEventListener('click',()=>session.openQuestion());el.refresh.addEventListener('click',()=>session.refreshCases());el.question.addEventListener('input',()=>session.setQuestion(el.question.value));el.check.addEventListener('click',()=>session.checkQuestion());el.eligibleContinue.addEventListener('click',()=>session.continueEligible());el.cancel.addEventListener('click',()=>{session.cancelDraft();el.question.value='';});el.termsCheck.addEventListener('change',()=>session.acceptTerms(el.termsCheck.checked));el.continueButton.addEventListener('click',()=>session.continueToPayment());el.composer.addEventListener('input',()=>render(session.snapshot()));el.send.addEventListener('click',async()=>{const value=el.composer.value;const result=await session.sendMessage(value);if(!result?.ignored&&!result?.error)el.composer.value='';render(session.snapshot());});doc.addEventListener?.('visibilitychange',()=>session.setDocumentVisible(doc.visibilityState!=='hidden'));render(session.snapshot());return {render};
  }
  return Object.freeze({COLLECTIONS,COLLECTION_LABELS,normalizeMessages,mergeMessages,effectiveClosed,canMessage,remainingLabel,categorizeCases,paymentStatusLabel,safePaymentQrUrl,renderPaymentQr,createFamilyConsultationSession,renderMessages,renderCaseGroups,createController});
}));
