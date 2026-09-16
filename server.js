require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { messagingApi, middleware, HTTPFetchError } = require('@line/bot-sdk');

// --- ตรวจว่ามีค่า env ที่จำเป็นครบ ---
const {
  LINE_CHANNEL_ACCESS_TOKEN,
  LINE_CHANNEL_SECRET,
  OPENWEATHER_API_KEY,
  CRON_SECRET,
  PORT = 3000,
} = process.env;

if (!LINE_CHANNEL_ACCESS_TOKEN || !LINE_CHANNEL_SECRET || !OPENWEATHER_API_KEY) {
  console.error('❌ กรุณาตั้งค่า LINE_CHANNEL_ACCESS_TOKEN, LINE_CHANNEL_SECRET และ OPENWEATHER_API_KEY ในไฟล์ .env');
  process.exit(1);
}

// MessagingApiClient แบบ v9+ (ไม่ใช่ Client เก่า)
const client = new messagingApi.MessagingApiClient({
  channelAccessToken: LINE_CHANNEL_ACCESS_TOKEN,
});

const USERS_FILE = path.join(__dirname, 'users.json');

// ========== จัดการไฟล์ users.json ==========

function loadUsers() {
  try {
    if (!fs.existsSync(USERS_FILE)) {
      return {};
    }
    const raw = fs.readFileSync(USERS_FILE, 'utf8');
    return JSON.parse(raw || '{}');
  } catch (err) {
    console.error('อ่าน users.json ไม่สำเร็จ:', err.message);
    return {};
  }
}

function saveUsers(users) {
  fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
}

// ========== OpenWeatherMap ==========

/** แปลงรหัสสภาพอากาศเป็นอีโมจิ */
function weatherEmoji(weatherId) {
  if (weatherId >= 200 && weatherId < 300) return '⛈️';
  if (weatherId >= 300 && weatherId < 400) return '🌦️';
  if (weatherId >= 500 && weatherId < 600) return '🌧️';
  if (weatherId >= 600 && weatherId < 700) return '❄️';
  if (weatherId >= 700 && weatherId < 800) return '🌫️';
  if (weatherId === 800) return '☀️';
  if (weatherId > 800) return '☁️';
  return '🌡️';
}

/** ดึงสภาพอากาศจาก lat/lng */
async function fetchWeather(lat, lng) {
  const url = 'https://api.openweathermap.org/data/2.5/weather';
  const { data } = await axios.get(url, {
    params: {
      lat,
      lon: lng,
      appid: OPENWEATHER_API_KEY,
      units: 'metric',
      lang: 'th',
    },
    timeout: 10000,
  });

  const weather = data.weather?.[0] || {};
  return {
    temp: Math.round(data.main.temp),
    feelsLike: Math.round(data.main.feels_like),
    humidity: data.main.humidity,
    description: weather.description || '-',
    emoji: weatherEmoji(weather.id),
  };
}

/** สร้างข้อความสรุปสภาพอากาศ */
function formatWeatherMessage(weather) {
  const now = new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'short',
    timeStyle: 'short',
  });

  return [
    `${weather.emoji} อุณหภูมิ ${weather.temp}°C (รู้สึกเหมือน ${weather.feelsLike}°C)`,
    `💧 ความชื้น ${weather.humidity}%`,
    `☁️ สภาพอากาศ: ${weather.description}`,
    `🕐 อัปเดต: ${now}`,
  ].join('\n');
}

// ========== ตอบกลับข้อความ LINE ==========

async function replyText(replyToken, text) {
  await client.replyMessage({
    replyToken,
    messages: [{ type: 'text', text }],
  });
}

// ========== ประมวลผล webhook event ==========

async function handleEvent(event) {
  // สนใจเฉพาะ message event จากผู้ใช้
  if (event.type !== 'message' || !event.source?.userId) {
    return;
  }

  const userId = event.source.userId;
  const replyToken = event.replyToken;
  const users = loadUsers();

  // ผู้ใช้แชร์ตำแหน่งที่ตั้ง
  if (event.message.type === 'location') {
    const { latitude, longitude, address } = event.message;

    users[userId] = {
      lat: latitude,
      lng: longitude,
      address: address || null,
      updatedAt: new Date().toISOString(),
    };
    saveUsers(users);

    await replyText(
      replyToken,
      '✅ บันทึกตำแหน่งของคุณเรียบร้อยแล้ว\nจะเริ่มแจ้งอุณหภูมิและความชื้นทุกชั่วโมง\n\nพิมพ์ "หยุด" หรือ "unsubscribe" เมื่อต้องการยกเลิก'
    );
    return;
  }

  // ข้อความทั่วไป
  if (event.message.type === 'text') {
    const text = (event.message.text || '').trim();
    const lower = text.toLowerCase();

    // หยุดรับการแจ้งเตือน
    if (text === 'หยุด' || lower === 'unsubscribe') {
      if (users[userId]) {
        delete users[userId];
        saveUsers(users);
      }
      await replyText(replyToken, '🛑 หยุดแจ้งเตือนแล้ว คุณจะไม่ได้รับสรุปอากาศรายชั่วโมงอีก');
      return;
    }

    // ยังไม่เคยแชร์ location
    if (!users[userId]) {
      await replyText(
        replyToken,
        '📍 ยังไม่มีตำแหน่งของคุณในระบบ\n\nกรุณากดปุ่มแนบไฟล์ (📎) แล้วเลือก "ตำแหน่งที่ตั้ง" เพื่อแชร์ location\nจากนั้นบอทจะแจ้งอุณหภูมิและความชื้นทุกชั่วโมง'
      );
      return;
    }

    // มีตำแหน่งแล้ว — ตอบสถานะสั้น ๆ
    await replyText(
      replyToken,
      'คุณสมัครรับแจ้งเตือนอยู่แล้ว ✓\nจะส่งสรุปอากาศทุกชั่วโมงตามตำแหน่งที่แชร์ไว้\n\nพิมพ์ "หยุด" หากต้องการยกเลิก'
    );
  }
}

// ========== Cron: แจ้งอากาศทุกชั่วโมง ==========

async function sendHourlyWeather() {
  const users = loadUsers();
  const userIds = Object.keys(users);

  if (userIds.length === 0) {
    console.log('[cron] ไม่มีผู้ใช้ในรายการแจ้งเตือน');
    return;
  }

  console.log(`[cron] เริ่มส่งอากาศให้ผู้ใช้ ${userIds.length} คน`);

  for (const userId of userIds) {
    try {
      const { lat, lng } = users[userId];
      const weather = await fetchWeather(lat, lng);
      const text = formatWeatherMessage(weather);

      await client.pushMessage({
        to: userId,
        messages: [{ type: 'text', text }],
      });

      console.log(`[cron] ส่งสำเร็จ → ${userId}`);
    } catch (err) {
      // ดัก error ไม่ให้ job หยุดทั้งก้อน
      const status = err instanceof HTTPFetchError ? err.status : err?.statusCode || err?.response?.status;
      console.error(`[cron] ส่งไม่สำเร็จ → ${userId}:`, err.message || err);

      // ลบผู้ใช้ที่บล็อกบอท / ไม่พบ (error code บ่งชี้ว่าถูกบล็อกหรือใช้งานไม่ได้)
      if (status === 403 || status === 404) {
        const latest = loadUsers();
        if (latest[userId]) {
          delete latest[userId];
          saveUsers(latest);
          console.log(`[cron] ลบผู้ใช้ ${userId} ออกจากรายการ (status ${status})`);
        }
      }
    }
  }
}

// รันทุกชั่วโมง ที่นาทีที่ 0 (เวลา Asia/Bangkok)
cron.schedule(
  '0 * * * *',
  () => {
    sendHourlyWeather().catch((err) => {
      console.error('[cron] เกิดข้อผิดพลาดที่ไม่คาดคิด:', err);
    });
  },
  { timezone: 'Asia/Bangkok' }
);

// ========== Express + Webhook ==========

const app = express();

// health check สำหรับ Render / Railway (และใช้ปลุกเครื่อง free tier ได้)
app.get('/', (_req, res) => {
  res.send('line-weather-bot is running');
});

// endpoint ให้ cron ภายนอกเรียก (เช่น cron-job.org) กรณี free tier sleep แล้วพลาด node-cron
app.get('/cron/weather', async (req, res) => {
  if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
    return res.status(401).send('unauthorized');
  }
  try {
    await sendHourlyWeather();
    res.status(200).send('ok');
  } catch (err) {
    console.error('[cron-http] ล้มเหลว:', err);
    res.status(500).send('error');
  }
});

// ตอบ 200 ทันทีก่อนประมวลผล event เพื่อกัน LINE timeout
// middleware ของ @line/bot-sdk จะ verify signature ด้วย Channel Secret ให้
app.post('/webhook', middleware({ channelSecret: LINE_CHANNEL_SECRET }), (req, res) => {
  res.status(200).end();

  const events = req.body?.events || [];
  Promise.all(events.map(handleEvent)).catch((err) => {
    console.error('ประมวลผล webhook ไม่สำเร็จ:', err);
  });
});

app.listen(PORT, () => {
  console.log(`🚀 line-weather-bot ทำงานที่พอร์ต ${PORT}`);
  console.log('⏰ Cron แจ้งอากาศทุกชั่วโมง (นาทีที่ 0, Asia/Bangkok)');
});
