require('dotenv').config();
const { CenterStaff, Centers } = require('../db');

async function run() {
  const targetCenterId = 'CTR-7906676e';
  const myLineId = 'U72a407849d8459f2cbc85bfd0811642';

  console.log('🧹 กำลังทำความสะอาดข้อมูลศูนย์และสิทธิ์พนักงาน...');

  // 1. เก็บเฉพาะศูนย์ที่ต้องการ ลบศูนย์ส่วนเกินอื่นๆ (ถ้ามี)
  const allCenters = await Centers.findWhere(() => true);
  for (const c of allCenters) {
    if (c.center_id !== targetCenterId) {
      await Centers.remove((item) => item.center_id === c.center_id);
      console.log(`🗑️ ลบศูนย์ส่วนเกิน: ${c.name} (${c.center_id})`);
    }
  }

  // 2. เคลียร์ตารางพนักงานให้ LINE ID ของคุณโอผูกกับ targetCenterId อันเดียวเท่านั้น
  const allStaff = await CenterStaff.findWhere(() => true);
  for (const s of allStaff) {
    if (s.line_user_id === myLineId) {
      await CenterStaff.remove((item) => item.center_id === s.center_id && item.line_user_id === s.line_user_id);
    }
  }

  // เพิ่มสิทธิ์ Owner ให้กับศูนย์หลักสาขาเดียว
  await CenterStaff.insert({
    center_id: targetCenterId,
    line_user_id: myLineId,
    role: 'owner',
    created_at: new Date().toISOString()
  });

  console.log(`✅ สำเร็จ! ล็อกให้ LINE ID ของคุณโอเป็น Owner ของศูนย์ ${targetCenterId} เรียบร้อยแล้ว`);
}

run();
