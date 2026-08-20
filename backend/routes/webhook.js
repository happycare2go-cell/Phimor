const express = require('express');
const router = express.Router();
const { asyncHandler } = require('../middleware/asyncHandler');
const lineClient = require('../providers/lineClient');
const centerService = require('../services/centerService');

router.post('/', asyncHandler(async (req, res) => {
    const events = req.body.events;
    if (!events || events.length === 0) {
        return res.status(200).send('OK');
    }

    for (const event of events) {
        // --- 1. กรณีมีคนออกจากกลุ่ม (ลาออก / ถูกเตะออก) ---
        if (event.type === 'memberLeft') {
            const groupId = event.source.groupId || event.source.roomId;
            const leftMembers = event.left.members;
            
            for (const member of leftMembers) {
                await centerService.removeStaffFromGroup(groupId, member.userId);
                console.log(`[Silent Ops] Removed staff ${member.userId} from group ${groupId}`);
            }
            continue;
        }

        // --- 2. กรณีการส่งข้อความในกลุ่ม (Group / Room) ---
        if (event.type === 'message' && (event.source.type === 'group' || event.source.type === 'room')) {
            // รองรับทั้งข้อความตัวอักษรและ "สติ๊กเกอร์"
            if (event.message.type === 'text' || event.message.type === 'sticker') {
                const groupId = event.source.groupId || event.source.roomId;
                const userId = event.source.userId;
                
                if (userId) {
                    await centerService.recordStaffFromGroup(groupId, userId);
                    console.log(`[Silent Ops] Registered staff ${userId} in group ${groupId}`);
                }
            }
            continue; // ทิ้ง event ทุกอย่างในกลุ่มแบบเงียบๆ
        }

        // --- 3. กรณีส่งข้อความในแชทส่วนตัว (User) ---
        if (event.type === 'message' && event.source.type === 'user') {
            const userId = event.source.userId;
            
            if (event.message.type === 'image') {
                const isStaff = await centerService.isStaff(userId);
                
                if (!isStaff) {
                    await lineClient.replyMessage(event.replyToken, {
                        type: 'text',
                        text: 'พี่หมอยังไม่รู้จักคุณเลยครับ รบกวนพิมพ์ทักทาย หรือส่งสติ๊กเกอร์ 1 ตัวใน "กลุ่มไลน์งานศูนย์" เพื่อให้พี่หมอจำหน้าได้ก่อนน้า'
                    });
                    continue;
                }
                console.log(`[Ops] Processing image from staff ${userId}`);
                // logic การทำงานอ่านเอกสารทางการแพทย์...
            }
        }
    }

    res.status(200).send('OK');
}));

module.exports = router;
