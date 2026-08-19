# พี่หมอ — Backend + LIFF (ต้นแบบพร้อมใช้งาน)

โค้ดชุดนี้สร้างตาม `Phimor_System_Requirements.docx` และ `Phimor_Technical_Design.docx`
ครอบคลุมข้อกำหนด **FR-A ถึง FR-O** (78 ข้อ) — เป็น**ต้นแบบที่ทำงานได้จริง**ทุก Business Logic
โดยจุดที่ต้องเชื่อมต่อบริการภายนอกจริง (Google Sheets, LINE, AI) ยังเป็น **Mock** ที่ออกแบบ
Interface ไว้ให้สลับเป็นของจริงได้โดยไม่ต้องแก้ Business Logic

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
  db.js                        Data Layer (ตอนนี้ In-memory)
  flexMessages.js              การ์ด LINE (S5)
  providers/
    aiProvider.js              ★ ต้องเชื่อม Anthropic/Gemini จริง
    lineClient.js               ★ ต้องเชื่อม LINE Messaging API จริง
  middleware/
    auth.js                     ★ ต้อง Verify LINE ID Token จริง (ตอนนี้อ่านจาก Header ตรงๆ)
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

tests/                          61 Test Cases ครอบคลุมเกณฑ์ยอมรับทั้ง 18 ข้อ
```

---

## ⚠️ สิ่งที่ต้องทำก่อน Deploy จริง (เรียงตามความสำคัญ)

### 1. เชื่อม AI Provider จริง — `backend/providers/aiProvider.js`
แทนที่ `interpretDocument()` และ `interpretLabResult()` ด้วยการเรียก Anthropic/Gemini จริง
**ต้องคงรูปแบบผลลัพธ์เดิมไว้** (`documentType`, `nameGuess`, `nameConfidence`, `appointment`, `medications`, `doctorNote`)
เพราะ Service ทั้งหมดผูกกับรูปแบบนี้อยู่

**ค่าที่ต้องทดลองหา:** `HIGH_CONFIDENCE` ใน `utils/nameMatch.js` (ตอนนี้ตั้งไว้ที่ 0.82 ชั่วคราว)
ต้องทดลองกับเอกสารจริงจาก 8 สาขาก่อนปรับเป็นค่าจริง

### 2. เชื่อม LINE Messaging API จริง — `backend/providers/lineClient.js`
แทนที่ `replyMessage()` / `pushMessage()` ด้วย `@line/bot-sdk` `MessagingApiClient` จริง
และใน `routes/webhook.js` ต้องเปลี่ยนจากอ่าน `event.message.mockBase64` เป็นเรียก
`MessagingApiBlobClient.getMessageContent()` จริง พร้อม**ตรวจสอบ Signature จาก LINE**
(ตอนนี้ยังไม่ได้ตรวจสอบเลย — ห้ามขึ้น Production โดยไม่มีขั้นตอนนี้)

### 3. Verify LINE ID Token จริง — `backend/middleware/auth.js`
ฟังก์ชัน `identify()` ตอนนี้อ่าน LINE User ID จาก Header `X-Line-User-Id` ตรงๆ เพื่อให้ทดสอบง่าย
**ก่อน Deploy ต้อง Verify JWT จริงจาก LINE** (ตรวจ Signature + วันหมดอายุ) ไม่ใช่เชื่อ Header

### 4. ย้ายจาก In-memory ไปฐานข้อมูลจริง — `backend/db.js`
ทุกตารางเรียกผ่าน `makeTable()` ที่มี Interface เดียวกัน (`insert`, `findWhere`, `findOne`, `update`, `remove`)
สลับ Implementation ภายในให้ไปคุยกับ Google Sheets หรือฐานข้อมูลจริงได้โดยไม่ต้องแก้ Service ใดๆ เลย
แนะนำ Google Sheets เฉพาะช่วงทดลองกับ 8 สาขา (< 500 ผู้พัก) ตามที่ระบุใน Technical Design

### 5. ใส่ค่าจริงในไฟล์ LIFF
ทั้ง 2 ไฟล์ HTML มีจุดที่ต้องแก้ (ค้นหาคำว่า `★ Dev`):
```js
const BACKEND_URL = 'https://api.phimor.example.com';  // → URL Backend จริง
await liff.init({ liffId: 'YOUR_LIFF_ID' });             // → LIFF ID จริงจาก LINE Developers Console
```

### 6. ตั้งค่าตัวแปรที่ต้องทดลองก่อนใช้จริง
ดู `Phimor_Technical_Design.docx` หมวด 9 — ค่าที่ต้องปรับได้จากภายนอก เช่น
`AI_MONTHLY_CAP_PER_CENTER`, `CARD_EXPIRY_HOURS` (ตอนนี้ Hardcode ไว้ในโค้ด ควรย้ายเป็น
Environment Variable ก่อน Deploy จริง)

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
- Google Sheets ยังไม่ได้เชื่อมจริง (ยังเป็น In-memory — ดูหัวข้อ "สิ่งที่ต้องทำก่อน Deploy จริง" ข้อ 4)
- richMenuService.js ยังเป็น Mock เหมือนกับ lineClient.js อื่นๆ ทั้งหมด
  ต้องแทนที่ด้วยการเรียก LINE Rich Menu API จริงตอน Deploy (ดู providers/lineClient.js)
- Admin API (routes/admin.js) ยังมีแค่สร้าง/แสดงรายชื่อศูนย์ ยังไม่มีแก้ไข/ปิดใช้งานศูนย์
- ระบบยังไม่มีหน้าจอให้ดูข้อมูล Vitals ที่รับเข้ามา (FR-J4) — เก็บไว้ในฐานข้อมูลแล้ว
  แต่ยังไม่มี UI แสดงผล เป็นงานสำหรับระยะถัดไปเมื่อศูนย์เริ่มส่งข้อมูลจริง
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
render.yaml                Blueprint สำหรับ Deploy อัตโนมัติ
backend/.env.example       รายการ Environment Variable ทั้งหมดที่ต้องตั้งค่า
```

---

## คำเตือนสำคัญที่สุด

**ข้อ L4** (ตัดสินใจไว้ชัดเจนในบทสนทนาออกแบบ): ศูนย์มีทางเลือกจัดการเดินทางแค่สองทาง
คือ "ศูนย์จัดการเอง" หรือ "ใช้บริการ Care2Go" **ห้ามเพิ่มปุ่มปฏิเสธเด็ดขาด**
เพราะครอบครัวที่กดขอให้ศูนย์จัดการต้องมั่นใจได้ว่าจะมีคนจัดให้เสมอ — ดู `transportService.js`
ฟังก์ชัน `centerChoose()` และ Test `เกณฑ์ยอมรับข้อ...ห้ามมีตัวเลือกปฏิเสธ`
