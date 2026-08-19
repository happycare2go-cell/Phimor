#!/usr/bin/env node
// scripts/setup-rich-menus.js
//
// รันครั้งเดียวตอน Deploy ครั้งแรก (หรือหลังแก้ไขดีไซน์เมนู) เพื่อสร้าง Rich Menu ทั้ง 2 ชุด
// ผ่าน LINE Messaging API และตั้งฝั่งครอบครัวเป็นเมนูเริ่มต้นให้ทุกคน
//
// วิธีใช้:  cd backend && node scripts/setup-rich-menus.js
//
// ⚠️ ก่อนรันต้องตั้งค่า LIFF_ID_CENTER_ADMIN และ LIFF_ID_FAMILY ใน .env ให้ครบก่อน
//    เพราะ URL ปุ่มในเมนูจะฝัง LIFF ID เหล่านี้เข้าไปตอนสร้าง ถ้าตั้งค่าทีหลัง ต้องลบเมนูเก่า
//    ออกจาก LINE Developers Console แล้วรัน Script นี้ใหม่ (ระบบเก็บ richMenuId ไว้ ไม่สร้างซ้ำอัตโนมัติ)

require('dotenv').config();
const richMenuService = require('../services/richMenuService');

async function main() {
  console.log('กำลังตั้งค่า Rich Menu...\n');

  if (!process.env.LIFF_ID_CENTER_ADMIN || !process.env.LIFF_ID_FAMILY) {
    console.warn('⚠️  ยังไม่ได้ตั้งค่า LIFF_ID_CENTER_ADMIN หรือ LIFF_ID_FAMILY ใน .env');
    console.warn('    ปุ่มในเมนูจะใช้ค่า placeholder ไปก่อน แก้ทีหลังต้องลบเมนูแล้วสร้างใหม่\n');
  }

  const { centerMenuId, familyMenuId } = await richMenuService.setupAllMenus();

  console.log('✅ สร้าง Rich Menu สำเร็จ');
  console.log(`   ฝั่งศูนย์      : ${centerMenuId}`);
  console.log(`   ฝั่งครอบครัว   : ${familyMenuId} (ตั้งเป็นเมนูเริ่มต้นแล้ว)\n`);
  console.log('ขั้นตอนต่อไป: เชื่อมเมนูฝั่งศูนย์ให้เจ้าของ/ผู้จัดการจะเกิดขึ้นอัตโนมัติ');
  console.log('เมื่อเรียก centerService.createCenter() หรือ appointManager() สำเร็จ');
}

main().catch((err) => {
  console.error('❌ ตั้งค่า Rich Menu ไม่สำเร็จ:', err.message);
  process.exit(1);
});
