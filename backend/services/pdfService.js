// services/pdfService.js — สร้างไฟล์ PDF จริงสำหรับส่งออกประวัติ (FR-H4)
// ใช้ pdfkit พร้อม Font Sarabun ฝังไว้ในโปรเจกต์เอง เพื่อให้ Deploy ที่ไหนก็แสดงภาษาไทยได้แน่นอน
// ไม่ต้องพึ่ง Font ที่ติดตั้งไว้ในเครื่อง Server

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { formatThaiDateTime } = require('../utils/thaiDate');

const FONT_REGULAR = path.join(__dirname, '../assets/fonts/Sarabun-Regular.ttf');
const FONT_BOLD = path.join(__dirname, '../assets/fonts/Sarabun-Bold.ttf');

const NAVY = '#1C2B64';
const GRAY = '#5A6580';
const LIGHT_LINE = '#DCE2F0';
const MEDICATION_USE_CONDITION_LABELS = Object.freeze({before_meal:'ก่อนอาหาร',after_meal:'หลังอาหาร',with_meal:'พร้อมอาหาร',as_needed:'เมื่อมีอาการ'});
const MEDICATION_PERIOD_LABELS = Object.freeze({morning:'เช้า',noon:'กลางวัน',evening:'เย็น',bedtime:'ก่อนนอน'});

function formatThaiDate(iso) {
  return formatThaiDateTime(iso);
}

function medicationHistoryValue(field, value) {
  if (field === 'useCondition') return MEDICATION_USE_CONDITION_LABELS[value] || '-';
  if (field === 'dayPeriods') return (Array.isArray(value) ? value : [])
    .map((period) => MEDICATION_PERIOD_LABELS[period]).filter(Boolean).join(', ') || '-';
  return value ?? '-';
}

/**
 * สร้าง PDF ประวัติสุขภาพ คืนเป็น Buffer (ไม่เขียนไฟล์ลงดิสก์ตรงๆ เพื่อให้ Route เลือกได้เองว่า
 * จะส่งเป็น Download ตรง หรืออัปโหลดขึ้น Storage แล้วคืน URL)
 *
 * @param {object} params
 * @param {object} params.profile           Care Profile (patient_name, blood_type, height_cm, weight_kg, chronic_conditions)
 * @param {Array}  params.appointments       รายการนัด (เรียงใหม่ไปเก่าแล้ว)
 * @param {Array}  params.medications        รายการยา
 * @param {string} [params.fromDate]
 * @param {string} [params.toDate]
 * @returns {Promise<Buffer>}
 */
function generateHistoryPdf({ profile, appointments = [], currentMedications = null, currentMedicationSnapshot = null,
  medicationHistory = [], healthReports = [], standaloneVitals = [], medications = [], fromDate, toDate }) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(FONT_REGULAR) || !fs.existsSync(FONT_BOLD)) {
      return reject(new Error('ไม่พบไฟล์ฟอนต์ภาษาไทย กรุณาตรวจสอบ backend/assets/fonts/'));
    }

    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    doc.registerFont('regular', FONT_REGULAR);
    doc.registerFont('bold', FONT_BOLD);

    const bodyText = (text, options = {}) => doc.font('regular').fontSize(11).fillColor('#000')
      .text(text, { lineGap: 4, ...options });
    const sectionTitle = (text) => {
      doc.moveDown(0.9);
      doc.font('bold').fontSize(13.5).fillColor(NAVY).text(text, { lineGap: 3 });
      const y = doc.y + 3;
      doc.moveTo(48, y).lineTo(doc.page.width - 48, y).lineWidth(0.7).strokeColor(LIGHT_LINE).stroke();
      doc.y = y + 9;
    };

    // ── หัวเอกสาร ──
    doc.font('bold').fontSize(20).fillColor(NAVY).text('พี่หมอ - สรุปประวัติสุขภาพ', { align: 'left', lineGap: 4 });
    doc.moveDown(0.55);
    doc.font('bold').fontSize(15).fillColor('#000').text(profile.patient_name || 'ไม่ระบุชื่อ', { lineGap: 3 });
    if (fromDate || toDate) {
      doc.font('regular').fontSize(10).fillColor(GRAY)
        .text(`ช่วงวันที่: ${fromDate ? formatThaiDate(fromDate) : 'เริ่มต้น'} - ${toDate ? formatThaiDate(toDate) : 'ปัจจุบัน'}`, { lineGap: 3 });
    }

    // ── ข้อมูลสุขภาพพื้นฐาน ──
    sectionTitle('ข้อมูลพื้นฐาน');
    const basics = [
      `กรุ๊ปเลือด: ${profile.blood_type || 'ไม่ทราบ'}`,
      `ส่วนสูง: ${profile.height_cm ? profile.height_cm + ' ซม.' : 'ไม่ระบุ'}`,
      `น้ำหนัก: ${profile.weight_kg ? profile.weight_kg + ' กก.' : 'ไม่ระบุ'}`,
    ];
    bodyText(basics.join('   |   '));
    if (profile.chronic_conditions?.length) {
      bodyText(`โรคประจำตัว: ${profile.chronic_conditions.join(', ')}`);
    }
    if (profile.drug_allergies) bodyText(`แพ้ยา: ${profile.drug_allergies}`);
    if (profile.food_allergies) bodyText(`แพ้อาหาร: ${profile.food_allergies}`);
    if (profile.mobility_limitations) bodyText(`ข้อจำกัดการเคลื่อนไหว: ${profile.mobility_limitations}`);
    if (profile.emergency_contact_name || profile.emergency_contact_phone) {
      bodyText(`ผู้ติดต่อฉุกเฉิน: ${profile.emergency_contact_name || '-'} ${profile.emergency_contact_phone || ''}`.trim());
    }

    // ── ตารางนัดหมาย ──
    sectionTitle('ประวัตินัดหมาย');
    if (appointments.length === 0) {
      doc.font('regular').fontSize(11).fillColor(GRAY).text('ไม่มีข้อมูลนัดหมายในช่วงที่เลือก');
    } else {
      appointments.forEach((a, i) => {
        doc.font('bold').fontSize(11).fillColor('#000').text(`${i + 1}. ${a.hospital}`, { lineGap: 4 });
        const cancelled = a.status === 'cancelled' ? ' [ยกเลิก]' : '';
        doc.font('regular').fontSize(10).fillColor(GRAY).text(`   ${formatThaiDate(a.datetime)}${cancelled}${a.note ? ' - ' + a.note : ''}`, { lineGap: 4 });
        doc.moveDown(0.45);
      });
    }
    // ── รายการยาปัจจุบัน (ไม่ถูกตัดตามช่วงประวัติ) ──
    const authoritativeMedications = currentMedications || medications;
    sectionTitle('รายการยาปัจจุบัน');
    if (authoritativeMedications.length === 0) {
      doc.font('regular').fontSize(11).fillColor(GRAY).text('ยังไม่มีรายการยาปัจจุบัน');
    } else {
      authoritativeMedications.forEach((m, i) => {
        const useConditionLabel=MEDICATION_USE_CONDITION_LABELS[m.useCondition] || '';
        const periods=(Array.isArray(m.dayPeriods)?m.dayPeriods:[]).map((value)=>MEDICATION_PERIOD_LABELS[value]).filter(Boolean).join(' / ');
        const detail = [m.strength, m.indication ? `ข้อบ่งใช้ ${m.indication}` : '',
          m.dose ? `ครั้งละ ${m.dose}${m.unit ? ` ${m.unit}` : ''}` : '',
          m.frequency, periods, useConditionLabel, m.timing ? `เวลาเดิม ${m.timing}` : '', m.instruction,
          m.amount ? `จำนวนที่ได้รับทั้งหมด ${m.amount}` : '', m.route,
          m.notes ? `หมายเหตุเพิ่มเติม ${m.notes}` : '',
          m.condition ? `ข้อมูลเดิม (ข้อบ่งใช้ / หมายเหตุ) ${m.condition}` : '',
          currentMedicationSnapshot?.recordedAt ? `อัปเดต ${formatThaiDate(currentMedicationSnapshot.recordedAt)}` : '']
          .filter(Boolean).join(' | ');
        doc.font('bold').fontSize(11).fillColor('#000').text(`${i + 1}. ${m.name}`, { lineGap: 4 });
        doc.font('regular').fontSize(9.5).fillColor(GRAY).text(`   ${detail || 'ไม่มีรายละเอียดเพิ่มเติม'}`, { lineGap: 4 });
        doc.moveDown(0.45);
      });
    }

    sectionTitle('ประวัติการเปลี่ยนยา');
    if (!medicationHistory.length) doc.font('regular').fontSize(11).fillColor(GRAY).text('ไม่มีการเปลี่ยนแปลงยาในช่วงที่เลือก');
    else medicationHistory.forEach((entry) => {
      const when=entry.snapshot?.recordedAt ? formatThaiDate(entry.snapshot.recordedAt) : 'ไม่ทราบเวลา';
      doc.font('bold').fontSize(10.5).fillColor('#000').text(`${when} · ${entry.sourceLabel || 'ข้อมูลในระบบ'}`);
      if (entry.kind === 'legacy_snapshot') {
        bodyText(`รายการยาที่บันทึกครั้งนั้น: ${(entry.medications || []).map((item) => `${item.name} ${item.strength || ''}`).join(', ') || '-'}`);
      } else {
        const labels={added:'เพิ่มยา',removed:'นำออกจากรายการยาปัจจุบัน',strength_changed:'ปรับขนาดยา',dose_changed:'ปรับปริมาณ',instruction_changed:'ปรับวิธีใช้',multiple_fields_changed:'ปรับข้อมูลหลายช่อง'};
        const fieldLabels={strength:'ความแรงของยา',dose:'ครั้งละ',instruction:'คำสั่งใช้ยาตามฉลาก',amount:'จำนวนที่ได้รับทั้งหมด',unit:'หน่วย',frequency:'ใช้วันละ',timing:'เวลาใช้ยาเดิม',route:'ทางใช้ยา',condition:'ข้อบ่งใช้ / หมายเหตุเดิม',indication:'ข้อบ่งใช้ยา',useCondition:'เงื่อนไขการใช้ยา',dayPeriods:'ช่วงเวลาที่ใช้ยา',notes:'หมายเหตุเพิ่มเติม'};
        for (const change of entry.changes || []) {
          const name=change.current?.name || change.previous?.name || 'ยา';
          const changedFields=(change.changedFields || []).filter((field)=>fieldLabels[field]);
          const details=changedFields.map((field)=>`${fieldLabels[field]}: ${medicationHistoryValue(field,change.previous?.[field])} → ${medicationHistoryValue(field,change.current?.[field])}`);
          if(!details.length&&['added','removed'].includes(change.category)){
            const factual=change.current || change.previous || {};
            const values=[factual.strength,factual.dose,factual.instruction,
              factual.amount&&factual.unit?`${factual.amount} ${factual.unit}`:null,
              factual.frequency,(factual.dayPeriods||[]).join('/'),factual.useCondition,factual.timing,
              factual.route,factual.indication,factual.notes,factual.condition].filter(Boolean);
            if(values.length)details.push(values.join(' | '));
          }
          bodyText(`• ${name} — ${labels[change.category] || 'มีการเปลี่ยนแปลง'}${details.length ? ` (${details.join(' | ')})` : ''}`);
        }
      }
      doc.moveDown(0.35);
    });

    const vitalText = (observations = []) => {
      const labels={temperature:'อุณหภูมิ',blood_pressure_systolic:'ความดันตัวบน',blood_pressure_diastolic:'ความดันตัวล่าง',pulse:'ชีพจร',spo2:'ออกซิเจน'};
      return observations.map((item) => `${labels[item.measurement_type || item.measurementType] || item.measurement_type || item.measurementType}: ${item.numeric_value ?? item.numericValue} ${item.canonical_unit || item.canonicalUnit || ''}`).join(' | ');
    };

    sectionTitle('รายงานสุขภาพ');
    if (!healthReports.length) doc.font('regular').fontSize(11).fillColor(GRAY).text('ไม่มีรายงานสุขภาพที่ยืนยันแล้วในช่วงที่เลือก');
    else healthReports.forEach((report) => {
      doc.font('bold').fontSize(10.5).fillColor('#000').text(formatThaiDate(report.occurred_at || report.finalized_at));
      const notes=(report.items || []).map((item) => item.source_value_text || item.text_value || item.value_text || '').filter(Boolean);
      if(notes.length)bodyText(notes.join(' / '));
      for(const set of report.vital_signs || []){const text=vitalText(set.observations || []);if(text)bodyText(text)}
      doc.moveDown(0.35);
    });

    sectionTitle('ประวัติสัญญาณชีพเดิม');
    if (!standaloneVitals.length) doc.font('regular').fontSize(11).fillColor(GRAY).text('ไม่มีสัญญาณชีพแบบเดี่ยวในช่วงที่เลือก');
    else standaloneVitals.forEach((set) => {
      doc.font('bold').fontSize(10.5).fillColor('#000').text(formatThaiDate(set.occurred_at));
      bodyText(vitalText(set.observations || []));doc.moveDown(0.35);
    });

    // ── ท้ายเอกสาร ──
    doc.moveDown(1.2);
    doc.font('regular').fontSize(9).fillColor(GRAY)
      .text(`สร้างโดยพี่หมอ เมื่อ ${formatThaiDate(new Date().toISOString())}`, { align: 'left', lineGap: 3 });
    doc.text('เอกสารนี้สรุปจากข้อมูลที่ครอบครัวและศูนย์ดูแลบันทึกไว้ กรุณาให้แพทย์ผู้ตรวจเป็นผู้วินิจฉัยขั้นสุดท้าย', { lineGap: 3 });

    doc.end();
  });
}

module.exports = { generateHistoryPdf };
