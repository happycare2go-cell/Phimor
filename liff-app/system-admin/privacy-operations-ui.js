(function initPrivacyOperationsUI(root, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (root) root.PhimorPrivacyOperationsUI = api;
}(typeof window !== 'undefined' ? window : globalThis, function privacyOperationsFactory() {
  const TYPE_LABELS = Object.freeze({ export:'ขอสำเนาข้อมูล', correct:'ขอแก้ไขข้อมูล', restrict:'ขอจำกัดการใช้ข้อมูล', delete:'ขอลบข้อมูล' });
  const STATUS_LABELS = Object.freeze({ pending:'รับคำขอแล้ว', in_progress:'กำลังตรวจสอบ', completed:'ดำเนินการตามขั้นตอนแล้ว', rejected:'ไม่สามารถดำเนินการได้' });
  const safeArray = (value) => Array.isArray(value) ? value.slice(0, 250) : [];
  const formatDate = (value) => { const date = value ? new Date(value) : null; return date && Number.isFinite(date.getTime()) ? date.toLocaleString('th-TH', { dateStyle:'medium', timeStyle:'short', timeZone:'Asia/Bangkok' }) : '-'; };
  const buildStatusRequest = (requestId, { status, publicNote = '', manualFulfillmentConfirmed = false } = {}) => ({
    path:`/api/admin/data-requests/${encodeURIComponent(requestId)}`,
    options:{ method:'PATCH', body:JSON.stringify({ status, publicNote, manualFulfillmentConfirmed:Boolean(manualFulfillmentConfirmed) }) },
  });

  function createController({ doc, request, confirmAction = async () => true } = {}) {
    if (!doc || typeof request !== 'function') throw new TypeError('doc and request are required');
    const content = doc.getElementById('privacyOperationsContent');
    const live = doc.getElementById('privacyOperationsLive');
    let generation = 0; const state = { loading:false, error:null, requests:[] };
    const element = (tag, className, text) => { const node=doc.createElement(tag); if(className)node.className=className; if(text!==undefined)node.textContent=text; return node; };
    function render() {
      content.replaceChildren();
      if (state.loading) { content.append(element('div','privacy-ops__empty','กำลังโหลดคำขอ…')); return; }
      if (state.error) { const box=element('div','privacy-ops__error','โหลดคิวคำขอไม่สำเร็จ'); const retry=element('button','secondary','ลองอีกครั้ง');retry.type='button';retry.addEventListener('click',load);content.append(box,retry);return; }
      if (!state.requests.length) { content.append(element('div','privacy-ops__empty','ยังไม่มีคำขอเกี่ยวกับข้อมูลส่วนบุคคล')); return; }
      const list=element('div','privacy-ops__list');
      state.requests.forEach((item)=>{
        const card=element('article','privacy-ops__item');
        const heading=element('div','privacy-ops__heading');heading.append(element('strong','',TYPE_LABELS[item.type]||'คำขอข้อมูล'),element('span',`privacy-ops__status privacy-ops__status--${item.status}`,STATUS_LABELS[item.status]||'รอตรวจสอบ'));card.append(heading);
        card.append(element('div','privacy-ops__identity',item.requesterIdentity||'ผู้ขอที่ยืนยันแล้ว'),element('div','privacy-ops__meta',`${item.requestReference||'คำขอที่ยืนยันแล้ว'} · ${formatDate(item.requestedAt)}`));
        if(item.requestDetails)card.append(element('p','privacy-ops__details',item.requestDetails));
        const label=element('label','','เปลี่ยนสถานะคำขอ');const select=element('select');select.setAttribute('aria-label','สถานะคำขอ');
        [['in_progress','กำลังตรวจสอบ'],['completed','ดำเนินการตามขั้นตอนแล้ว'],['rejected','ไม่สามารถดำเนินการได้']].forEach(([value,text])=>{const option=element('option','',text);option.value=value;option.selected=item.status===value;select.append(option);});label.append(select);card.append(label);
        const noteLabel=element('label','','ข้อความที่ผู้ขอจะเห็น');const note=element('textarea');note.maxLength=500;note.value=item.publicNote||'';note.placeholder='ระบุเฉพาะผลหรือขั้นตอนที่ปลอดภัย ไม่ใส่ข้อมูลสุขภาพที่ไม่เกี่ยวข้อง';noteLabel.append(note);card.append(noteLabel);
        const completion=element('label','privacy-ops__confirm');const check=element('input');check.type='checkbox';completion.append(check,doc.createTextNode(' ยืนยันว่าได้ดำเนินงานตามขั้นตอนที่ได้รับอนุมัติแล้ว (ไม่ใช่การลบอัตโนมัติ)'));completion.hidden=select.value!=='completed';select.addEventListener('change',()=>{completion.hidden=select.value!=='completed';});card.append(completion);
        const action=element('button','','บันทึกสถานะ');action.type='button';action.addEventListener('click',async()=>{const approved=await confirmAction('บันทึกสถานะคำขอ','การเปลี่ยนสถานะไม่เรียกใช้ระบบลบ ส่งออก หรือจำกัดข้อมูลอัตโนมัติ');if(!approved)return;action.disabled=true;live.textContent='';try{const descriptor=buildStatusRequest(item.requestId,{status:select.value,publicNote:note.value.trim(),manualFulfillmentConfirmed:check.checked});await request(descriptor.path,descriptor.options);live.textContent='บันทึกสถานะคำขอแล้ว';await load();}catch(_){live.textContent='บันทึกสถานะไม่สำเร็จ กรุณาตรวจสอบข้อมูลและลองอีกครั้ง';}finally{action.disabled=false;}});card.append(action);list.append(card);
      });content.append(list);
    }
    async function load(){const token=++generation;state.loading=true;state.error=null;render();try{const result=await request('/api/admin/data-requests',{method:'GET'});if(token!==generation)return {ignored:true,stale:true};state.requests=safeArray(result?.requests);state.loading=false;render();return state;}catch(_){if(token===generation){state.loading=false;state.error={code:'PRIVACY_QUEUE_UNAVAILABLE'};render();}return {status:'unavailable'};}}
    return Object.freeze({ load, render, snapshot:()=>({...state,requests:[...state.requests]}) });
  }
  return Object.freeze({ TYPE_LABELS, STATUS_LABELS, formatDate, buildStatusRequest, createController });
}));
