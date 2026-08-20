const interpretDocument = async (imageBuffer) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY || '';
    if (!apiKey) throw new Error("GEMINI_API_KEY is empty");

    const listUrl = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;
    const listRes = await fetch(listUrl);
    if (!listRes.ok) {
        const errText = await listRes.text();
        throw new Error(`Cannot list models: ${listRes.status} ${errText}`);
    }
    
    const listData = await listRes.json();
    const availableModels = listData.models || [];
    
    console.log("[Auto-Discover] Found models:", availableModels.map(m => m.name).join(", "));

    // อัปเดตรายชื่อโมเดลตามที่ Google แนะนำใน Log (gemini-3.6-flash)
    const priority = [
        "models/gemini-3.6-flash",
        "models/gemini-3.6-pro",
        "models/gemini-3.5-flash",
        "models/gemini-3.5-pro",
        "models/gemini-3.1-flash"
    ];

    let targetModel = null;
    for (const p of priority) {
        if (availableModels.some(m => m.name === p)) {
            targetModel = p;
            break;
        }
    }

    if (!targetModel) {
         const fallback = availableModels.find(m => 
            m.supportedGenerationMethods?.includes("generateContent") && 
            m.name.includes("gemini") && 
            !m.name.includes("2.5") // ข้าม 2.5 ที่มีปัญหา
        );
        if (fallback) targetModel = fallback.name;
    }

    if (!targetModel) {
         throw new Error("No usable model found.");
    }

    console.log("[Auto-Discover] Selected model:", targetModel);

    const url = `https://generativelanguage.googleapis.com/v1beta/${targetModel}:generateContent?key=${apiKey}`;

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
      unrelatedNote: `ระบบ AI ขัดข้องชั่วคราว กรุณาลองใหม่อีกครั้งค่ะ`,
      nameGuess: null, nameConfidence: 0, appointment: null, medications: [], doctorNote: null
    };
  }
};

const interpretLabResult = async (imageBuffer) => { return {}; };
const queueMockResponse = () => {};
const clearMockQueue = () => {};

module.exports = { interpretDocument, interpretLabResult, queueMockResponse, clearMockQueue };
