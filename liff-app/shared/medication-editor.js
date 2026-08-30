(function medicationEditorModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PhimorMedicationEditor = api;
})(typeof window !== 'undefined' ? window : globalThis, function buildMedicationEditor() {
  const FIELDS = Object.freeze([
    ['name', 'ชื่อยา', 200, true], ['strength', 'ขนาดยา', 120, false],
    ['dose', 'ปริมาณที่ใช้', 200, false], ['instruction', 'วิธีใช้', 500, false],
    ['amount', 'จำนวน', 120, false], ['unit', 'หน่วย', 120, false],
    ['frequency', 'ความถี่', 120, false], ['timing', 'เวลา', 120, false],
    ['route', 'วิธีให้ยา', 120, false], ['condition', 'ข้อบ่งใช้ / หมายเหตุ', 500, false],
  ]);
  const MAX_ROWS = 30;

  function clean(item = {}) {
    const output = { medicationId:item.medicationId || null, stableMedicationId:item.stableMedicationId || null };
    for (const [field] of FIELDS) output[field] = item[field] == null ? '' : String(item[field]);
    return output;
  }

  function renderRows(container, items = [], { editable = true, onChange = null, confirmRemove = null } = {}) {
    if (!container) return;
    container.replaceChildren();
    const rows = items.length ? items : (editable ? [{}] : []);
    rows.slice(0, MAX_ROWS).forEach((item) => {
      const row = document.createElement('fieldset');
      row.className = 'medication-editor__row';
      row.dataset.medicationId = item.medicationId || '';
      row.dataset.stableMedicationId = item.stableMedicationId || '';
      const legend = document.createElement('legend');
      legend.textContent = `ยา ${container.children.length + 1}`;
      row.appendChild(legend);
      for (const [field, labelText, maxLength, required] of FIELDS) {
        const label = document.createElement('label');
        const labelSpan = document.createElement('span');
        labelSpan.textContent = labelText;
        const input = field === 'instruction' || field === 'condition'
          ? document.createElement('textarea') : document.createElement('input');
        input.className = `medication-editor__${field}`;
        input.dataset.medicationField = field;
        input.maxLength = maxLength;
        input.value = item[field] == null ? '' : String(item[field]);
        input.disabled = !editable;
        input.required = required;
        input.autocomplete = 'off';
        input.addEventListener('input', () => onChange?.());
        label.append(labelSpan, input);
        row.appendChild(label);
      }
      if (editable) {
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'btn btn-outline medication-editor__remove';
        remove.textContent = 'ลบรายการ';
        remove.setAttribute('aria-label', `ลบยา ${container.children.length + 1}`);
        remove.addEventListener('click', async () => {
          if (remove.disabled) return;
          remove.disabled = true;
          try {
            const confirmed = confirmRemove ? await confirmRemove(clean(item)) : true;
            if (!confirmed) return;
            row.remove(); renumber(container); onChange?.();
          } finally {
            if (remove.isConnected) remove.disabled = false;
          }
        });
        row.appendChild(remove);
      }
      container.appendChild(row);
    });
    if (!rows.length) {
      const empty = document.createElement('p');
      empty.className = 'medication-editor__empty';
      empty.textContent = 'ยังไม่มีรายการยาปัจจุบัน';
      container.appendChild(empty);
    }
  }

  function renumber(container) {
    [...container.querySelectorAll('.medication-editor__row')].forEach((row, index) => {
      row.querySelector('legend').textContent = `ยา ${index + 1}`;
      row.querySelector('.medication-editor__remove')?.setAttribute('aria-label', `ลบยา ${index + 1}`);
    });
  }

  function addRow(container, item = {}, options = {}) {
    const current = collectRows(container, { includeBlank:true });
    if (current.length >= MAX_ROWS) return false;
    renderRows(container, [...current, clean(item)], options);
    container.querySelector('.medication-editor__row:last-child input')?.focus();
    return true;
  }

  function collectRows(container, { includeBlank = false } = {}) {
    if (!container) return [];
    return [...container.querySelectorAll('.medication-editor__row')].map((row) => {
      const item = {
        medicationId:row.dataset.medicationId || null,
        stableMedicationId:row.dataset.stableMedicationId || null,
      };
      row.querySelectorAll('[data-medication-field]').forEach((input) => { item[input.dataset.medicationField] = input.value.trim(); });
      return item;
    }).filter((item) => includeBlank || item.name);
  }

  function showRowConflicts(container, conflicts = []) {
    if (!container) return;
    container.querySelectorAll('.medication-editor__row-error').forEach((node) => node.remove());
    container.querySelectorAll('[aria-invalid="true"]').forEach((node) => {
      node.removeAttribute('aria-invalid'); node.removeAttribute('aria-describedby');
    });
    const rows = [...container.querySelectorAll('.medication-editor__row')];
    const affected = new Set(conflicts.flatMap((conflict) => Array.isArray(conflict.rows) ? conflict.rows : []));
    for (const rowIndex of affected) {
      const row = rows[rowIndex]; if (!row) continue;
      const field = conflicts.find((conflict) => conflict.rows?.includes(rowIndex))?.field === 'stableMedicationId'
        ? 'name' : 'name';
      const input = row.querySelector(`[data-medication-field="${field}"]`); if (!input) continue;
      const error = document.createElement('p'); error.className = 'medication-editor__row-error';
      error.id = `medication-row-error-${rowIndex}-${Date.now()}`;
      error.textContent = 'รายการยานี้ซ้ำกับอีกแถว กรุณารวมข้อมูลให้เหลือหนึ่งรายการ';
      input.setAttribute('aria-invalid','true'); input.setAttribute('aria-describedby',error.id);
      row.appendChild(error);
    }
    rows[[...affected][0]]?.querySelector('[data-medication-field="name"]')?.focus();
  }

  function proposedCompleteSet(proposal, decisions = {}) {
    const complete = (proposal?.current?.medications || []).map(clean);
    for (const item of proposal?.proposals || []) {
      if (item.ambiguous) continue;
      const decision = decisions[item.extractedIndex] || (item.classification === 'NEW' ? 'new' : 'current');
      if (item.classification === 'NEW') {
        if (decision === 'new') complete.push(clean(item.extracted));
      } else if (item.currentIndex !== null && decision === 'new') {
        complete[item.currentIndex] = clean({ ...complete[item.currentIndex], ...item.extracted,
          medicationId:complete[item.currentIndex].medicationId,
          stableMedicationId:item.extracted?.stableMedicationId || complete[item.currentIndex].stableMedicationId });
      }
    }
    return complete;
  }

  return Object.freeze({ FIELDS, MAX_ROWS, clean, renderRows, addRow, collectRows, showRowConflicts, proposedCompleteSet });
});
