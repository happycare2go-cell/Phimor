// flexMessages.js — สร้าง Flex Message ตาม Phimor_Technical_Design.docx หมวด 4 (S5) และหมวด 6

// ── S5: การ์ดยืนยันก่อนส่งให้ครอบครัว — ชื่อผู้พักต้องใหญ่ที่สุด (ข้อ E1) ──
function confirmCardFlex({ cardId, residentName, room, data }) {
  const bodyContents = [
    { type: 'text', text: residentName + (room ? ` · ห้อง ${room}` : ''), weight: 'bold', size: 'xl', wrap: true, color: '#1C2B64' },
  ];

  if (data.appointment) {
    bodyContents.push(
      { type: 'separator', margin: 'md' },
      { type: 'text', text: '📅 นัดครั้งหน้า', weight: 'bold', size: 'sm', margin: 'md' },
      { type: 'text', text: `${data.appointment.hospital}\n${data.appointment.datetime}`, size: 'sm', wrap: true },
    );
    if (data.appointment.note) bodyContents.push({ type: 'text', text: data.appointment.note, size: 'xs', color: '#5A6580', wrap: true });
  }
  if (data.medications?.length) {
    bodyContents.push(
      { type: 'separator', margin: 'md' },
      { type: 'text', text: '💊 รายการยา', weight: 'bold', size: 'sm', margin: 'md' },
      ...data.medications.map((m) => ({ type: 'text', text: `${m.name} — ${m.dose}`, size: 'sm', wrap: true })),
    );
  }
  if (data.doctorNote) {
    bodyContents.push(
      { type: 'separator', margin: 'md' },
      { type: 'text', text: '📋 คำสั่งแพทย์', weight: 'bold', size: 'sm', margin: 'md' },
      { type: 'text', text: data.doctorNote, size: 'sm', wrap: true },
    );
  }

  return {
    type: 'flex',
    altText: `ตรวจสอบก่อนส่งให้ครอบครัว — ${residentName}`,
    contents: {
      type: 'bubble',
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#1C2B64', paddingAll: 'md',
        contents: [{ type: 'text', text: 'ตรวจสอบก่อนส่งให้ครอบครัว', color: '#FFFFFF', weight: 'bold', size: 'sm' }],
      },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: bodyContents },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm',
        contents: [
          { type: 'button', style: 'secondary', action: { type: 'postback', label: 'แก้ไขก่อนส่ง', data: `action=edit_card&cardId=${cardId}` } },
          { type: 'button', style: 'primary', color: '#1C2B64', action: { type: 'postback', label: 'ส่งเลย', data: `action=confirm_card&cardId=${cardId}` } },
        ],
      },
    },
  };
}

// ── ข้อ D3, D4: Quick Reply เลือกผู้พัก (สูงสุด 13 รายการ) ──
function residentSelectionQuickReply(cardId, candidates) {
  return {
    type: 'text',
    text: 'ไม่แน่ใจว่าเป็นข้อมูลของใคร กรุณาเลือกค่ะ',
    quickReply: {
      items: candidates.slice(0, 13).map((c) => ({
        type: 'action',
        action: { type: 'postback', label: c.fullName + (c.room ? ` (${c.room})` : ''), data: `action=select_resident&cardId=${cardId}&residentId=${c.residentId}` },
      })),
    },
  };
}

// ── ชั้นที่ 1: การ์ดให้ครอบครัวเลือกวิธีเดินทาง ──
function transportFamilyChoiceFlex({ planId, hospital, datetime }) {
  return {
    type: 'flex',
    altText: 'เลือกวิธีเดินทางไปพบแพทย์',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: 'นัดหมายที่กำลังจะถึง', weight: 'bold', size: 'md', color: '#1C2B64' },
          { type: 'text', text: `${hospital}\n${datetime}`, size: 'sm', wrap: true },
          { type: 'text', text: 'ใครจะพาไปดี', size: 'sm', margin: 'md', color: '#5A6580' },
        ],
      },
      footer: {
        type: 'box', layout: 'horizontal', spacing: 'sm',
        contents: [
          { type: 'button', style: 'secondary', action: { type: 'postback', label: 'เราไปเอง', data: `action=transport_self&planId=${planId}` } },
          { type: 'button', style: 'primary', color: '#1C2B64', action: { type: 'postback', label: 'ให้ศูนย์จัดการให้', data: `action=transport_request_center&planId=${planId}` } },
        ],
      },
    },
  };
}

// ── ชั้นที่ 2: การ์ดให้ศูนย์เลือก (เจ้าของ/ผู้จัดการเท่านั้น) — สองทาง ไม่มีปฏิเสธ (ข้อ L4) ──
function transportCenterChoiceFlex({ planId, residentName, room, hospital, datetime }) {
  return {
    type: 'flex',
    altText: 'ญาติขอให้ศูนย์จัดการเรื่องการเดินทาง',
    contents: {
      type: 'bubble',
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: 'ญาติขอให้ศูนย์จัดการ', weight: 'bold', size: 'md', color: '#1C2B64' },
          { type: 'text', text: `${residentName}${room ? ' · ห้อง ' + room : ''}`, weight: 'bold', size: 'sm' },
          { type: 'text', text: `${hospital}\n${datetime}`, size: 'sm', wrap: true },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'button', style: 'primary', color: '#1C2B64', action: { type: 'postback', label: 'ศูนย์จัดการเอง', data: `action=center_own&planId=${planId}` } },
          { type: 'button', style: 'primary', color: '#3A4E96', action: { type: 'postback', label: 'ใช้บริการ Care2Go', data: `action=center_care2go&planId=${planId}` } },
        ],
      },
    },
  };
}

module.exports = { confirmCardFlex, residentSelectionQuickReply, transportFamilyChoiceFlex, transportCenterChoiceFlex };
