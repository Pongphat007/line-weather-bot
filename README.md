# line-weather-bot

LINE Bot แจ้งอุณหภูมิ/ความชื้นทุกชั่วโมง และแจ้งตารางวิ่งประจำวันจาก Google Sheet  
ใช้ Official Account ตัวเดียว · Node.js + Express + OpenWeatherMap + Google Sheets + `@line/bot-sdk`

---

## 1) สร้าง LINE Official Account

1. ไปที่ [entry.line.biz](https://entry.line.biz/)
2. สร้าง LINE Official Account ใหม่ (หรือใช้บัญชีที่มีอยู่)
3. จดชื่อบัญชีไว้สำหรับใช้ตั้งค่าต่อ

---

## 2) เปิดใช้งาน Messaging API

1. เข้า [LINE Official Account Manager](https://manager.line.biz/)
2. เลือก Official Account ของคุณ
3. ไปที่ **Settings → Messaging API → Enable Messaging API**
4. ยืนยันการเชื่อมกับ LINE Developers

จากนั้นใน Messaging API settings แนะนำให้:

- ปิด **Auto-reply messages** / **Greeting messages** (ถ้ามี) เพื่อไม่ให้ชนกับบอท
- เปิด **Use webhooks**

---

## 3) ดึง Channel Access Token และ Channel Secret

1. เปิด [LINE Developers Console](https://developers.line.biz/console/)
2. เลือก Provider → Channel ที่ผูกกับ Official Account
3. แท็บ **Basic settings** → คัดลอก **Channel secret**
4. แท็บ **Messaging API** → **Channel access token** → กด **Issue** (long-lived)
5. เก็บค่าทั้งสองไว้ใส่ในไฟล์ `.env`

---

## 4) สมัคร OpenWeatherMap API key

1. สมัครที่ [openweathermap.org](https://openweathermap.org/api)
2. สร้าง API key ฟรี (Current Weather Data)
3. รอประมาณ 10–30 นาทีให้คีย์เริ่มใช้งานได้
4. ใส่ค่าใน `.env` เป็น `OPENWEATHER_API_KEY`

---

## 5) ตั้งค่า Google Sheet สำหรับตารางวิ่ง

### โครงสร้างคอลัมน์

| A: Date | B: งานวิ่ง | C / D / … (ชื่อคน) |
|---------|------------|---------------------|
| `YYYY-MM-DD` | ชื่องานแข่งของวันนั้น (ว่างได้) | ตารางวิ่งของคนนั้นในวันนั้น |

ตัวอย่าง:

| Date | งานวิ่ง | จ๋า | นิว |
|------|--------|-----|-----|
| 2026-09-16 | ATM | 5K easy @ 6:00 | 10K tempo |
| 2026-09-17 | | Rest | 8K easy |

- คอลัมน์ A และ B ตำแหน่งตายตัว
- คอลัมน์คนวิ่งอ่านจาก **header แถวแรกแบบ dynamic** — เพิ่มคนใหม่ได้โดยเพิ่มคอลัมน์ใหม่

### สร้าง Service Account + เปิด Sheets API

1. เปิด [Google Cloud Console](https://console.cloud.google.com/)
2. สร้างโปรเจกต์ (หรือเลือกโปรเจกต์ที่มีอยู่)
3. เปิด **APIs & Services → Library** → ค้นหา **Google Sheets API** → **Enable**
4. ไป **APIs & Services → Credentials → Create credentials → Service account**
5. สร้าง Service Account เสร็จแล้วกดเข้าไปที่บัญชีนั้น → แท็บ **Keys → Add key → Create new key → JSON**
6. เปิดไฟล์ JSON ที่ดาวน์โหลด แล้วนำค่าไปใส่ `.env`:
   - `client_email` → `GOOGLE_SERVICE_ACCOUNT_EMAIL`
   - `private_key` → `GOOGLE_PRIVATE_KEY` (ใน `.env` ใส่บรรทัดเดียว ใช้ `\n` แทนขึ้นบรรทัดใหม่)
7. เปิด Google Sheet → ปุ่ม **Share** → ใส่ email ของ Service Account เป็น **Viewer**

### หา Sheet ID จาก URL

จาก URL แบบ:

`https://docs.google.com/spreadsheets/d/1AbCDefGHijKLmnopQRstuVWxyz/edit`

ส่วน `1AbCDefGHijKLmnopQRstuVWxyz` คือ `GOOGLE_SHEET_ID`

---

## 6) รันในเครื่อง

```bash
npm install
cp .env.example .env
# แก้ไข .env ให้ครบทุกค่า
npm start
```

เซิร์ฟเวอร์จะฟังที่ `http://localhost:3000`  
Webhook path คือ `POST /webhook`

---

## 7) ทดสอบด้วย ngrok + ตั้งค่า Webhook URL

LINE ต้องเรียก webhook ผ่าน public HTTPS URL

```bash
ngrok http 3000
```

ตั้งใน LINE Developers Console:

- **Webhook URL** = `https://xxxx.ngrok-free.app/webhook`
- กด **Verify** → เปิด **Use webhook**

ทดสอบ:

1. แชร์ตำแหน่ง → ยืนยันบันทึก (สมัครรับทั้งอากาศ + ตารางวิ่งตี 5)
2. พิมพ์ `จ๋าวิ่ง` → ได้ตารางวิ่งวันนี้ของจ๋า (ถ้ามีในชีท)
3. พิมพ์ `หยุด` → ยกเลิกแจ้งเตือน

---

## 8) Cron และ timezone

| Job | เวลา | timezone | ส่งหาใคร |
|-----|------|----------|----------|
| แจ้งอากาศ | ทุกชั่วโมง นาทีที่ 0 | `Asia/Bangkok` | ผู้ใช้ที่แชร์ตำแหน่งไว้ |
| แจ้งตารางวิ่ง | ทุกวัน 05:00 | `Asia/Bangkok` | **ชุดเดียวกัน** — ข้อความรวมทุกคนในชีท |

ตัวอย่างข้อความตอนตี 5:

```text
🏃 ตารางวิ่งวันนี้ (16 ก.ย. 2569)
🎽 งานวิ่ง: ATM

👤 จ๋า
📋 5K easy @ 6:00

👤 นิว
📋 10K tempo
```

โค้ดใช้ `node-cron` พร้อม `{ timezone: 'Asia/Bangkok' }`  
แม้เซิร์ฟเวอร์ใช้ UTC ก็ยังยิงตามเวลาไทยถูกต้อง

บน **Render free tier** แนะนำตั้ง [cron-job.org](https://cron-job.org):

- ปลุกเครื่อง: `GET /` ทุก 10 นาที
- อากาศ: `GET /cron/weather?secret=...` ทุกชั่วโมง
- ตารางวิ่ง: `GET /cron/runs?secret=...` เวลา 05:00 ไทย

---

## 9) Deploy ขึ้น Render.com หรือ Railway.app (free tier)

1. Push โปรเจกต์ขึ้น GitHub (อย่า commit `.env`)
2. สร้าง Web Service จาก repo → Start: `npm start`
3. ใส่ Environment Variables ตาม `.env.example` (รวม Google Sheets)
4. ตั้ง Webhook เป็น `https://your-app.onrender.com/webhook`

---

## 10) คำเตือนเรื่องความปลอดภัย

- **ห้าม commit ไฟล์ `.env` เข้า git**
- `.gitignore` exclude `.env`, `node_modules`, `users.json` อยู่แล้ว
- ถ้า key หลุด ให้ revoke / ออก key ใหม่ทันที

---

## โครงสร้างโปรเจกต์

| ไฟล์ | คำอธิบาย |
|------|----------|
| `server.js` | Webhook + cron อากาศ + cron ตารางวิ่ง |
| `googleSheets.js` | อ่าน/parse Google Sheet |
| `users.json` | ผู้ใช้ที่สมัครแจ้งเตือน (ไม่ commit) |
| `.env.example` | ตัวอย่างตัวแปรสภาพแวดล้อม |

## คำสั่งที่ใช้บ่อย

| คำสั่งผู้ใช้ | ผลลัพธ์ |
|-------------|---------|
| แชร์ Location | สมัครรับอากาศทุกชั่วโมง + ตารางวิ่งรวมทุกวันตี 5 |
| `<ชื่อ>วิ่ง` เช่น `จ๋าวิ่ง` | ตอบตารางวิ่งวันนี้ของคนนั้น |
| `หยุด` / `unsubscribe` | ยกเลิกการแจ้งเตือนทั้งหมด |
