# คู่มือ Deploy พี่หมอ Backend ขึ้น Render.com

## ก่อนเริ่ม — Checklist สิ่งที่ต้องมีในมือ

```
☐ LINE Channel Access Token + Channel Secret (จาก LINE Developers Console)
☐ LIFF ID 2 ตัว (ฝั่งศูนย์ + ฝั่งครอบครัว)
☐ AI API Key (Anthropic หรือ Gemini อย่างน้อยหนึ่งตัว)
☐ บัญชี Google Cloud + Service Account (ถ้าจะใช้ Google Sheets เป็นฐานข้อมูล)
☐ บัญชี GitHub ที่ Push โค้ดนี้ขึ้นไปแล้ว
☐ บัญชี Render.com (สมัครฟรีได้ที่ render.com)
```

**⚠️ ก่อน Deploy ต้องทำตาม README.md หัวข้อ "สิ่งที่ต้องทำก่อน Deploy จริง" ให้ครบทั้ง 6 ข้อก่อน**
โดยเฉพาะการเชื่อม AI Provider จริงและเชื่อม LINE Messaging API จริง — ไฟล์นี้สอนแค่ขั้นตอน Deploy
ไม่ได้สอนการแก้โค้ดให้เชื่อมบริการจริง

---

## วิธีที่ 1 — Deploy ด้วย Blueprint (แนะนำ เร็วที่สุด)

```
① Push โค้ดทั้งหมด (รวมไฟล์ render.yaml ที่ root) ขึ้น GitHub
② เข้า https://dashboard.render.com/blueprints
③ กด "New Blueprint Instance"
④ เชื่อม Repository ที่เพิ่ง Push ไป
⑤ Render จะอ่าน render.yaml แล้วสร้าง Web Service ให้อัตโนมัติ
⑥ กรอกค่า Environment Variables ที่ทำเครื่องหมาย sync: false ไว้
   (Token, Secret, API Key ทั้งหมด — ห้ามใส่ในไฟล์ render.yaml เด็ดขาด)
⑦ กด "Apply" รอ Build เสร็จประมาณ 2-3 นาที
```

---

## วิธีที่ 2 — Deploy ด้วยมือ (ถ้าไม่อยากใช้ Blueprint)

```
① เข้า https://dashboard.render.com → "New +" → "Web Service"
② เชื่อม GitHub Repository
③ ตั้งค่าตามนี้:

   Name              phimor-backend
   Region            Singapore
   Root Directory    backend
   Runtime           Node
   Build Command     npm install
   Start Command     node server.js
   Instance Type     Starter (หรือ Free สำหรับทดสอบเบื้องต้น)

④ เลื่อนลงมาที่ "Environment Variables" → เพิ่มทีละตัวตามรายการใน backend/.env.example
⑤ กด "Create Web Service"
```

---

## หลัง Deploy เสร็จ — ตั้งค่า Webhook ที่ LINE

```
① คัดลอก URL ที่ Render ให้มา เช่น https://phimor-backend.onrender.com
② เข้า https://developers.line.biz/console/ → เลือก Channel ของพี่หมอ
③ แท็บ "Messaging API" → ช่อง "Webhook URL" → ใส่ https://phimor-backend.onrender.com/webhook
④ กด "Verify" — ต้องขึ้นเครื่องหมายถูกสีเขียว
⑤ เปิดสวิตช์ "Use webhook" ให้เป็นสีเขียว
```

**ทดสอบว่า Deploy สำเร็จ:**
```bash
curl https://phimor-backend.onrender.com/health
# ต้องได้ {"status":"ok","service":"phimor-backend"}
```

---

## ตั้งค่า LIFF ให้ชี้มาที่ Backend จริง

หลัง Deploy เสร็จ ต้องแก้ 2 จุดในไฟล์ LIFF (ค้นหาคำว่า `★ Dev`):

```
liff-app/center-admin/index.html
liff-app/family/index.html
```

```js
const BACKEND_URL = 'https://phimor-backend.onrender.com'; // ← ใส่ URL จริงจาก Render
await liff.init({ liffId: 'xxxxxxxxxx-xxxxxxxx' });          // ← ใส่ LIFF ID จริงจาก LINE Developers Console
```

จากนั้นอัปโหลดไฟล์ HTML ทั้งสองขึ้น Hosting ที่รองรับ HTTPS (Render Static Site, Vercel, หรือ GitHub Pages
ก็ได้ทั้งนั้น) แล้วนำ URL ไปตั้งเป็น "Endpoint URL" ของแต่ละ LIFF App ในหน้า LINE Developers Console

---

## ข้อจำกัดของ Render Starter Plan ที่ต้องรู้

```
・Free Plan จะ Sleep หลังไม่มีคนเรียกใช้ 15 นาที ทำให้ Webhook แรกหลังตื่นช้าประมาณ 30-60 วินาที
  → ไม่เหมาะกับ Production เพราะ LINE จะ Timeout webhook ที่ตอบช้าเกินไป
  → ใช้ Starter Plan ขึ้นไปสำหรับใช้งานจริง (Starter ไม่ Sleep)

・Scheduler (node-cron) ทำงานได้ตราบที่ Service ไม่ Sleep และมีแค่ 1 Instance เท่านั้น
  → ถ้าอนาคตขยายเป็นหลาย Instance (Horizontal Scaling) ต้องย้าย Cron ไปเป็น Render Cron Job แยกต่างหาก
    ไม่ใช่ setInterval/node-cron ฝังในตัว Web Service เอง (ไม่งั้นงานเดียวกันจะรันซ้ำหลายรอบ)
```

---

## การตรวจสอบหลัง Deploy (Smoke Test)

```bash
# 1. Backend ตอบสนอง
curl https://phimor-backend.onrender.com/health

# 2. Webhook รับ Event ได้ (ต้องเห็น 200 กลับมา แม้ event จะว่างเปล่า)
curl -X POST https://phimor-backend.onrender.com/webhook \
  -H "Content-Type: application/json" \
  -d '{"events":[]}'

# 3. ทดสอบเพิ่มเพื่อน LINE OA จริง แล้วส่งข้อความทดสอบดูว่า Backend ตอบกลับไหม
```

## ⚠️ ก่อนเปิดให้ 8 สาขาใช้งานจริง

```
☐ ทำตาม README.md ครบทั้ง 6 ข้อ (โดยเฉพาะ Verify LINE Signature ที่ตอนนี้ยังไม่ได้ทำ)
☐ ย้ายจาก In-memory Database ไป Google Sheets หรือฐานข้อมูลจริง (ข้อมูลจะหายทุกครั้งที่ Deploy ใหม่ถ้าไม่ทำ)
☐ ทดลองหาค่า AI_NAME_MATCH_THRESHOLD ที่แม่นยำจากเอกสารจริง
☐ ตั้งค่า Rich Menu ตาม docs/RICHMENU_SETUP.md
☐ สร้างบัญชีศูนย์แรกและทดสอบ Flow เต็มด้วยข้อมูลจริง 1 รอบก่อนเปิดใช้งานทุกสาขา
```

## สร้างศูนย์แรก (หลัง Deploy เสร็จ)

การสร้างศูนย์เป็นสิทธิ์ของทีมงานเท่านั้น (ไม่ใช่ Self-service — ตาม FR-A1) มี 2 วิธี:

**วิธีที่ 1 — CLI Script (แนะนำ สำหรับใช้ระหว่างคุยกับเจ้าของศูนย์)**
```bash
# SSH หรือรันผ่าน Render Shell
cd backend
node scripts/create-center.js --name "ศูนย์สุขสบาย" --owner "Uxxxxxxxxxxxxxxxx"
```

**วิธีที่ 2 — Admin API (สำหรับต่อยอดเป็นเครื่องมือ Internal)**
```bash
curl -X POST https://phimor-backend.onrender.com/api/admin/centers \
  -H "Content-Type: application/json" \
  -H "X-Admin-Key: {ค่า ADMIN_API_KEY ที่ตั้งไว้บน Render}" \
  -d '{"name":"ศูนย์สุขสบาย","ownerLineId":"Uxxxxxxxxxxxxxxxx"}'
```

ทั้งสองวิธีต้องการ **LINE User ID ของเจ้าของศูนย์** ซึ่งหาได้โดยให้เจ้าของศูนย์เพิ่มเพื่อน LINE OA
ก่อน แล้วส่งข้อความอะไรมาสักอย่าง จากนั้นดู `userId` จาก Webhook Event ที่เข้ามา (ดู Log บน Render)
