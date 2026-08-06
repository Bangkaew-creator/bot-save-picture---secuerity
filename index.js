require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const sharp = require('sharp'); // นำเข้าไลบรารีจัดการรูปภาพ

// 1. ตั้งค่าเชื่อมต่อ Firebase
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore, FieldValue } = require('firebase-admin/firestore');
const serviceAccount = require('./serviceAccountKey.json');

initializeApp({
  credential: cert(serviceAccount)
});
const db = getFirestore();

// 2. ตั้งค่าเชื่อมต่อ LINE
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});
const app = express();

// ---------------------------------------------------------
// ระบบความจำสั้น: เก็บสถานะ "รอรับรูป" ของแต่ละคน (5 นาที)
// ---------------------------------------------------------
const pendingUsers = {}; 

function setPendingUser(userId, docId, collectionName) {
    // ถ้าเคยมีคิวค้างอยู่ ให้ยกเลิกเวลานับถอยหลังเดิม
    if (pendingUsers[userId] && pendingUsers[userId].timeoutId) {
        clearTimeout(pendingUsers[userId].timeoutId);
    }
    
    // สร้างสถานะรอรูปภาพ 5 นาที (300,000 มิลลิวินาที)
    const timeoutId = setTimeout(() => {
        delete pendingUsers[userId];
        console.log(`หมดเวลารอรูปภาพจาก: ${userId}`);
    }, 5 * 60 * 1000);

    pendingUsers[userId] = { docId, collectionName, timeoutId };
}

// ---------------------------------------------------------
// ฟังก์ชันสกัดข้อมูล (Text Parsing)
// ---------------------------------------------------------
function parseShiftReport(text) {
    const lines = text.split('\n');
    let date = "ไม่ระบุ", shift = "ไม่ระบุ";
    let guards = [];

    lines.forEach(line => {
        if (line.includes('วันที่')) date = line.replace('วันที่', '').trim();
        if (line.includes('ผลัด')) {
            const match = line.match(/ผลัด([^\s]+)/);
            if (match) shift = match[1];
        }
        if (line.match(/^[1-2]\.?\s/)) guards.push(line.replace(/^[1-2]\.?\s*/, '').trim());
    });
    return { date, shift, guards, raw_text: text };
}

function parsePatrolReport(text) {
    const lines = text.split('\n');
    let time = "ไม่ระบุ", guardName = "ไม่ระบุ";

    lines.forEach(line => {
        if (line.includes('เวลา')) time = line.replace('เวลา', '').trim();
        if (line.includes('นาย') || line.includes('นาง')) guardName = line.trim();
    });
    return { time, guardName, raw_text: text };
}

// 3. สร้างเส้นทาง Webhook
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// 4. ฟังก์ชันหลัก: ประมวลผลข้อความและรูปภาพ
async function handleEvent(event) {
  const userId = event.source.userId;

  // ==========================================
  // กรณีเป็น "ข้อความ"
  // ==========================================
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text;

    // --- เงื่อนไขที่ 1: รายงานเข้าเวร ---
    if (text.includes('รายงานเข้าเวร')) {
        const parsedData = parseShiftReport(text);
        
        // บันทึกลงตาราง shift_reports
        const docRef = await db.collection('shift_reports').add({
            ...parsedData,
            reported_by_userId: userId,
            timestamp: FieldValue.serverTimestamp()
        });

        // เปิดสถานะรอรับรูป
        setPendingUser(userId, docRef.id, 'shift_reports');

        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: 'บันทึกข้อมูลเข้าเวรแล้ว กรุณาส่งรูปภาพประกอบภายใน 5 นาทีครับ' }]
        });
    } 
    
    // --- เงื่อนไขที่ 2: รายงานเหตุการณ์ ---
    else if (text.includes('รายงานเหตุการณ์')) {
        const parsedData = parsePatrolReport(text);
        
        // บันทึกลงตาราง patrol_reports
        const docRef = await db.collection('patrol_reports').add({
            ...parsedData,
            reported_by_userId: userId,
            timestamp: FieldValue.serverTimestamp()
        });

        // เปิดสถานะรอรับรูป
        setPendingUser(userId, docRef.id, 'patrol_reports');

        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: 'บันทึกรายงานเหตุการณ์แล้ว กรุณาส่งรูปภาพ (สูงสุด 10 รูป) ภายใน 5 นาทีครับ' }]
        });
    }
  }

  // ==========================================
  // กรณีเป็น "รูปภาพ"
  // ==========================================
  if (event.type === 'message' && event.message.type === 'image') {
      const userState = pendingUsers[userId];
      
      // ถ้าไม่ได้อยู่ในสถานะรอรูป ให้ข้ามไปเลย
      if (!userState) return Promise.resolve(null);

      try {
          // 1. โหลดรูปภาพจาก LINE API
          const stream = await client.getMessageContent(event.message.id);
          const chunks = [];
          for await (const chunk of stream) {
              chunks.push(chunk);
          }
          const buffer = Buffer.concat(chunks);

          // 2. ใช้ Sharp บีบอัดรูปภาพ (ลดความกว้างเหลือ 800px)
          const compressedBuffer = await sharp(buffer)
              .resize({ width: 800, withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toBuffer();

          // 3. แปลงเป็น Base64
          const base64Image = compressedBuffer.toString('base64');
          const dataUrl = `data:image/jpeg;base64,${base64Image}`;

          // 4. บันทึกลง Subcollection 'images' ของรายงานนั้นๆ
          await db.collection(userState.collectionName)
                  .doc(userState.docId)
                  .collection('images')
                  .add({
                      image_data: dataUrl,
                      timestamp: FieldValue.serverTimestamp()
                  });
          
          console.log(`บันทึกรูปภาพให้รายงาน ${userState.docId} สำเร็จ`);
          
      } catch (error) {
          console.error("เกิดข้อผิดพลาดในการโหลดหรือแปลงรูปภาพ:", error);
      }

      return Promise.resolve(null); 
  }

  return Promise.resolve(null);
}

// เริ่มเปิดเซิร์ฟเวอร์
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
