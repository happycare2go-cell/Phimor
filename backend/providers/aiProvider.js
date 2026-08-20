const interpretDocument = async (imageBuffer) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY || '';
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

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

    const base64Image = imageBuffer.toString("base64");

    const payload = {
      contents: [{
        parts: [
          { text: prompt },
          { inline_data: { mime_type: "image/jpeg", data: base64Image } }
        ]
      }]
    };

    // ส่งข้อมูลตรงหา Google โดยไม่ต้องใช้ Package ใดๆ ทั้งสิ้น
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    if (!response.ok) {
        const errText = await response.text();
        throw new Error(`Google API Error: ${response.status} - ${errText}`);
    }

    const data = await response.json();
    const responseText = data.candidates?.[0]?.content?.parts?.[0]?.text || "";
    
    const jsonMatch = responseText.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        return JSON.parse(jsonMatch[0]);
    } else {
        throw new Error("Invalid format from AI");
    }
  } catch (error) {
    console.error("AI Error:", error.message || error);
    return {
      documentType: 'unrelated',
      unrelatedNote: 'ระบบ AI ไม่สามารถอ่านเอกสารนี้ได้ หรือรูปภาพไม่ชัดเจน กรุณาลองใหม่อีกครั้งค่ะ',
      nameGuess: null, nameConfidence: 0, appointment: null, medications: [], doctorNote: null
    };
  }
};

const interpretLabResult = async (imageBuffer) => { return {}; };
const queueMockResponse = () => {};
const clearMockQueue = () => {};

module.exports = { interpretDocument, interpretLabResult, queueMockResponse, clearMockQueue };
