const line = require('@line/bot-sdk');

// สร้างตัวเชื่อมต่อกับ LINE ด้วย Access Token ของจริงจาก Environment
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'dummy'
});
const blobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'dummy'
});
const sentLog = [];

// ฟังก์ชันตอบกลับข้อความทันที (ใช้ตอนลูกค้ายิงแชทมา)
async function replyMessage(replyToken, messages) {
  if (process.env.NODE_ENV === 'test') { sentLog.push({ type: 'reply', replyToken, messages: Array.isArray(messages) ? messages : [messages] }); return { ok: true }; }
  try {
    await client.replyMessage({
      replyToken: replyToken,
      messages: Array.isArray(messages) ? messages : [messages]
    });
    return { ok: true };
  } catch (err) {
    console.error('LINE Reply Error:', err.response?.data || err.message);
    const error = new Error('ส่งข้อความตอบกลับ LINE ไม่สำเร็จ');
    error.cause = err;
    throw error;
  }
}

function providerStatus(error) {
  const status = Number(error?.status || error?.statusCode || error?.response?.status);
  return Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
}

function responseHeader(error, name) {
  const headers = error?.headers || error?.response?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get(name) || headers.get(name.toLowerCase()) || null;
  const match = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  const value = match ? headers[match] : null;
  return Array.isArray(value) ? value[0] : value;
}

function safeRequestId(value) {
  const clean = String(value || '').trim();
  return /^[A-Za-z0-9._:-]{1,160}$/.test(clean) ? clean : null;
}

function createPushMessage({ messagingClient = client, environment = () => process.env.NODE_ENV, log = sentLog } = {}) {
  return async function pushMessage(to, messages, options = {}) {
    const normalizedMessages = Array.isArray(messages) ? messages : [messages];
    const retryKey = typeof options?.retryKey === 'string' && options.retryKey.trim()
      ? options.retryKey.trim() : undefined;
    if (environment() === 'test') {
      const entry = { type:'push', to, messages:normalizedMessages };
      if (retryKey) entry.retryKey = retryKey;
      log.push(entry);
      return { ok:true };
    }
    try {
      await messagingClient.pushMessage({ to, messages:normalizedMessages }, retryKey);
      return { ok:true };
    } catch (error) {
      if (retryKey && providerStatus(error) === 409) {
        return {
          ok:true, retryKeyConflict:true,
          providerRequestId:safeRequestId(responseHeader(error, 'x-line-accepted-request-id')),
        };
      }
      const safeError = new Error('ส่ง LINE push ไม่สำเร็จ');
      safeError.code = 'LINE_PUSH_FAILED';
      safeError.providerStatus = providerStatus(error);
      throw safeError;
    }
  };
}

// ฟังก์ชันส่งข้อความแบบ Push (ใช้ตอนแจ้งเตือน หรือส่งหาคนอื่น)
const pushMessage = createPushMessage();

// ฟังก์ชันดึงชื่อโปรไฟล์
async function getProfile(userId) {
  if (process.env.NODE_ENV === 'test') return { userId, displayName: `Test ${userId}` };
  try {
    return await client.getProfile(userId);
  } catch (err) {
    console.error('LINE GetProfile Error:', err.message);
    return { userId, displayName: 'ผู้ใช้งาน' };
  }
}

async function getGroupMemberProfile(groupId, userId) {
  if (process.env.NODE_ENV === 'test') return { userId, displayName: `Test ${userId}` };
  try {
    return await client.getGroupMemberProfile(groupId, userId);
  } catch (err) {
    return null;
  }
}

async function listGroupMemberUserIds(groupId) {
  if (process.env.NODE_ENV === 'test') return { available: false, userIds: [] };
  const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
  if (!token) return { available: false, userIds: [] };
  const userIds = [];
  let start = null;
  try {
    do {
      const suffix = start ? `?start=${encodeURIComponent(start)}` : '';
      const response = await fetch(`https://api.line.me/v2/bot/group/${encodeURIComponent(groupId)}/members/ids${suffix}`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!response.ok) return { available: false, userIds: [], status: response.status };
      const page = await response.json();
      userIds.push(...(page.memberIds || []));
      start = page.next || null;
    } while (start);
    return { available: true, userIds: [...new Set(userIds)] };
  } catch (err) {
    return { available: false, userIds: [], error: err.message };
  }
}

function clearSentLog() { sentLog.splice(0, sentLog.length); }
function getSentLog() { return [...sentLog]; }
async function createRichMenu(obj) { if (process.env.NODE_ENV === 'test') { const richMenuId=`richmenu-test-${Date.now()}-${sentLog.length}`; sentLog.push({type:'richmenu_create',richMenuId,object:obj}); return { richMenuId }; } return client.createRichMenu(obj); }
async function uploadRichMenuImage(id, buf, type = 'image/png') {
  if (process.env.NODE_ENV === 'test') { sentLog.push({type:'richmenu_upload_image',richMenuId:id,size:buf.length,contentType:type}); return {}; }
  return blobClient.setRichMenuImage(id, new Blob([buf], { type }));
}
async function setDefaultRichMenu(id) { if (process.env.NODE_ENV === 'test') { sentLog.push({type:'richmenu_set_default',richMenuId:id}); return {}; } return client.setDefaultRichMenu(id); }
async function linkRichMenuToUser(uid, id) { if (process.env.NODE_ENV === 'test') { sentLog.push({type:'richmenu_link_user',userId:uid,richMenuId:id}); return {}; } return client.linkRichMenuIdToUser(uid, id); }
async function unlinkRichMenuFromUser(uid) { if (process.env.NODE_ENV === 'test') { sentLog.push({type:'richmenu_unlink_user',userId:uid}); return {}; } return client.unlinkRichMenuIdFromUser(uid); }

module.exports = {
  replyMessage, pushMessage, getProfile, getGroupMemberProfile, listGroupMemberUserIds,
  clearSentLog, getSentLog,
  createRichMenu, uploadRichMenuImage, setDefaultRichMenu, linkRichMenuToUser, unlinkRichMenuFromUser,
  createPushMessage,
};
