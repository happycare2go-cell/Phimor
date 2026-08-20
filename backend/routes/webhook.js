const express = require('express');
const router = express.Router();

const centerService = require('../services/centerService');
const cardService = require('../services/cardService');
const transportService = require('../services/transportService');
const familyService = require('../services/familyService');
const lineClient = require('../providers/lineClient');
const flex = require('../flexMessages');
const rateLimiter = require('../utils/rateLimiter');
const { Residents, PendingCards, CareProfiles } = require('../db');

const IMAGE_RATE_LIMIT = Number(process.env.IMAGE_RATE_LIMIT_PER_MINUTE) || 5;

async function safeReply(replyToken, messages) {
  return lineClient.replyMessage(replyToken, Array.isArray(messages) ? messages : [messages]);
}

async function handleJoinEvent(event) {
  const groupId = event.source.groupId;
  const inviterLineId = event.source.userId;
  if (!groupId || !inviterLineId) return;

  const { CenterStaff } = require('../db');
  const staffRows = await CenterStaff.findWhere((s) => s.line_user_id === inviterLineId && ['owner', 'manager'].includes(s.role));
  if (staffRows.length === 0) return;

  const result = await centerService.bindGroupToCenter({ centerId: staffRows[0].center_id, groupId, requesterLineId: inviterLineId });
  if (result.ok) {
    await lineClient.pushMessage(groupId, [{ type: 'text', text: 'ผูกกลุ่มนี้เป็นกลุ่มงานศูนย์เรียบร้อยค่ะ\n\nขั้นตอนต่อไปสำหรับพนักงานทุกคน:\nพิมพ์ทักทายอะไรก็ได้ในกลุ่มนี้หนึ่งครั้ง เพื่อให้ระบบรู้จักว่าท่านเป็นพนักงานของศูนย์นี้\nจากนั้นส่งรูปเอกสารมาที่แชทส่วนตัวกับพี่หมอได้เลย' }]);
  }
}

async function captureStaffFromGroupEvent(event) {
  if (event.message.type !== 'text' && event.message.type !== 'sticker') return;
  const groupId = event.source?.groupId;
  const lineUserId = event.source?.userId;
  if (!groupId || !lineUserId) return;
  await centerService.recordStaffFromGroup(groupId, lineUserId);
}

async function handleImageMessage(event, imageBuffer) {
  const groupId = event.source.groupId;
  const lineUserId = event.source.userId;

  if (groupId) return; // โหมดนินจา
  if (!lineUserId) return;

  const center = await centerService.findCenterByStaffUser(lineUserId);
  if (!center) {
    const profile = await CareProfiles.findOne((p) => p.owner_line_id === lineUserId && p.status === 'independent');
    if (profile) return safeReply(event.replyToken, { type: 'text', text: familyService.AI_RESTRICTED_MESSAGE });
    
    return safeReply(event.replyToken, {
      type: 'text', text: 'พี่หมอยังไม่รู้จักคุณเลยครับ รบกวนพิมพ์ทักทาย หรือส่งสติ๊กเกอร์ 1 ตัวใน "กลุ่มไลน์งานศูนย์" เพื่อให้พี่หมอจำหน้าได้ก่อนน้า'
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

    if (action === 'select_resident') {
        const cardId = params.get('cardId');
        const residentId = params.get('residentId');
        const result = await cardService.selectResidentForCard(cardId, residentId);
        if (!result.ok) return safeReply(event.replyToken, { type: 'text', text: result.reason });

        const card = await PendingCards.findOne((c) => c.card_id === cardId);
        const center = await centerService.findCenterByStaffUser(lineUserId);
        if (center) await notifyApproversAndSubmitter(event, card, center);
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

router.post('/webhook', express.json(), async (req, res) => {
  res.status(200).end();
  const events = req.body.events || [];

  for (const event of events) {
    try {
      if (event.type === 'memberLeft') {
        const groupId = event.source.groupId || event.source.roomId;
        const leftMembers = event.left.members;
        for (const member of leftMembers) {
            await centerService.removeStaffFromGroup(groupId, member.userId);
        }
      } else if (event.type === 'join' || event.type === 'memberJoined') {
        await handleJoinEvent(event);
      } else if (event.type === 'message' && event.message.type === 'image') {
        const imageBuffer = Buffer.from(event.message.mockBase64 || '', 'base64');
        await handleImageMessage(event, imageBuffer);
      } else if (event.type === 'postback') {
        await handlePostback(event);
      } else if (event.type === 'message' && event.source?.groupId) {
        await captureStaffFromGroupEvent(event);
      }
    } catch (err) {
      console.error('webhook handler error:', err);
    }
  }
});

module.exports = router;
