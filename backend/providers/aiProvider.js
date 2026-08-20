const { GoogleGenerativeAI } = require('@google/generative-ai');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || '');

async function interpretDocument(imageBuffer) {
  try {
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

    const imageParts = [
      {
        inlineData: {
          data: imageBuffer.toString("base64"),
          mimeType: "image/jpeg"
        }
      }
    ];

    // ระบบสำรอง (Fallback): ลองเรียกใช้โมเดลตามลำดับ ถ้าตัวแรกพัง ให้เปลี่ยนไปใช้ตัวถัดไปอัตโนมัติ
    const modelsToTry = ["gemini-1.5-flash-latest", "gemini-1.5-pro-latest", "gemini-pro-vision"];
    let responseText = "";
    let lastError = null;

    for (const modelName of modelsToTry) {
        try {
            const model = genAI.getGenerativeModel({ model: modelName });
            const result = await model.generateContent([prompt, ...imageParts]);
            const response = await result.response;
            responseText = response.text();
            console.log(`[Success] Used model: ${modelName}`);
            break; // สำเร็จแล้วให้ออกจากลูปทันที
        } catch (err) {
            console.log(`[Fallback] Model ${modelName} failed, trying next...`);
            lastError = err;
        }
    }

    if (!responseText) {
        throw lastError || new Error("All AI models failed");
    }
    
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
}

async function interpretLabResult(imageBuffer) { return {}; }
function queueMockResponse() {}
function clearMockQueue() {}

module.exports = { interpretDocument, interpretLabResult, queueMockResponse, clearMockQueue };
