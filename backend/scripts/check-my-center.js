require('dotenv').config();
const { CenterStaff, Centers } = require('../db');

async function run() {
  // ดึงรายชื่อพนักงานทั้งหมดในระบบเพื่อดูว่ามี ID ของเราไหม
  const allStaff = await CenterStaff.findWhere(() => true);
  console.log(`📋 พบข้อมูลพนักงานในระบบทั้งหมด: ${allStaff.length} คน`);
  
  for (const staff of allStaff) {
    console.log(`- LINE ID: ${staff.line_user_id} | Center ID: ${staff.center_id} | Role: ${staff.role}`);
  }

  const allCenters = await Centers.findWhere(() => true);
  console.log(`\n🏢 พบข้อมูลศูนย์ทั้งหมด: ${allCenters.length} แห่ง`);
  for (const c of allCenters) {
    console.log(`- Center ID: ${c.center_id} | ชื่อศูนย์: ${c.name}`);
  }
}

run();
