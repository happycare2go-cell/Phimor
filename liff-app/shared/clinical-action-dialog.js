(function attachClinicalActionDialog(root, factory) {
  const api=factory();
  if(typeof module!=='undefined'&&module.exports)module.exports=api;
  if(root)root.PhimorClinicalActionDialog=api;
}(typeof window!=='undefined'?window:globalThis,function clinicalActionDialogFactory(){
  'use strict';
  const ERROR_COPY=Object.freeze({
    ACCESS_DENIED:'คุณไม่มีสิทธิ์แก้ไขรายการนี้',CENTER_ACCESS_DENIED:'คุณไม่มีสิทธิ์แก้ไขรายการนี้',
    EXTERNAL_RECORD_LOCAL_MUTATION_DENIED:'รายการนี้มาจากระบบที่เชื่อมต่อ จึงไม่สามารถแก้ไขจากพี่หมอได้',
    VERSION_CONFLICT:'ข้อมูลรายการนี้มีการเปลี่ยนแปลง กรุณารีเฟรชแล้วลองอีกครั้ง',
    CORRECTION_REASON_REQUIRED:'กรุณาระบุเหตุผลที่สร้างฉบับแก้ไข',VOID_REASON_REQUIRED:'กรุณาระบุเหตุผลที่ยกเลิกรายการ',
  });
  function safeError(error){return ERROR_COPY[error?.errorCode||error?.code]||'ดำเนินการไม่สำเร็จ กรุณาลองอีกครั้ง';}
  function createElement(doc,tag,className,text){const element=doc.createElement(tag);if(className)element.className=className;if(text)element.textContent=text;return element;}
  function createDialog({doc,host}={}){
    if(!doc)throw new Error('doc is required');
    const mount=host||doc.body;
    const overlay=createElement(doc,'div','clinical-action-dialog');overlay.hidden=true;overlay.setAttribute('aria-hidden','true');
    const sheet=createElement(doc,'section','clinical-action-dialog__sheet');sheet.setAttribute('role','dialog');sheet.setAttribute('aria-modal','true');
    const title=createElement(doc,'h3','clinical-action-dialog__title');title.id='clinicalActionDialogTitle';sheet.setAttribute('aria-labelledby',title.id);
    const explanation=createElement(doc,'p','clinical-action-dialog__explanation');
    const label=createElement(doc,'label','clinical-action-dialog__label','เหตุผล (จำเป็น)');
    const reason=createElement(doc,'textarea','clinical-action-dialog__reason');reason.maxLength=500;reason.rows=4;reason.setAttribute('aria-required','true');
    label.appendChild(reason);
    const error=createElement(doc,'p','clinical-action-dialog__error');error.setAttribute('role','alert');error.setAttribute('aria-live','polite');
    const actions=createElement(doc,'div','clinical-action-dialog__actions');
    const cancel=createElement(doc,'button','btn btn-outline','กลับ');cancel.type='button';
    const confirm=createElement(doc,'button','btn btn-danger','ยืนยัน');confirm.type='button';
    actions.append(cancel,confirm);sheet.append(title,explanation,label,error,actions);overlay.appendChild(sheet);mount.appendChild(overlay);
    let active=null;let busy=false;let previousFocus=null;
    function close(value){if(!active)return;const resolve=active.resolve;active=null;busy=false;overlay.hidden=true;overlay.setAttribute('aria-hidden','true');reason.value='';error.textContent='';cancel.disabled=false;confirm.disabled=false;previousFocus?.focus?.();resolve(value);}
    cancel.addEventListener('click',()=>{if(!busy)close(null);});
    overlay.addEventListener('keydown',(event)=>{if(event.key==='Escape'&&!busy){event.preventDefault();close(null);}});
    confirm.addEventListener('click',async()=>{
      if(!active||busy)return;
      const clean=reason.value.trim();
      if(!clean){error.textContent=active.reasonRequired||'กรุณาระบุเหตุผล';reason.focus();return;}
      busy=true;cancel.disabled=true;confirm.disabled=true;confirm.textContent=active.busyLabel||'กำลังดำเนินการ...';error.textContent='';
      try{const result=await active.onConfirm(clean);close(result===undefined?true:result);}
      catch(actionError){if(!active)return;error.textContent=safeError(actionError);busy=false;cancel.disabled=false;confirm.disabled=false;confirm.textContent=active.confirmLabel;reason.focus();}
    });
    function open(options={}){
      if(active)return Promise.resolve({ignored:true,busy:true});
      previousFocus=doc.activeElement;title.textContent=options.title||'ยืนยันการดำเนินการ';explanation.textContent=options.explanation||'';
      reason.value='';reason.placeholder=options.placeholder||'ระบุเหตุผล';error.textContent='';
      confirm.textContent=options.confirmLabel||'ยืนยัน';confirm.className=`btn ${options.danger===false?'btn-primary':'btn-danger'}`;
      overlay.hidden=false;overlay.setAttribute('aria-hidden','false');
      return new Promise((resolve)=>{active={...options,resolve,confirmLabel:confirm.textContent,onConfirm:typeof options.onConfirm==='function'?options.onConfirm:async(value)=>value};setTimeout(()=>reason.focus(),0);});
    }
    return Object.freeze({open,close:()=>close(null),isOpen:()=>Boolean(active),elements:{overlay,sheet,reason,confirm,cancel,error}});
  }
  return Object.freeze({ERROR_COPY,safeError,createDialog});
}));
