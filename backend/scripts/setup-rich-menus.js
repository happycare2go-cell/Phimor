require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { CenterStaff, RichMenus, now } = require('../db');

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LIFF_ID_CENTER_ADMIN = process.env.LIFF_ID_CENTER_ADMIN;
const LIFF_ID_FAMILY = process.env.LIFF_ID_FAMILY;

const requiredEnv = { LINE_CHANNEL_ACCESS_TOKEN: CHANNEL_ACCESS_TOKEN, LIFF_ID_CENTER_ADMIN, LIFF_ID_FAMILY };
const missingEnv = Object.entries(requiredEnv).filter(([, value]) => !value).map(([key]) => key);
if (missingEnv.length > 0) {
  console.error(`❌ ไม่พบ Environment Variables: ${missingEnv.join(', ')}`);
  process.exit(1);
}

const FAMILY_IMAGE = path.join(__dirname, '../assets/richmenu/family.png');
const ADMIN_IMAGE = path.join(__dirname, '../assets/richmenu/center-admin.png');

async function callLineApi(endpoint, method = 'GET', body = null, isBinary = false) {
  const headers = { Authorization: `Bearer ${CHANNEL_ACCESS_TOKEN}` };
  if (isBinary) headers['Content-Type'] = 'image/png';
  else if (body) headers['Content-Type'] = 'application/json';

  const res = await fetch(endpoint, {
    method,
    headers,
    body: isBinary ? body : (body ? JSON.stringify(body) : null),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`LINE API [${res.status}] ${detail}`);
  }
  if (res.status === 204) return {};
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function createMenu(payload, imagePath) {
  if (!fs.existsSync(imagePath)) throw new Error(`ไม่พบไฟล์ภาพ Rich Menu: ${imagePath}`);
  const created = await callLineApi('https://api.line.me/v2/bot/richmenu', 'POST', payload);
  await callLineApi(
    `https://api-data.line.me/v2/bot/richmenu/${created.richMenuId}/content`,
    'POST', fs.readFileSync(imagePath), true,
  );
  return created.richMenuId;
}

async function replaceStoredMenu(key, richMenuId) {
  await RichMenus.remove((menu) => menu.key === key);
  await RichMenus.insert({ key, rich_menu_id: richMenuId, created_at: now() });
}

async function removeOldPhimorMenus() {
  const existing = await callLineApi('https://api.line.me/v2/bot/richmenu/list');
  const oldMenus = (existing.richmenus || []).filter((menu) =>
    String(menu.name || '').toLowerCase().startsWith('phimor-')
  );
  for (const menu of oldMenus) {
    await callLineApi(`https://api.line.me/v2/bot/richmenu/${menu.richMenuId}`, 'DELETE');
  }
  console.log(`🧹 ลบ Rich Menu เก่าของ Phimor ${oldMenus.length} รายการ`);
}

async function linkAdminMenuToStaff(adminMenuId) {
  const staff = await CenterStaff.findWhere((row) =>
    ['owner', 'manager'].includes(row.role) && Boolean(row.line_user_id)
  );
  const userIds = [...new Set(staff.map((row) => String(row.line_user_id).trim()))];
  let linkedCount = 0;
  let skippedCount = 0;
  for (const userId of userIds) {
    if (!/^U[0-9a-f]{32}$/i.test(userId)) {
      console.warn(`⚠️ ข้าม LINE userId ที่รูปแบบไม่ถูกต้อง: ${userId}`);
      skippedCount += 1;
      continue;
    }
    try {
      await callLineApi(
        `https://api.line.me/v2/bot/user/${encodeURIComponent(userId)}/richmenu/${adminMenuId}`,
        'POST',
      );
      linkedCount += 1;
    } catch (err) {
      console.warn(`⚠️ ผูก Rich Menu ให้ ${userId} ไม่สำเร็จ: ${err.message}`);
      skippedCount += 1;
    }
  }
  return { linkedCount, skippedCount };
}

async function run() {
  console.log('🚀 กำลังติดตั้ง Rich Menu จากไฟล์ภาพจริง...');
  await removeOldPhimorMenus();

  const familyMenuId = await createMenu({
    size: { width: 2500, height: 1686 }, selected: true,
    name: 'Phimor-Family-Menu', chatBarText: 'เมนูพี่หมอ',
    areas: [
      { bounds: { x: 0, y: 0, width: 1250, height: 843 },
        action: { type: 'uri', label: 'หน้าหลัก', uri: `https://liff.line.me/${LIFF_ID_FAMILY}` } },
      { bounds: { x: 1250, y: 0, width: 1250, height: 843 },
        action: { type: 'uri', label: 'บันทึกนัด/ยา', uri: `https://liff.line.me/${LIFF_ID_FAMILY}?view=record` } },
      { bounds: { x: 0, y: 843, width: 1250, height: 843 },
        action: { type: 'uri', label: 'ดูประวัติ', uri: `https://liff.line.me/${LIFF_ID_FAMILY}?view=history` } },
      { bounds: { x: 1250, y: 843, width: 1250, height: 843 },
        action: { type: 'message', label: 'ติดต่อ Admin', text: 'ติดต่อ Admin' } },
    ],
  }, FAMILY_IMAGE);
  await callLineApi(`https://api.line.me/v2/bot/user/all/richmenu/${familyMenuId}`, 'POST');
  await replaceStoredMenu('family', familyMenuId);

  const adminMenuId = await createMenu({
    size: { width: 2500, height: 1686 }, selected: true,
    name: 'Phimor-Admin-Menu', chatBarText: 'เมนูผู้จัดการศูนย์',
    areas: [
      { bounds: { x: 0, y: 0, width: 833, height: 1686 },
        action: { type: 'uri', label: 'จัดการผู้พัก', uri: `https://liff.line.me/${LIFF_ID_CENTER_ADMIN}?view=residents&v=2` } },
      { bounds: { x: 833, y: 0, width: 834, height: 1686 },
        action: { type: 'uri', label: 'รอดำเนินการ', uri: `https://liff.line.me/${LIFF_ID_CENTER_ADMIN}?view=transport&v=2` } },
      { bounds: { x: 1667, y: 0, width: 833, height: 1686 },
        action: { type: 'message', label: 'ติดต่อทีมงาน', text: 'ติดต่อทีมงานพี่หมอ' } },
    ],
  }, ADMIN_IMAGE);
  await replaceStoredMenu('center_admin', adminMenuId);
  const { linkedCount, skippedCount } = await linkAdminMenuToStaff(adminMenuId);

  console.log('✅ ติดตั้ง Rich Menu สำเร็จ');
  console.log(`- Family (default): ${familyMenuId}`);
  console.log(`- Center admin: ${adminMenuId}`);
  console.log(`- ผูกเมนูศูนย์ให้ owner/manager: ${linkedCount} คน`);
  if (skippedCount > 0) console.log(`- ข้าม userId ที่ไม่ถูกต้อง/ผูกไม่สำเร็จ: ${skippedCount} คน`);
}

run().catch((err) => {
  console.error('❌ ติดตั้ง Rich Menu ไม่สำเร็จ:', err.message);
  process.exitCode = 1;
});
