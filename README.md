# line-weather-bot

LINE Bot แจ้งอุณหภูมิและความชื้นทุกชั่วโมง ตามตำแหน่งที่ผู้ใช้แชร์ผ่าน LINE  
ใช้ Node.js + Express + OpenWeatherMap + `@line/bot-sdk`

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

## 5) รันในเครื่อง

```bash
npm install
cp .env.example .env
# แก้ไข .env ให้ครบทุกค่า
npm start
```

เซิร์ฟเวอร์จะฟังที่ `http://localhost:3000`  
Webhook path คือ `POST /webhook`

---

## 6) ทดสอบด้วย ngrok + ตั้งค่า Webhook URL

LINE ต้องเรียก webhook ผ่าน public HTTPS URL

```bash
# ติดตั้ง ngrok แล้วรัน (สมมติบอทรันพอร์ต 3000)
ngrok http 3000
```

คัดลอก URL แบบ HTTPS เช่น `https://xxxx.ngrok-free.app`  
แล้วตั้งใน LINE Developers Console:

- **Messaging API → Webhook URL** = `https://xxxx.ngrok-free.app/webhook`
- กด **Verify** ให้ผ่าน
- เปิด **Use webhook**

จากนั้นเพิ่มเพื่อนบัญชี LINE OA แล้วลอง:

1. แชร์ **ตำแหน่งที่ตั้ง** (📎 → ตำแหน่งที่ตั้ง) → บอทยืนยันการบันทึก
2. พิมพ์ข้อความทั่วไปก่อนแชร์ตำแหน่ง → ได้คำแนะนำ
3. พิมพ์ `หยุด` หรือ `unsubscribe` → ยกเลิกการแจ้งเตือน

Cron จะส่งสรุปอากาศทุกชั่วโมง ที่นาทีที่ 0 (เวลา `Asia/Bangkok`)

---

## 7) Deploy ขึ้น Render.com หรือ Railway.app (free tier)

### Render.com

1. Push โปรเจกต์ขึ้น GitHub (อย่า commit `.env`)
2. สร้าง **Web Service** ใหม่จาก repo
3. Runtime: Node  
   - Build: `npm install`  
   - Start: `npm start`
4. ใส่ Environment Variables ตาม `.env.example`
5. หลังได้ URL เช่น `https://your-app.onrender.com`  
   ตั้ง Webhook เป็น `https://your-app.onrender.com/webhook`

> หมายเหตุ free tier ของ Render อาจ sleep เมื่อไม่มีทราฟฟิก ทำให้ cron พลาดได้ — เหมาะทดสอบ หรืออัปเกรด/ใช้ keep-alive ตามความเหมาะสม

### Railway.app

1. New Project → Deploy from GitHub repo
2. ใส่ Environment Variables ให้ครบ
3. Start command: `npm start`
4. คัดลอก public URL แล้วตั้ง Webhook เป็น `https://your-domain/webhook`

---

## 8) คำเตือนเรื่องความปลอดภัย

- **ห้าม commit ไฟล์ `.env` เข้า git** — มี token/key ที่ใช้ควบคุมบอทและเรียก API ได้
- โปรเจกต์นี้มี `.gitignore` ที่ exclude `.env`, `node_modules`, และ `users.json` อยู่แล้ว
- ถ้า token หลุด ให้ revoke / issue token ใหม่ทันทีที่ LINE Developers Console และ OpenWeatherMap

---

## โครงสร้างโปรเจกต์

| ไฟล์ | คำอธิบาย |
|------|----------|
| `server.js` | Webhook + cron + อ่าน/เขียน `users.json` |
| `package.json` | dependencies |
| `.env.example` | ตัวอย่างตัวแปรสภาพแวดล้อม |
| `users.json` | สร้างอัตโนมัติเมื่อมีผู้ใช้แชร์ตำแหน่ง (ไม่ commit) |

## คำสั่งที่ใช้บ่อย

| คำสั่งผู้ใช้ | ผลลัพธ์ |
|-------------|---------|
| แชร์ Location | บันทึก lat/lng แล้วเริ่มแจ้งทุกชั่วโมง |
| ข้อความทั่วไป (ยังไม่มีตำแหน่ง) | แนะนำวิธีแชร์ตำแหน่ง |
| `หยุด` / `unsubscribe` | ลบออกจากรายการแจ้งเตือน |
