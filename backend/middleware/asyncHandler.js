// middleware/asyncHandler.js
//
// ⚠️ เหตุผลที่ต้องมีไฟล์นี้ (พบจาก Bug จริงระหว่างพัฒนา):
// Express 4.x ไม่ดักจับ Error ที่เกิดขึ้นภายใน async Route Handler โดยอัตโนมัติ
// ถ้า Error เกิดขึ้น (เช่น res.setHeader() พังเพราะใส่อักขระที่ไม่ใช่ ASCII) โดยไม่มี try-catch
// Promise จะ Reject เฉยๆ โดยไม่มีใครจัดการ → Express ไม่ส่ง Response กลับ → Client ค้างรอตลอดไป
// (ไม่ได้ 500 กลับมาเลย แม้แต่ error handler กลางใน server.js ก็ไม่ถูกเรียก)
//
// ทุก Route Handler แบบ async ในระบบนี้ต้องห่อด้วยฟังก์ชันนี้เสมอ

function asyncHandler(fn) {
  return function (req, res, next) {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

module.exports = { asyncHandler };
