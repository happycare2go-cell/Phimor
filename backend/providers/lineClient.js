const line = require('@line/bot-sdk');

// สร้างตัวเชื่อมต่อกับ LINE ด้วย Access Token ของจริงจาก Environment
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'dummy'
});

// ฟังก์ชันตอบกลับข้อความทันที (ใช้ตอนลูกค้ายิงแชทมา)
async function replyMessage(replyToken, messages) {
  try {
    await client.replyMessage({
      replyToken: replyToken,
      messages: Array.isArray(messages) ? messages : [messages]
    });
  } catch (err) {
    console.error('LINE Reply Error:', err.response?.data || err.message);
  }
}

// ฟังก์ชันส่งข้อความแบบ Push (ใช้ตอนแจ้งเตือน หรือส่งหาคนอื่น)
async function pushMessage(to, messages) {
  try {
    await client.pushMessage({
      to: to,
      messages: Array.isArray(messages) ? messages : [messages]
    });
  } catch (err) {
    console.error('LINE Push Error:', err.response?.data || err.message);
  }
}

// ฟังก์ชันดึงชื่อโปรไฟล์
async function getProfile(userId) {
  try {
    return await client.getProfile(userId);
  } catch (err) {
    console.error('LINE GetProfile Error:', err.message);
    return { userId, displayName: 'ผู้ใช้งาน' };
  }
}

// ------------------------------------------------------------------
// ฟังก์ชันด้านล่างคือ Mock ของเดิม เก็บไว้ไม่ให้ส่วนอื่นของระบบ (เช่น Test) Error
// ------------------------------------------------------------------
function clearSentLog() {}
function getSentLog() { return []; }
async function createRichMenu(obj) { return { richMenuId: 'dummy' }; }
async function uploadRichMenuImage(id, buf, type) { return {}; }
async function setDefaultRichMenu(id) { return {}; }
async function linkRichMenuToUser(uid, id) { return {}; }
async function unlinkRichMenuFromUser(uid) { return {}; }

module.exports = {
  replyMessage, pushMessage, getProfile,
  clearSentLog, getSentLog,
  createRichMenu, uploadRichMenuImage, setDefaultRichMenu, linkRichMenuToUser, unlinkRichMenuFromUser
};
