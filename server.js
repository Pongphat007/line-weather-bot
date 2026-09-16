require('dotenv').config();

const fs = require('fs');
const path = require('path');
const express = require('express');
const axios = require('axios');
const cron = require('node-cron');
const { messagingApi, middleware, HTTPFetchError } = require('@line/bot-sdk');
const {
  fetchRunScheduleSheet,
  todayInBangkok,
  matchRunnerName,
} = require('./googleSheets');

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

// ========== ตารางวิ่ง (Google Sheet) ==========

/** แปลง YYYY-MM-DD เป็นข้อความวันที่ไทยสั้น ๆ */
function formatThaiDate(yyyyMmDd) {
  const [y, m, d] = yyyyMmDd.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
  return date.toLocaleDateString('th-TH', {
    timeZone: 'Asia/Bangkok',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}

/** สร้างข้อความตารางวิ่งคนเดียว (ตอบเมื่อพิมพ์ "<ชื่อ>วิ่ง") */
function formatRunMessage(name, dateKey, scheduleText, eventName) {
  const lines = [
    `🏃 ตารางวิ่งของ ${name} วันนี้ (${formatThaiDate(dateKey)})`,
    `📋 ${scheduleText}`,
  ];
  if (eventName) {
    lines.push(`🎽 งานวิ่ง: ${eventName}`);
  }
  return lines.join('\n');
}

/** สร้างข้อความรวมตารางวิ่งทุกคนสำหรับ cron ตี 5 */
function formatAllRunnersMessage(dateKey, day, runnerNames) {
  const lines = [`🏃 ตารางวิ่งวันนี้ (${formatThaiDate(dateKey)})`];

  if (day.eventName) {
    lines.push(`🎽 งานวิ่ง: ${day.eventName}`);
  }

  let hasAny = false;
  for (const name of runnerNames) {
    const scheduleText = day.schedules?.[name];
    if (!scheduleText) continue;
    hasAny = true;
    lines.push('');
    lines.push(`👤 ${name}`);
    lines.push(`📋 ${scheduleText}`);
  }

  if (!hasAny) return null;
  return lines.join('\n');
}

/**
 * ลองจับข้อความแบบ "<ชื่อ>วิ่ง"
 * คืน { handled: true } ถ้าตอบไปแล้ว
 * คืน { handled: false } ถ้าไม่ใช่คำสั่งวิ่ง หรือชื่อไม่ตรง header → ปล่อยให้ handler อื่นจัดการ
 */
async function tryHandleRunQuery(replyToken, text) {
  const match = text.trim().match(/^(.+?)\s*วิ่ง\s*$/u);
  if (!match) {
    return { handled: false };
  }

  const queryName = match[1].trim();
  if (!queryName) {
    return { handled: false };
  }

  let sheet;
  try {
    sheet = await fetchRunScheduleSheet();
  } catch (err) {
    console.error('[run] ดึง Google Sheet ไม่สำเร็จ:', err.message || err);
    await replyText(replyToken, 'ตอนนี้ดึงข้อมูลตารางวิ่งไม่ได้ ลองใหม่อีกครั้งครับ');
    return { handled: true };
  }

  const runnerName = matchRunnerName(queryName, sheet.runnerNames);
  // ชื่อไม่ตรง header ใด ๆ → ไม่ตอบ ปล่อยผ่าน
  if (!runnerName) {
    return { handled: false };
  }

  const dateKey = todayInBangkok();
  const day = sheet.byDate[dateKey];
  const scheduleText = day?.schedules?.[runnerName];

  if (!scheduleText) {
    await replyText(replyToken, `วันนี้ยังไม่มีตารางวิ่งของ ${runnerName} ครับ 😴`);
    return { handled: true };
  }

  await replyText(
    replyToken,
    formatRunMessage(runnerName, dateKey, scheduleText, day.eventName || '')
  );
  return { handled: true };
}

/**
 * Cron 05:00 — สร้างข้อความรวมทุกคน แล้ว push หาผู้ใช้ที่สมัครแจ้งเตือน
 * (ชุดเดียวกับ users.json ของแจ้งอากาศ) ไม่แยกส่งรายคน
 */
async function sendDailyRunSchedules() {
  const users = loadUsers();
  const userIds = Object.keys(users);

  if (userIds.length === 0) {
    console.log('[cron-run] ไม่มีผู้ใช้ในรายการแจ้งเตือน');
    return;
  }

  let sheet;
  try {
    sheet = await fetchRunScheduleSheet();
  } catch (err) {
    console.error('[cron-run] ดึง Google Sheet ไม่สำเร็จ:', err.message || err);
    return;
  }

  const dateKey = todayInBangkok();
  const day = sheet.byDate[dateKey];

  if (!day) {
    console.log(`[cron-run] ไม่มีแถววันที่ ${dateKey} ในชีท`);
    return;
  }

  const text = formatAllRunnersMessage(dateKey, day, sheet.runnerNames);
  if (!text) {
    console.log(`[cron-run] วันนี้ยังไม่มีตารางวิ่งของใครเลย (${dateKey})`);
    return;
  }

  console.log(`[cron-run] เริ่มส่งตารางวิ่งรวมให้ผู้ใช้ ${userIds.length} คน`);

  for (const userId of userIds) {
    try {
      await client.pushMessage({
        to: userId,
        messages: [{ type: 'text', text }],
      });
      console.log(`[cron-run] ส่งสำเร็จ → ${userId}`);
    } catch (err) {
      // ดัก error คนละคน ไม่ให้กระทบคนอื่น
      console.error(`[cron-run] ส่งไม่สำเร็จ → ${userId}:`, err.message || err);
    }
  }
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

  // log userId ไว้ดูตอน debug (ไม่จำเป็นต่อตารางวิ่งแล้ว)
  if (event.message.type === 'text') {
    console.log(`[webhook] userId=${userId} text=${event.message.text}`);
  } else {
    console.log(`[webhook] userId=${userId} type=${event.message.type}`);
  }

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

    // ตารางวิ่ง: "<ชื่อ>วิ่ง" — ถ้าชื่อไม่ตรง header จะปล่อยผ่านไป handler อากาศด้านล่าง
    const runResult = await tryHandleRunQuery(replyToken, text);
    if (runResult.handled) {
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
      'คุณสมัครรับแจ้งเตือนอยู่แล้ว ✓\nจะส่งสรุปอากาศทุกชั่วโมงตามตำแหน่งที่แชร์ไว้\n\nพิมพ์ "หยุด" หากต้องการยกเลิก\nพิมพ์ "<ชื่อ>วิ่ง" เช่น "จ๋าวิ่ง" เพื่อดูตารางวิ่งวันนี้'
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

// แจ้งตารางวิ่งทุกวันตี 5 (Asia/Bangkok) — ตั้ง timezone ชัดเจนแม้เซิร์ฟเวอร์ไม่ใช่เวลาไทย
cron.schedule(
  '0 5 * * *',
  () => {
    sendDailyRunSchedules().catch((err) => {
      console.error('[cron-run] เกิดข้อผิดพลาดที่ไม่คาดคิด:', err);
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

// endpoint สำรองให้ cron ภายนอกเรียกแจ้งตารางวิ่ง (กรณี free tier sleep พลาด node-cron ตี 5)
app.get('/cron/runs', async (req, res) => {
  if (!CRON_SECRET || req.query.secret !== CRON_SECRET) {
    return res.status(401).send('unauthorized');
  }
  try {
    await sendDailyRunSchedules();
    res.status(200).send('ok');
  } catch (err) {
    console.error('[cron-run-http] ล้มเหลว:', err);
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
  console.log('🏃 Cron แจ้งตารางวิ่งทุกวัน 05:00 (Asia/Bangkok)');
});
