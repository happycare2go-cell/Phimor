// flexMessages.js — สร้าง Flex Message ตาม Phimor_Technical_Design.docx หมวด 4 (S5) และหมวด 6

const DEFAULT_PUBLIC_LIFF_BASE_URL = 'https://phimor-liff.onrender.com';

function mascotHero(filename, backgroundColor = '#F5F7FA') {
  const baseUrl = (process.env.PUBLIC_LIFF_BASE_URL || DEFAULT_PUBLIC_LIFF_BASE_URL).replace(/\/$/, '');
  return {
    type: 'image',
    url: `${baseUrl}/assets/mascot/${filename}`,
    size: 'full',
    aspectRatio: '20:13',
    aspectMode: 'fit',
    backgroundColor,
  };
}

// ── S5: การ์ดยืนยันก่อนส่งให้ครอบครัว — ชื่อผู้พักต้องใหญ่ที่สุด (ข้อ E1) ──
function confirmCardFlex({ cardId, residentName, room, data }) {
  const isLab = data.documentSubtype === 'lab_report';
  const bodyContents = [
    { type: 'text', text: residentName + (room ? ` · ห้อง ${room}` : ''), weight: 'bold', size: 'xl', wrap: true, color: '#1C2B64' },
  ];

  if (isLab) {
    bodyContents.push(
      { type: 'separator', margin: 'md' },
      { type: 'text', text: '🧪 ผลตรวจ Lab · รอตรวจสอบ', weight: 'bold', size: 'sm', margin: 'md', color: '#8A6D1F' },
      { type: 'text', text: 'กรุณาเปิดเอกสารต้นฉบับ ตรวจและแก้ข้อมูลที่ AI สกัด ก่อนยืนยันทุกครั้ง', size: 'xs', color: '#5A6580', wrap: true },
    );
  }

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
      hero: mascotHero('phimor-review.png', '#EAF2FF'),
      header: {
        type: 'box', layout: 'vertical', backgroundColor: '#1C2B64', paddingAll: 'md',
        contents: [{ type: 'text', text: 'ตรวจสอบก่อนส่งให้ครอบครัว', color: '#FFFFFF', weight: 'bold', size: 'sm' }],
      },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: bodyContents },
      footer: {
        type: 'box', layout: isLab ? 'vertical' : 'horizontal', spacing: 'sm',
        contents: isLab
          ? [{ type: 'button', style: 'primary', color: '#1C2B64', action: { type: 'postback', label: 'ตรวจสอบผล Lab', data: `action=edit_card&cardId=${cardId}` } }]
          : [
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
      hero: mascotHero('phimor-important.png', '#FFF7DC'),
      body: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'text', text: 'นัดหมายที่กำลังจะถึง', weight: 'bold', size: 'md', color: '#1C2B64' },
          { type: 'text', text: `${hospital}\n${datetime}`, size: 'sm', wrap: true },
          { type: 'text', text: 'ใครจะพาไปดี', size: 'sm', margin: 'md', color: '#5A6580' },
        ],
      },
      footer: {
        type: 'box', layout: 'vertical', spacing: 'sm',
        contents: [
          { type: 'button', style: 'secondary', action: { type: 'postback', label: 'เราไปเอง', data: `action=transport_self&planId=${planId}` } },
          { type: 'button', style: 'primary', color: '#1C2B64', action: { type: 'postback', label: 'ให้ศูนย์จัดการให้', data: `action=transport_request_center&planId=${planId}` } },
        ],
      },
    },
  };
}

function care2goOperationsRequestFlex({residentName,destination,origin,datetime,contact,requestedByType,needs,note}) {
  const labels={vehicle:'รถรับส่ง',escort:'คนเฝ้าไข้'};
  return {type:'flex',altText:'มีคำขอบริการ Care2Go ใหม่',contents:{type:'bubble',hero:mascotHero('phimor-care2go.png','#EAF2FF'),body:{type:'box',layout:'vertical',spacing:'sm',contents:[
    {type:'text',text:'🚐 คำขอบริการ Care2Go',weight:'bold',size:'lg',color:'#1C2B64'},
    {type:'text',text:`ผู้รับบริการ: ${residentName}`,wrap:true,size:'sm'},{type:'text',text:`ต้นทาง: ${origin}`,wrap:true,size:'sm'},
    {type:'text',text:`ปลายทาง: ${destination}`,wrap:true,size:'sm'},{type:'text',text:`วันเวลา: ${datetime}`,wrap:true,size:'sm'},
    {type:'text',text:`บริการ: ${(needs||[]).map(n=>labels[n]||n).join(', ')}`,wrap:true,size:'sm'},
    {type:'text',text:`ผู้ร้องขอ: ${requestedByType==='center'?'ศูนย์':'ญาติ'} · โทร ${contact}`,wrap:true,size:'sm'},
    ...(note?[{type:'text',text:`หมายเหตุ: ${note}`,wrap:true,size:'xs'}]:[]),
    {type:'separator',margin:'md'},
    {type:'text',text:'กรุณาโทรประสานผู้ติดต่อโดยตรง',weight:'bold',color:'#0F6E56',wrap:true,margin:'md',size:'sm'},
  ]}}};
}

// ── ชั้นที่ 2: การ์ดให้ศูนย์เลือก (เจ้าของ/ผู้จัดการเท่านั้น) — สองทาง ไม่มีปฏิเสธ (ข้อ L4) ──
function transportCenterChoiceFlex({ planId, residentName, room, hospital, datetime }) {
  return {
    type: 'flex',
    altText: 'ญาติขอให้ศูนย์จัดการเรื่องการเดินทาง',
    contents: {
      type: 'bubble',
      hero: mascotHero('phimor-important.png', '#FFF7DC'),
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

module.exports = { confirmCardFlex, residentSelectionQuickReply, transportFamilyChoiceFlex, transportCenterChoiceFlex, care2goOperationsRequestFlex };
