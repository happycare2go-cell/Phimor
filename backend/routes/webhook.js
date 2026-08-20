const line = require('@line/bot-sdk');
const blobClient = new line.messagingApi.MessagingApiBlobClient({ channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN || 'dummy' });
const express = require('express');
const router = express.Router();

const centerService = require('../services/centerService');
const cardService = require('../services/cardService');
const transportService = require('../services/transportService');
const familyService = require('../services/familyService');
const lineClient = require('../providers/lineClient');
const flex = require('../flexMessages');
const rateLimiter = require('../utils/rateLimiter');
const { Residents, PendingCards, CareProfiles, CenterStaff, Centers } = require('../db');

const IMAGE_RATE_LIMIT = Number(process.env.IMAGE_RATE_LIMIT_PER_MINUTE) || 5;
const webhookParser = (process.env.NODE_ENV === 'test' || process.env.ALLOW_UNSIGNED_LINE_WEBHOOK === 'true')
  ? express.json()
  : line.middleware({ channelSecret: process.env.LINE_CHANNEL_SECRET || 'missing-channel-secret' });

async function safeReply(replyToken, messages) {
  return lineClient.replyMessage(replyToken, Array.isArray(messages) ? messages : [messages]);
}

async function handleJoinEvent(event) {
  const groupId = event.source.groupId;
  if (!groupId) return;
  // join event ไม่รับประกัน userId ของผู้เชิญ จึงห้ามเดาว่าเป็นกลุ่มพนักงานหรือครอบครัว
  await lineClient.pushMessage(groupId, [{
    type: 'text',
    text: 'พี่หมอเข้ากลุ่มแล้วค่ะ กรุณาให้ผู้ที่สร้างรหัสผูกกลุ่มส่งรหัส STAFF-xxxxxx หรือ FAMILY-xxxxxx ในกลุ่มนี้ภายใน 15 นาที',
  }]);
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
  const match = String(event.message.text || '').toUpperCase().match(/\b(STAFF|FAMILY)-[A-Z0-9]{6}\b/);
  if (!match) return false;
  const groupBindingService = require('../services/groupBindingService');
  const result = await groupBindingService.consumeCodeFromGroup({
    code: match[0], groupId: event.source?.groupId, senderLineId: event.source?.userId,
  });
  await safeReply(event.replyToken, {
    type: 'text',
    text: result.ok
      ? (result.kind === 'center_staff' ? '✅ ผูกเป็นกลุ่มพนักงานของสาขาเรียบร้อยค่ะ' : '✅ ผูกเป็นกลุ่มครอบครัวเรียบร้อยค่ะ')
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

  const rl = rateLimiter.checkAndRecord(lineUserId, IMAGE_RATE_LIMIT, 60000);
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
    await safeReply(event.replyToken, { type: 'text', text: `รับข้อมูลของ ${resident.full_name} แล้วค่ะ\nส่งให้ผู้จัดการตรวจสอบและยืนยันเรียบร้อย` });
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
        const membership = card ? await CenterStaff.findOne((s) => s.center_id === card.center_id && s.line_user_id === lineUserId) : null;
        const staffCenter = membership ? await Centers.findOne((c) => c.center_id === card.center_id && c.status === 'active') : null;
        if (!card || !staffCenter) {
          return safeReply(event.replyToken, { type: 'text', text: '⚠️ คุณไม่มีสิทธิ์เลือกผู้พักสำหรับรายการนี้' });
        }
        const result = await cardService.selectResidentForCard(cardId, residentId);
        if (!result.ok) return safeReply(event.replyToken, { type: 'text', text: result.reason });

        const updatedCard = await PendingCards.findOne((c) => c.card_id === cardId);
        if (staffCenter) await notifyApproversAndSubmitter(event, updatedCard, staffCenter);
        return;
    }

    if (action === 'confirm_card') {
        const cardId = params.get('cardId');
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
           const allowed = await centerService.canApprove(card.center_id, lineUserId);
           if (!allowed) return safeReply(event.replyToken, { type: 'text', text: '⚠️ เฉพาะเจ้าของศูนย์และผู้จัดการเท่านั้นที่แก้ไขข้อมูลได้' });
        }
        const editUrl = `https://liff.line.me/${process.env.LIFF_ID_CENTER_ADMIN || 'YOUR_LIFF_ID'}?view=edit-card&cardId=${cardId}`;
        return safeReply(event.replyToken, { type: 'text', text: `แก้ไขข้อมูลก่อนส่งได้ที่นี่ค่ะ\n${editUrl}` });
    }

    if (action === 'transport_self') {
        const planId = params.get('planId');
        const result = await transportService.familyChooseSelf(planId, lineUserId);
        return safeReply(event.replyToken, { type: 'text', text: result.ok ? 'บันทึกแล้วค่ะ ขับรถปลอดภัยนะคะ' : result.reason });
    }

    if (action === 'transport_request_center') {
        const planId = params.get('planId');
        const result = await transportService.familyRequestCenter(planId, lineUserId);
        return safeReply(event.replyToken, { type: 'text', text: result.ok ? 'ส่งเรื่องให้ศูนย์แล้ว รอศูนย์ยืนยันวิธีจัดการนะคะ' : result.reason });
    }

    if (action === 'center_own' || action === 'center_care2go') {
        const planId = params.get('planId');
        const choice = action === 'center_own' ? 'center_own' : 'care2go';
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

router.post('/webhook', webhookParser, async (req, res) => {
  res.status(200).end();
  const events = req.body.events || [];

  for (const event of events) {
    try {
      if (event.type === 'memberLeft') {
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
    } catch (err) {
      console.error('webhook handler error:', err);
    }
  }
});

module.exports = router;
