(function initFamilyHomeV2(root,factory){
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PhimorFamilyHomeV2=api;
}(typeof window!=='undefined'?window:globalThis,function familyHomeV2Factory(){
  const safeArray=(value)=>Array.isArray(value)?value:[];
  const text=(value,fallback='')=>typeof value==='string'?value:fallback;
  const profileIdOf=(entry)=>text(entry?.profile?.care_profile_id);
  const requestProfileId=(item)=>text(item?.careProfileId||item?.care_profile_id);

  function consultationAction(state){
    const collections=state?.collections||{};
    if(safeArray(collections.active).length)return {kind:'consultation',destination:'consultation',icon:'💬',title:'กำลังปรึกษาเภสัชกร',detail:'เปิดห้องเดิมเพื่ออ่านข้อความและสนทนาต่อ'};
    if(safeArray(collections.resolved).length)return {kind:'consultation',destination:'consultation',icon:'💬',title:'เภสัชกรตอบประเด็นหลักแล้ว',detail:'ยังเปิดห้องเดิมเพื่อติดตามคำถามที่เกี่ยวข้องได้จนหมดเวลา'};
    if(safeArray(collections.queued).length)return {kind:'consultation',destination:'consultation',icon:'⏳',title:'รอเภสัชกรรับเคส',detail:'ชำระเงินแล้ว ระยะเวลา 24 ชั่วโมงยังไม่เริ่มจนกว่าเภสัชกรจะรับเคส'};
    return null;
  }

  function consultationServiceLabel(state){
    const action=consultationAction(state);
    if(action?.title==='กำลังปรึกษาเภสัชกร')return 'กำลังปรึกษา';
    if(action?.title==='เภสัชกรตอบประเด็นหลักแล้ว')return 'ตอบประเด็นหลักแล้ว';
    if(action?.title==='รอเภสัชกรรับเคส')return 'รอเภสัชกร';
    return 'ห้องปรึกษาเรื่องยา';
  }

  function buildActionItems({profileEntry=null,accessRequests=[],pendingTransport=[],consultationState=null}={}){
    if(!profileEntry)return [];
    const profileId=profileIdOf(profileEntry),items=[];
    const consultation=consultationAction(consultationState);
    if(consultation)items.push(consultation);
    const accessCount=safeArray(accessRequests).filter((item)=>!requestProfileId(item)||requestProfileId(item)===profileId).length;
    if(accessCount)items.push({kind:'access',destination:'access',icon:'🔐',title:'มีคำขอเข้าถึงข้อมูล',detail:`รอตรวจสอบ ${accessCount} รายการ`});
    const transportCount=safeArray(pendingTransport).filter((item)=>!requestProfileId(item)||requestProfileId(item)===profileId).length;
    if(transportCount)items.push({kind:'transport',destination:'transport',icon:'🚐',title:'รอเลือกวิธีเดินทาง',detail:`มี ${transportCount} นัดที่ต้องเลือกวิธีเดินทาง`});
    const next=safeArray(profileEntry.upcomingAppointments)[0];
    if(next)items.push({kind:'appointment',destination:'appointments',icon:'📅',title:'มีนัดหมายที่ใกล้ถึง',detail:[text(next.hospital,'นัดหมาย'),formatDate(next.datetime)].filter(Boolean).join(' · ')});
    return items;
  }

  function formatDate(value){
    if(!value)return '';
    const date=new Date(value);
    if(Number.isNaN(date.getTime()))return '';
    return date.toLocaleString('th-TH',{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Bangkok'});
  }

  function buildRecentItems(profileEntry){
    if(!profileEntry)return [];
    const items=[];
    const updatedAt=profileEntry.profile?._updatedAt||profileEntry.profile?.updated_at||null;
    if(updatedAt)items.push({destination:'health',icon:'✓',title:'อัปเดต Care Profile ล่าสุด',detail:formatDate(updatedAt)});
    return items.slice(0,3);
  }

  function clearNode(node){while(node?.firstChild)node.removeChild(node.firstChild);}
  function appendText(doc,parent,tag,className,value){const element=doc.createElement(tag);element.className=className;element.textContent=value;parent.appendChild(element);return element;}

  function createController({doc,onNavigate=()=>{}}={}){
    const actionList=doc?.getElementById('familyActionList');
    const recentList=doc?.getElementById('familyRecentActivity');
    const count=doc?.getElementById('familyActionCount');
    const consultationStatus=doc?.getElementById('familyConsultationServiceStatus');
    function renderActionItems(items){
      clearNode(actionList);
      if(!items.length){appendText(doc,actionList,'div','family-action-empty','ไม่มีรายการที่ต้องดำเนินการ');return;}
      items.forEach((item)=>{
        const button=doc.createElement('button');button.type='button';button.className='family-action';button.dataset.destination=item.destination;
        appendText(doc,button,'span','family-action__icon',item.icon);
        const copy=doc.createElement('span');copy.className='family-action__copy';
        appendText(doc,copy,'span','family-action__title',item.title);
        appendText(doc,copy,'span','family-action__detail',item.detail);
        button.appendChild(copy);appendText(doc,button,'span','family-action__arrow','›');
        button.addEventListener('click',()=>onNavigate(item.destination));actionList.appendChild(button);
      });
    }
    function renderRecent(items){
      clearNode(recentList);
      if(!items.length){appendText(doc,recentList,'div','family-action-empty','ยังไม่มีกิจกรรมล่าสุดที่แสดงได้จากข้อมูลปัจจุบัน');return;}
      items.forEach((item)=>{
        const row=doc.createElement('button');row.type='button';row.className='family-action family-recent-item';row.dataset.destination=item.destination;
        appendText(doc,row,'span','family-action__icon',item.icon);
        const copy=doc.createElement('span');copy.className='family-recent-item__copy';appendText(doc,copy,'span','family-recent-item__title',item.title);appendText(doc,copy,'span','family-recent-item__detail',item.detail);row.appendChild(copy);
        row.addEventListener('click',()=>onNavigate(item.destination));recentList.appendChild(row);
      });
    }
    function render(context={}){
      const actions=buildActionItems(context),recent=buildRecentItems(context.profileEntry);
      renderActionItems(actions);renderRecent(recent);
      if(count){count.textContent=String(actions.length);count.hidden=actions.length===0;}
      if(consultationStatus)consultationStatus.textContent=consultationServiceLabel(context.consultationState);
      return {actionCount:actions.length,recentCount:recent.length};
    }
    function clear(){return render({});}
    return Object.freeze({render,clear});
  }

  return Object.freeze({profileIdOf,consultationAction,consultationServiceLabel,buildActionItems,buildRecentItems,createController});
}));
