# แผนดำเนินงานพี่หมอ 5 ระยะ

เอกสารนี้อธิบายขอบเขตที่ทำใน release candidate ชุดนี้และลำดับนำขึ้นระบบจริง โดยการ deploy และการทดสอบกับบัญชี LINE จริงยังต้องทำใน staging ก่อน production

## ระยะ 1 — ฐานข้อมูลและความถูกต้องของข้อมูล

- ใช้ UUID เต็ม ป้องกันรหัสชนกันเมื่อข้อมูลเพิ่มขึ้น
- เพิ่ม transaction และ lock สำหรับงานที่อาจถูกกดพร้อมกัน
- กัน Resident/Care Profile/สิทธิ์ข้ามศูนย์ที่ service layer
- เพิ่ม lifecycle ให้คำเชิญ คำขอเชื่อมต่อ พนักงาน และการจำหน่ายผู้พัก
- เพิ่มตาราง outbox, webhook inbox, pending family delivery และ data-subject request

เกณฑ์ผ่าน: สำรองฐานข้อมูลก่อน deploy, ตั้ง `DATABASE_URL`, เปิด `/ready` แล้วได้ HTTP 200 และทดสอบ rollback ใน staging

## ระยะ 2 — สิทธิ์และกระบวนการคน

- สมาชิกใหม่จากกลุ่มพนักงานอยู่สถานะรออนุมัติ เจ้าของ/ผู้จัดการจึงอนุมัติได้
- เมื่อออกจากกลุ่ม งาน reconcile จะเพิกถอนสิทธิ์พนักงานอัตโนมัติ
- เจ้าของหนึ่งคนดูแลหลายสาขาและสลับสาขาได้
- เจ้าของโอนสิทธิ์เจ้าของสาขาได้ ส่วนผู้จัดการถูกถอดหรือเปลี่ยนสิทธิ์ได้
- ญาติหลักเชิญ/เพิกถอนผู้ดูแลร่วม และกำหนดสิทธิ์ดู แก้ไข หรือเลือกการเดินทางได้

เกณฑ์ผ่าน: ทดสอบ join/leave/approve/revoke/transfer ด้วย LINE user จริงอย่างน้อยสองบัญชีและสองสาขา

## ระยะ 3 — Care Profile นัด ยา และการเดินทาง

- Resident ของศูนย์และ Care Profile ของครอบครัวเป็นข้อมูลคนเดียวกันหลังยืนยันการเชื่อม
- เก็บข้อมูลสุขภาพ รายการยาและภาพเป็นประวัติแบบ snapshot
- ข้อมูลจาก AI เป็น draft ต้องให้เจ้าของ/ผู้จัดการยืนยัน แก้ไข หรือยกเลิกก่อนใช้เตือน
- นัดเตือนครอบครัวและศูนย์ตามผู้รับที่ผูกจริง พร้อมคิวกรณียังไม่ผูก Family LIFF
- ญาติเลือก `ไปเอง` หรือ `ให้ศูนย์จัดการ`; ปุ่ม Care2Go โดยตรงซ่อนไว้ใน Family LIFF
- คำขอ Care2Go จะเปลี่ยนสถานะได้เมื่อผูกกลุ่มปฏิบัติการแล้วเท่านั้น

เกณฑ์ผ่าน: ทดสอบนัดจากศูนย์และญาติ ตั้งแต่ upload → confirm → reminder → edit/cancel → transport ด้วยข้อมูลจำลอง

## ระยะ 4 — แพ็กเกจและหน้าผู้ดูแลระบบ

- ศูนย์ใหม่ใน production ถูกล็อกจนกว่า Admin กำหนดวันเริ่มและวันหมดอายุ
- Admin เลือกแพ็กเกจรายเดือน รายปี หรือกำหนดเอง และแก้ช่วงเวลาได้แบบ manual
- ระบบแจ้งเจ้าของก่อนหมดอายุ 3 วันแบบไม่ส่งซ้ำ
- เมื่อ Admin ขยายเวลา ระบบส่ง LINE แจ้งวันหมดอายุใหม่ให้เจ้าของ
- หน้า `/system-admin/index.html` แสดงทุกสาขา ทีมงาน จำนวนผู้พัก สถานะแพ็กเกจ และ Care Profile
- การเปิดดู Care Profile โดย Admin ถูกบันทึก audit log

API หลัก:

- `GET /api/admin/centers`
- `GET /api/admin/centers/:centerId`
- `PATCH /api/admin/centers/:centerId/subscription`
- `GET /api/admin/centers/:centerId/care-profiles`
- `GET /api/admin/audit`

เกณฑ์ผ่าน: ตั้งแพ็กเกจสาขาทดสอบให้หมดใน 3 วัน ตรวจ LINE จริงหนึ่งครั้ง จากนั้นขยายเวลาและตรวจข้อความยืนยัน

## ระยะ 5 — ความทนทาน ความปลอดภัย และการเปิดใช้จริง

- Notification outbox และ webhook inbox retry อัตโนมัติ ลดเหตุการณ์ LINE ล่มแล้วข้อมูลหาย
- Webhook มี idempotency ป้องกันประมวลผลซ้ำ
- `/health` ใช้ตรวจ process และ `/ready` ตรวจฐานข้อมูล/Environment/คิว
- CORS allowlist, security headers, API rate limit และ constant-time admin key comparison
- ล้างภาพเอกสารต้นฉบับตาม retention policy โดยยังเก็บข้อมูลที่ผู้ใช้ยืนยันแล้ว
- ชุดทดสอบอัตโนมัติ 159 เคสและ syntax check backend/LIFF

เกณฑ์ผ่าน: ทดสอบ backup/restore, LINE retry, webhook ซ้ำ, package expiry, load test และ incident rollback ใน staging ก่อนเปิด production

## ลำดับ Deploy ที่แนะนำ

1. สำรองฐานข้อมูล production และสร้าง staging จากสำเนา
2. ตั้ง Environment ตาม `backend/.env.example` โดยเฉพาะ `DATABASE_URL`, LINE/LIFF IDs และ `ADMIN_API_KEY`
3. Deploy backend แล้วตรวจ `GET /health` และ `GET /ready`
4. Deploy `liff-app` และตั้ง LIFF Endpoint ให้ตรง `/register`, `/center-admin/index.html`, `/family/index.html`
5. เปิด `/system-admin/index.html` ใส่ Admin API Key และกำหนดแพ็กเกจให้ทุกสาขาก่อนบังคับใช้
6. ทดสอบ LINE จริงตามเกณฑ์ของแต่ละระยะ แล้วจึงเปิด production

## ข้อควรระวัง

- `ADMIN_API_KEY` ใน release นี้เป็น shared secret สำหรับผู้ดูแลระบบ จึงต้องส่งให้เฉพาะผู้ได้รับอนุญาตและควรเปลี่ยนเป็นระบบ login/MFA ก่อนมี Admin หลายคน
- ศูนย์เดิมที่ไม่มี `subscription_required=true` ถูกมองเป็น legacy และยังใช้ได้ เพื่อป้องกันระบบปัจจุบันดับทันที ควรให้ Admin กำหนดวันทุกสาขาแล้วจึงเปิดบังคับแพ็กเกจ
- อย่าใช้ `npm audit fix --force` บน production โดยไม่ทดสอบ เพราะอาจอัปเกรด dependency แบบ breaking change
- การดู Care Profile โดย Admin เป็นข้อมูลสุขภาพ ต้องมีนโยบาย PDPA, จำกัดผู้ใช้จริง และทบทวน audit log เป็นระยะ
