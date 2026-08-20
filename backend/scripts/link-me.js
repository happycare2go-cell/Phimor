require('dotenv').config();
const { CenterStaff } = require('../db');

async function run() {
  // ค้นหาพนักงานที่เป็น owner/manager คนแรก หรือระบุ LINE ID ของคุณโอลงไปตรงๆ
  const staff = await CenterStaff.findWhere(s => s.role === 'owner' || s.role === 'manager');
  if (staff.length === 0) {
    console.log('❌ ยังไม่พบข้อมูล Owner/Manager ในระบบ กรุณาส่งสติ๊กเกอร์เข้ากลุ่มไลน์ก่อนครับ');
    return;
  }
  const myLineId = staff[0].line_user_id;
  console.log(`👤 พบ LINE ID ของผู้จัดการแล้ว: ${myLineId}`);

  // ดึงรายการ Rich Menu ทั้งหมดที่สร้างไว้
  const res = await fetch('https://api.line.me/v2/bot/richmenu/list', {
    headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
  });
  const data = await res.json();

  // คหาเมนูของ Admin (ที่เราตั้งชื่อหรือดูจาก size/areas)
  const adminMenu = data.richmenus.find(m => m.name === 'Phimor-Admin-Menu');
  if (!adminMenu) {
    console.log('❌ ไม่พบเมนู Admin ในระบบ กรุณารัน setup-rich-menus.js ก่อนครับ');
    return;
  }

  // สั่งผูกเมนู Admin เข้ากับ LINE ID ของคุณโอทันที
  const linkRes = await fetch(`https://api.line.me/v2/bot/user/${myLineId}/richmenu/${adminMenu.richMenuId}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${process.env.LINE_CHANNEL_ACCESS_TOKEN}` }
  });

  if (linkRes.ok) {
    console.log('🎉 สำเร็จ! ผูก Admin Rich Menu ให้คุณโอเรียบร้อยแล้ว เปิด LINE ดูได้เลย!');
  } else {
    const err = await linkRes.text();
    console.log('❌ ผูกเมนูไม่สำเร็จ:', err);
  }
}

run();
