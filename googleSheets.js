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

/** หา index คอลัมน์จาก header (ไม่สนตัวพิมพ์เล็ก/ใหญ่ ตัดช่องว่าง) */
function findColumnIndex(headers, aliases) {
  const normalized = headers.map((h) => String(h || '').trim().toLowerCase());
  for (const alias of aliases) {
    const i = normalized.indexOf(alias.toLowerCase());
    if (i >= 0) return i;
  }
  return -1;
}

/**
 * แปลงแถวดิบจาก Sheets เป็นโครงสร้างใช้งาน
 * คอลัมน์: date | งานวิ่ง | โจทย์ | หมายเหตุ | ชื่อ
 * (หาคอลัมน์จากชื่อ header — แถวละหนึ่งคน)
 */
function parseSheetRows(rows) {
  if (!rows || rows.length === 0) {
    return { runnerNames: [], byDate: {} };
  }

  const headers = rows[0].map((h) => String(h || '').trim());
  const colDate = findColumnIndex(headers, ['date', 'วันที่']);
  const colEvent = findColumnIndex(headers, ['งานวิ่ง']);
  const colTask = findColumnIndex(headers, ['โจทย์']);
  const colNote = findColumnIndex(headers, ['หมายเหตุ']);
  const colName = findColumnIndex(headers, ['ชื่อ', 'name']);

  if (colDate < 0 || colName < 0) {
    throw new Error('ชีทต้องมีคอลัมน์ header ชื่อ "date" และ "ชื่อ"');
  }

  const byDate = {};
  const nameSet = new Set();

  for (let r = 1; r < rows.length; r += 1) {
    const row = rows[r] || [];
    const date = normalizeDate(row[colDate]);
    const name = String(row[colName] || '').trim();
    if (!date || !name) continue;

    nameSet.add(name);

    const entry = {
      name,
      eventName: colEvent >= 0 ? String(row[colEvent] || '').trim() : '',
      task: colTask >= 0 ? String(row[colTask] || '').trim() : '',
      note: colNote >= 0 ? String(row[colNote] || '').trim() : '',
    };

    // ต้องมีอย่างน้อยโจทย์ / งานวิ่ง / หมายเหตุ อย่างใดอย่างหนึ่ง
    if (!entry.task && !entry.eventName && !entry.note) continue;

    if (!byDate[date]) {
      byDate[date] = { entries: [] };
    }
    byDate[date].entries.push(entry);
  }

  return {
    runnerNames: [...nameSet],
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
 * จับคู่ชื่อจากข้อความกับรายชื่อในชีท (exact หรือ contains, ไม่สนตัวพิมพ์)
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
