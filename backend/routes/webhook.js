// routes/webhook.js — รับ Event จาก LINE ทั้งหมด แยกประเภทแล้วส่งต่อ (Technical Design หมวด 5.1)
//
// ⚠️ โหมดนี้ยังไม่ตรวจสอบ Signature จาก LINE จริง (ต้องเพิ่มก่อน Deploy)
//    และรับรูปภาพแบบ Base64 ใน body ตรงๆ เพื่อให้ทดสอบง่าย
//    ของจริงต้องดึงเนื้อหารูปผ่าน MessagingApiBlobClient.getMessageContent()
//
// ── โครงสร้าง Flow ที่ปรับใหม่ ──
// ① กลุ่มงานศูนย์  = ใช้เพื่อ "ระบุตัวตนพนักงาน" เท่านั้น ไม่ใช้ส่งรูป
//                    ทุก Event ที่เกิดในกลุ่ม ระบบจะบันทึกว่าผู้ส่งเป็นพนักงานของศูนย์ใด
//                    (LINE ไม่มี API ค้นย้อนว่าผู้ใช้อยู่กลุ่มไหน จึงต้องเก็บเองแบบนี้)
// ② แชทส่วนตัวพนักงาน = ใช้ส่งรูปเอกสาร กันไม่ให้เรื่องอื่นปนในกลุ่ม และกัน AI อ่านรูปที่ไม่เกี่ยวข้อง
// ③ แชทส่วนตัวผู้จัดการ = ใช้ตรวจและยืนยันการ์ด พนักงานทั่วไปยืนยันไม่ได้
//                          เหตุผล: ต้องมีผู้รับผิดชอบชัดเจน และกันการกดยืนยันซ้ำซ้อนโดยไม่มีใครรู้

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

const IMAGE_RATE_LIMIT = Number(process.env.IMAGE_RATE_LIMIT_PER_MINUTE) || 5; // ข้อ C5

async function safeReply(replyToken, messages) {
  return lineClient.replyMessage(replyToken, Array.isArray(messages) ? messages : [messages]);
}

// ── ข้อ A2: เมื่อพี่หมอถูกเชิญเข้ากลุ่ม และผู้เชิญมีสิทธิ์ → ผูกกลุ่มอัตโนมัติ ──
async function handleJoinEvent(event) {
  const groupId = event.source.groupId;
  const inviterLineId = event.source.userId;
  if (!groupId || !inviterLineId) return;

  const { CenterStaff } = require('../db');
  const staffRows = await CenterStaff.findWhere(
    (s) => s.line_user_id === inviterLineId && ['owner', 'manager'].includes(s.role)
  );
  if (staffRows.length === 0) return; // ไม่ใช่เจ้าของ/ผู้จัดการศูนย์ใด ไม่ผูกอัตโนมัติ

  const result = await centerService.bindGroupToCenter({ centerId: staffRows[0].center_id, groupId, requesterLineId: inviterLineId });
  if (result.ok) {
    await lineClient.pushMessage(groupId, [{
      type: 'text',
      text: 'ผูกกลุ่มนี้เป็นกลุ่มงานศูนย์เรียบร้อยค่ะ\n\nขั้นตอนต่อไปสำหรับพนักงานทุกคน:\nพิมพ์ทักทายอะไรก็ได้ในกลุ่มนี้หนึ่งครั้ง เพื่อให้ระบบรู้จักว่าท่านเป็นพนักงานของศูนย์นี้\nจากนั้นส่งรูปเอกสารมาที่แชทส่วนตัวกับพี่หมอได้เลย',
    }]);
  }
}

// ── บันทึกทะเบียนพนักงานอัตโนมัติจาก Event ที่เกิดในกลุ่มงานศูนย์ ──
async function captureStaffFromGroupEvent(event) {
  const groupId = event.source?.groupId;
  const lineUserId = event.source?.userId;
  if (!groupId || !lineUserId) return;

  const staff = await centerService.recordStaffFromGroup(groupId, lineUserId);
  // แจ้งเฉพาะครั้งแรกที่บันทึกใหม่ เพื่อให้พนักงานรู้ว่าลงทะเบียนแล้วและทำอะไรต่อ
  if (staff && staff.auto_registered && event.replyToken) {
    await safeReply(event.replyToken, {
      type: 'text',
      text: 'ระบบจดจำท่านเป็นพนักงานของศูนย์นี้แล้วค่ะ\n\nต่อไปส่งรูปใบนัด ใบสั่งยา หรือผลตรวจ มาที่แชทส่วนตัวกับพี่หมอได้เลย ไม่ต้องส่งในกลุ่มนี้',
    });
  }
}

// ── รับรูปภาพ (เฉพาะแชทส่วนตัวเท่านั้น) ──
async function handleImageMessage(event, imageBuffer) {
  const groupId = event.source.groupId;
  const lineUserId = event.source.userId;

  // ส่งรูปในกลุ่ม → ไม่ประมวลผล และแนะนำให้ส่งส่วนตัวแทน
  // (กันเรื่องอื่นปนในกลุ่ม และกัน AI อ่านรูปที่ไม่เกี่ยวข้อง)
  if (groupId) {
    return safeReply(event.replyToken, {
      type: 'text',
      text: 'กรุณาส่งรูปเอกสารมาที่แชทส่วนตัวกับพี่หมอแทนนะคะ เพื่อไม่ให้ปนกับการพูดคุยเรื่องอื่นในกลุ่ม',
    });
  }
  if (!lineUserId) return;

  // ── ตรวจว่าเป็นพนักงานของศูนย์ใด ──
  const center = await centerService.findCenterByStaffUser(lineUserId);
  if (!center) {
    // อาจเป็นครอบครัวที่ใช้ Care Profile แบบอิสระ (ข้อ N4)
    const profile = await CareProfiles.findOne((p) => p.owner_line_id === lineUserId && p.status === 'independent');
    if (profile) {
      return safeReply(event.replyToken, { type: 'text', text: familyService.AI_RESTRICTED_MESSAGE });
    }
    // พนักงานที่ระบบยังไม่รู้จัก
    return safeReply(event.replyToken, {
      type: 'text',
      text: 'ระบบยังไม่รู้จักท่านค่ะ\n\nกรุณาพิมพ์ทักทายอะไรก็ได้ในกลุ่มงานศูนย์ของท่านหนึ่งครั้งก่อน เพื่อให้ระบบทราบว่าท่านเป็นพนักงานของศูนย์ใด จากนั้นส่งรูปมาที่นี่ได้เลย',
    });
  }

  // ข้อ C5: จำกัดอัตราการส่งรูปต่อผู้ใช้ เพื่อควบคุมต้นทุน AI
  const rl = rateLimiter.checkAndRecord(lineUserId, IMAGE_RATE_LIMIT, 60000);
  if (!rl.allowed) {
    const waitSec = Math.ceil(rl.retryAfterMs / 1000);
    return safeReply(event.replyToken, { type: 'text', text: `ส่งรูปถี่เกินไปค่ะ กรุณารออีกประมาณ ${waitSec} วินาทีแล้วลองใหม่` });
  }

  const result = await cardService.handleIncomingPhoto({ centerId: center.center_id, imageBuffer, submittedBy: lineUserId });

  // ข้อ C3: ไม่ใช่เอกสารทางการแพทย์ → ปฏิเสธสุภาพ ไม่สร้างการ์ด
  if (result.rejected) {
    return safeReply(event.replyToken, { type: 'text', text: `🤔 ${result.reason}` });
  }

  // ข้อ D3: AI ไม่มั่นใจว่าเป็นของใคร → ให้พนักงานที่ถ่ายเป็นคนเลือก (เพราะถือเอกสารอยู่)
  if (result.needsSelection) {
    return safeReply(event.replyToken, flex.residentSelectionQuickReply(result.card.card_id, result.candidates));
  }

  await notifyApproversAndSubmitter(event, result.card, center);
}

// ── ส่งการ์ดยืนยันเข้าแชทส่วนตัวของเจ้าของและผู้จัดการทุกคน ──
async function notifyApproversAndSubmitter(event, card, center) {
  const resident = await Residents.findOne((r) => r.resident_id === card.resident_id);
  const data = card.edited_result || card.ai_result;

  const approvers = await centerService.listApprovers(center.center_id);
  for (const approver of approvers) {
    await lineClient.pushMessage(approver.line_user_id, [
      flex.confirmCardFlex({ cardId: card.card_id, residentName: resident.full_name, room: resident.room, data }),
    ]);
  }

  // ตอบกลับพนักงานที่ส่งรูปว่าส่งต่อให้ผู้จัดการแล้ว
  if (event?.replyToken) {
    await safeReply(event.replyToken, {
      type: 'text',
      text: `รับข้อมูลของ ${resident.full_name} แล้วค่ะ\nส่งให้ผู้จัดการตรวจสอบและยืนยันเรียบร้อย`,
    });
  }
}

// ── Postback ต่างๆ ──
async function handlePostback(event) {
  const params = new URLSearchParams(event.postback.data);
  const action = params.get('action');
  const lineUserId = event.source.userId;

  // พนักงานเลือกชื่อผู้พัก (เมื่อ AI ไม่มั่นใจ)
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

  // ผู้จัดการยืนยันการ์ด
  if (action === 'confirm_card') {
    const cardId = params.get('cardId');
    const profile = await lineClient.getProfile(lineUserId);
    const result = await cardService.confirmCard(cardId, lineUserId, profile.displayName);
    if (!result.ok) return safeReply(event.replyToken, { type: 'text', text: `⚠️ ${result.reason}` });

    // แจ้งกลับพนักงานที่ถ่ายรูปส่งมาว่าผู้จัดการยืนยันแล้ว
    if (result.submittedBy && result.submittedBy !== lineUserId) {
      await lineClient.pushMessage(result.submittedBy, [{
        type: 'text', text: `ผู้จัดการยืนยันข้อมูลที่ท่านส่งมาแล้ว และส่งให้ครอบครัวเรียบร้อยค่ะ`,
      }]);
    }
    return safeReply(event.replyToken, { type: 'text', text: '✅ ส่งข้อมูลให้ครอบครัวเรียบร้อยค่ะ' });
  }

  // ผู้จัดการเปิดหน้าแก้ไข
  if (action === 'edit_card') {
    const cardId = params.get('cardId');
    const card = await PendingCards.findOne((c) => c.card_id === cardId);
    if (card) {
      const allowed = await centerService.canApprove(card.center_id, lineUserId);
      if (!allowed) {
        return safeReply(event.replyToken, { type: 'text', text: '⚠️ เฉพาะเจ้าของศูนย์และผู้จัดการเท่านั้นที่แก้ไขข้อมูลได้' });
      }
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

  // ข้อ F4: ครอบครัวกดปุ่มแจ้งว่าข้อมูลไม่ถูกต้อง
  if (action === 'report_issue') {
    const cardId = params.get('cardId');
    const result = await cardService.reportCardIssue(cardId, lineUserId, null);
    const msg = result.ok
      ? 'รับทราบค่ะ แจ้งศูนย์ให้ตรวจสอบแล้ว จะติดต่อกลับโดยเร็วที่สุด'
      : `⚠️ ${result.reason}`;
    return safeReply(event.replyToken, { type: 'text', text: msg });
  }
}

// ── จุดเข้า Webhook หลัก ──
router.post('/webhook', express.json(), async (req, res) => {
  res.status(200).end(); // ตอบ 200 ทันทีตามข้อกำหนด แล้วประมวลผลต่อแบบไม่รอ (async)
  const events = req.body.events || [];

  for (const event of events) {
    try {
      if (event.type === 'join' || event.type === 'memberJoined') {
        await handleJoinEvent(event);
      } else if (event.type === 'message' && event.message.type === 'image') {
        const imageBuffer = Buffer.from(event.message.mockBase64 || '', 'base64'); // ของจริง: getMessageContent()
        await handleImageMessage(event, imageBuffer);
      } else if (event.type === 'postback') {
        await handlePostback(event);
      } else if (event.type === 'message' && event.source?.groupId) {
        // ข้อความอื่นในกลุ่มงานศูนย์ ใช้เพื่อบันทึกทะเบียนพนักงานอัตโนมัติเท่านั้น
        // ไม่มีการตีความข้อความเป็นคำสั่งใดๆ ทั้งสิ้น (ข้อ B8)
        await captureStaffFromGroupEvent(event);
      }
    } catch (err) {
      console.error('webhook handler error:', err);
    }
  }
});

module.exports = router;
