require('dotenv').config();
const zlib = require('zlib');

const CHANNEL_ACCESS_TOKEN = process.env.LINE_CHANNEL_ACCESS_TOKEN;
const LIFF_ID_CENTER_ADMIN = process.env.LIFF_ID_CENTER_ADMIN || '2000000000-xxxxxxx';
const LIFF_ID_CARE_PROFILE = process.env.LIFF_ID_CARE_PROFILE || '2000000000-xxxxxxx';

if (!CHANNEL_ACCESS_TOKEN) {
  console.error('❌ ไม่พบ LINE_CHANNEL_ACCESS_TOKEN ใน Environment Variables');
  process.exit(1);
}

// สร้าง PNG Buffer ขนาด 2500 x 1686 โดยไม่ต้องพึ่ง external package
function createPngBuffer(width, height, r, g, b) {
  const signature = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  
  // IHDR
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type 2 (RGB)
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  const ihdrChunk = makeChunk('IHDR', ihdr);

  // IDAT
  const row = Buffer.alloc(1 + width * 3);
  row[0] = 0; // filter type 0
  for (let i = 0; i < width; i++) {
    row[1 + i * 3] = r;
    row[1 + i * 3 + 1] = g;
    row[1 + i * 3 + 2] = b;
  }
  const rawData = Buffer.concat(Array(height).fill(row));
  const compressed = zlib.deflateSync(rawData);
  const idatChunk = makeChunk('IDAT', compressed);

  // IEND
  const iendChunk = makeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([signature, ihdrChunk, idatChunk, iendChunk]);
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function crc32(buf) {
  let crc = 0 ^ (-1);
  for (let i = 0; i < buf.length; i++) {
    crc = (crc >>> 8) ^ crcTable[(crc ^ buf[i]) & 0xFF];
  }
  return (crc ^ (-1)) >>> 0;
}

const crcTable = (() => {
  let c;
  const table = [];
  for (let n = 0; n < 256; n++) {
    c = n;
    for (let k = 0; k < 8; k++) {
      c = ((c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1));
    }
    table[n] = c;
  }
  return table;
})();

async function callLineApi(endpoint, method = 'GET', body = null, isBinary = false) {
  const headers = { 'Authorization': `Bearer ${CHANNEL_ACCESS_TOKEN}` };
  if (!isBinary && body) headers['Content-Type'] = 'application/json';
  if (isBinary) headers['Content-Type'] = 'image/png';

  const res = await fetch(endpoint, {
    method,
    headers,
    body: isBinary ? body : (body ? JSON.stringify(body) : null)
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new Error(`LINE API [${res.status}] ${errText}`);
  }
  return isBinary ? res : (res.status !== 200 && res.status !== 201 ? {} : res.json());
}

async function run() {
  console.log('🚀 กำลังเริ่มสร้าง Rich Menu จริงบน LINE Official Account...');

  try {
    // 1. ลบ Rich Menu เก่าทั้งหมดที่ค้างอยู่ในบอท
    const existing = await callLineApi('https://api.line.me/v2/bot/richmenu/list');
    if (existing.richmenus && existing.richmenus.length > 0) {
      console.log(`🧹 พบ Rich Menu เก่า ${existing.richmenus.length} รายการ กำลังล้างระบบ...`);
      for (const m of existing.richmenus) {
        await callLineApi(`https://api.line.me/v2/bot/richmenu/${m.richMenuId}`, 'DELETE');
      }
    }

    // 2. สร้าง Rich Menu ฝั่งครอบครัว / พนักงานทั่วไป (Default)
    console.log('📦 1/2 สร้าง Rich Menu ฝั่งผู้ใช้ทั่วไป...');
    const familyMenuPayload = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: "Phimor-Family-Menu",
      chatBarText: "เมนูพี่หมอ",
      areas: [
        {
          bounds: { x: 0, y: 0, width: 1250, height: 1686 },
          action: { type: "uri", label: "Care Profile", uri: `https://liff.line.me/${LIFF_ID_CARE_PROFILE}` }
        },
        {
          bounds: { x: 1250, y: 0, width: 1250, height: 1686 },
          action: { type: "message", label: "วิธีใช้งาน", text: "วิธีส่งรูป: ถ่ายภาพใบนัดหรือซองยาแล้วส่งเข้ามาในแชทนี้ได้เลยค่ะ" }
        }
      ]
    };
    const familyRes = await callLineApi('https://api.line.me/v2/bot/richmenu', 'POST', familyMenuPayload);
    const familyMenuId = familyRes.richMenuId;
    
    // อัปโหลดรูปสีฟ้าให้ Family Menu
    const bluePng = createPngBuffer(2500, 1686, 41, 128, 185);
    await callLineApi(`https://api-data.line.me/v2/bot/richmenu/${familyMenuId}/content`, 'POST', bluePng, true);
    
    // ตั้งเป็น Default สำหรับทุกคน
    await callLineApi(`https://api.line.me/v2/bot/user/all/richmenu/${familyMenuId}`, 'POST');
    console.log(`✅ ติดตั้ง Family Rich Menu (${familyMenuId}) เป็น Default สำเร็จ!`);

    // 3. สร้าง Rich Menu ฝั่งเจ้าของ / ผู้จัดการศูนย์ (Center Manager Menu)
    console.log('📦 2/2 สร้าง Rich Menu ฝั่งผู้จัดการศูนย์...');
    const adminMenuPayload = {
      size: { width: 2500, height: 1686 },
      selected: true,
      name: "Phimor-Admin-Menu",
      chatBarText: "เมนูผู้จัดการศูนย์",
      areas: [
        {
          bounds: { x: 0, y: 0, width: 833, height: 1686 },
          action: { type: "uri", label: "จัดการผู้พัก", uri: `https://liff.line.me/${LIFF_ID_CENTER_ADMIN}?view=residents` }
        },
        {
          bounds: { x: 833, y: 0, width: 834, height: 1686 },
          action: { type: "uri", label: "จัดการศูนย์", uri: `https://liff.line.me/${LIFF_ID_CENTER_ADMIN}` }
        },
        {
          bounds: { x: 1667, y: 0, width: 833, height: 1686 },
          action: { type: "message", label: "สถานะระบบ", text: "ระบบพี่หมอพร้อมใช้งานค่ะ" }
        }
      ]
    };
    const adminRes = await callLineApi('https://api.line.me/v2/bot/richmenu', 'POST', adminMenuPayload);
    const adminMenuId = adminRes.richMenuId;
    
    // อัปโหลดรูปสีเขียวมรกตให้ Admin Menu
    const greenPng = createPngBuffer(2500, 1686, 39, 174, 96);
    await callLineApi(`https://api-data.line.me/v2/bot/richmenu/${adminMenuId}/content`, 'POST', greenPng, true);
    console.log(`✅ ติดตั้ง Admin Rich Menu (${adminMenuId}) สำเร็จ!`);

    console.log('\n🎉 สรุปผลการสร้าง Rich Menu จริงบน LINE:');
    console.log(`- เมนูเริ่มต้น (Family): ${familyMenuId}`);
    console.log(`- เมนูผู้จัดการ (Admin): ${adminMenuId}`);
    console.log('\n👉 ตอนนี้เปิดแอป LINE แล้วจะเห็น Rich Menu ตัวใหม่ทันที 100% ครับ!');

  } catch (err) {
    console.error('❌ เกิดข้อผิดพลาดในการสร้าง Rich Menu:', err.message);
  }
}

run();
