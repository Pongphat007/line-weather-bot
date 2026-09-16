const { google } = require('googleapis');

/**
 * สร้าง JWT auth จาก Service Account ใน .env
 * GOOGLE_PRIVATE_KEY ใน .env ใช้ \n แทนขึ้นบรรทัดใหม่
 */
function createSheetsClient() {
  const sheetId = process.env.GOOGLE_SHEET_ID;
  const email = process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL;
  const privateKey = (process.env.GOOGLE_PRIVATE_KEY || '').replace(/\\n/g, '\n');

  if (!sheetId || !email || !privateKey) {
    throw new Error('ยังไม่ได้ตั้งค่า GOOGLE_SHEET_ID / GOOGLE_SERVICE_ACCOUNT_EMAIL / GOOGLE_PRIVATE_KEY');
  }

  const auth = new google.auth.JWT({
    email,
    key: privateKey,
    scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
  });

  return {
    sheetId,
    sheets: google.sheets({ version: 'v4', auth }),
  };
}

/** แปลงค่าวันที่จากชีทให้เป็น YYYY-MM-DD */
function normalizeDate(value) {
  if (value == null || value === '') return null;
  const raw = String(value).trim();

  // รูปแบบที่ต้องการ: YYYY-MM-DD
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return raw;
  }

  // รองรับ DD/MM/YYYY หรือ D/M/YYYY
  const dmy = raw.match(/^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/);
  if (dmy) {
    const day = dmy[1].padStart(2, '0');
    const month = dmy[2].padStart(2, '0');
    return `${dmy[3]}-${month}-${day}`;
  }

  return null;
}

/**
 * แปลงแถวดิบจาก Sheets เป็นโครงสร้างใช้งาน
 * คอลัมน์ A = Date, B = งานวิ่ง, คอลัมน์ถัดไป = ชื่อคน (dynamic จาก header)
 */
function parseSheetRows(rows) {
  if (!rows || rows.length === 0) {
    return { runnerNames: [], byDate: {} };
  }

  const headers = rows[0].map((h) => String(h || '').trim());
  const runnerNames = [];

  // อ่าน header คนวิ่งแบบ dynamic ตั้งแต่คอลัมน์ C เป็นต้นไป (index 2+)
  for (let i = 2; i < headers.length; i += 1) {
    const name = headers[i];
    if (name) {
      runnerNames.push({ name, colIndex: i });
    }
  }

  const byDate = {};
  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r] || [];
    const date = normalizeDate(row[0]);
    if (!date) continue;

    const eventName = String(row[1] || '').trim();
    const schedules = {};

    for (const { name, colIndex } of runnerNames) {
      const value = String(row[colIndex] || '').trim();
      if (value) {
        schedules[name] = value;
      }
    }

    byDate[date] = { eventName, schedules };
  }

  return {
    runnerNames: runnerNames.map((r) => r.name),
    byDate,
  };
}

/**
 * ดึงทั้งชีทครั้งเดียว แล้ว parse เป็น object ในหน่วยความจำ
 * ใช้ร่วมกันทั้งตอบในแชทและ cron ตี 5
 */
async function fetchRunScheduleSheet() {
  const { sheetId, sheets } = createSheetsClient();

  const res = await sheets.spreadsheets.values.get({
    spreadsheetId: sheetId,
    // อ่านชีทแรกทั้งแผ่น (header + ทุกแถว)
    range: 'A:ZZ',
  });

  return parseSheetRows(res.data.values || []);
}

/** วันที่วันนี้ตาม Asia/Bangkok เป็น YYYY-MM-DD */
function todayInBangkok() {
  return new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' });
}

/**
 * จับคู่ชื่อจากข้อความกับ header ในชีท (exact หรือ contains, ไม่สนตัวพิมพ์)
 * คืนชื่อตาม header จริง หรือ null ถ้าไม่เจอ
 */
function matchRunnerName(queryName, runnerNames) {
  const q = String(queryName || '').trim().toLowerCase();
  if (!q || !Array.isArray(runnerNames)) return null;

  const exact = runnerNames.find((name) => name.toLowerCase() === q);
  if (exact) return exact;

  const contains = runnerNames.find(
    (name) => name.toLowerCase().includes(q) || q.includes(name.toLowerCase())
  );
  return contains || null;
}

module.exports = {
  fetchRunScheduleSheet,
  parseSheetRows,
  todayInBangkok,
  matchRunnerName,
  normalizeDate,
};
