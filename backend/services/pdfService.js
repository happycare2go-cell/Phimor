// services/pdfService.js — สร้างไฟล์ PDF จริงสำหรับส่งออกประวัติ (FR-H4)
// ใช้ pdfkit พร้อม Font ไทย (Loma) ฝังไว้ในโปรเจกต์เอง เพื่อให้ Deploy ที่ไหนก็แสดงภาษาไทยได้แน่นอน
// ไม่ต้องพึ่ง Font ที่ติดตั้งไว้ในเครื่อง Server

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const { formatThaiDateTime } = require('../utils/thaiDate');

const FONT_REGULAR = path.join(__dirname, '../assets/fonts/Loma.otf');
const FONT_BOLD = path.join(__dirname, '../assets/fonts/Loma-Bold.otf');

const NAVY = '#1C2B64';
const GRAY = '#5A6580';

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

    // ── หัวเอกสาร ──
    doc.font('bold').fontSize(20).fillColor(NAVY).text('พี่หมอ — สรุปประวัติสุขภาพ', { align: 'left' });
    doc.moveDown(0.3);
    doc.font('bold').fontSize(15).fillColor('#000').text(profile.patient_name || 'ไม่ระบุชื่อ');
    if (fromDate || toDate) {
      doc.font('regular').fontSize(10).fillColor(GRAY)
        .text(`ช่วงวันที่: ${fromDate ? formatThaiDate(fromDate) : 'เริ่มต้น'} — ${toDate ? formatThaiDate(toDate) : 'ปัจจุบัน'}`);
    }
    doc.moveDown(1);

    // ── ข้อมูลสุขภาพพื้นฐาน ──
    doc.font('bold').fontSize(13).fillColor(NAVY).text('ข้อมูลพื้นฐาน');
    doc.moveDown(0.3);
    doc.font('regular').fontSize(11).fillColor('#000');
    const basics = [
      `กรุ๊ปเลือด: ${profile.blood_type || 'ไม่ทราบ'}`,
      `ส่วนสูง: ${profile.height_cm ? profile.height_cm + ' ซม.' : 'ไม่ระบุ'}`,
      `น้ำหนัก: ${profile.weight_kg ? profile.weight_kg + ' กก.' : 'ไม่ระบุ'}`,
    ];
    doc.text(basics.join('   |   '));
    if (profile.chronic_conditions?.length) {
      doc.text(`โรคประจำตัว: ${profile.chronic_conditions.join(', ')}`);
    }
    doc.moveDown(1);

    // ── ตารางนัดหมาย ──
    doc.font('bold').fontSize(13).fillColor(NAVY).text('ประวัตินัดหมาย');
    doc.moveDown(0.3);
    if (appointments.length === 0) {
      doc.font('regular').fontSize(11).fillColor(GRAY).text('ไม่มีข้อมูลนัดหมายในช่วงที่เลือก');
    } else {
      appointments.forEach((a, i) => {
        doc.font('bold').fontSize(11).fillColor('#000').text(`${i + 1}. ${a.hospital}`);
        doc.font('regular').fontSize(10).fillColor(GRAY).text(`   ${formatThaiDate(a.datetime)}${a.note ? '  ·  ' + a.note : ''}`);
        doc.moveDown(0.2);
      });
    }
    doc.moveDown(0.8);

    // ── รายการยา ──
    doc.font('bold').fontSize(13).fillColor(NAVY).text('รายการยา');
    doc.moveDown(0.3);
    if (medications.length === 0) {
      doc.font('regular').fontSize(11).fillColor(GRAY).text('ไม่มีข้อมูลยาในช่วงที่เลือก');
    } else {
      medications.forEach((m, i) => {
        doc.font('regular').fontSize(11).fillColor('#000').text(`${i + 1}. ${m.name} — ${m.dose || 'ไม่ระบุวิธีใช้'}`);
      });
    }

    // ── ท้ายเอกสาร ──
    doc.moveDown(1.5);
    doc.font('regular').fontSize(9).fillColor(GRAY)
      .text(`สร้างโดยพี่หมอ เมื่อ ${formatThaiDate(new Date().toISOString())}`, { align: 'left' });
    doc.text('เอกสารนี้สรุปจากข้อมูลที่ครอบครัวและศูนย์ดูแลบันทึกไว้ กรุณาให้แพทย์ผู้ตรวจเป็นผู้วินิจฉัยขั้นสุดท้าย');

    doc.end();
  });
}

module.exports = { generateHistoryPdf };
