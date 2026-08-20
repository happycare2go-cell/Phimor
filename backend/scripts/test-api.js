require('dotenv').config();
const { CenterStaff, Centers } = require('../db');

async function run() {
  const myLineId = 'U72a407849d8459f2cbc85bfd0811642';
  
  // 1. ลองค้นหาพนักงานจาก LINE ID นี้
  const staffList = await CenterStaff.findWhere(s => s.line_user_id === myLineId);
  console.log('📌 ผลค้นหาพนักงาน:', staffList);

  if (staffList.length > 0) {
    const centerId = staffList[0].center_id;
    // 2. ค้นหาข้อมูลศูนย์จาก center_id ที่พบ
    const centerList = await Centers.findWhere(c => c.center_id === centerId);
    console.log('🏢 ผลค้นหาศูนย์:', centerList);
  } else {
    console.log('❌ ไม่พบพนักงานที่ผูกกับ LINE ID นี้ในฐานข้อมูล');
  }
}

run();
