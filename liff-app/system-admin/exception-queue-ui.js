(function initExceptionQueue(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PhimorAdminExceptionQueue = api;
}(typeof window !== 'undefined' ? window : globalThis, function exceptionQueueFactory() {
  const CATEGORY_LABELS = Object.freeze({
    all:'ทั้งหมด', dsr:'คำขอข้อมูลส่วนบุคคล', pending_mapping:'ผู้พักรอเชื่อม',
    groups:'กลุ่ม LINE', group_missing:'กลุ่ม LINE ไม่พร้อม', group_mismatch:'กลุ่ม LINE ไม่ตรงกัน',
    identity_ambiguity:'ชื่อซ้ำ / จับคู่ไม่ได้', integration_failure:'Integration ล้มเหลว',
    retry_warning:'Retry / dead-letter', scheduler_warning:'Scheduler',
  });
  const STATUS_LABELS = Object.freeze({ pending:'รอดำเนินการ', in_progress:'กำลังดำเนินการ',
    open:'ต้องตรวจ', retrying:'กำลังลองใหม่', dead:'หยุดรอตรวจ', rejected:'ถูกปฏิเสธ', failed:'ล้มเหลว' });

  function buildRequest(state) {
    const query = new URLSearchParams({ category:state.category || 'all', status:state.status || 'all',
      search:String(state.search || '').trim(), page:String(state.page || 1), pageSize:String(state.pageSize || 20) });
    return { path:`/api/admin/exceptions?${query.toString()}`, options:{ method:'GET' } };
  }

  function createController({ doc, request, onAction = async () => {} }) {
    const state = { category:'all', status:'all', search:'', page:1, pageSize:20,
      items:[], pagination:{page:1,total:0,totalPages:0}, loading:false, error:'', requestSequence:0 };
    const content = doc.getElementById('exceptionQueueContent');
    const live = doc.getElementById('exceptionQueueLive');
    const filters = doc.getElementById('exceptionCategoryFilters');
    const status = doc.getElementById('exceptionStatusFilter');
    const search = doc.getElementById('exceptionSearch');
    const previous = doc.getElementById('exceptionPreviousPage');
    const next = doc.getElementById('exceptionNextPage');
    const pageLabel = doc.getElementById('exceptionPageLabel');

    function el(tag, className = '', text = '') { const node=doc.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node; }
    function formatDate(value) { return value ? new Date(value).toLocaleString('th-TH') : 'ไม่ระบุเวลา'; }
    function render() {
      filters.querySelectorAll('[data-exception-filter]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.exceptionFilter === state.category)));
      status.value = state.status; search.value = state.search;
      live.textContent = state.loading ? 'กำลังโหลดงานที่ต้องตรวจ…' : state.error || `พบ ${state.pagination.total || 0} รายการ`;
      content.replaceChildren();
      if (state.loading) { content.append(el('div','exception-queue__empty','กำลังโหลด…')); return; }
      if (state.error) { const retry=el('button','secondary','ลองอีกครั้ง');retry.type='button';retry.addEventListener('click',()=>load());content.append(retry);return; }
      if (!state.items.length) { content.append(el('div','exception-queue__empty','ไม่มีงานที่ตรงกับตัวกรอง')); }
      else {
        const list=el('div','exception-queue__list');
        state.items.forEach((item) => {
          const card=el('article','exception-queue__item');
          const heading=el('div','exception-queue__heading');
          heading.append(el('strong','',item.title || CATEGORY_LABELS[item.category] || 'งานต้องตรวจ'));
          const badge=el('span',`exception-queue__status exception-queue__status--${item.status}`,STATUS_LABELS[item.status] || 'ต้องตรวจ');heading.append(badge);card.append(heading);
          card.append(el('div','exception-queue__category',CATEGORY_LABELS[item.category] || item.category),el('p','exception-queue__summary',item.summary || 'ตรวจสอบสถานะการดำเนินงาน'));
          const meta=el('div','exception-queue__meta',[item.centerName,item.safeReference,formatDate(item.occurredAt)].filter(Boolean).join(' · '));card.append(meta);
          const action=el('button','secondary exception-queue__action',item.action?.label || 'ตรวจสอบ');action.type='button';action.addEventListener('click',async()=>{action.disabled=true;try{await onAction(item)}finally{action.disabled=false}});card.append(action);list.append(card);
        });
        content.append(list);
      }
      const paging=state.pagination;pageLabel.textContent=paging.totalPages ? `หน้า ${paging.page} จาก ${paging.totalPages}` : 'ไม่มีรายการ';previous.disabled=paging.page<=1;next.disabled=!paging.totalPages||paging.page>=paging.totalPages;
    }

    async function load() {
      const sequence=++state.requestSequence;state.loading=true;state.error='';render();
      try { const descriptor=buildRequest(state);const result=await request(descriptor.path,descriptor.options);if(sequence!==state.requestSequence)return;state.items=result.items||[];state.pagination=result.pagination||{page:1,total:state.items.length,totalPages:state.items.length?1:0}; }
      catch (error) { if(sequence!==state.requestSequence)return;state.error=error?.message||'โหลดงานที่ต้องตรวจไม่สำเร็จ';state.items=[]; }
      finally { if(sequence===state.requestSequence){state.loading=false;render();} }
    }

    function setFilters(patch = {}, { reload = false } = {}) {
      if (Object.hasOwn(patch,'category') && CATEGORY_LABELS[patch.category]) state.category=patch.category;
      if (Object.hasOwn(patch,'status')) state.status=patch.status || 'all';
      if (Object.hasOwn(patch,'search')) state.search=String(patch.search||'').slice(0,100);
      state.page=Number(patch.page)||1;render();if(reload)return load();return null;
    }

    let searchTimer=null;
    filters.addEventListener('click',(event)=>{const button=event.target.closest('[data-exception-filter]');if(!button)return;setFilters({category:button.dataset.exceptionFilter,page:1},{reload:true});});
    status.addEventListener('change',()=>setFilters({status:status.value,page:1},{reload:true}));
    search.addEventListener('input',()=>{clearTimeout(searchTimer);searchTimer=setTimeout(()=>setFilters({search:search.value,page:1},{reload:true}),250);});
    previous.addEventListener('click',()=>{if(state.page>1){state.page-=1;load();}});
    next.addEventListener('click',()=>{if(state.page<state.pagination.totalPages){state.page+=1;load();}});
    doc.getElementById('exceptionQueueRefresh').addEventListener('click',()=>load());
    render();
    return { load, setFilters, getState:()=>({...state,items:[...state.items]}) };
  }

  return { CATEGORY_LABELS, STATUS_LABELS, buildRequest, createController };
}));
