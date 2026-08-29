const line = require('@line/bot-sdk');
const blobClient = new line.messagingApi.MessagingApiBlobClient({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'dummy' });
const express = require('express');
const { createHash } = require('crypto');
const router = express.Router();

const centerService = require('../services/centerService');
const cardService = require('../services/cardService');
const transportService = require('../services/transportService');
const familyService = require('../services/familyService');
const lineClient = require('../providers/lineClient');
const flex = require('../flexMessages');
const rateLimiter = require('../utils/rateLimiter');
const { messagingConfigured } = require('../config/runtimeCapabilities');
const { Residents, PendingCards, CareProfiles, CenterStaff, Centers, WebhookInbox, id, now, withTransaction } = require('../db');

const IMAGE_RATE_LIMIT = Number(process.env.IMAGE_RATE_LIMIT_PER_MINUTE) || 5;
const WEBHOOK_PROCESSING_LEASE_MS = 5 * 60 * 1000;
const webhookParser = (process.env.NODE_ENV === 'test' || process.env.ALLOW_UNSIGNED_LINE_WEBHOOK === 'true')
  ? express.json()
  : line.middleware({ channelSecret: process.env.LINE_CHANNEL_SECRET || 'missing-channel-secret' });

function requireMessagingCapability(req, res, next) {
  if (!messagingConfigured()) {
    return res.status(503).json({
      error: 'line_messaging_unavailable',
      message: 'LINE Messaging/Webhook ไม่ได้เปิดใช้งานใน environment นี้',
    });
  }
  next();
}

async function safeReply(replyToken, messages) {
  return lineClient.replyMessage(replyToken, Array.isArray(messages) ? messages : [messages]);
}

function isUserIdCommand(event) {
  return event?.type === 'message'
    && event.message?.type === 'text'
    && String(event.message.text || '').trim().toLowerCase() === 'user_id';
}

async function handleUserIdCommand(event) {
  if (!isUserIdCommand(event)) return false;
  const lineUserId = typeof event.source?.userId === 'string' && event.source.userId
    ? event.source.userId
    : null;
  if (event.replyToken) {
    await safeReply(event.replyToken, {
      type: 'text',
      text: lineUserId ? `LINE User ID:\n${lineUserId}` : 'ไม่พบ LINE User ID ของบัญชีนี้',
    });
  }
  return true;
}

const OPEN_CENTER_COMMANDS = new Set([
  'opencenter', 'open center', 'เปิดศูนย์', 'สมัครศูนย์', 'ลงทะเบียนศูนย์',
]);

function normalizeTextCommand(value) {
  return String(value || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

function isOpenCenterCommand(event) {
  return event?.type === 'message'
    && event.message?.type === 'text'
    && OPEN_CENTER_COMMANDS.has(normalizeTextCommand(event.message.text));
}

async function handleOpenCenterCommand(event) {
  if (!isOpenCenterCommand(event)) return false;
  // Recognized aliases are deliberately consumed without a response outside a
  // one-to-one chat. Registration onboarding must never appear in any group.
  if (event.source?.type !== 'user') return true;
  if (!event.replyToken) return true;
  const registerLiffId = String(process.env.LIFF_ID_REGISTER || '').trim();
  if (!registerLiffId) {
    await safeReply(event.replyToken, {
      type:'text',
      text:'ขณะนี้ยังไม่สามารถเปิดหน้าลงทะเบียนศูนย์ได้\nกรุณาติดต่อทีมงานพี่หมอ',
    });
    return true;
  }
  await safeReply(event.replyToken, {
    type:'template',
    altText:'เปิดศูนย์ใหม่กับพี่หมอ',
    template:{
      type:'buttons',
      text:'สำหรับเจ้าของศูนย์ดูแลที่ต้องการเริ่มใช้งานพี่หมอ\nกดด้านล่างเพื่อลงทะเบียนศูนย์',
      actions:[{
        type:'uri', label:'ลงทะเบียนศูนย์ใหม่',
        uri:`https://liff.line.me/${registerLiffId}`,
      }],
    },
  });
  return true;
}

async function handleJoinEvent(event) {
  const groupId = event.source.groupId;
  if (!groupId) return;
  // join event ไม่รับประกัน userId ของผู้เชิญ จึงห้ามเดาว่าเป็นกลุ่มพนักงานหรือครอบครัว
  await lineClient.pushMessage(groupId, [{
    type: 'text',
    text: 'พี่หมอเข้ากลุ่มแล้วค่ะ กรุณาส่งรหัส STAFF-xxxxxx, FAMILY-xxxxxx หรือ CGROUP-xxxxxx ที่สร้างไว้ หรือรหัสตั้งค่ากลุ่ม Care2Go ตามที่ผู้ดูแลระบบกำหนด',
  }], { retryKey:webhookRetryKey(event, 'group-onboarding') });
}

async function captureStaffFromGroupEvent(event) {
  if (event.message.type !== 'text' && event.message.type !== 'sticker') return;
  const groupId = event.source?.groupId;
  const lineUserId = event.source?.userId;
  if (!groupId || !lineUserId) return;
  await centerService.recordStaffFromGroup(groupId, lineUserId);
}

async function handleGroupBindingCode(event) {
  if (event.message?.type !== 'text') return false;
  const raw = String(event.message.text || '').trim();
  if (process.env.CARE2GO_GROUP_BIND_CODE && raw === process.env.CARE2GO_GROUP_BIND_CODE) {
    const result = await transportService.bindCare2goOperationsGroup(event.source?.groupId, event.source?.userId);
    await safeReply(event.replyToken,{type:'text',text:result.ok
      ? '✅ ผูกกลุ่มนี้เป็นกลุ่มปฏิบัติการ Care2Go แล้ว'
      : `⚠️ ผูกกลุ่มไม่สำเร็จ: ${result.reason}`});
    return true;
  }
  const match = raw.toUpperCase().match(/\b(?:CGROUP-[A-F0-9]{32}|(?:STAFF|FAMILY)-[A-Z0-9]{6})\b/);
  if (!match) return false;
  const groupBindingService = require('../services/groupBindingService');
  const result = await groupBindingService.consumeCodeFromGroup({
    code: match[0], groupId: event.source?.groupId, senderLineId: event.source?.userId,
  });
  await safeReply(event.replyToken, {
    type: 'text',
    text: result.ok
      ? (result.kind === 'center_staff' ? '✅ ผูกเป็นกลุ่มพนักงานของสาขาเรียบร้อยค่ะ'
        : result.kind === 'center_family' ? '✅ เชื่อมกลุ่มนี้กับ Care Profile เรียบร้อยแล้ว'
          : '✅ ผูกเป็นกลุ่มครอบครัวเรียบร้อยค่ะ')
      : `⚠️ ผูกกลุ่มไม่สำเร็จ: ${result.reason}`,
  });
  return true;
}

async function handleImageMessage(event, imageBuffer) {
  const groupId = event.source.groupId;
  const lineUserId = event.source.userId;

  if (groupId) return safeReply(event.replyToken, { type: 'text', text: 'เพื่อรักษาความเป็นส่วนตัว กรุณาส่งรูปเอกสารในแชทส่วนตัวกับพี่หมอค่ะ' });
  if (!lineUserId) return;

  const center = await centerService.findCenterByStaffUser(lineUserId);
  if (!center) {
    const staffCenters = await centerService.listCentersByStaffUser(lineUserId);
    if (staffCenters.length > 1) {
      return safeReply(event.replyToken, {
        type: 'text', text: 'กรุณาเลือกสาขาสำหรับเอกสารนี้ แล้วส่งรูปอีกครั้งค่ะ',
        quickReply: { items: staffCenters.slice(0, 13).map((c) => ({
          type: 'action', action: { type: 'postback', label: String(c.name).slice(0, 20), data: `action=set_active_center&centerId=${c.center_id}` },
        })) },
      });
    }
    const profile = await CareProfiles.findOne((p) => p.owner_line_id === lineUserId && p.status === 'independent');
    if (profile) return safeReply(event.replyToken, { type: 'text', text: familyService.AI_RESTRICTED_MESSAGE });
    
    return safeReply(event.replyToken, {
      type: 'text', text: 'พี่หมอยังไม่รู้จักคุณเลยครับ รบกวนพิมพ์ทักทาย หรือส่งสติ๊กเกอร์ 1 ตัวใน "กลุ่มงานศูนย์" เพื่อให้พี่หมอจำหน้าได้ก่อนน้า'
    });
  }

  let rl;
  try {
    rl = await rateLimiter.checkAndRecord(lineUserId, IMAGE_RATE_LIMIT, 60000, { domain:'line_image_ingestion' });
  } catch (_) {
    return safeReply(event.replyToken, { type:'text', text:'ระบบจำกัดการส่งรูปยังไม่พร้อม กรุณาลองใหม่ภายหลังค่ะ' });
  }
  if (!rl.allowed) {
    const waitSec = Math.ceil(rl.retryAfterMs / 1000);
    return safeReply(event.replyToken, { type: 'text', text: `ส่งรูปถี่เกินไปค่ะ กรุณารออีกประมาณ ${waitSec} วินาทีแล้วลองใหม่` });
  }

  const result = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer, submittedBy: lineUserId });
  if (result.rejected) return safeReply(event.replyToken, { type: 'text', text: `🤔 ${result.reason}` });
  if (result.needsSelection) return safeReply(event.replyToken, flex.residentSelectionQuickReply(result.card.card_id, result.candidates));
  await notifyApproversAndSubmitter(event, result.card, center);
}

async function notifyApproversAndSubmitter(event, card, center) {
  const resident = await Residents.findOne((r) => r.resident_id === card.resident_id);
  const data = card.edited_result || card.ai_result;
  const approvers = await centerService.listApprovers(center.center_id);
  for (const approver of approvers) {
    await lineClient.pushMessage(approver.line_user_id, [flex.confirmCardFlex({ cardId: card.card_id, residentName: resident.full_name, room: resident.room, data })]);
  }
  if (event?.replyToken) {
    const isLab = data.documentSubtype === 'lab_report';
    const editUrl = isLab
      ? `\nตรวจและแก้ฉบับร่างได้ที่\nhttps://liff.line.me/${process.env.LIFF_ID_CENTER_ADMIN || 'YOUR_LIFF_ID'}?view=edit-card&cardId=${card.card_id}`
      : '';
    await safeReply(event.replyToken, {
      type: 'text',
      text: `รับข้อมูลของ ${resident.full_name} แล้วค่ะ\n${isLab ? 'ผล Lab ยังเป็นฉบับรอตรวจสอบ' : 'ส่งให้ผู้จัดการตรวจสอบและยืนยันเรียบร้อย'}${editUrl}`,
    });
  }
}

async function handlePostback(event) {
    const params = new URLSearchParams(event.postback.data);
    const action = params.get('action');
    const lineUserId = event.source.userId;

    if (action === 'set_active_center') {
      const result = await centerService.setActiveCenterForStaff(lineUserId, params.get('centerId'));
      return safeReply(event.replyToken, { type: 'text', text: result.ok ? '✅ เลือกสาขาแล้ว กรุณาส่งรูปเอกสารอีกครั้งค่ะ' : `⚠️ ${result.reason}` });
    }

    if (action === 'select_resident') {
        const cardId = params.get('cardId');
        const residentId = params.get('residentId');
        const card = await PendingCards.findOne((c) => c.card_id === cardId);
        const membership = card ? await CenterStaff.findOne((s) => s.center_id === card.center_id && s.line_user_id === lineUserId && (!s.status || s.status === 'active')) : null;
        const staffCenter = membership ? await Centers.findOne((c) => c.center_id === card.center_id) : null;
        const entitlement = require('../services/subscriptionService').entitlement(staffCenter);
        if (!card || !membership || !entitlement.allowed) {
          return safeReply(event.replyToken, { type: 'text', text: '⚠️ คุณไม่มีสิทธิ์เลือกผู้พักสำหรับรายการนี้' });
        }
        const result = await cardService.selectResidentForCard(cardId, residentId, lineUserId);
        if (!result.ok) return safeReply(event.replyToken, { type: 'text', text: result.reason });

        const updatedCard = await PendingCards.findOne((c) => c.card_id === cardId);
        if (staffCenter) await notifyApproversAndSubmitter(event, updatedCard, staffCenter);
        return;
    }

    if (action === 'confirm_card') {
        const cardId = params.get('cardId');
        const card = await PendingCards.findOne((c) => c.card_id === cardId);
        const center = card && await Centers.findOne((c) => c.center_id === card.center_id);
        const entitlement = require('../services/subscriptionService').entitlement(center);
        if (!card || !entitlement.allowed) {
          return safeReply(event.replyToken, { type: 'text', text: '⚠️ ไม่สามารถยืนยันได้ กรุณาตรวจสอบสิทธิ์แพ็กเกจของศูนย์' });
        }
        const profile = await lineClient.getProfile(lineUserId);
        const result = await cardService.confirmCard(cardId, lineUserId, profile.displayName);
        if (!result.ok) return safeReply(event.replyToken, { type: 'text', text: `⚠️ ${result.reason}` });

        if (result.submittedBy && result.submittedBy !== lineUserId) {
           await lineClient.pushMessage(result.submittedBy, [{ type: 'text', text: `ผู้จัดการยืนยันข้อมูลที่ท่านส่งมาแล้ว และส่งให้ครอบครัวเรียบร้อยค่ะ` }]);
        }
        return safeReply(event.replyToken, { type: 'text', text: '✅ ส่งข้อมูลให้ครอบครัวเรียบร้อยค่ะ' });
    }

    if (action === 'edit_card') {
        const cardId = params.get('cardId');
        const card = await PendingCards.findOne((c) => c.card_id === cardId);
        if (card) {
           const center = await Centers.findOne((c) => c.center_id === card.center_id);
           const isLab = (card.document_subtype || card.ai_result?.documentSubtype) === 'lab_report';
           const membership = isLab ? await CenterStaff.findOne((s) =>
             s.center_id === card.center_id && s.line_user_id === lineUserId && (!s.status || s.status === 'active')) : null;
           const allowed = isLab ? Boolean(membership) : await centerService.canApprove(card.center_id, lineUserId);
           const entitlement = require('../services/subscriptionService').entitlement(center);
           if (!allowed || !entitlement.allowed) return safeReply(event.replyToken, { type: 'text', text: '⚠️ ไม่สามารถแก้ไขได้ กรุณาตรวจสอบบทบาทและสิทธิ์แพ็กเกจของศูนย์' });
        }
        const editUrl = `https://liff.line.me/${process.env.LIFF_ID_CENTER_ADMIN || 'YOUR_LIFF_ID'}?view=edit-card&cardId=${cardId}`;
        return safeReply(event.replyToken, { type: 'text', text: `แก้ไขข้อมูลก่อนส่งได้ที่นี่ค่ะ\n${editUrl}` });
    }

    if (['transport_self','transport_request_center','transport_care2go'].includes(action)) {
        const url = `https://liff.line.me/${process.env.LIFF_ID_FAMILY || 'YOUR_LIFF_ID'}?view=transport`;
        return safeReply(event.replyToken, { type:'text', text:`เพื่อป้องกันการกดผิด กรุณาตรวจสอบและเลือกวิธีเดินทางใน Family LIFF ค่ะ\n${url}` });
    }

    if (action === 'care2go_ack' || action === 'care2go_confirm') {
        return safeReply(event.replyToken,{type:'text',text:'ℹ️ ปุ่มจากการ์ดรุ่นเก่าไม่ใช้แล้ว กรุณาโทรประสานผู้ติดต่อจากรายละเอียดในการ์ดโดยตรงค่ะ'});
    }

    if (action === 'center_own' || action === 'center_care2go') {
        const planId = params.get('planId');
        const choice = action === 'center_own' ? 'center_own' : 'care2go';
        const plan = await require('../db').TransportPlans.findOne((p) => p.plan_id === planId);
        if (!plan || !await centerService.canApprove(plan.center_id, lineUserId)) return safeReply(event.replyToken, { type: 'text', text: '⚠️ เฉพาะเจ้าของหรือผู้จัดการของสาขานี้เท่านั้นที่ตัดสินใจได้' });
        const result = await transportService.centerChoose(planId, choice, lineUserId, { needs: ['escort', 'vehicle'] });
        return safeReply(event.replyToken, { type: 'text', text: result.ok ? 'บันทึกแล้วค่ะ แจ้งครอบครัวเรียบร้อย' : result.reason });
    }

    if (action === 'report_issue') {
        const cardId = params.get('cardId');
        const result = await cardService.reportCardIssue(cardId, lineUserId, null);
        const msg = result.ok ? 'รับทราบค่ะ แจ้งศูนย์ให้ตรวจสอบแล้ว จะติดต่อกลับโดยเร็วที่สุด' : `⚠️ ${result.reason}`;
        return safeReply(event.replyToken, { type: 'text', text: msg });
    }
}

async function processEvent(event) {
      if (await handleOpenCenterCommand(event)) {
        return;
      } else if (await handleUserIdCommand(event)) {
        return;
      } else if (event.type === 'memberLeft') {
        const groupId = event.source.groupId || event.source.roomId;
        const leftMembers = event.left.members;
        for (const member of leftMembers) {
            await require('../services/groupBindingService').handleMemberLeft(groupId, member.userId);
        }
      } else if (event.type === 'leave') {
        const groupId = event.source.groupId || event.source.roomId;
        await require('../services/groupBindingService').deactivateGroup(groupId);
      } else if (event.type === 'join') {
        await handleJoinEvent(event);
      } else if (event.type === 'memberJoined') {
        const groupId = event.source.groupId || event.source.roomId;
        for (const member of event.joined?.members || []) {
          await centerService.recordStaffFromGroup(groupId, member.userId);
        }
      } else if (event.type === 'message' && event.message.type === 'image') {
        let imageBuffer;
        if (event.message.mockBase64) {
            imageBuffer = Buffer.from(event.message.mockBase64, 'base64');
        } else {
            const stream = await blobClient.getMessageContent(event.message.id);
            const chunks = [];
            for await (const chunk of stream) { chunks.push(chunk); }
            imageBuffer = Buffer.concat(chunks);
        }
        await handleImageMessage(event, imageBuffer);
      } else if (event.type === 'postback') {
        await handlePostback(event);
      } else if (event.type === 'message' && event.source?.groupId) {
        const handledBinding = await handleGroupBindingCode(event);
        if (!handledBinding) await captureStaffFromGroupEvent(event);
      }
}

function eventKey(event) {
  if (event.webhookEventId) return event.webhookEventId;
  return createHash('sha256').update(JSON.stringify({ type:event.type, timestamp:event.timestamp, source:event.source, message:event.message, postback:event.postback?.data, replyToken:event.replyToken })).digest('hex');
}

function webhookRetryKey(event, purpose) {
  const bytes = Buffer.from(createHash('sha256').update(`${purpose}:${eventKey(event)}`).digest().subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`;
}

function processingLeaseExpired(item, currentTime = Date.now()) {
  if (item.status !== 'processing' || !item.processing_started_at) return false;
  const started = new Date(item.processing_started_at).getTime();
  return Number.isFinite(started) && currentTime - started >= WEBHOOK_PROCESSING_LEASE_MS;
}

async function enqueueWebhookEvent(event) {
  const key = eventKey(event);
  return withTransaction(`line-webhook-intake:${key}`, async () => {
    const existing = await WebhookInbox.findOne((item) => item.event_key === key);
    if (existing) return { inserted:false, item:existing };
    const item = await WebhookInbox.insert({
      inbox_id:id('WH'), event_key:key, event, status:'pending', attempts:0, received_at:now(),
    });
    return { inserted:true, item };
  });
}

async function claimWebhookEvent(candidate) {
  return withTransaction(`line-webhook-process:${candidate.inbox_id}`, async () => {
    const current = await WebhookInbox.findOne((item) => item.inbox_id === candidate.inbox_id);
    if (!current) return null;
    if (!['pending', 'retrying'].includes(current.status) && !processingLeaseExpired(current)) return null;
    const claimId = id('WHC');
    return WebhookInbox.update((item) => item.inbox_id === current.inbox_id, {
      status:'processing', processing_claim_id:claimId, processing_started_at:now(),
    });
  });
}

async function processPendingWebhookEvents(limit = 50) {
  const pending = await WebhookInbox.findWhere((item) =>
    ['pending', 'retrying'].includes(item.status) || processingLeaseExpired(item));
  let processed = 0;
  for (const candidate of pending.slice(0, limit)) {
    const item = await claimWebhookEvent(candidate);
    if (!item) continue;
    try {
      await processEvent(item.event);
      await WebhookInbox.update((entry) => entry.inbox_id === item.inbox_id
        && entry.processing_claim_id === item.processing_claim_id, {
        status:'processed', processed_at:now(), attempts:Number(item.attempts||0)+1,
        processing_claim_id:null, processing_started_at:null,
      });
      processed += 1;
    } catch (err) {
      const attempts = Number(item.attempts || 0) + 1;
      await WebhookInbox.update((entry) => entry.inbox_id === item.inbox_id
        && entry.processing_claim_id === item.processing_claim_id, {
        status:attempts>=5?'dead_letter':'retrying', attempts,
        last_error:String(err.message||err).slice(0,500), last_attempt_at:now(),
        processing_claim_id:null, processing_started_at:null,
      });
      console.error('webhook handler error:', err);
    }
  }
  return { processed };
}

router.post('/webhook', requireMessagingCapability, webhookParser, async (req, res) => {
  const events = req.body.events || [];
  // Persist every event before acknowledging LINE.  A worker can replay a
  // pending item after a process restart, and webhookEventId prevents doubles.
  for (const event of events) {
    await enqueueWebhookEvent(event);
  }
  res.status(200).end();
  await processPendingWebhookEvents();
});

module.exports = router;
module.exports.processPendingWebhookEvents = processPendingWebhookEvents;
module.exports.requireMessagingCapability = requireMessagingCapability;
module.exports.isUserIdCommand = isUserIdCommand;
module.exports.handleUserIdCommand = handleUserIdCommand;
module.exports.normalizeTextCommand = normalizeTextCommand;
module.exports.isOpenCenterCommand = isOpenCenterCommand;
module.exports.handleOpenCenterCommand = handleOpenCenterCommand;
module.exports.processEvent = processEvent;
module.exports.enqueueWebhookEvent = enqueueWebhookEvent;
module.exports.webhookRetryKey = webhookRetryKey;
