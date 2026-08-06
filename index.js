require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');
const sharp = require('sharp'); 

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

// ไคลเอนต์สำหรับข้อความตัวอักษร
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

// ไคลเอนต์สำหรับดาวน์โหลดไฟล์รูปภาพ (แก้ไขคำผิดตรงนี้ครับ)
const blobClient = new line.messagingApi.MessagingApiBlobClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

const app = express();

// สร้างหน้าเว็บเปล่าๆ ให้ UptimeRobot เช็กว่าบอทตื่นอยู่
app.get('/', (req, res) => {
    console.log('⏰ UptimeRobot แวะมาปลุกเซิร์ฟเวอร์ให้ตื่นแล้ว!'); // <--- เพิ่มบรรทัดนี้
    res.status(200).send('บอทตื่นแล้วจ้า!');
});

// ระบบความจำสั้น: เก็บสถานะ "รอรับรูป" (5 นาที)
const pendingUsers = {}; 

function setPendingUser(userId, docId, collectionName) {
    if (pendingUsers[userId] && pendingUsers[userId].timeoutId) {
        clearTimeout(pendingUsers[userId].timeoutId);
    }
    const timeoutId = setTimeout(() => {
        delete pendingUsers[userId];
        console.log(`หมดเวลารอรูปภาพจาก: ${userId}`);
    }, 5 * 60 * 1000);

    pendingUsers[userId] = { docId, collectionName, timeoutId };
}

// ฟังก์ชันสกัดข้อมูล (Text Parsing)
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
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    let time = "ไม่ระบุ", guardName = "ไม่ระบุ";
    let guardList = [];
    let dateLine = "";
    let timeLine = "";

    lines.forEach((line, index) => {
        // 1. ดึงวันที่และเวลา (หาบรรทัดที่มีคำว่า 'เวลา' และดึงบรรทัดก่อนหน้ามาเป็นวันที่)
        if (line.includes('เวลา')) {
            timeLine = line;
            if (index > 0 && !lines[index - 1].includes('เรียน')) {
                dateLine = lines[index - 1];
            }
        }
        
        // 2. หาชื่อเจ้าหน้าที่ (เช็คจากตัวเลข 1. 2. หรือคำว่า พลฯ, นาย, นาง, น.ส., เจ้าหน้าที่)
        if (/^[1-9]\./.test(line) || line.includes('พลฯ') || line.includes('นาย') || line.includes('นาง') || line.includes('เจ้าหน้าที่')) {
            // ตัดตัวเลข 1. 2. ข้างหน้าออกให้เหลือแต่ชื่อ
            guardList.push(line.replace(/^[1-9]\.\s*/, '').trim());
        }
    });

    // นำวันที่และเวลามาต่อกัน
    if (dateLine || timeLine) {
        time = `${dateLine} ${timeLine}`.trim();
    }

    // ถ้าระบุชื่อ รปภ. หลายคน ให้นำชื่อมาต่อกันด้วยลูกน้ำ (,)
    if (guardList.length > 0) {
        guardName = guardList.join(', ');
    }

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
  // 💡 แก้ไขจุดที่ 1: ป้องกันบอทพังหาก รปภ. ยังไม่ได้แอดบอทเป็นเพื่อน
  // ให้ดึง ID กลุ่มมาใช้แทน หากไม่มี ID ส่วนตัว
  const senderId = event.source.userId || event.source.groupId || "unknown_id";
  const reportedBy = event.source.userId || "ไม่ระบุ (ยังไม่ได้แอดบอทเป็นเพื่อน)";

  // กรณีเป็น "ข้อความ"
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text;

    if (text.includes('รายงานเข้าเวร')) {
        const parsedData = parseShiftReport(text);
        const docRef = await db.collection('shift_reports').add({
            ...parsedData,
            reported_by_userId: reportedBy, // 💡 แก้ไขจุดที่ 2: ใช้ตัวแปรใหม่ ป้องกัน Firebase พัง
            timestamp: FieldValue.serverTimestamp()
        });
        setPendingUser(senderId, docRef.id, 'shift_reports'); // ใช้ senderId แบบใหม่
        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: 'บันทึกข้อมูลเข้าเวรแล้ว กรุณาส่งรูปภาพประกอบภายใน 5 นาทีครับ' }]
        });
    } 
    else if (text.includes('รายงานเหตุการณ์')) {
        const parsedData = parsePatrolReport(text);
        const docRef = await db.collection('patrol_reports').add({
            ...parsedData,
            reported_by_userId: reportedBy, // 💡 แก้ไขจุดที่ 2: ใช้ตัวแปรใหม่ ป้องกัน Firebase พัง
            timestamp: FieldValue.serverTimestamp()
        });
        setPendingUser(senderId, docRef.id, 'patrol_reports'); // ใช้ senderId แบบใหม่
        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{ type: 'text', text: 'บันทึกรายงานเหตุการณ์แล้ว กรุณาส่งรูปภาพ (สูงสุด 10 รูป) ภายใน 5 นาทีครับ' }]
        });
    }
  }

  // กรณีเป็น "รูปภาพ"
  if (event.type === 'message' && event.message.type === 'image') {
      const userState = pendingUsers[senderId]; // 💡 อ้างอิงจากรหัสผู้ส่งหรือกลุ่ม
      if (!userState) return Promise.resolve(null);

      try {
          // โหลดรูปภาพ
          const stream = await blobClient.getMessageContent(event.message.id);
          const chunks = [];
          for await (const chunk of stream) {
              chunks.push(chunk);
          }
          const buffer = Buffer.concat(chunks);

          // บีบอัดรูปภาพ
          const compressedBuffer = await sharp(buffer)
              .resize({ width: 800, withoutEnlargement: true })
              .jpeg({ quality: 80 })
              .toBuffer();

          // แปลงเป็น Base64
          const base64Image = compressedBuffer.toString('base64');
          const dataUrl = `data:image/jpeg;base64,${base64Image}`;

          // บันทึกลง Subcollection 'images'
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

const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
