const { Anthropic } = require('@anthropic-ai/sdk');

const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY || '',
});

async function interpretDocument(imageBuffer) {
  try {
    const base64Image = imageBuffer.toString('base64');
    
    const prompt = `คุณคือผู้เชี่ยวชาญด้านการอ่านเอกสารทางการแพทย์ภาษาไทย
    โปรดอ่านภาพเอกสารนี้และสกัดข้อมูลออกมาเป็น JSON เท่านั้น โดยมีโครงสร้างดังนี้เป๊ะๆ (ห้ามมีข้อความอื่นนอกจาก JSON):
    {
      "documentType": "medical" หรือ "unrelated" (ถ้าไม่ใช่ใบนัด ซองยา หรือผลตรวจ ให้ตอบ unrelated),
      "unrelatedNote": "เหตุผลสั้นๆ ที่ปฏิเสธ (ถ้าเป็น unrelated)",
      "nameGuess": "ชื่อ-นามสกุลของผู้ป่วย (ถ้าไม่มีให้ตอบ null)",
      "nameConfidence": 0.0 ถึง 1.0 (ความมั่นใจ),
      "appointment": {
        "hospital": "ชื่อโรงพยาบาล",
        "datetime": "วันเวลานัดหมายในรูปแบบ ISO 8601 เช่น 2026-08-25T09:00:00 (ถ้าไม่มีเวลาให้สมมติเป็น 09:00:00, ถ้าไม่มีนัดเลยให้เป็น null)",
        "note": "หมายเหตุการนัด เช่น งดน้ำงดอาหาร"
      },
      "medications": [
        { "name": "ชื่อยา", "dose": "วิธีใช้ยา" }
      ],
      "doctorNote": "คำสั่งแพทย์อื่นๆ (ถ้าไม่มีให้ตอบ null)"
    }`;

    const response = await anthropic.messages.create({
      model: "claude-3-5-sonnet-20240620",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "image",
              source: { type: "base64", media_type: "image/jpeg", data: base64Image }
            },
            { type: "text", text: prompt }
          ]
        }
      ]
    });

    const textResponse = response.content[0].text;
    const jsonMatch = textResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
    } else {
        throw new Error("Invalid format from AI");
    }
  } catch (error) {
    console.error("AI Error:", error);
    return {
      documentType: 'unrelated',
      unrelatedNote: 'ระบบ AI ไม่สามารถอ่านเอกสารนี้ได้ หรือรูปภาพไม่ชัดเจน กรุณาลองใหม่อีกครั้งค่ะ',
      nameGuess: null, nameConfidence: 0, appointment: null, medications: [], doctorNote: null
    };
  }
}

async function interpretLabResult(imageBuffer) { return {}; }
function queueMockResponse() {}
function clearMockQueue() {}

module.exports = { interpretDocument, interpretLabResult, queueMockResponse, clearMockQueue };
