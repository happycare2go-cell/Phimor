(function initOwnershipTransfer(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.PhimorOwnershipTransferUI = api;
}(typeof window !== 'undefined' ? window : globalThis, function ownershipTransferFactory() {
  const ROLE_LABELS = Object.freeze({ owner:'เจ้าของศูนย์', manager:'ผู้จัดการ', staff:'พนักงาน' });
  const OUTCOME_LABELS = Object.freeze({ manager:'ผู้จัดการ', revoked:'ไม่มีสิทธิ์ในศูนย์' });

  function formatDate(value) {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime())
      ? date.toLocaleString('th-TH', { timeZone:'Asia/Bangkok', dateStyle:'medium', timeStyle:'short' }) : 'ไม่ระบุเวลา';
  }

  function createController({ doc, request, onTransferred = async () => {} }) {
    const dialog = doc.getElementById('ownershipTransferDialog');
    const body = doc.getElementById('ownershipTransferBody');
    const error = doc.getElementById('ownershipTransferError');
    const checkButton = doc.getElementById('ownershipTransferCheck');
    const confirmButton = doc.getElementById('ownershipTransferConfirm');
    const cancelButton = doc.getElementById('ownershipTransferCancel');
    const closeButton = doc.getElementById('ownershipTransferClose');
    let context = null;
    let preview = null;
    let previewIntent = null;
    let busy = false;

    const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (char) => ({
      '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;',
    }[char]));

    function transferIntent() {
      const selected = doc.getElementById('ownershipTargetStaff')?.value || '';
      const entered = doc.getElementById('ownershipTargetLine')?.value?.trim() || '';
      const keepPreviousAsManager = doc.querySelector('input[name="previousOwnerOutcome"]:checked')?.value === 'manager';
      return {
        ...(selected ? { targetStaffId:selected } : { newOwnerLineId:entered }),
        keepPreviousAsManager,
      };
    }

    function setBusy(value) {
      busy = value;
      checkButton.disabled = value;
      confirmButton.disabled = value;
      cancelButton.disabled = value;
      closeButton.disabled = value;
    }

    function renderForm() {
      const candidates = (context?.staff || []).filter((member) => (
        ['staff', 'manager'].includes(member.role) && member.status === 'active'
      ));
      body.innerHTML = `
        <section class="ownership-transfer__notice">
          <strong>สิทธิ์การดูแลข้อมูลผู้พักเป็นสิทธิ์ของศูนย์</strong>
          <p>การเปลี่ยนเจ้าของจะไม่ยกเลิกการเชื่อม Care Profile ของศูนย์</p>
        </section>
        <section class="ownership-transfer__section">
          <h3>บัญชีเจ้าของคนใหม่</h3>
          <label for="ownershipTargetStaff">เลือกจากทีมงานปัจจุบัน</label>
          <select id="ownershipTargetStaff">
            <option value="">เลือกบัญชีอื่นด้วย LINE User ID</option>
            ${candidates.map((member) => `<option value="${escape(member.staffId)}">${escape(member.displayIdentity)} · ${escape(ROLE_LABELS[member.role] || member.role)}</option>`).join('')}
          </select>
          <label for="ownershipTargetLine">หรือกรอก LINE User ID</label>
          <input id="ownershipTargetLine" type="text" autocomplete="off" inputmode="text" placeholder="U ตามด้วยอักขระ 32 ตัว">
          <p class="muted">บัญชีใหม่ต้องเพิ่มเพื่อนพี่หมอก่อน ระบบจะตรวจสอบกับ LINE โดยตรง</p>
        </section>
        <fieldset class="ownership-transfer__section">
          <legend>เจ้าของเดิมหลังโอน</legend>
          <label class="ownership-transfer__choice"><input type="radio" name="previousOwnerOutcome" value="revoked" checked><span><strong>ถอดสิทธิ์เจ้าของเดิมออกจากศูนย์</strong><small>เจ้าของเดิมจะเข้าใช้งานศูนย์นี้ไม่ได้</small></span></label>
          <label class="ownership-transfer__choice"><input type="radio" name="previousOwnerOutcome" value="manager"><span><strong>คงเจ้าของเดิมไว้เป็นผู้จัดการ</strong><small>ยังใช้ฟังก์ชันระดับผู้จัดการได้ แต่ไม่มีสิทธิ์เจ้าของ</small></span></label>
        </fieldset>`;
      const select = doc.getElementById('ownershipTargetStaff');
      const input = doc.getElementById('ownershipTargetLine');
      select.addEventListener('change', () => {
        input.disabled = Boolean(select.value);
        if (select.value) input.value = '';
        preview = null;
        previewIntent = null;
        confirmButton.hidden = true;
      });
      input.addEventListener('input', () => {
        if (input.value) select.value = '';
        preview = null;
        previewIntent = null;
        confirmButton.hidden = true;
      });
      body.querySelectorAll('input[name="previousOwnerOutcome"]').forEach((radio) => radio.addEventListener('change', () => {
        preview = null;
        previewIntent = null;
        confirmButton.hidden = true;
      }));
    }

    function renderPreview(result) {
      preview = result;
      body.innerHTML = `
        <section class="ownership-transfer__notice ownership-transfer__notice--confirmed">
          <strong>ตรวจสอบบัญชีแล้ว</strong>
          <p>กรุณาตรวจรายละเอียดอีกครั้งก่อนยืนยันการโอนสิทธิ์</p>
        </section>
        <dl class="ownership-transfer__summary">
          <dt>ศูนย์</dt><dd>${escape(result.center.displayName)}</dd>
          <dt>เจ้าของเดิม</dt><dd>${escape(result.currentOwner.displayName)}</dd>
          <dt>เจ้าของใหม่</dt><dd><strong>${escape(result.newOwner.displayName)}</strong><br><span class="muted">${escape(result.newOwner.maskedIdentity)}</span></dd>
          <dt>บทบาทปัจจุบัน</dt><dd>${escape(ROLE_LABELS[result.newOwner.existingCenterRole] || 'ยังไม่ได้อยู่ในทีมศูนย์นี้')}</dd>
          <dt>เจ้าของเดิมหลังโอน</dt><dd>${escape(OUTCOME_LABELS[result.previousOwnerOutcome])}</dd>
        </dl>
        <section class="ownership-transfer__preserved" aria-label="ข้อมูลที่คงเดิม">
          <strong>ข้อมูลที่คงเดิม</strong>
          <ul><li>ผู้พักยังอยู่ศูนย์เดิม</li><li>Care Profile เดิมยังเชื่อมต่อ</li><li>ญาติไม่ต้องอนุญาตใหม่</li><li>ประวัติเดิมไม่ถูกเปลี่ยน</li></ul>
        </section>`;
      checkButton.hidden = true;
      confirmButton.hidden = false;
    }

    async function check() {
      if (busy || !context) return;
      error.textContent = '';
      setBusy(true);
      try {
        const intent = transferIntent();
        const result = await request(`/api/admin/centers/${encodeURIComponent(context.center.centerId)}/transfer-owner/preview`, {
          method:'POST', body:JSON.stringify(intent),
        });
        previewIntent = intent;
        renderPreview(result);
      } catch (exception) {
        error.textContent = exception.message || 'ตรวจสอบบัญชีไม่สำเร็จ กรุณาลองใหม่';
      } finally {
        setBusy(false);
      }
    }

    async function confirm() {
      if (busy || !context || !preview || !previewIntent) return;
      error.textContent = '';
      setBusy(true);
      try {
        await request(`/api/admin/centers/${encodeURIComponent(context.center.centerId)}/transfer-owner`, {
          method:'POST', body:JSON.stringify(previewIntent),
        });
        const centerId = context.center.centerId;
        dialog.close();
        await onTransferred(centerId);
      } catch (exception) {
        error.textContent = exception.message || 'โอนสิทธิ์ไม่สำเร็จ กรุณาตรวจสอบแล้วลองใหม่';
      } finally {
        setBusy(false);
      }
    }

    function close() {
      if (!busy) dialog.close();
    }

    function open(nextContext) {
      context = nextContext;
      preview = null;
      previewIntent = null;
      error.textContent = '';
      checkButton.hidden = false;
      confirmButton.hidden = true;
      renderForm();
      dialog.showModal();
    }

    async function loadHistory(centerId, host) {
      if (!host) return;
      host.innerHTML = '<p class="muted">กำลังโหลดประวัติ...</p>';
      try {
        const result = await request(`/api/admin/centers/${encodeURIComponent(centerId)}/ownership-history?limit=20`);
        host.innerHTML = result.items.length ? result.items.map((item) => `
          <article class="ownership-history__item">
            <time>${escape(formatDate(item.transferredAt))}</time>
            <div>เจ้าของเดิม: <strong>${escape(item.previousOwner.displayName)}</strong></div>
            <div>เจ้าของใหม่: <strong>${escape(item.newOwner.displayName)}</strong></div>
            <div>เจ้าของเดิมหลังโอน: ${escape(OUTCOME_LABELS[item.previousOwnerOutcome])}</div>
            <div class="muted">ดำเนินการโดย: ${escape(item.operator.displayName)}</div>
          </article>`).join('') : '<p class="muted">ยังไม่มีประวัติการเปลี่ยนเจ้าของ</p>';
      } catch (exception) {
        host.innerHTML = `<p class="bad">${escape(exception.message || 'โหลดประวัติไม่สำเร็จ')}</p>`;
      }
    }

    checkButton.addEventListener('click', check);
    confirmButton.addEventListener('click', confirm);
    cancelButton.addEventListener('click', close);
    closeButton.addEventListener('click', close);
    return { open, close, check, confirm, loadHistory, transferIntent };
  }

  return { createController, formatDate, ROLE_LABELS, OUTCOME_LABELS };
}));
