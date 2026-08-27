# พี่หมอ (Phimor) — Backend + LINE LIFF

> อัปเดตสถานะปัจจุบัน 27 สิงหาคม 2026: ระบบใช้ PostgreSQL, LINE Messaging API/LIFF และ Gemini จริงแล้ว เนื้อหาที่กล่าวว่าเป็น Mock หรือ In-memory ในประวัติด้านล่างไม่ใช่สถานะปัจจุบัน

## ภาพรวมระบบปัจจุบัน

- มี LIFF สำหรับลงทะเบียนศูนย์, ศูนย์/บุคลากร, ครอบครัว, ผู้ดูแลระบบ และเภสัชกร (เมื่อเปิด Consultation)
- เจ้าของดูแลหลายสาขาได้ และบุคคลหนึ่งทำงานหลายสาขาได้ โดยสิทธิ์แยกต่อสาขา
- ไม่มี flow ให้เจ้าของลดสิทธิ์ตัวเองเป็นพนักงาน เพราะไม่ใช่งานปกติและเสี่ยงทำให้สาขาขาดเจ้าของ
- ผู้ถูกถอนสิทธิ์จะเข้าข้อมูลสาขาไม่ได้ทันที แต่ไปทำสาขาอื่นได้ หากกลับกลุ่มเดิมจะเป็น `pending` และต้องอนุมัติใหม่
- ศูนย์สร้าง Resident และ Care Profile แบบ `center_managed` ได้เองแม้ยังไม่มีญาติ จากนั้นส่งลิงก์ให้ญาติยอมรับ PDPA และรับความเป็นเจ้าของภายหลัง โดยข้อมูลสุขภาพเดิมไม่หาย
- ครอบครัวสร้าง Care Profile เอง เชิญผู้ดูแลร่วม บันทึกนัด/ยา และส่งออก PDF ได้
- เอกสารจาก LINE ผ่าน AI แต่เจ้าของ/ผู้จัดการต้องตรวจ แก้ และยืนยันก่อนบันทึก
- เมื่อเลือก Care2Go ระบบส่งรายละเอียดเข้ากลุ่ม Care2Go เท่านั้น เจ้าหน้าที่โทรประสานเอง ไม่มี flow รับงาน/จัดรถในระบบ
- System Admin จัดการสาขา/แพ็กเกจ, capability, integration, pending mapping และ LINE group reconciliation ผ่านหน้าปฏิบัติการที่จำกัดข้อมูล

## เริ่มต้นและทดสอบ

```bash
cd backend
npm install
npm test
npm start
```

ตรวจ `http://localhost:3000/health` และ `http://localhost:3000/ready` ก่อน deploy ทุกครั้ง ค่าที่ต้องตั้งดูใน `backend/.env.example` โดยเฉพาะฐานข้อมูล, LINE, LIFF ที่เปิดใช้, Gemini, `ADMIN_API_KEY`, `PUBLIC_BACKEND_URL` และ Consultation realtime secret

`CARE2GO_GROUP_BIND_CODE` ใช้เฉพาะผูกกลุ่มครั้งแรก หลังผูกแล้วข้อมูลอยู่ในฐานข้อมูล จึงไม่ควรเป็นตัวบังคับให้ `/health` ล้ม

## Deploy บน Render

1. Hold/ปิด Render Auto-Deploy และยืนยันว่าไม่มี deploy กำลังทำงาน
2. สำรอง PostgreSQL แล้วรัน `npm run migrate:status`; หยุดทันทีเมื่อ checksum ไม่ตรง
3. รัน `npm run migrate` และตรวจ status ซ้ำจนถึง migration ที่อนุมัติ
4. ตั้ง Environment/Secret ตาม `backend/.env.example` โดยห้ามใส่ secret ใน Git
5. Deploy backend แล้วตรวจ `/health`, `/ready`, scheduler และ queues
6. ตรวจ `/config/liff`, deploy LIFF แล้ว smoke-test ทุกบทบาทที่เปิดใช้

ขั้นตอนเต็มและความเสี่ยงของ legacy startup DDL อยู่ใน `docs/DEPLOY_RENDER.md` ห้าม deploy backend ที่ต้องใช้ schema ใหม่ก่อน migration เสร็จ

## ข้อจำกัดที่ต้องตรวจหลัง Deploy

- LINE ไม่มี API ค้นย้อนหลังว่าสมาชิกอยู่กลุ่มใด ระบบรู้จักพนักงานจาก event ในกลุ่มที่ผูกแล้ว
- Flex Message ที่ส่งแล้วคงอยู่ในแชท แต่ backend ตรวจสิทธิ์และอายุแพ็กเกจใหม่ทุกครั้ง จึงใช้การ์ดเก่าหลังถูกถอนสิทธิ์ไม่ได้
- Performance test ในโครงการไม่แทน load test ของ LINE, Gemini และ PostgreSQL จริง
- AI ต้องทดสอบกับเอกสารจริง โดยการตรวจยืนยันของเจ้าของ/ผู้จัดการยังเป็นขั้นตอนบังคับ

---

## เอกสารสถาปัตยกรรมเดิม (เก็บเป็นประวัติ)

โค้ดชุดนี้สร้างตาม `Phimor_System_Requirements.docx` และ `Phimor_Technical_Design.docx`
ครอบคลุมข้อกำหนดเดิม **FR-A ถึง FR-O** แต่ส่วนถัดจากหัวข้อนี้เป็นบันทึกโครงสร้างรุ่นแรก ไม่ใช่สถานะ deploy ปัจจุบัน
สถานะปัจจุบันใช้ PostgreSQL, LINE Messaging/LIFF และ provider AI ผ่าน configuration จริง โปรดใช้ `backend/.env.example`, `docs/DEPLOY_RENDER.md` และเอกสาร integration ปัจจุบันเป็นแหล่งอ้างอิง

---

## เริ่มต้นใช้งาน

```bash
cd backend
npm install
npm test          # รัน Test ทั้งหมด 136 เคส ต้องผ่านทุกตัวก่อนแก้โค้ดต่อ
npm start         # รันที่ http://localhost:3000
```

ทดสอบว่ารันสำเร็จ:
```bash
curl http://localhost:3000/health
# → {"status":"ok","service":"phimor-backend"}
```

---

## โครงสร้างโปรเจกต์

```
backend/
  server.js                    จุดเริ่มต้น รวม Route + Scheduler
  db.js                        PostgreSQL + legacy JSONB compatibility layer
  flexMessages.js              การ์ด LINE (S5)
  providers/
    aiProvider.js              Provider abstraction สำหรับ AI ที่กำหนดผ่าน Environment
    lineClient.js              LINE Messaging API client พร้อม test double
  middleware/
    auth.js                     Verify LINE ID Token; header ตรงเปิดได้เฉพาะ local/test
  utils/
    nameMatch.js                จับคู่ชื่อผู้พัก (FR-D) — พร้อมใช้งานจริง
  services/                     Business Logic ทั้งหมด — พร้อมใช้งานจริง
    centerService.js            FR-A, FR-B, FR-J
    cardService.js              FR-C, D, E, F (หัวใจของระบบ)
    familyService.js            FR-H, FR-N
    transportService.js         FR-K, L, M
    accessService.js            FR-O
    reminderService.js          FR-G, FR-I
  routes/                       Express Routes ตาม API Spec
    webhook.js  centers.js  cards.js  family.js  transport.js  access.js

liff-app/
  center-admin/index.html       หน้าจัดการศูนย์ (S1-S4)
  family/index.html             หน้าฝั่งครอบครัว (F1-F5)

tests/                          ชุดทดสอบ domain, route, security และ LIFF contracts
```

---

## ⚠️ ข้อเท็จจริงด้านความปลอดภัยก่อน Deploy จริง

### 1. AI Provider
ระบบเรียก provider ผ่าน abstraction และ structured validation แล้ว ต้องตั้ง Gemini/AI Environment ตาม `backend/.env.example`, ทดสอบ safe-unavailable และคง human review สำหรับข้อมูลทางคลินิก

**ค่าที่ต้องทดลองหา:** `HIGH_CONFIDENCE` ใน `utils/nameMatch.js` (ตอนนี้ตั้งไว้ที่ 0.82 ชั่วคราว)
ต้องทดลองกับเอกสารจริงจาก 8 สาขาก่อนปรับเป็นค่าจริง

### 2. LINE Messaging และ Webhook
Production ใช้ LINE SDK, ดาวน์โหลด message content จาก LINE และตรวจ `x-line-signature` แล้ว ห้ามตั้ง `ALLOW_UNSIGNED_LINE_WEBHOOK=true` ใน Production

### 3. LINE Login Identity
Production ส่ง LINE ID Token ให้ backend ตรวจผ่าน LINE Login verify endpoint; `X-Line-User-Id` ใช้ได้เฉพาะ test/local เมื่อเปิด flag ชัดเจน ห้ามตั้ง `ALLOW_INSECURE_LINE_HEADER=true` ใน Production

### 4. PostgreSQL และ migrations
ระบบใช้ PostgreSQL จริง ต้องสำรองฐานข้อมูลและใช้ `npm run migrate:status` / `npm run migrate` ตามลำดับใน `docs/DEPLOY_RENDER.md` ห้ามเปลี่ยนไปใช้ Google Sheets หรือพึ่ง memory test store ใน Production

### 5. LIFF runtime configuration
ห้ามแก้ LIFF ID หรือ production backend URL ใน source HTML/JavaScript ให้ static build สร้าง `environment.js` จาก `PUBLIC_BACKEND_URL` และให้แต่ละ LIFF อ่าน ID จาก `GET /config/liff`

### 6. Release gate
ตรวจ secret/readiness, hold Auto-Deploy, migration checksum/order, queues/scheduler และ controlled E2E ก่อนเปิด Center capability ตาม pilot runbook

---

## Mapping: ข้อกำหนด → โค้ด

| ข้อกำหนด | ไฟล์หลัก | Test ที่ยืนยัน |
|---|---|---|
| FR-A ตั้งค่าศูนย์ | `services/centerService.js` | `tests/centerService.test.js` |
| FR-B ทะเบียนผู้พัก | `services/centerService.js` | `tests/centerService.test.js` |
| FR-C รับรูป | `services/cardService.js` | `tests/cardService.test.js` |
| FR-D จับคู่ผู้พัก | `utils/nameMatch.js` | `tests/nameMatch.test.js` |
| FR-E ยืนยัน/แก้ไข | `services/cardService.js` | `tests/cardService.test.js` |
| FR-F ส่งครอบครัว | `services/cardService.js` | `tests/cardService.test.js` |
| FR-G แจ้งเตือนนัด | `services/reminderService.js` | — (ยังไม่มี Test เจาะจง ดูข้อควรทำเพิ่มด้านล่าง) |
| FR-H ฝั่งครอบครัว | `services/familyService.js` | `tests/familyService.test.js` |
| FR-I สรุปรายสัปดาห์ | `services/reminderService.js` | — |
| FR-J นำเข้าข้อมูล | `services/centerService.js` | `tests/centerService.test.js` |
| FR-K ตารางนัดศูนย์ | `routes/transport.js` | ครอบคลุมบางส่วนใน `transportService.test.js` |
| FR-L การจัดการเดินทาง | `services/transportService.js` | `tests/transportService.test.js` |
| FR-M ราคา/ใบแจ้งหนี้ | `services/transportService.js` | `tests/transportService.test.js` |
| FR-N Care Profile อิสระ | `services/familyService.js` | `tests/familyService.test.js` |
| FR-O คำขอเชื่อมต่อ | `services/accessService.js` | `tests/accessService.test.js` |
| Audit Log | `db.js` (ฟังก์ชัน `audit()`) | `tests/auditLog.test.js` |
| Webhook Flow เต็ม | `routes/webhook.js` | `tests/webhook.test.js` |
| FR-H4 Export PDF | `services/pdfService.js` | `tests/familyService.test.js`, `tests/familyRoutes.test.js` |
| Cron Scheduler | `server.js` | `tests/scheduler.test.js` |
| Performance | — | `tests/performance.test.js` |
| Rich Menu | `services/richMenuService.js` | `tests/richMenuService.test.js` |
| FR-A1 สร้างศูนย์ (ทีมงาน) | `routes/admin.js`, `scripts/create-center.js` | `tests/adminRoutes.test.js` |
| FR-K1/K2 ตารางนัดศูนย์ | `services/centerService.js` (getCenterAppointments) | `tests/centerService.test.js` |
| FR-K3 สรุปนัดพรุ่งนี้ | `services/reminderService.js` | `tests/reminderService.test.js` |
| FR-L10 เตือนครอบครัวไม่ตัดสินใจ | `services/transportService.js` | `tests/transportService.test.js` |
| FR-J4 API สัญญาณชีพภายนอก | `routes/external.js`, `middleware/externalAuth.js` | `tests/externalRoutes.test.js` |
| FR-F4 แจ้งข้อมูลผิด | `services/cardService.js` (reportCardIssue) | `tests/cardService.test.js` |

---

## งานที่ยังไม่ได้ทำ (นอกขอบเขตต้นแบบนี้)

```
- ยังไม่มีการทดสอบ Load จริงกับ AI/LINE จริง (Performance Test ที่มีตอนนี้วัดแค่ Overhead ของโค้ดเราเอง)
- ยังไม่มี load test จริงกับ LINE, Gemini และ PostgreSQL production; automated tests ไม่แทน controlled E2E
- Legacy JSONB tables บางส่วนยัง bootstrap ด้วย startup DDL จนกว่าจะมี numbered migration รับ ownership ครบ ดู `docs/DEPLOY_RENDER.md`
- Family มี Vital/Daily Care read-only UI แล้ว และ System Admin มี Care Operations UI; การเปิดใช้จริงยังต้องผ่าน capability, mapping, GroupBinding และ pilot runbook
- นโยบาย retention/DSR หลาย domain ยังต้องมีการตัดสินใจของบริษัท ดู `docs/PILOT_DATA_GOVERNANCE.md`
```

## 🔄 การเปลี่ยนแปลงสำคัญล่าสุด (หลังทบทวน Flow กับผู้ก่อตั้ง)

```
① พนักงานส่งรูปในแชทส่วนตัวกับพี่หมอ ไม่ใช่ในกลุ่มงานศูนย์อีกต่อไป
   เหตุผล: กันเรื่องอื่นปนในกลุ่ม และกัน AI อ่านรูปที่ไม่เกี่ยวข้อง
   กลุ่มงานศูนย์เปลี่ยนบทบาทเป็น "ใช้ระบุตัวตนพนักงาน" เท่านั้น
   (LINE ไม่มี API ค้นย้อนว่าผู้ใช้อยู่กลุ่มไหน ระบบจึงบันทึกเองจาก Event ในกลุ่ม)

② การยืนยันการ์ดเป็นสิทธิ์ของเจ้าของและผู้จัดการเท่านั้น พนักงานทั่วไปยืนยันไม่ได้
   และการ์ดส่งเข้าแชทส่วนตัวของผู้อนุมัติแต่ละคน ไม่ส่งเข้ากลุ่ม
   เหตุผล: ต้องมีผู้รับผิดชอบชัดเจน และกันพนักงานหลายคนเผลอกดโดยไม่รู้ว่ามีคนกดไปแล้ว

③ การเตือนครอบครัวที่ยังไม่เลือกวิธีเดินทาง เปลี่ยนจากทุกชั่วโมง
   เป็นเตือนเพียง 2 จังหวะ คือเหลือ 12 ชั่วโมง และเหลือ 6 ชั่วโมง
   โดยแจ้งศูนย์เฉพาะจังหวะสุดท้ายเท่านั้น เพื่อลดความรำคาญ
```

## ✅ ตรวจสอบครบถ้วนแล้ว — Requirements Audit

หลังพัฒนาเสร็จ ได้ทำการตรวจสอบ **ทั้ง 85 ข้อ (FR-A ถึง FR-O)** เทียบกับโค้ดจริงอย่างละเอียด
(ไม่ใช่แค่ดู Comment อ้างอิง แต่ไล่ตาม Flow แต่ละข้อว่าเรียกใช้งานได้จริงจนจบหรือไม่)
พบช่องโหว่ 12 จุดและแก้ไขครบทั้งหมดแล้ว รวมถึง:

```
・หน้า LIFF แก้ไขการ์ดก่อนส่ง (S4) ที่ไม่เคยถูกสร้างขึ้นจริง ทั้งที่ Backend มี API รองรับครบ
・การแจ้งเตือนที่ Service เขียนไว้ถูกต้องแต่ไม่เคยถูกเรียกจากจุดที่ควรเรียกจริงในธุรกิจ
  (จำหน่ายผู้พัก, ตรวจสอบเบอร์ซ้ำ, ข้อความปฏิเสธ AI)
・Rate Limit ป้องกันต้นทุน AI ที่ไม่เคยมีมาก่อนเลย
・Endpoint ที่ Requirements ประกาศไว้แต่ไม่เคยสร้าง (ตารางนัดศูนย์, สรุปนัดพรุ่งนี้,
  เตือนครอบครัวไม่ตัดสินใจ, API รับสัญญาณชีพภายนอก, ปุ่มแจ้งข้อมูลผิด)
```

Test เพิ่มจาก 100 เป็น 132 เคส ครอบคลุมทุกจุดที่แก้ไข

---

## ⚠️ Bug สำคัญที่เจอระหว่างพัฒนา — บทเรียนสำหรับแก้โค้ดต่อ

พบระหว่างพัฒนา 3 ชุด เป็น Bug ที่ซ่อนอยู่ทั่วทั้งระบบ ถ้า Dev เพิ่ม Route ใหม่ในอนาคต
**ต้องระวังจุดเดียวกันนี้เสมอ:**

### 1. เขตเวลา — ห้ามเรียก `toLocaleString('th-TH')` ตรงๆ เด็ดขาด
Cloud Hosting (Render, Vercel, AWS ฯลฯ) ตั้งเครื่อง Server เป็น UTC โดยปริยาย ถ้าจัดรูปแบบวันที่
โดยไม่ระบุ `timeZone` จะได้เวลาไทยผิดไป 7 ชั่วโมงทุกครั้ง (นัด 09:00 จะกลายเป็น 02:00) — อันตรายมาก
เพราะเป็นเวลานัดหมายทางการแพทย์ **ต้องเรียกผ่าน `backend/utils/thaiDate.js` เท่านั้น**

### 2. Async Route Handler ทุกตัวต้องห่อด้วย `asyncHandler`
Express 4.x ไม่ดักจับ Error จาก `async` Handler โดยอัตโนมัติ ถ้า Error เกิดขึ้นโดยไม่มี try-catch
(เช่น `res.setHeader()` พังเพราะใส่อักขระที่ไม่ใช่ ASCII) **Request จะค้างตลอดไป ไม่ได้ 500 กลับมาเลย**
ทุก Route และทุก Custom Middleware แบบ `async` ต้องห่อด้วย `backend/middleware/asyncHandler.js` เสมอ
(ดูตัวอย่างที่ถูกต้องได้ในทุกไฟล์ `routes/*.js` และ `middleware/auth.js` ที่แก้ไปแล้ว)

### 3. `router.use(middleware)` จับทุก Path Prefix ไม่ใช่แค่ Path ที่ Route ตรงกัน
พบตอนสร้าง `routes/admin.js` — `centersRouter` มี `router.use(requireAuth)` (ไม่ระบุ Path เจาะจง)
ซึ่ง Express จะจับ**ทุก Request ที่ขึ้นต้นด้วย Prefix ที่ Mount ไว้** (`/api`) ไปตรวจ LINE Auth ก่อนเสมอ
แม้ Path จะไม่ตรงกับ Route ใดใน `centersRouter` เลยก็ตาม (เช่น `/api/admin/centers`)
ทำให้ Endpoint ของ Admin โดนปฏิเสธด้วย LINE Auth ก่อนจะถึง Admin Auth เสมอ ทั้งที่คนละระบบสิทธิ์กัน

**ทางแก้ที่ใช้:** Router ที่ต้องการระบบสิทธิ์ต่างจาก Router อื่นทั้งหมด (เช่น `adminRouter`)
ต้อง **Register ก่อน Router อื่นที่ Mount ที่ Path Prefix เดียวกัน** (ดูลำดับ `app.use()` ใน `server.js`)
เพราะ Express จับคู่ Route ตามลำดับที่ Register ไว้ ไม่ใช่ตามความเจาะจงของ Path

---

## เอกสารเพิ่มเติม

```
docs/RICHMENU_SETUP.md    คู่มือตั้งค่า Rich Menu ผ่าน LINE Official Account Manager
docs/DEPLOY_RENDER.md     คู่มือ Deploy ขึ้น Render.com แบบละเอียด
docs/IMPLEMENTATION_5_PHASES.md แผนดำเนินงานและเกณฑ์ตรวจรับทั้ง 5 ระยะ
render.yaml                Blueprint สำหรับ Deploy อัตโนมัติ
backend/.env.example       รายการ Environment Variable ทั้งหมดที่ต้องตั้งค่า
```

---

## คำเตือนสำคัญที่สุด

**ข้อ L4** (ตัดสินใจไว้ชัดเจนในบทสนทนาออกแบบ): ศูนย์มีทางเลือกจัดการเดินทางแค่สองทาง
คือ "ศูนย์จัดการเอง" หรือ "ใช้บริการ Care2Go" **ห้ามเพิ่มปุ่มปฏิเสธเด็ดขาด**
เพราะครอบครัวที่กดขอให้ศูนย์จัดการต้องมั่นใจได้ว่าจะมีคนจัดให้เสมอ — ดู `transportService.js`
ฟังก์ชัน `centerChoose()` และ Test `เกณฑ์ยอมรับข้อ...ห้ามมีตัวเลือกปฏิเสธ`
