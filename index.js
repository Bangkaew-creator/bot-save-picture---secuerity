require('dotenv').config();
const express = require('express');
const line = require('@line/bot-sdk');

// 1. ตั้งค่าเชื่อมต่อ Firebase (Modular API)
const { initializeApp, cert } = require('firebase-admin/app');
const { getFirestore } = require('firebase-admin/firestore');
const serviceAccount = require('./serviceAccountKey.json');

initializeApp({
  credential: cert(serviceAccount)
});
const db = getFirestore();

// 2. ตั้งค่าเชื่อมต่อ LINE (อัปเดตสำหรับ @line/bot-sdk เวอร์ชันใหม่)
const lineConfig = {
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
  channelSecret: process.env.LINE_CHANNEL_SECRET,
};

// ใช้ MessagingApiClient สำหรับเวอร์ชันใหม่
const client = new line.messagingApi.MessagingApiClient({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN
});

const app = express();

// 3. สร้างเส้นทาง Webhook สำหรับรับข้อมูลจาก LINE
app.post('/webhook', line.middleware(lineConfig), (req, res) => {
  Promise
    .all(req.body.events.map(handleEvent))
    .then((result) => res.json(result))
    .catch((err) => {
      console.error(err);
      res.status(500).end();
    });
});

// 4. ฟังก์ชันหลัก: คัดกรองและประมวลผลข้อความ
async function handleEvent(event) {
  const userId = event.source.userId;

  // กรณีเป็น "ข้อความ"
  if (event.type === 'message' && event.message.type === 'text') {
    const text = event.message.text;

    if (text.includes('รายงานเข้าเวร')) {
        // TODO: สกัดข้อความวันที่, ผลัด, ชื่อ รปภ.
        // TODO: บันทึกลง Firestore (Collection: shift_reports)
        // TODO: เปิดสถานะ 'รอรับรูป' ในระบบให้ userId นี้
        
        // รูปแบบการตอบกลับ (Reply) ของ LINE SDK เวอร์ชันใหม่
        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{
                type: 'text',
                text: 'รับทราบข้อมูลเข้าเวร กรุณาส่งรูปภาพภายใน 5 นาทีครับ'
            }]
        });
    } 
    
    else if (text.includes('รายงานเหตุการณ์')) {
        // TODO: สกัดข้อมูลเวลา, ผู้ส่ง, ข้อความเหตุการณ์
        // TODO: บันทึกลง Firestore (Collection: patrol_reports)
        // TODO: เปิดสถานะ 'รอรับรูป' (รองรับสูงสุด 10 รูป) ให้ userId นี้
        
        return client.replyMessage({
            replyToken: event.replyToken,
            messages: [{
                type: 'text',
                text: 'รับทราบรายงานเหตุการณ์ กรุณาส่งรูปภาพภายใน 5 นาทีครับ'
            }]
        });
    }
  }

  // กรณีเป็น "รูปภาพ"
  if (event.type === 'message' && event.message.type === 'image') {
      // TODO: เช็กว่า userId นี้อยู่ในสถานะ 'รอรับรูป' หรือไม่
      // TODO: ใช้ API โหลดรูปจาก LINE
      // TODO: ใช้ไลบรารี 'sharp' ย่อขนาดรูปภาพ
      // TODO: แปลงเป็น Base64 และบันทึกลง Subcollection 'images' ของรายงานนั้น
      return Promise.resolve(null); 
  }

  return Promise.resolve(null);
}

// เริ่มเปิดเซิร์ฟเวอร์
const port = process.env.PORT || 3000;
app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});