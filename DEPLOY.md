# Deploy ฟรีบน Render (ไม่ต้องเปิดคอมค้าง)

โค้ดอยู่ที่ GitHub (private): https://github.com/Pongphat007/line-weather-bot

## ขั้นตอน Deploy (ครั้งเดียว)

### 1) สร้างบริการบน Render
1. เปิด: https://dashboard.render.com/blueprint/new?repo=https://github.com/Pongphat007/line-weather-bot  
   (หรือ New → Blueprint → เลือก repo `line-weather-bot`)
2. สมัคร / ล็อกอิน Render ด้วย GitHub (ฟรี ไม่ต้องใส่บัตร)
3. กด **Apply** เพื่อสร้าง Web Service

### 2) ใส่ Environment Variables
ในหน้า service → **Environment** ใส่ค่าจากไฟล์ `.env` ในเครื่องคุณ:

| Key | เอามาจาก |
|-----|----------|
| `LINE_CHANNEL_ACCESS_TOKEN` | `.env` |
| `LINE_CHANNEL_SECRET` | `.env` |
| `OPENWEATHER_API_KEY` | `.env` |
| `CRON_SECRET` | `.env` (มีอยู่แล้ว) |

จากนั้นกด **Manual Deploy** / รอให้สถานะเป็น **Live**

จะได้ URL ประมาณ: `https://line-weather-bot-xxxx.onrender.com`

### 3) เปลี่ยน Webhook ใน LINE
LINE Developers Console → Messaging API → Webhook URL:

`https://line-weather-bot-xxxx.onrender.com/webhook`

กด Verify → เปิด Use webhook

### 4) กันเครื่องหลับ (สำคัญมากบนแผนฟรี)
Render free จะ sleep หลังไม่มีการใช้งาน ~15 นาที

สมัครฟรีที่ https://cron-job.org แล้วสร้าง 2 งาน:

**งาน A — ปลุกเซิร์ฟเวอร์ทุก 10 นาที**
- URL: `https://line-weather-bot-xxxx.onrender.com/`
- Schedule: ทุก 10 นาที

**งาน B — ส่งอากาศทุกชั่วโมง**
- URL: `https://line-weather-bot-xxxx.onrender.com/cron/weather?secret=ค่า_CRON_SECRET_ใน_.env`
- Schedule: `0 * * * *` (ทุกชั่วโมง นาทีที่ 0)

### 5) ทดสอบ
1. ปิด `npm start` และ ngrok ในเครื่องได้เลย
2. แชร์ตำแหน่งใหม่ใน LINE (เพราะ `users.json` บนคลาวด์เริ่มว่าง)
3. รอถึงหัวชั่วโมงถัดไป หรือเรียก URL งาน B เองเพื่อทดสอบทันที

## หมายเหตุ
- อย่า commit ไฟล์ `.env`
- หลัง redeploy บน free tier ข้อมูลผู้ใช้อาจหาย (ไฟล์ไม่ถาวร) — แชร์ตำแหน่งใหม่ได้
