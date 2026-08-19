#!/usr/bin/env node
// scripts/create-center.js
//
// เครื่องมือหลักสำหรับทีมงานสร้างบัญชีศูนย์ใหม่ (ตาม FR-A1: "ทีมงานสร้างบัญชีศูนย์")
// ออกแบบมาให้ใช้ระหว่างคุยกับเจ้าของศูนย์ตัวต่อตัวตอน Onboarding — ไม่ใช่ระบบสมัครเอง
//
// วิธีใช้:
//   cd backend
//   node scripts/create-center.js --name "ศูนย์สุขสบาย" --owner "U1234567890abcdef1234567890abcdef"
//
// LINE User ID ของเจ้าของ หาได้จาก: ให้เจ้าของศูนย์เพิ่มเพื่อน LINE OA ก่อน แล้วส่งข้อความอะไรมาสักอย่าง
// จากนั้นดู userId ใน Webhook Event ที่เข้ามา (Log ไว้ที่ Backend) หรือใช้ LINE Login ยืนยันตัวตนก็ได้

require('dotenv').config();
const centerService = require('../services/centerService');

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i]?.replace(/^--/, '');
    args[key] = argv[i + 1];
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (!args.name || !args.owner) {
    console.error('❌ ใช้งานไม่ถูกต้อง\n');
    console.error('วิธีใช้: node scripts/create-center.js --name "ชื่อศูนย์" --owner "LINE_USER_ID"\n');
    process.exit(1);
  }

  console.log(`กำลังสร้างศูนย์ "${args.name}"...\n`);

  const center = await centerService.createCenter({ name: args.name, ownerLineId: args.owner });

  console.log('✅ สร้างศูนย์สำเร็จ\n');
  console.log(`   Center ID  : ${center.center_id}`);
  console.log(`   ชื่อศูนย์   : ${center.name}`);
  console.log(`   เจ้าของ    : ${center.owner_line_id}\n`);
  console.log('ขั้นตอนถัดไป (ทำระหว่างสายกับเจ้าของศูนย์ได้เลย):');
  console.log('  ① ให้เจ้าของศูนย์เพิ่มเพื่อน LINE OA ของพี่หมอ (ถ้ายังไม่ได้เพิ่ม)');
  console.log('  ② ให้เจ้าของศูนย์สร้างกลุ่มไลน์งานศูนย์ แล้วเชิญพี่หมอเข้ากลุ่ม');
  console.log('     → ระบบจะผูกกลุ่มนี้เป็นกลุ่มงานศูนย์ให้อัตโนมัติทันที (ข้อ A2)');
  console.log('  ③ นำเข้ารายชื่อผู้พัก ผ่าน API POST /api/residents/import');
  console.log('     หรือให้เจ้าของศูนย์เพิ่มเองทีละคนผ่านหน้า LIFF จัดการผู้พัก\n');
}

main().catch((err) => {
  console.error('❌ สร้างศูนย์ไม่สำเร็จ:', err.message);
  process.exit(1);
});
