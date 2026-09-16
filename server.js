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
  parseRunQuery,
  dateKeyInCurrentWeek,
  loadWeatherUsers,
  saveWeatherUsers,
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

// ========== ผู้ใช้แจ้งอากาศ (เก็บถาวรใน Google Sheet แท็บ users) ==========

/** โหลดผู้ใช้ — Google Sheet เป็นหลัก, แล้ว WEATHER_USERS_JSON, แล้วไฟล์ท้องถิ่น */
async function loadUsers() {
  // 1) Google Sheet แท็บ users
  try {
    const fromSheet = await loadWeatherUsers();
    if (Object.keys(fromSheet).length > 0) {
      return fromSheet;
    }
  } catch (err) {
    console.error('อ่านผู้ใช้จาก Google Sheet ไม่สำเร็จ:', err.message);
  }

  // 2) Environment (ใช้บน Render ถ้ายังแชร์ Sheet เป็น Viewer อยู่)
  if (process.env.WEATHER_USERS_JSON) {
    try {
      const fromEnv = JSON.parse(process.env.WEATHER_USERS_JSON);
      if (fromEnv && typeof fromEnv === 'object') {
        return fromEnv;
      }
    } catch (err) {
      console.error('parse WEATHER_USERS_JSON ไม่สำเร็จ:', err.message);
    }
  }

  // 3) ไฟล์ท้องถิ่น
  try {
    if (!fs.existsSync(USERS_FILE)) return {};
    return JSON.parse(fs.readFileSync(USERS_FILE, 'utf8') || '{}');
  } catch (fileErr) {
    console.error('อ่าน users.json ไม่สำเร็จ:', fileErr.message);
    return {};
  }
}

/** บันทึกผู้ใช้ลง Google Sheet (+ สำรองไฟล์ท้องถิ่น) */
async function saveUsers(users) {
  try {
    fs.writeFileSync(USERS_FILE, JSON.stringify(users, null, 2), 'utf8');
  } catch (err) {
    console.error('สำรอง users.json ไม่สำเร็จ:', err.message);
  }

  try {
    await saveWeatherUsers(users);
  } catch (err) {
    console.error('บันทึกผู้ใช้ลง Google Sheet ไม่สำเร็จ:', err.message);
    // ไม่ throw — ยังมีไฟล์สำรอง / WEATHER_USERS_JSON; แจ้งใน reply ตอนแชร์ location แทน
    const perm = /permission|insufficient|403/i.test(err.message || '');
    if (perm) {
      const e = new Error(
        'Service Account ยังไม่มีสิทธิ์เขียนชีท — แชร์ชีทเป็น Editor แล้วลองใหม่'
      );
      e.code = 'SHEET_WRITE_DENIED';
      throw e;
    }
    throw err;
  }
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

/** สร้างข้อความตารางวิ่งคนเดียว — ลำดับ: ชื่อ → งานวิ่ง → โจทย์ → หมายเหตุ */
function formatRunMessage(dateKey, entry, dayLabel) {
  const when = dayLabel ? `วัน${dayLabel}` : 'วันนี้';
  const lines = [`🏃 ตารางวิ่งของ ${entry.name} ${when} (${formatThaiDate(dateKey)})`];
  if (entry.eventName) lines.push(`🎽 งานวิ่ง: ${entry.eventName}`);
  if (entry.task) lines.push(`📋 โจทย์: ${entry.task}`);
  if (entry.note) lines.push(`📝 หมายเหตุ: ${entry.note}`);
  return lines.join('\n');
}

/** สร้างข้อความรวมตารางวิ่งทุกคนสำหรับ cron ตี 5 */
function formatAllRunnersMessage(dateKey, day) {
  const entries = day?.entries || [];
  if (entries.length === 0) return null;

  const lines = [`🏃 ตารางวิ่งวันนี้ (${formatThaiDate(dateKey)})`];

  for (const entry of entries) {
    lines.push('');
    lines.push(`👤 ${entry.name}`);
    if (entry.eventName) lines.push(`🎽 งานวิ่ง: ${entry.eventName}`);
    if (entry.task) lines.push(`📋 โจทย์: ${entry.task}`);
    if (entry.note) lines.push(`📝 หมายเหตุ: ${entry.note}`);
  }

  return lines.join('\n');
}

/**
 * ลองจับข้อความแบบ "[วัน]<ชื่อ>วิ่ง" เช่น "นิววิ่ง", "ศุกร์นิววิ่ง"
 * คืน { handled: true } ถ้าตอบไปแล้ว
 * คืน { handled: false } ถ้าไม่ใช่คำสั่งวิ่ง หรือชื่อไม่ตรง → ปล่อยให้ handler อื่นจัดการ
 */
async function tryHandleRunQuery(replyToken, text) {
  const parsed = parseRunQuery(text);
  if (!parsed) {
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

  const runnerName = matchRunnerName(parsed.queryName, sheet.runnerNames);
  // ชื่อไม่ตรงรายชื่อในชีท → ไม่ตอบ ปล่อยผ่าน
  if (!runnerName) {
    return { handled: false };
  }

  const dateKey =
    parsed.weekdayDow == null ? todayInBangkok() : dateKeyInCurrentWeek(parsed.weekdayDow);
  const dayLabel = parsed.weekdayLabel; // null = วันนี้
  const day = sheet.byDate[dateKey];
  const entry = day?.entries?.find((e) => e.name === runnerName);

  if (!entry) {
    const when = dayLabel ? `วัน${dayLabel}` : 'วันนี้';
    await replyText(replyToken, `${when}ยังไม่มีตารางวิ่งของ ${runnerName} ครับ 😴`);
    return { handled: true };
  }

  await replyText(replyToken, formatRunMessage(dateKey, entry, dayLabel));
  return { handled: true };
}

/**
 * Cron 05:00 — สร้างข้อความรวมทุกคน แล้ว push หาผู้ใช้ที่สมัครแจ้งเตือน
 * (ชุดเดียวกับ users.json ของแจ้งอากาศ) ไม่แยกส่งรายคน
 */
async function sendDailyRunSchedules() {
  const users = await loadUsers();
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
  const text = formatAllRunnersMessage(dateKey, day);

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

/** แปลง AQI ของ OpenWeather (1–5) เป็นข้อความภาษาไทย */
function aqiLabel(aqi) {
  const map = {
    1: 'ดีมาก',
    2: 'ดี',
    3: 'ปานกลาง',
    4: 'แย่',
    5: 'แย่มาก',
  };
  return map[aqi] || '-';
}

/** ดึงคุณภาพอากาศ (PM2.5 / AQI) — ถ้าเรียกไม่สำเร็จคืน null ไม่ให้กระทบรายงานอากาศหลัก */
async function fetchAirPollution(lat, lng) {
  try {
    const { data } = await axios.get('https://api.openweathermap.org/data/2.5/air_pollution', {
      params: {
        lat,
        lon: lng,
        appid: OPENWEATHER_API_KEY,
      },
      timeout: 10000,
    });

    const item = data.list?.[0];
    if (!item) return null;

    const pm25 = item.components?.pm2_5;
    const aqi = item.main?.aqi;

    return {
      pm25: pm25 != null ? Math.round(pm25 * 10) / 10 : null,
      aqi: aqi != null ? aqi : null,
      aqiText: aqi != null ? aqiLabel(aqi) : null,
    };
  } catch (err) {
    console.error('[air] ดึงคุณภาพอากาศไม่สำเร็จ:', err.message || err);
    return null;
  }
}

/** ดึงสภาพอากาศ + ฝุ่น จาก lat/lng ตามตำแหน่งที่ผู้ใช้แชร์ */
async function fetchWeather(lat, lng) {
  const weatherUrl = 'https://api.openweathermap.org/data/2.5/weather';

  const [weatherRes, air] = await Promise.all([
    axios.get(weatherUrl, {
      params: {
        lat,
        lon: lng,
        appid: OPENWEATHER_API_KEY,
        units: 'metric',
        lang: 'th',
      },
      timeout: 10000,
    }),
    fetchAirPollution(lat, lng),
  ]);

  const data = weatherRes.data;
  const weather = data.weather?.[0] || {};

  return {
    temp: Math.round(data.main.temp),
    feelsLike: Math.round(data.main.feels_like),
    humidity: data.main.humidity,
    description: weather.description || '-',
    emoji: weatherEmoji(weather.id),
    pm25: air?.pm25 ?? null,
    aqi: air?.aqi ?? null,
    aqiText: air?.aqiText ?? null,
  };
}

/** สร้างข้อความสรุปสภาพอากาศ (รวมฝุ่น PM2.5) */
function formatWeatherMessage(weather) {
  const now = new Date().toLocaleString('th-TH', {
    timeZone: 'Asia/Bangkok',
    dateStyle: 'short',
    timeStyle: 'short',
  });

  const lines = [
    `${weather.emoji} อุณหภูมิ ${weather.temp}°C (รู้สึกเหมือน ${weather.feelsLike}°C)`,
    `💧 ความชื้น ${weather.humidity}%`,
    `☁️ สภาพอากาศ: ${weather.description}`,
  ];

  if (weather.pm25 != null) {
    lines.push(`🌫️ PM2.5: ${weather.pm25} µg/m³`);
  }
  if (weather.aqi != null && weather.aqiText) {
    lines.push(`📊 คุณภาพอากาศ: ${weather.aqi}/5 (${weather.aqiText})`);
  }

  lines.push(`🕐 อัปเดต: ${now}`);
  return lines.join('\n');
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
  const users = await loadUsers();

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
    try {
      await saveUsers(users);
      await replyText(
        replyToken,
        '✅ บันทึกตำแหน่งของคุณเรียบร้อยแล้ว\nจะเริ่มแจ้งอุณหภูมิ ความชื้น และค่าฝุ่น PM2.5 ทุกชั่วโมง\n\nพิมพ์ "หยุด" หรือ "unsubscribe" เมื่อต้องการยกเลิก'
      );
    } catch (err) {
      console.error('บันทึกตำแหน่งล้มเหลว:', err.message);
      await replyText(
        replyToken,
        '⚠️ รับตำแหน่งแล้ว แต่บันทึกลงระบบยังไม่สำเร็จ\nกรุณาแชร์ชีท Google ให้ Service Account เป็น Editor แล้วลองแชร์ตำแหน่งอีกครั้ง'
      );
    }
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
        try {
          await saveUsers(users);
        } catch (err) {
          console.error('ลบผู้ใช้จาก Sheet ไม่สำเร็จ:', err.message);
        }
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
      'คุณสมัครรับแจ้งเตือนอยู่แล้ว ✓\nจะส่งสรุปอากาศทุกชั่วโมงตามตำแหน่งที่แชร์ไว้\n\nพิมพ์ "หยุด" หากต้องการยกเลิก\nพิมพ์ "นิววิ่ง" หรือ "ศุกร์นิววิ่ง" เพื่อดูตารางวิ่ง'
    );
  }
}

// ========== Cron: แจ้งอากาศทุกชั่วโมง ==========

async function sendHourlyWeather() {
  const users = await loadUsers();
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
        try {
          const latest = await loadUsers();
          if (latest[userId]) {
            delete latest[userId];
            await saveUsers(latest);
            console.log(`[cron] ลบผู้ใช้ ${userId} ออกจากรายการ (status ${status})`);
          }
        } catch (saveErr) {
          console.error('[cron] ลบผู้ใช้จาก Sheet ไม่สำเร็จ:', saveErr.message);
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
