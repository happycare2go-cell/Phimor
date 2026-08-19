// providers/lineClient.js
// Interface กลางสำหรับส่งข้อความ LINE — ของจริงใช้ @line/bot-sdk MessagingApiClient
// ตอนนี้เป็น Mock ที่บันทึกทุกครั้งที่ "จะส่ง" ไว้ใน sentLog เพื่อให้ Test ตรวจสอบได้
//
// Dev แทนที่ฟังก์ชัน replyMessage/pushMessage ด้วยการเรียก LINE Messaging API จริงตอน Deploy
// (ดู Phimor_Technical_Design.docx หมวด 1 — LINE Platform)

let sentLog = [];

function clearSentLog() {
  sentLog = [];
}

function getSentLog() {
  return [...sentLog];
}

/** ตอบกลับด้วย replyToken (ฟรี ไม่นับโควต้า ใช้ได้ครั้งเดียวต่อ Event) */
async function replyMessage(replyToken, messages) {
  const entry = { type: 'reply', replyToken, messages, at: new Date().toISOString() };
  sentLog.push(entry);
  return entry;
}

/** Push ข้อความไปหาบุคคลหรือกลุ่ม (มีต้นทุน คิดตามจำนวนผู้รับ) */
async function pushMessage(to, messages) {
  const entry = { type: 'push', to, messages, at: new Date().toISOString() };
  sentLog.push(entry);
  return entry;
}

/** ดึงข้อมูลโปรไฟล์ผู้ใช้ (ชื่อที่แสดงใน LINE) */
async function getProfile(userId) {
  return { userId, displayName: `ผู้ใช้ ${userId.slice(0, 6)}` };
}

// ── Rich Menu API ──
// อ้างอิง: https://developers.line.biz/en/reference/messaging-api/#rich-menu
// ของจริงต้องเรียก 5 endpoint: create → upload image → (set default | link to user) → unlink
// ตอนนี้เป็น Mock ที่จำลองพฤติกรรมและบันทึกลง sentLog เพื่อให้ Test ตรวจสอบได้

let mockRichMenuSeq = 0;

/** สร้าง Rich Menu ใหม่ คืน { richMenuId } (ของจริง: POST /v2/bot/richmenu) */
async function createRichMenu(richMenuObject) {
  mockRichMenuSeq += 1;
  const richMenuId = `richmenu-mock-${mockRichMenuSeq}`;
  sentLog.push({ type: 'richmenu_create', richMenuId, richMenuObject, at: new Date().toISOString() });
  return { richMenuId };
}

/** อัปโหลดภาพให้ Rich Menu (ของจริง: POST https://api-data.line.me/v2/bot/richmenu/{richMenuId}/content) */
async function uploadRichMenuImage(richMenuId, imageBuffer, contentType = 'image/png') {
  sentLog.push({ type: 'richmenu_upload_image', richMenuId, size: imageBuffer.length, contentType, at: new Date().toISOString() });
  return {};
}

/** ตั้งเป็นเมนูเริ่มต้นสำหรับทุกคน (ของจริง: POST /v2/bot/user/all/richmenu/{richMenuId}) */
async function setDefaultRichMenu(richMenuId) {
  sentLog.push({ type: 'richmenu_set_default', richMenuId, at: new Date().toISOString() });
  return {};
}

/** ผูก Rich Menu ให้ผู้ใช้คนใดคนหนึ่งโดยเฉพาะ มีลำดับความสำคัญสูงกว่าเมนูเริ่มต้น
 *  (ของจริง: POST /v2/bot/user/{userId}/richmenu/{richMenuId})
 *  ⚠️ ข้อจำกัดจริงของ LINE: เชื่อมให้คนที่ยังไม่ได้เป็นเพื่อนกับ OA ไม่ได้ */
async function linkRichMenuToUser(userId, richMenuId) {
  sentLog.push({ type: 'richmenu_link_user', userId, richMenuId, at: new Date().toISOString() });
  return {};
}

/** ยกเลิกการผูก Rich Menu เฉพาะบุคคล (กลับไปแสดงเมนูเริ่มต้นแทน) */
async function unlinkRichMenuFromUser(userId) {
  sentLog.push({ type: 'richmenu_unlink_user', userId, at: new Date().toISOString() });
  return {};
}

module.exports = {
  replyMessage, pushMessage, getProfile, clearSentLog, getSentLog,
  createRichMenu, uploadRichMenuImage, setDefaultRichMenu, linkRichMenuToUser, unlinkRichMenuFromUser,
};
