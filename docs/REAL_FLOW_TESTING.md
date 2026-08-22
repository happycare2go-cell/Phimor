# แผนทดสอบเสมือนใช้งานจริง — ระบบพี่หมอ

เอกสารนี้แบ่งการตรวจเป็น 3 ชั้น เพื่อให้รู้ชัดว่าความผิดพลาดเกิดที่โค้ด การแสดงผล หรือระบบภายนอก

## คำสั่งทดสอบ

รันจากโฟลเดอร์ `backend`

- `npm test` — ทุกชุดทดสอบ (จำนวนจริงจะแสดงท้ายผลทดสอบ)
- `npm run test:flows` — เส้นทางผู้ใช้ต่อเนื่องครบวงจร
- `npm run test:ui` — สัญญาหน้า LIFF, mobile markup, consent gate และความปลอดภัยของลำดับ route
- `npm run test:browser` — เปิด Chrome/Edge แบบไม่แสดงหน้าต่างและให้ผู้ใช้จำลองกดหน้า LIFF จริง
- `npm run test:ai-golden` — ตรวจชุดภาพทดสอบ AI โดยไม่เรียก AI จริงและไม่เสียค่าใช้จ่าย

ตัวรันจะบังคับ `NODE_ENV=test` และใช้ LINE/ฐานข้อมูลจำลองเสมอ จึงไม่ส่งข้อความหาผู้ใช้จริงและไม่แก้ฐานข้อมูล Production

Browser simulation ต้องมีแพ็กเกจ Playwright (`npm install --save-dev playwright`) และ Chrome หรือ Edge หาก browser อยู่ตำแหน่งอื่นให้กำหนด `PHIMOR_CHROMIUM_EXECUTABLE` ส่วนสภาพแวดล้อม Codex สามารถกำหนด `PHIMOR_PLAYWRIGHT_MODULE` ไปยัง Playwright ที่ให้มาพร้อม runtime ได้

## LIFF Mock และการตรวจบน LINE จริง

ชุด `test:browser` ฉีด LIFF identity จำลองเข้าเบราว์เซอร์เฉพาะระหว่างทดสอบ ไม่แก้หน้า Production และไม่ต้องใช้บัญชี LINE จริง จึงเหมาะกับ regression test ในเครื่องหรือ CI

หากต้อง debug API ของ LIFF เพิ่มเติม ให้ใช้แพ็กเกจทางการ `@line/liff-mock` ใน environment สำหรับพัฒนาเท่านั้น โดยเปิด `mock: true` ตอน `liff.init()` ห้ามเปิดค่านี้ใน Production ส่วนปัญหาที่เกิดเฉพาะ LINE WebView ให้ใช้ `@line/liff-inspector` ต่อกับอุปกรณ์ทดสอบจริง

Official LIFF Mock ยังไม่สามารถยืนยันแทน LINE Login, ID token, scopes หรือ WebView จริงได้ จึงต้องมี smoke test บนอุปกรณ์อย่างน้อยหนึ่งรอบก่อนปล่อย Production

### Browser simulation ที่มีแล้ว

- Family LIFF: เปิด consent gate, กดยอมรับ PDPA และเข้าหน้าไม่มี Care Profile
- Center LIFF: กดแท็บรอดำเนินการและเห็น empty state โดยไม่ขึ้น error
- Center LIFF error state: จำลอง API 500 และตรวจว่าข้อความสาเหตุแสดงบนหน้าจอ
- Register LIFF: ตรวจช่องว่าง กรอกข้อมูล และยืนยันลงทะเบียนสำเร็จ
- System Admin: เปิดหน้าปรับแพ็กเกจ ตรวจวันที่ผิด และบันทึกช่วงวันที่ที่ถูกต้อง

## Flow ต่อเนื่องที่จำลองแล้ว

1. System Admin สร้างศูนย์และกำหนดแพ็กเกจ
2. เจ้าของเข้า Center LIFF และระบบเห็นบทบาท owner
3. เจ้าของเพิ่มผู้พัก
4. เจ้าของสร้าง Care Profile พร้อมข้อมูลสุขภาพและฉุกเฉิน
5. ญาติเข้าระบบ ตรวจ PDPA และให้ความยินยอม
6. ญาติเปิดลิงก์เชิญและรับ Care Profile
7. ญาติสร้างนัดใหม่
8. ระบบสร้างแผนเดินทางและรายการรอญาติโดยอัตโนมัติ
9. ญาติเลือกให้ศูนย์จัดการ
10. หน้า “รอดำเนินการ” ของศูนย์เห็นรายการเดียวกัน
11. เจ้าของกำหนด Rate Card และเลือกให้ศูนย์จัดการเอง
12. ญาติบันทึกรายการยา
13. ศูนย์เห็นยาและข้อมูลแพ้ยาใน Clinical Summary
14. เลื่อนเวลาจำลองไปหนึ่งวันก่อนนัดและตรวจการแจ้งเตือน
15. เรียก Scheduler ซ้ำและตรวจว่าไม่แจ้งซ้ำ
16. เจ้าของแต่งตั้งผู้จัดการ
17. ผู้จัดการเปิดข้อมูลของศูนย์ได้
18. เจ้าของถอนสิทธิ์ และผู้จัดการเดิมถูกปฏิเสธทันที

## การเร่งเวลา

งานแจ้งเตือนไม่ต้องรอเวลาจริง ชุดทดสอบส่ง `referenceDate` เข้า service โดยตรง จึงจำลองได้ทันที:

- ก่อนวันนัด 1 วัน
- เช้าวันนัด
- เหลือ 12 และ 6 ชั่วโมงก่อนเดินทาง
- ก่อนแพ็กเกจหมดอายุ 3 วัน
- สรุปนัดวันพรุ่งนี้และสรุปรายสัปดาห์
- การ์ดหมดอายุและการป้องกันส่งซ้ำ

### เร่งเวลาบน Render Staging

ไฟล์ `render.staging.yaml` เตรียม Backend, LIFF และ PostgreSQL แยกจาก Production ไว้แล้ว หลังสร้าง Blueprint ให้ใส่ secret ของบัญชี/LINE channel สำหรับทดสอบเท่านั้น แล้วตั้ง:

- `STAGING_MODE=true`
- `STAGING_CLOCK_OFFSET_MINUTES=1440` เพื่อจำลองเวลาเร็วขึ้น 1 วัน
- `STAGING_CLOCK_OFFSET_MINUTES=4320` เพื่อจำลองเวลาเร็วขึ้น 3 วัน

เมื่อเปิด Staging mode งานนัด พรุ่งนี้ และแพ็กเกจหมดอายุจะตรวจทุก 1 นาที ห้ามตั้ง `STAGING_MODE=true` ใน Production เพราะอาจทำให้ส่งการแจ้งเตือนผิดเวลา

หลังเปลี่ยน offset ให้รอไม่เกิน 1 นาที ตรวจ Logs และฐานข้อมูล notification outbox จากนั้นคืน offset เป็น `0`

## Webhook ที่ตรวจอัตโนมัติแล้ว

- LINE ส่ง `events: []` จากปุ่ม Verify แล้ว Backend ตอบ 200
- ลายเซ็น HMAC-SHA256 ที่ถูกต้องผ่าน และข้อความหรือลายเซ็นที่ถูกแก้ถูกปฏิเสธ
- `webhookEventId` เดิมที่ถูกส่งซ้ำถูกบันทึกและประมวลผลเพียงครั้งเดียว

หลัง Deploy ยังต้องกด Verify ใน LINE Developers Console หนึ่งครั้ง เพราะ local test ไม่สามารถยืนยัน Channel Secret, DNS และ HTTPS ของ Staging ได้

## ชุดภาพ AI Golden

เก็บเฉพาะภาพสังเคราะห์หรือภาพที่ลบข้อมูลส่วนบุคคลแล้วใน `tests/fixtures/ai-golden` และกำหนดผลคาดหวังใน `manifest.json`

- โหมดปกติ: `npm run test:ai-golden` ตรวจว่า manifest และไฟล์ครบ โดยไม่ส่งรูปออกนอกเครื่อง
- โหมดเรียก AI จริงบน Staging เท่านั้น: ตั้ง `RUN_REAL_AI_GOLDEN=true` และ `GEMINI_API_KEY` แล้วรันคำสั่งเดิม

ห้ามใช้ภาพผู้ป่วยจริงใน repository และไม่ควรเปิดโหมดเรียก AI จริงใน CI ที่ไม่ควบคุมค่าใช้จ่าย

## สิ่งที่จำลองแทน LINE ได้

- LINE user identity ของ owner, manager, staff, family และ system admin
- webhook จากแชทส่วนตัวและกลุ่ม
- LINE reply/push, Flex Message และ Rich Menu linking
- การออกจากกลุ่ม/กลับเข้ากลุ่มและการถอนสิทธิ์
- AI response สำหรับเอกสารและรูปยา
- การส่งแจ้งเตือนและตรวจปลายทางโดยไม่ส่งข้อความจริง

## สิ่งที่ต้องตรวจบน Staging หลัง Deploy

สิ่งเหล่านี้มีเจ้าของระบบภายนอก จึงรับประกันด้วย local test อย่างเดียวไม่ได้:

1. LINE Login จริง: LIFF ID, Endpoint URL, scopes `openid/profile` และ ID token
2. LINE OA จริง: webhook signature, reply token, push quota และสิทธิ์อ่านข้อความกลุ่ม
3. กล้อง/คลังรูป: iPhone Safari/LINE in-app browser และ Android
4. PDF: เปิด ดู แชร์ และบันทึกลง Files บน iPhone/Android
5. Render: Environment variables, PostgreSQL, Scheduler, cold start และ Auto-Deploy
6. Flex/Rich Menu: การตัดข้อความ ฟอนต์ ขนาดจอ และตำแหน่งปุ่มใน LINE รุ่นจริง
7. AI จริง: รูปเบลอ แสงสะท้อน ลายมือ ภาษาไทย และเอกสารหลายหน้า

BrowserStack หรือบริการอุปกรณ์จริงใช้ตรวจ Safari/Chrome บนมือถือได้ แต่ต้องมีบัญชีและ access key ของบริการนั้น การจำลองขนาด iPhone ด้วย Playwright ช่วยตรวจ layout ได้ แต่ไม่เท่ากับ LINE in-app browser บน iPhone จริง

## Checklist หลัง Deploy แบบไม่กระทบลูกค้าจริง

- ใช้ LINE บัญชีทดสอบแยกสำหรับ owner, manager, staff และ family
- ใช้ศูนย์ชื่อ `STAGING - ห้ามใช้จริง`
- ตั้งวันนัดทดสอบในอนาคตและลบ/ยกเลิกหลังตรวจ
- ใช้กลุ่ม LINE ทดสอบแยกจากกลุ่ม Care2Go และศูนย์จริง
- ตรวจ `/health`, `/ready` และ commit บน Render ก่อนเริ่ม
- บันทึกภาพหน้าจอและ response เมื่อพบข้อผิดพลาด
- ห้ามใส่ `ADMIN_API_KEY`, token หรือข้อมูลผู้ป่วยจริงใน repository/test fixture

## ข้อผิดพลาดที่ชุด Journey พบแล้ว

ลิงก์เชิญที่สร้างซ้ำเคยใช้ `?invite=` แต่ Family LIFF อ่าน `?token=` ทำให้ญาติเปิดลิงก์แล้วไม่เข้าสู่ขั้นตอนรับ Care Profile ปัจจุบันแก้ให้ใช้ `?token=` เหมือนกันทั้งหมดและมี regression test ป้องกันแล้ว
