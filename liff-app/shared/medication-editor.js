(function medicationEditorModule(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PhimorMedicationEditor = api;
})(typeof window !== 'undefined' ? window : globalThis, function buildMedicationEditor() {
  const FIELDS = Object.freeze([
    ['name', 'ชื่อยา', 200, true, 'basic'],
    ['strength', 'ความแรงของยา', 120, false, 'basic'],
    ['dose', 'ครั้งละ', 200, false, 'usage'],
    ['unit', 'หน่วย', 120, false, 'usage', ['เม็ด','แคปซูล','มล.','ช้อนชา','หยด','พัฟ']],
    ['frequency', 'ใช้วันละ', 120, false, 'usage', ['1 ครั้ง','2 ครั้ง','3 ครั้ง','4 ครั้ง','เมื่อมีอาการ']],
    ['timing', 'เวลาใช้ยา', 120, false, 'usage', ['เช้า','กลางวัน','เย็น','ก่อนนอน','ก่อนอาหาร','หลังอาหาร','พร้อมอาหาร']],
    ['route', 'ทางใช้ยา', 120, false, 'advanced', ['รับประทาน','ทาภายนอก','หยอดตา','หยอดหู','สูดพ่น','ฉีด']],
    ['instruction', 'คำสั่งใช้ยาตามฉลาก', 500, false, 'advanced'],
    ['amount', 'จำนวนที่ได้รับทั้งหมด', 120, false, 'advanced'],
    ['condition', 'หมายเหตุเพิ่มเติม', 500, false, 'advanced'],
  ]);
  const FIELD_LABELS = Object.freeze(Object.fromEntries(FIELDS.map(([field, label]) => [field, label])));
  const MAX_ROWS = 30;
  const MAX_IMAGES = 4;

  function clean(item = {}) {
    const output = { medicationId:item.medicationId || null, stableMedicationId:item.stableMedicationId || null };
    for (const [field] of FIELDS) output[field] = item[field] == null ? '' : String(item[field]);
    return output;
  }

  function element(tag, className = '', text = '') {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
  }

  function doseLine(item = {}) {
    const dose = String(item.dose || '').trim();
    const unit = String(item.unit || '').trim();
    if (!dose || isLegacyDoseInstruction(item)) return '';
    const amount = unit && !dose.toLocaleLowerCase().includes(unit.toLocaleLowerCase()) ? `${dose} ${unit}` : dose;
    return /^ครั้งละ\s/u.test(amount) ? amount : `ครั้งละ ${amount}`;
  }

  function isLegacyDoseInstruction(item = {}) {
    const dose = String(item.dose || '').trim();
    if (!dose || [item.instruction, item.unit, item.frequency, item.timing, item.route]
      .some((value) => String(value || '').trim())) return false;
    return /^(?:รับประทาน|ทา|หยอด|สูด|พ่น|ฉีด|อม|เหน็บ|ใช้ยา|ให้ยา)/u.test(dose);
  }

  function instructionLine(item = {}) {
    const instruction = String(item.instruction || '').trim();
    if (instruction) return instruction;
    return isLegacyDoseInstruction(item) ? String(item.dose || '').trim() : '';
  }

  function scheduleLine(item = {}) {
    const rawFrequency = String(item.frequency || '').trim();
    const frequency = /^\d+\s*ครั้ง$/u.test(rawFrequency) ? `วันละ ${rawFrequency}` : rawFrequency;
    return [frequency, item.timing].map((value) => String(value || '').trim()).filter(Boolean).join(' · ');
  }

  function renderMedicationSummary(parent, item = {}, { prefix = '' } = {}) {
    if (prefix) parent.append(element('div', 'medication-editor__comparison-label', prefix));
    const summary = element('div', 'medication-editor__summary');
    const heading = element('div', 'medication-editor__summary-heading');
    heading.append(element('strong', '', String(item.name || 'ยังไม่ระบุชื่อยา')));
    if (item.strength) heading.append(element('span', '', String(item.strength)));
    summary.append(heading);
    const use = [doseLine(item), scheduleLine(item)].filter(Boolean);
    if (use.length) summary.append(element('p', 'medication-editor__usage', use.join('\n')));
    const instruction = instructionLine(item);
    if (instruction) summary.append(element('p', 'medication-editor__instruction', instruction));
    parent.append(summary);
  }

  function renderCards(container, items = [], { editable = false, onEdit = null } = {}) {
    if (!container) return;
    container.replaceChildren();
    if (!items.length) {
      const empty = element('div', 'medication-editor__empty');
      empty.append(element('strong', '', 'ยังไม่มีรายการยาปัจจุบัน'),
        element('p', '', 'เพิ่มยาโดยถ่ายรูปฉลากยา หรือกรอกข้อมูลเอง'));
      container.append(empty);
      return;
    }
    items.slice(0, MAX_ROWS).forEach((item, index) => {
      const card = element('article', 'medication-editor__card');
      renderMedicationSummary(card, item);
      const details = [item.route, item.amount ? `จำนวนที่ได้รับทั้งหมด ${item.amount}` : '', item.condition]
        .map((value) => String(value || '').trim()).filter(Boolean);
      if (details.length) card.append(element('p', 'medication-editor__card-details', details.join(' · ')));
      if (editable && onEdit) {
        const button = element('button', 'btn btn-outline medication-editor__edit', 'แก้ไข');
        button.type = 'button'; button.addEventListener('click', () => onEdit(index)); card.append(button);
      }
      container.append(card);
    });
  }

  function appendField(parent, definition, item, rowIndex, onChange) {
    const [field, labelText, maxLength, required, , options] = definition;
    const label = element('label');
    const labelSpan = element('span', '', labelText);
    const input = field === 'instruction' || field === 'condition'
      ? document.createElement('textarea') : document.createElement('input');
    input.className = `medication-editor__${field}`;
    input.dataset.medicationField = field;
    input.maxLength = maxLength;
    input.value = item[field] == null ? '' : String(item[field]);
    input.required = required;
    input.autocomplete = 'off';
    if (field === 'amount' || field === 'dose') input.inputMode = 'decimal';
    if (options?.length) {
      const listId = `medication-${field}-${rowIndex}-${Math.random().toString(36).slice(2, 8)}`;
      input.setAttribute('list', listId);
      const list = document.createElement('datalist'); list.id = listId;
      options.forEach((option) => { const choice = document.createElement('option'); choice.value = option; list.append(choice); });
      label.append(labelSpan, input, list);
    } else label.append(labelSpan, input);
    input.addEventListener('input', () => onChange?.());
    parent.append(label);
  }

  function renderRows(container, items = [], { editable = true, onChange = null, confirmRemove = null } = {}) {
    if (!container) return;
    container.replaceChildren();
    items.slice(0, MAX_ROWS).forEach((rawItem, rowIndex) => {
      const item = clean(rawItem);
      const row = document.createElement('fieldset');
      row.className = 'medication-editor__row';
      row.dataset.medicationId = item.medicationId || '';
      row.dataset.stableMedicationId = item.stableMedicationId || '';
      const legend = document.createElement('legend');
      legend.textContent = item.name || `ยา ${rowIndex + 1}`;
      row.appendChild(legend);
      const basic = element('section', 'medication-editor__section');
      basic.append(element('h4', '', 'ข้อมูลยา'));
      FIELDS.filter((field) => field[4] === 'basic').forEach((field) => appendField(basic, field, item, rowIndex, onChange));
      row.append(basic);
      const usage = element('section', 'medication-editor__section');
      usage.append(element('h4', '', 'วิธีใช้'));
      const doseGroup = element('div', 'medication-editor__dose-group');
      const legacyDose = isLegacyDoseInstruction(item);
      if (legacyDose) doseGroup.classList.add('medication-editor__dose-group--legacy');
      FIELDS.filter((field) => ['dose','unit'].includes(field[0])).forEach((field) => {
        const definition = legacyDose && field[0] === 'dose'
          ? [field[0], 'คำสั่งใช้ยาตามฉลาก (ข้อมูลเดิม)', ...field.slice(2)] : field;
        appendField(doseGroup, definition, item, rowIndex, onChange);
      });
      usage.append(doseGroup);
      if (legacyDose) usage.append(element('p', 'medication-editor__legacy-note',
        'ข้อมูลเดิมนี้จะคงรูปแบบเดิมไว้จนกว่าคุณจะแก้ไขเอง'));
      FIELDS.filter((field) => field[4] === 'usage' && !['dose','unit'].includes(field[0]))
        .forEach((field) => appendField(usage, field, item, rowIndex, onChange));
      row.append(usage);
      const advanced = element('details', 'medication-editor__advanced');
      advanced.append(element('summary', '', 'รายละเอียดเพิ่มเติม'));
      const advancedBody = element('div', 'medication-editor__advanced-body');
      FIELDS.filter((field) => field[4] === 'advanced').forEach((field) => appendField(advancedBody, field, item, rowIndex, onChange));
      advanced.append(advancedBody); row.append(advanced);
      row.querySelectorAll('input,textarea').forEach((input) => { input.disabled = !editable; });
      if (editable) {
        const remove = element('button', 'btn btn-outline medication-editor__remove', 'ลบรายการ');
        remove.type = 'button'; remove.setAttribute('aria-label', `ลบยา ${rowIndex + 1}`);
        remove.addEventListener('click', async () => {
          if (remove.disabled) return;
          remove.disabled = true;
          try {
            const confirmed = confirmRemove ? await confirmRemove(clean(item)) : true;
            if (!confirmed) return;
            row.remove(); renumber(container); onChange?.();
          } finally { if (remove.isConnected) remove.disabled = false; }
        });
        row.append(remove);
      }
      container.append(row);
    });
  }

  function renumber(container) {
    [...container.querySelectorAll('.medication-editor__row')].forEach((row, index) => {
      const name = row.querySelector('[data-medication-field="name"]')?.value.trim();
      row.querySelector('legend').textContent = name || `ยา ${index + 1}`;
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
      const item = { medicationId:row.dataset.medicationId || null, stableMedicationId:row.dataset.stableMedicationId || null };
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
      const input = row.querySelector('[data-medication-field="name"]'); if (!input) continue;
      const error = element('p', 'medication-editor__row-error', 'รายการยานี้ซ้ำกับอีกแถว กรุณารวมข้อมูลให้เหลือหนึ่งรายการ');
      error.id = `medication-row-error-${rowIndex}-${Date.now()}`;
      input.setAttribute('aria-invalid','true'); input.setAttribute('aria-describedby',error.id);
      row.append(error);
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

  function combineImageExtractions(results = []) {
    const extracted = []; const reviewByIndex = {}; let failedImages = 0; let readableImages = 0;
    results.slice(0, MAX_IMAGES).forEach((result) => {
      const items = result?.ok && Array.isArray(result.extracted) ? result.extracted : [];
      if (!items.length) { failedImages += 1; return; }
      readableImages += 1;
      const offset = extracted.length;
      items.forEach((item) => extracted.push(clean(item)));
      (result.extractionReview || []).forEach((review) => {
        const index = offset + Number(review.extractedIndex);
        reviewByIndex[index] = { state:review.state === 'review' ? 'review' : 'read',
          uncertainFields:(review.uncertainFields || []).filter((field) => FIELD_LABELS[field]) };
      });
    });
    return { extracted:extracted.slice(0, MAX_ROWS), reviewByIndex, failedImages, readableImages,
      totalImages:Math.min(results.length, MAX_IMAGES), truncated:extracted.length > MAX_ROWS };
  }

  function renderProposalReview(container, proposal, { prefix = 'medication-choice', reviewByIndex = {}, onDraftChange = null } = {}) {
    if (!container) return { ambiguous:false };
    container.replaceChildren(); let ambiguous = false;
    (proposal?.proposals || []).forEach((item, index) => {
      const card = element('section', `medication-editor__proposal${item.ambiguous ? ' medication-editor__proposal--ambiguous' : ''}`);
      card.dataset.extractedIndex = item.extractedIndex == null ? '' : String(item.extractedIndex);
      const review = item.extractedIndex == null ? null : reviewByIndex[item.extractedIndex];
      const needsReview = item.ambiguous || review?.state === 'review';
      card.append(element('span', `medication-editor__read-state medication-editor__read-state--${needsReview ? 'review' : 'read'}`,
        needsReview ? 'ควรตรวจ' : 'อ่านได้'));
      if (item.current) renderMedicationSummary(card, item.current, { prefix:'ข้อมูลปัจจุบัน' });
      if (item.extracted) renderMedicationSummary(card, item.extracted, { prefix:'ข้อมูลจากฉลาก' });
      if (review?.uncertainFields?.length) {
        card.append(element('p', 'medication-editor__uncertain',
          `ระบบอ่านข้อมูลส่วนนี้ได้ไม่ชัด กรุณาตรวจสอบจากฉลาก: ${review.uncertainFields.map((field) => FIELD_LABELS[field]).join(', ')}`));
      }
      if (item.extracted) {
        const edit = element('details', 'medication-editor__draft-edit');
        edit.append(element('summary', '', 'ตรวจสอบ/แก้ไขข้อมูลจากฉลาก'));
        const editor = element('div', 'medication-editor__draft-fields'); edit.append(editor); card.append(edit);
        renderRows(editor, [item.extracted], { editable:true, onChange:() => {
          const changed = collectRows(editor, { includeBlank:true })[0] || clean();
          item.extracted = changed;
          if (item.extractedIndex != null) proposal.extracted[item.extractedIndex] = changed;
          onDraftChange?.();
        } });
      }
      if (item.ambiguous) {
        ambiguous = true;
        card.append(element('p', 'medication-editor__uncertain',
          item.extracted ? 'พบรายการที่อาจเป็นยาเดียวกัน กรุณาแก้ไขแล้วตรวจสอบรายการอีกครั้ง'
            : 'พบรายการที่อาจซ้ำกัน ระบบจะไม่รวมข้อมูลให้อัตโนมัติ'));
      } else if (item.classification !== 'UNCHANGED') {
        const choices = element('div', 'medication-editor__proposal-options');
        const name = `${prefix}-${index}`;
        const currentLabel = element('label'); const current = document.createElement('input');
        current.type = 'radio'; current.name = name; current.value = 'current'; current.checked = item.classification !== 'NEW';
        currentLabel.append(current, document.createTextNode(item.classification === 'NEW' ? ' ไม่เพิ่มรายการนี้' : ' คงข้อมูลปัจจุบัน'));
        const newLabel = element('label'); const fresh = document.createElement('input');
        fresh.type = 'radio'; fresh.name = name; fresh.value = 'new'; fresh.checked = item.classification === 'NEW';
        newLabel.append(fresh, document.createTextNode(' ใช้ข้อมูลจากฉลากใหม่'));
        choices.append(currentLabel, newLabel); card.append(choices);
      }
      container.append(card);
    });
    return { ambiguous };
  }

  function collectProposalDecisions(container) {
    const decisions = {};
    container?.querySelectorAll('.medication-editor__proposal').forEach((card) => {
      if (card.dataset.extractedIndex !== '') decisions[card.dataset.extractedIndex] =
        card.querySelector('input[type=radio]:checked')?.value || 'current';
    });
    return decisions;
  }

  return Object.freeze({ FIELDS, FIELD_LABELS, MAX_ROWS, MAX_IMAGES, clean, doseLine, isLegacyDoseInstruction,
    instructionLine, scheduleLine,
    renderMedicationSummary, renderCards, renderRows, addRow, collectRows, showRowConflicts,
    proposedCompleteSet, combineImageExtractions, renderProposalReview, collectProposalDecisions });
});
