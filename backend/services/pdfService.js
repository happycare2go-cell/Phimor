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

function formatThaiDate(iso) {
  return formatThaiDateTime(iso);
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
function generateHistoryPdf({ profile, appointments, medications, fromDate, toDate }) {
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
    // ── รายการยา ──
    sectionTitle('รายการยา');
    if (medications.length === 0) {
      doc.font('regular').fontSize(11).fillColor(GRAY).text('ไม่มีข้อมูลยาในช่วงที่เลือก');
    } else {
      medications.forEach((m, i) => {
        const date = m.created_at || m.recorded_at;
        const detail = [m.dose || 'ไม่ระบุวิธีใช้', m.condition ? `สำหรับ ${m.condition}` : '', date ? `บันทึก ${formatThaiDate(date)}` : '']
          .filter(Boolean).join(' | ');
        doc.font('bold').fontSize(11).fillColor('#000').text(`${i + 1}. ${m.name}`, { lineGap: 4 });
        doc.font('regular').fontSize(9.5).fillColor(GRAY).text(`   ${detail}`, { lineGap: 4 });
        doc.moveDown(0.45);
      });
    }

    // ── ท้ายเอกสาร ──
    doc.moveDown(1.2);
    doc.font('regular').fontSize(9).fillColor(GRAY)
      .text(`สร้างโดยพี่หมอ เมื่อ ${formatThaiDate(new Date().toISOString())}`, { align: 'left', lineGap: 3 });
    doc.text('เอกสารนี้สรุปจากข้อมูลที่ครอบครัวและศูนย์ดูแลบันทึกไว้ กรุณาให้แพทย์ผู้ตรวจเป็นผู้วินิจฉัยขั้นสุดท้าย', { lineGap: 3 });

    doc.end();
  });
}

module.exports = { generateHistoryPdf };
