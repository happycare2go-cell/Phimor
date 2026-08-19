// services/richMenuService.js — จัดการ Rich Menu 2 ชุด (ฝั่งศูนย์ / ฝั่งครอบครัว) และเชื่อมให้ผู้ใช้อัตโนมัติ
//
// หลักการ (อ้างอิงจาก LINE Developers — Use per-user rich menus):
// - Rich Menu แบบเจาะจงต่อผู้ใช้ มีลำดับความสำคัญสูงกว่าเมนูเริ่มต้นเสมอ
// - เชื่อมเมนูให้คนที่ยังไม่ได้เป็นเพื่อนกับ OA ไม่ได้ (ต้องเรียกหลังผู้ใช้ทักบอทแล้วเท่านั้น)
// - เมนูฝั่งครอบครัวตั้งเป็น "เมนูเริ่มต้น" เพราะมีผู้ใช้จำนวนมากกว่ามาก
//   ส่วนเมนูฝั่งศูนย์ใช้วิธีเชื่อมเฉพาะบุคคล เพราะมีจำนวนน้อยและระบุตัวได้ชัดเจน
//
// ⚠️ งานนี้ไม่ได้ "จำเป็นต้องมี" ในเฟส 1 — เจ้าของ/ผู้จัดการศูนย์มีจำนวนน้อยมาก (8-40 คน)
//    และทีมงานลงมือ Setup ให้ทุกศูนย์อยู่แล้ว จะรันคำสั่งเชื่อมเมนูด้วยมือทีละคนก็ได้เช่นกัน
//    โค้ดชุดนี้แค่ลดขั้นตอนหนึ่งจาก Onboarding ที่ทำอยู่แล้ว ไม่ใช่ฟีเจอร์ที่ขาดไม่ได้

const fs = require('fs');
const path = require('path');
const { RichMenus, audit } = require('../db');
const lineClient = require('../providers/lineClient');

const CENTER_ADMIN_KEY = 'center_admin';
const FAMILY_KEY = 'family';

const MENU_DEFS = {
  [CENTER_ADMIN_KEY]: {
    imagePath: path.join(__dirname, '../assets/richmenu/center-admin.png'),
    object: {
      size: { width: 2500, height: 1686 },
      selected: false,
      name: 'phimor-center-admin',
      chatBarText: 'เมนูศูนย์',
      areas: [
        { bounds: { x: 0, y: 0, width: 833, height: 1686 },
          action: { type: 'uri', label: 'จัดการผู้พัก', uri: `https://liff.line.me/${process.env.LIFF_ID_CENTER_ADMIN || 'YOUR_LIFF_ID'}` } },
        { bounds: { x: 833, y: 0, width: 834, height: 1686 },
          action: { type: 'uri', label: 'รอดำเนินการ', uri: `https://liff.line.me/${process.env.LIFF_ID_CENTER_ADMIN || 'YOUR_LIFF_ID'}?view=transport` } },
        { bounds: { x: 1667, y: 0, width: 833, height: 1686 },
          action: { type: 'message', label: 'ติดต่อทีมงาน', text: 'ติดต่อทีมงานพี่หมอ' } },
      ],
    },
  },
  [FAMILY_KEY]: {
    imagePath: path.join(__dirname, '../assets/richmenu/family.png'),
    object: {
      size: { width: 2500, height: 1686 },
      selected: true, // เมนูนี้เป็นค่าเริ่มต้น ให้แสดงแบบเปิดอยู่ตั้งแต่แรก
      name: 'phimor-family',
      chatBarText: 'เมนูพี่หมอ',
      areas: [
        { bounds: { x: 0, y: 0, width: 1250, height: 843 },
          action: { type: 'uri', label: 'หน้าหลัก', uri: `https://liff.line.me/${process.env.LIFF_ID_FAMILY || 'YOUR_LIFF_ID'}` } },
        { bounds: { x: 1250, y: 0, width: 1250, height: 843 },
          action: { type: 'uri', label: 'บันทึกนัด/ยา', uri: `https://liff.line.me/${process.env.LIFF_ID_FAMILY || 'YOUR_LIFF_ID'}?view=record` } },
        { bounds: { x: 0, y: 843, width: 1250, height: 843 },
          action: { type: 'uri', label: 'ดูประวัติ', uri: `https://liff.line.me/${process.env.LIFF_ID_FAMILY || 'YOUR_LIFF_ID'}?view=history` } },
        { bounds: { x: 1250, y: 843, width: 1250, height: 843 },
          action: { type: 'message', label: 'ติดต่อ Admin', text: 'ติดต่อ Admin' } },
      ],
    },
  },
};

/** สร้าง Rich Menu ถ้ายังไม่เคยสร้าง (Idempotent — เรียกซ้ำได้ไม่สร้างซ้ำ) คืน richMenuId */
async function ensureMenu(key) {
  const existing = await RichMenus.findOne((m) => m.key === key);
  if (existing) return existing.rich_menu_id;

  const def = MENU_DEFS[key];
  if (!def) throw new Error(`ไม่รู้จัก Rich Menu key: ${key}`);

  const { richMenuId } = await lineClient.createRichMenu(def.object);
  const imageBuffer = fs.existsSync(def.imagePath) ? fs.readFileSync(def.imagePath) : Buffer.from('');
  await lineClient.uploadRichMenuImage(richMenuId, imageBuffer, 'image/png');

  await RichMenus.insert({ key, rich_menu_id: richMenuId, created_at: new Date().toISOString() });
  return richMenuId;
}

/** เรียกครั้งเดียวตอนติดตั้งระบบ (setup script) — สร้างเมนูทั้งสองชุด และตั้งเมนูครอบครัวเป็นค่าเริ่มต้น */
async function setupAllMenus() {
  const centerMenuId = await ensureMenu(CENTER_ADMIN_KEY);
  const familyMenuId = await ensureMenu(FAMILY_KEY);
  await lineClient.setDefaultRichMenu(familyMenuId); // ตั้งฝั่งครอบครัวเป็นค่าเริ่มต้น เพราะมีผู้ใช้มากกว่ามาก
  return { centerMenuId, familyMenuId };
}

/** เชื่อมเมนูฝั่งศูนย์ให้ผู้ใช้คนใดคนหนึ่ง — เรียกหลัง createCenter()/appointManager() สำเร็จ (ไม่บังคับ ดูหมายเหตุด้านบน) */
async function linkCenterMenuToUser(lineUserId) {
  const richMenuId = await ensureMenu(CENTER_ADMIN_KEY);
  await lineClient.linkRichMenuToUser(lineUserId, richMenuId);
  await audit('richmenu.linked', lineUserId, { menu: CENTER_ADMIN_KEY, richMenuId });
  return { ok: true, richMenuId };
}

/** เชื่อมเมนูฝั่งครอบครัวให้ผู้ใช้เจาะจง (ปกติไม่จำเป็นเพราะเป็นค่าเริ่มต้นอยู่แล้ว — มีไว้เผื่อกรณีเคยสลับไปเมนูอื่นมาก่อน) */
async function linkFamilyMenuToUser(lineUserId) {
  const richMenuId = await ensureMenu(FAMILY_KEY);
  await lineClient.linkRichMenuToUser(lineUserId, richMenuId);
  await audit('richmenu.linked', lineUserId, { menu: FAMILY_KEY, richMenuId });
  return { ok: true, richMenuId };
}

module.exports = {
  CENTER_ADMIN_KEY, FAMILY_KEY, MENU_DEFS,
  ensureMenu, setupAllMenus, linkCenterMenuToUser, linkFamilyMenuToUser,
};
