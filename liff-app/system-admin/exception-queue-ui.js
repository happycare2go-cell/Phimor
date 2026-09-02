(function initExceptionQueue(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PhimorAdminExceptionQueue = api;
}(typeof window !== 'undefined' ? window : globalThis, function exceptionQueueFactory() {
  const CATEGORY_LABELS = Object.freeze({
    all:'ทั้งหมด', dsr:'คำขอข้อมูลส่วนบุคคล', pending_mapping:'ผู้พักรอเชื่อม',
    groups:'กลุ่ม LINE', group_missing:'กลุ่ม LINE ไม่พร้อม', group_mismatch:'กลุ่ม LINE ไม่ตรงกัน',
    identity_ambiguity:'ชื่อซ้ำ / จับคู่ไม่ได้', integration_failure:'Integration ล้มเหลว',
    retry_warning:'การส่งแจ้งเตือน', scheduler_warning:'งานเบื้องหลัง',
  });
  const STATUS_LABELS = Object.freeze({ pending:'รอดำเนินการ', in_progress:'กำลังดำเนินการ',
    open:'ต้องตรวจ', retrying:'กำลังลองส่งใหม่', dead:'หยุดลองส่งแล้ว', rejected:'ถูกปฏิเสธ', failed:'ล้มเหลว' });
  const RECIPIENT_TYPE_LABELS = Object.freeze({
    family:'กลุ่มครอบครัว', center:'กลุ่มเจ้าหน้าที่ศูนย์', center_staff:'กลุ่มเจ้าหน้าที่ศูนย์',
    user:'บัญชี LINE', family_group:'กลุ่มครอบครัว', line_user:'บัญชี LINE', line_group:'กลุ่ม LINE',
  });

  function buildRequest(state) {
    const query = new URLSearchParams({ category:state.category || 'all', status:state.status || 'all',
      search:String(state.search || '').trim(), page:String(state.page || 1), pageSize:String(state.pageSize || 20) });
    return { path:`/api/admin/exceptions?${query.toString()}`, options:{ method:'GET' } };
  }

  function parsedDate(value) {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date : null;
  }

  function formatDate(value) {
    const date = parsedDate(value);
    return date ? date.toLocaleString('th-TH') : 'ไม่ระบุเวลา';
  }

  function formatRetryTime(value, now = new Date()) {
    const date = parsedDate(value);
    if (!date) return null;
    const sameDay = date.getFullYear() === now.getFullYear()
      && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
    if (sameDay) return `${date.toLocaleTimeString('th-TH', { hour:'2-digit', minute:'2-digit' })} น.`;
    return date.toLocaleString('th-TH', { dateStyle:'medium', timeStyle:'short' });
  }

  function notificationCardModel(item, now = new Date()) {
    const notification = item?.notification || {};
    const status = item?.status === 'retrying' ? 'retrying' : 'dead';
    const label = notification.kindLabel || 'การแจ้งเตือน';
    const attempts = Math.max(0, Number(notification.attempts) || 0);
    return {
      title:item?.title || `${label}${status === 'retrying' ? 'ยังไม่สำเร็จ' : 'ส่งไม่สำเร็จ'}`,
      statusLabel:STATUS_LABELS[status],
      summary:item?.summary || (status === 'retrying'
        ? `ส่งไม่สำเร็จ ${attempts} ครั้ง` : `ระบบลองส่งแล้ว ${attempts} ครั้ง แต่ยังไม่สำเร็จ`),
      nextRetry:status === 'retrying' && notification.nextAttemptAt
        ? `จะลองอีกครั้ง ${formatRetryTime(notification.nextAttemptAt, now)}` : null,
    };
  }

  function notificationDetailModel(item) {
    const notification = item?.notification || {};
    const retrying = item?.status === 'retrying';
    const attempts = Math.max(0, Number(notification.attempts) || 0);
    const timeRows = [
      ['สร้างเมื่อ', notification.createdAt ? formatDate(notification.createdAt) : null],
      ['อัปเดตสถานะล่าสุด', notification.statusUpdatedAt
        ? formatDate(notification.statusUpdatedAt) : null],
      ['จะลองอีกครั้ง', retrying && notification.nextAttemptAt
        ? formatDate(notification.nextAttemptAt) : null],
    ].filter(([, value]) => value);
    const recipient = RECIPIENT_TYPE_LABELS[notification.recipientType]
      || (notification.recipientType ? 'ปลายทาง LINE' : null);
    const technical = [
      ['ชนิดการแจ้งเตือน', notification.kind || 'notification'],
      ['รหัสข้อผิดพลาด', notification.lastErrorCode || 'NOTIFICATION_DELIVERY_FAILED'],
      ['เลขอ้างอิง', item?.safeReference || null],
      ['ทรัพยากร', notification.safeResourceReference || null],
      ['การตอบรับจากผู้ให้บริการ', notification.providerAcceptance || null],
      ['เลขอ้างอิงผู้ให้บริการ', notification.providerRequestReference || null],
    ].filter(([, value]) => value);
    return {
      title:'รายละเอียดการแจ้งเตือน',
      sections:[
        { title:'เกิดอะไรขึ้น', rows:[['ประเภท', notification.kindLabel || 'การแจ้งเตือน'],
          ['สถานะ', retrying ? 'กำลังลองส่งใหม่' : 'หยุดลองส่งแล้ว']] },
        { title:'เวลา', rows:timeRows },
        { title:'การลองส่ง', rows:[['จำนวนครั้ง', `${attempts} ครั้ง`]] },
        { title:'ปลายทาง', rows:[['ประเภทปลายทาง', recipient],
          ['ปลายทาง', notification.maskedDestination || 'ไม่แสดงข้อมูลปลายทาง']].filter(([, value]) => value) },
        { title:'สาเหตุ', rows:[['สถานะการส่ง', notification.lastErrorMessage || 'ส่งการแจ้งเตือนไม่สำเร็จ']] },
        { title:'ควรตรวจอะไร', note:retrying
          ? 'ระบบยังลองส่งให้อัตโนมัติ ไม่ต้องสั่งส่งซ้ำ'
          : 'ระบบหยุดลองส่งอัตโนมัติแล้ว ตรวจว่าปลายทางยังเชื่อมกับพี่หมออยู่ และตรวจการเชื่อมต่อ LINE หากปลายทางยังถูกต้อง' },
      ],
      technical,
    };
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
    const detailDialog = doc.getElementById('notificationExceptionDialog');
    const detailTitle = doc.getElementById('notificationExceptionTitle');
    const detailBody = doc.getElementById('notificationExceptionBody');
    const detailClose = doc.getElementById('notificationExceptionClose');
    let detailTrigger = null;

    function el(tag, className = '', text = '') {
      const node=doc.createElement(tag);if(className)node.className=className;if(text)node.textContent=text;return node;
    }

    function appendRows(parent, rows) {
      if (!rows?.length) return;
      const list=el('dl','exception-detail__rows');
      rows.forEach(([term,value])=>{list.append(el('dt','',term),el('dd','',value));});
      parent.append(list);
    }

    function openNotificationDetail(item, trigger) {
      const model=notificationDetailModel(item);detailTrigger=trigger;detailTitle.textContent=model.title;detailBody.replaceChildren();
      model.sections.forEach((section)=>{const block=el('section','exception-detail__section');block.append(el('h3','',section.title));appendRows(block,section.rows);if(section.note)block.append(el('p','exception-detail__advice',section.note));detailBody.append(block);});
      const technical=el('details','exception-detail__technical');technical.append(el('summary','', 'รายละเอียดทางเทคนิค'));appendRows(technical,model.technical);detailBody.append(technical);
      if (typeof detailDialog.showModal === 'function') detailDialog.showModal(); else detailDialog.setAttribute('open','');
      detailClose.focus();
    }

    detailClose?.addEventListener('click',()=>detailDialog.close());
    detailDialog?.addEventListener('close',()=>{detailTrigger?.focus?.();detailTrigger=null;});

    function render() {
      filters.querySelectorAll('[data-exception-filter]').forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.exceptionFilter === state.category)));
      status.value = state.status; search.value = state.search;
      live.textContent = state.loading ? 'กำลังโหลดงานที่ต้องตรวจ…' : state.error || `พบ ${state.pagination.total || 0} รายการ`;
      content.replaceChildren();
      if (state.loading) { content.append(el('div','exception-queue__empty','กำลังโหลด…')); return; }
      if (state.error) { const retry=el('button','secondary','ลองอีกครั้ง');retry.type='button';retry.addEventListener('click',()=>load());content.append(retry);return; }
      if (!state.items.length) {
        const empty=el('div','exception-queue__empty');empty.append(el('strong','', 'ไม่มีรายการที่ต้องตรวจ'),
          el('p','', 'ระบบยังไม่พบงานที่ต้องให้ผู้ดูแลดำเนินการ'));content.append(empty);
      } else {
        const list=el('div','exception-queue__list');
        state.items.forEach((item) => {
          const notification=item.action?.kind === 'inspect_notification' ? notificationCardModel(item) : null;
          const card=el('article','exception-queue__item');
          const heading=el('div','exception-queue__heading');
          heading.append(el('strong','',notification?.title || item.title || CATEGORY_LABELS[item.category] || 'งานต้องตรวจ'));
          const badge=el('span',`exception-queue__status exception-queue__status--${item.status}`,
            notification?.statusLabel || STATUS_LABELS[item.status] || 'ต้องตรวจ');heading.append(badge);card.append(heading);
          card.append(el('div','exception-queue__category',CATEGORY_LABELS[item.category] || item.category),
            el('p','exception-queue__summary',notification?.summary || item.summary || 'ตรวจสอบสถานะการดำเนินงาน'));
          if(notification?.nextRetry)card.append(el('p','exception-queue__next-attempt',notification.nextRetry));
          const meta=el('div','exception-queue__meta',[item.centerName,item.safeReference,formatDate(item.occurredAt)].filter(Boolean).join(' · '));card.append(meta);
          const action=el('button','secondary exception-queue__action',item.action?.label || 'ตรวจสอบ');action.type='button';
          action.addEventListener('click',async()=>{if(item.action?.kind==='inspect_notification'){openNotificationDetail(item,action);return}action.disabled=true;try{await onAction(item)}finally{action.disabled=false}});
          card.append(action);list.append(card);
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

  return { CATEGORY_LABELS, STATUS_LABELS, RECIPIENT_TYPE_LABELS, buildRequest, formatDate,
    formatRetryTime, notificationCardModel, notificationDetailModel, createController };
}));
