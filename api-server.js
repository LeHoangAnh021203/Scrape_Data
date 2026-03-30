import express from 'express';
import cors from 'cors';
import cron from 'node-cron';
import { connectDB, Skin, SyncState } from './src/db.js';
import { cfg } from './src/config.js';
import puppeteer from 'puppeteer';
import { extractAllPages } from './src/utils/pagination-extractor.js';
import { once } from 'events';

const app = express();
const PORT = process.env.API_PORT || 3001;
const ALLOWED_RANGE_FIELDS = ['scrapedAt', 'crt_time'];
const DEFAULT_RANGE_FIELD = ALLOWED_RANGE_FIELDS.includes((process.env.DEFAULT_RANGE_FIELD || '').trim())
  ? (process.env.DEFAULT_RANGE_FIELD || '').trim()
  : 'crt_time';

const getHourInTimezone = (now = new Date(), timezone = 'Asia/Ho_Chi_Minh') => {
  const hourText = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour: '2-digit',
    hour12: false
  }).format(now);
  const hour = Number(hourText);
  return Number.isFinite(hour) ? hour : now.getHours();
};

const isWithinSyncWindow = (now = new Date()) => {
  const startHour = Number.isFinite(cfg.syncWindow?.startHour) ? cfg.syncWindow.startHour : 9;
  const endHour = Number.isFinite(cfg.syncWindow?.endHour) ? cfg.syncWindow.endHour : 22;
  const timezone = cfg.syncTimezone || 'Asia/Ho_Chi_Minh';
  const currentHour = getHourInTimezone(now, timezone);

  if (startHour === endHour) return true;
  if (startHour < endHour) {
    return currentHour >= startHour && currentHour < endHour;
  }
  return currentHour >= startHour || currentHour < endHour;
};

const normalizeAccessToken = (raw) => {
  if (!raw) return '';
  const token = String(raw).trim();
  if (!token) return '';
  if (/%[0-9A-Fa-f]{2}/.test(token)) {
    try {
      return decodeURIComponent(token);
    } catch (_) {
      return token;
    }
  }
  return token;
};

const getTidPrefixFromToken = (raw) => {
  const token = normalizeAccessToken(raw);
  if (!token) return '';
  const parts = token.split('.');
  const last = parts[parts.length - 1];
  if (!last) return '';
  try {
    const decoded = Buffer.from(last, 'base64').toString('utf8');
    const candidate = decoded.split(':').pop();
    if (/^\d+$/.test(candidate)) return candidate;
  } catch (_) {}
  return '';
};

const applyAccessToken = async (page, token) => {
  if (!token) return;
  const normalized = normalizeAccessToken(token);
  if (!normalized) return;
  const tidPrefix = getTidPrefixFromToken(normalized);
  const locale = cfg.forceLocale || '';
  const language = cfg.forceLanguage || '';
  const weidu = cfg.forceWeidu || '';
  try {
    await page.setCookie({
      name: 'access_token',
      value: normalized,
      url: 'https://zm.bitmoji-zmlh.com/',
      path: '/',
      secure: true
    });
  } catch (_) {}
  try {
    await page.evaluate(({ value, tidPrefix, locale, language, weidu }) => {
      localStorage.setItem('access_token', value);
      localStorage.setItem('accessToken', value);
      sessionStorage.setItem('access_token', value);
      sessionStorage.setItem('accessToken', value);
      if (tidPrefix) {
        const tidValue = `${tidPrefix}-${Date.now()}`;
        localStorage.setItem('x-tid', tidValue);
        localStorage.setItem('tid', tidValue);
        sessionStorage.setItem('x-tid', tidValue);
        sessionStorage.setItem('tid', tidValue);
      }
      if (locale) {
        localStorage.setItem('locale', locale);
        sessionStorage.setItem('locale', locale);
      }
      if (language) {
        localStorage.setItem('language', language);
        sessionStorage.setItem('language', language);
      }
      if (weidu) {
        localStorage.setItem('weidu', weidu);
        sessionStorage.setItem('weidu', weidu);
      }
    }, { value: normalized, tidPrefix, locale, language, weidu });
  } catch (_) {}
};

const buildBootstrapApiConfig = (rawToken, extraHeaders = {}) => {
  const token = normalizeAccessToken(rawToken || cfg.forceAccessToken);
  if (!token) return null;
  const tidPrefix = getTidPrefixFromToken(token);
  const headers = {
    access_token: token,
    locale: 'en',
    language: 'en'
  };
  if (tidPrefix) headers['x-tid'] = `${tidPrefix}-${Date.now()}`;
  if (extraHeaders && typeof extraHeaders === 'object') {
    Object.assign(headers, extraHeaders);
  }
  return {
    url: 'https://zm.bitmoji-zmlh.com/skinMgrSrv/record/list',
    method: 'POST',
    headers,
    payload: {
      code: '-1',
      page: '1',
      pageSize: '10',
      weidu: 'all'
    }
  };
};

const maskToken = (token) => {
  const normalized = normalizeAccessToken(token);
  if (!normalized) return '';
  return `${normalized.slice(0, 6)}...${normalized.slice(-6)}`;
};

const fetchAccessTokenViaApi = async () => {
  if (!cfg.auth?.useApiLogin) return null;
  const username = cfg.auth.username || cfg.auth.email;
  const password = cfg.auth.password;
  if (!username || !password) return null;

  const params = new URLSearchParams({
    username,
    password,
    client_id: cfg.auth.clientId || '93dc94c23d83c2ca',
    app_type: cfg.auth.appType || 'zmskin',
    code_token: cfg.auth.codeToken || '-1'
  });

  try {
    const resp = await fetch('https://zm.bitmoji-zmlh.com/auth2/token', {
      method: 'POST',
      headers: {
        accept: 'application/json, text/plain, */*',
        'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
        locale: 'en',
        language: 'en'
      },
      body: params.toString()
    });
    if (!resp.ok) {
      console.log(`⚠️  Auth API failed: ${resp.status} ${resp.statusText}`);
      return null;
    }
    const data = await resp.json().catch(() => null);
    const token = data?.access_token || data?.data?.access_token || '';
    const code = data?.code ?? data?.data?.code;
    if (!token || (typeof code !== 'undefined' && Number(code) !== 0)) {
      console.log('⚠️  Auth API returned no token');
      return null;
    }
    const masked = `${token.slice(0, 6)}...${token.slice(-6)}`;
    console.log(`✅ Auth API token acquired: ${masked}`);
    return token;
  } catch (error) {
    console.log(`⚠️  Auth API error: ${error.message}`);
    return null;
  }
};

const readAuthTokenFromPage = async (page) => {
  try {
    return await page.evaluate(() => {
      const cookieToken = document.cookie
        .split(';')
        .map(s => s.trim())
        .find(s => s.startsWith('access_token=') || s.startsWith('accessToken='));
      const cookieValue = cookieToken ? cookieToken.split('=').slice(1).join('=') : '';
      return (
        localStorage.getItem('access_token') ||
        localStorage.getItem('accessToken') ||
        localStorage.getItem('token') ||
        sessionStorage.getItem('access_token') ||
        sessionStorage.getItem('accessToken') ||
        sessionStorage.getItem('token') ||
        cookieValue ||
        ''
      );
    });
  } catch (_) {
    return '';
  }
};

const logSessionPrefs = async (page, label) => {
  try {
    const prefs = await page.evaluate(() => {
      const pick = key => localStorage.getItem(key) || sessionStorage.getItem(key) || '';
      return {
        locale: pick('locale'),
        language: pick('language'),
        weidu: pick('weidu'),
        tid: pick('x-tid') || pick('tid'),
        token: pick('access_token') || pick('accessToken')
      };
    });
    const masked = prefs.token ? `${prefs.token.slice(0, 6)}...${prefs.token.slice(-6)}` : '';
    console.log(`🧭 Session prefs ${label}:`, { ...prefs, token: masked });
  } catch (_) {}
};

const normalizeDateInput = (value, isEnd = false) => {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const pad = n => String(n).padStart(2, '0');
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return `${raw} ${isEnd ? '23:59' : '00:00'}`;
  }
  if (/^\d{4}-\d{1,2}$/.test(raw)) {
    const [y, m] = raw.split('-').map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return raw;
    if (isEnd) {
      const end = new Date(y, m, 0, 23, 59, 0, 0);
      return `${end.getFullYear()}-${pad(end.getMonth() + 1)}-${pad(end.getDate())} 23:59`;
    }
    return `${y}-${pad(m)}-01 00:00`;
  }
  return raw;
};

const normalizeRangeField = (value) => {
  const field = (value || DEFAULT_RANGE_FIELD).trim();
  return ALLOWED_RANGE_FIELDS.includes(field) ? field : DEFAULT_RANGE_FIELD;
};

const parseDateInput = (value) => {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    const parsed = new Date(`${raw}T00:00:00`);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (/^\d{4}-\d{1,2}$/.test(raw)) {
    const [y, m] = raw.split('-').map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
    const parsed = new Date(y, m - 1, 1, 0, 0, 0, 0);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}(:\d{2})?$/.test(raw)) {
    const normalized = raw.replace(' ', 'T');
    const withSeconds = normalized.length === 16 ? `${normalized}:00` : normalized;
    const parsed = new Date(withSeconds);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const parseRangeDateString = (value) => {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const parsed = new Date(raw.replace(' ', 'T'));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
};

const parseRangeDateValue = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value;
  return parseRangeDateString(value);
};

const padNumber = (num) => String(num).padStart(2, '0');

const formatRangeBoundary = (date) => {
  if (!date) return null;
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())} `
    + `${padNumber(date.getHours())}:${padNumber(date.getMinutes())}`;
};

const getLatestMonthRange = async (field) => {
  const latest = await Skin.findOne({ [field]: { $exists: true, $ne: '' } })
    .sort({ [field]: -1 })
    .lean();
  if (!latest) return null;
  const rawValue = latest[field];
  const parsed = parseRangeDateValue(rawValue);
  if (!parsed) return null;
  const year = parsed.getFullYear();
  const month = parsed.getMonth();
  const start = new Date(year, month, 1, 0, 0, 0, 0);
  const end = new Date(year, month + 1, 0, 23, 59, 0, 0);
  return {
    start: formatRangeBoundary(start),
    end: formatRangeBoundary(end)
  };
};

const timezoneFormatterCache = new Map();

const getTimezoneFormatter = (timezone) => {
  const key = timezone || 'UTC';
  if (!timezoneFormatterCache.has(key)) {
    timezoneFormatterCache.set(
      key,
      new Intl.DateTimeFormat('en-US', {
        timeZone: key,
        hourCycle: 'h23',
        hour12: false,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit'
      })
    );
  }
  return timezoneFormatterCache.get(key);
};

const getTimezoneParts = (timestamp, timezone) => {
  try {
    const formatter = getTimezoneFormatter(timezone);
    const parts = formatter.formatToParts(new Date(timestamp));
    const parsed = {};
    for (const part of parts) {
      if (part.type !== 'literal' && part.value) {
        parsed[part.type] = Number(part.value);
      }
    }
    if (!parsed.year || !parsed.month || !parsed.day) return null;
    return {
      year: parsed.year,
      month: parsed.month,
      day: parsed.day,
      hour: Number.isFinite(parsed.hour) ? parsed.hour : 0,
      minute: Number.isFinite(parsed.minute) ? parsed.minute : 0,
      second: Number.isFinite(parsed.second) ? parsed.second : 0
    };
  } catch (_) {
    return null;
  }
};

const parseTimestampComponents = (value) => {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const [datePart, timePart = '00:00:00'] = raw.split(' ');
  const dateSegments = datePart.split('-');
  if (dateSegments.length !== 3) return null;
  const [year, month, day] = dateSegments.map(Number);
  if (![year, month, day].every(Number.isFinite)) return null;
  const [hour = '0', minute = '0', second = '0'] = timePart.split(':');
  const hourNum = Number(hour);
  const minuteNum = Number(minute);
  const secondNum = Number(second);
  if (![hourNum, minuteNum, secondNum].every(Number.isFinite)) return null;
  return {
    year,
    month,
    day,
    hour: hourNum,
    minute: minuteNum,
    second: secondNum
  };
};

const parseDateInTimezone = (value, timezone) => {
  const components = parseTimestampComponents(value);
  if (!components) return null;
  const { year, month, day, hour, minute, second } = components;
  const guessMs = Date.UTC(year, month - 1, day, hour, minute, second);
  const actual = getTimezoneParts(guessMs, timezone);
  if (!actual) return new Date(guessMs);
  const actualMs = Date.UTC(
    actual.year,
    actual.month - 1,
    actual.day,
    actual.hour,
    actual.minute,
    actual.second
  );
  const delta = actualMs - guessMs;
  return new Date(guessMs - delta);
};

const formatDateInTimezone = (date, timezone) => {
  if (!date) return null;
  const parts = getTimezoneParts(date.getTime(), timezone);
  if (!parts) return null;
  return `${parts.year}-${padNumber(parts.month)}-${padNumber(parts.day)} `
    + `${padNumber(parts.hour)}:${padNumber(parts.minute)}:${padNumber(parts.second)}`;
};

const formatStoredTime = (value) => {
  if (!value) return null;
  const hasTimezoneHint = /[zZ]$|[+-]\d{2}(:?\d{2})?$/.test(value.trim());
  let parsed = null;
  if (hasTimezoneHint) {
    parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) parsed = null;
  }
  if (!parsed) {
    parsed = parseDateInTimezone(value, cfg.sourceTimezone);
  }
  if (!parsed) return value;
  return formatDateInTimezone(parsed, cfg.displayTimezone) || value;
};

const formatDataRangeForDisplay = (range) => {
  if (!range) return range;
  return {
    from: formatStoredTime(range.from),
    to: formatStoredTime(range.to)
  };
};

const formatRangeForDisplay = (range) => {
  if (!range) return range;
  return {
    start: formatStoredTime(range.start),
    end: formatStoredTime(range.end)
  };
};

const formatRangeDateString = (date) => {
  if (!date) return '';
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())} ${padNumber(date.getHours())}:${padNumber(date.getMinutes())}`;
};

const addMinutes = (date, minutes) => new Date(date.getTime() + minutes * 60000);

const computeMissingRange = (rangeStart, rangeEnd, dataRange) => {
  if (!rangeStart || !rangeEnd) return null;
  const requestedStart = parseRangeDateString(rangeStart);
  const requestedEnd = parseRangeDateString(rangeEnd);
  if (!requestedStart || !requestedEnd) return null;
  const dataStart = dataRange?.from ? new Date(dataRange.from) : null;
  const dataEnd = dataRange?.to ? new Date(dataRange.to) : null;

  if (!dataEnd || dataEnd.getTime() < requestedEnd.getTime()) {
    const missingStart = dataEnd ? addMinutes(dataEnd, 1) : requestedStart;
    if (missingStart.getTime() > requestedEnd.getTime()) return null;
    return {
      start: formatRangeDateString(missingStart),
      end: formatRangeDateString(requestedEnd)
    };
  }
  if (!dataStart || dataStart.getTime() > requestedStart.getTime()) {
    const missingEnd = addMinutes(dataStart || requestedEnd, -1);
    if (missingEnd.getTime() < requestedStart.getTime()) return null;
    return {
      start: formatRangeDateString(requestedStart),
      end: formatRangeDateString(missingEnd)
    };
  }
  return null;
};

const formatDateTime = (date) => {
  const pad = n => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

const formatDateTimeInTimezone = (date, timezone) => {
  const formatted = formatDateInTimezone(date, timezone);
  if (!formatted) return formatDateTime(date);
  return formatted.slice(0, 16);
};

const getLatestRecordAnchor = async () => {
  const [latestByCrt, latestByTest, latestByScrapedAt] = await Promise.all([
    Skin.findOne({ crt_time: { $gt: '' } }).sort({ crt_time: -1 }).lean(),
    Skin.findOne({ testTime: { $gt: '' } }).sort({ testTime: -1 }).lean(),
    Skin.findOne({ scrapedAt: { $exists: true } }).sort({ scrapedAt: -1 }).lean()
  ]);

  const candidates = [];

  if (latestByCrt?.crt_time) {
    const parsed = parseDateInTimezone(latestByCrt.crt_time, cfg.sourceTimezone) || parseDateInput(latestByCrt.crt_time);
    if (parsed && !Number.isNaN(parsed.getTime())) {
      candidates.push({ sourceField: 'crt_time', latestRaw: latestByCrt.crt_time, latestDate: parsed });
    }
  }

  if (latestByTest?.testTime) {
    const parsed = parseDateInTimezone(latestByTest.testTime, cfg.sourceTimezone) || parseDateInput(latestByTest.testTime);
    if (parsed && !Number.isNaN(parsed.getTime())) {
      candidates.push({ sourceField: 'testTime', latestRaw: latestByTest.testTime, latestDate: parsed });
    }
  }

  if (latestByScrapedAt?.scrapedAt) {
    const parsed = latestByScrapedAt.scrapedAt instanceof Date
      ? latestByScrapedAt.scrapedAt
      : parseDateInput(latestByScrapedAt.scrapedAt);
    if (parsed && !Number.isNaN(parsed.getTime())) {
      candidates.push({ sourceField: 'scrapedAt', latestRaw: latestByScrapedAt.scrapedAt, latestDate: parsed });
    }
  }

  if (candidates.length === 0) return null;
  candidates.sort((a, b) => b.latestDate.getTime() - a.latestDate.getTime());
  return candidates[0];
};

const buildIncrementalSyncRange = async (now = new Date()) => {
  const anchor = await getLatestRecordAnchor();
  if (!anchor?.latestDate) return null;
  const rangeStartDate = new Date(anchor.latestDate.getTime() + 60 * 1000);
  if (rangeStartDate.getTime() > now.getTime()) {
    return {
      invalid: true,
      anchor,
      rangeStartDate,
      rangeEndDate: now
    };
  }
  const rangeTimezone = cfg.sourceTimezone || cfg.syncTimezone || 'Asia/Ho_Chi_Minh';
  return {
    invalid: false,
    anchor,
    rangeStartDate,
    rangeEndDate: now,
    rangeStart: formatDateTimeInTimezone(rangeStartDate, rangeTimezone),
    rangeEnd: formatDateTimeInTimezone(now, rangeTimezone)
  };
};

const rangeKey = (rangeStart, rangeEnd) => `range:${rangeStart || 'none'}:${rangeEnd || 'none'}`;

const buildRangeQuery = (rangeStart, rangeEnd, field = 'scrapedAt') => {
  if (!rangeStart || !rangeEnd) return null;
  if (field === 'crt_time') {
    return { [field]: { $gte: rangeStart, $lte: rangeEnd } };
  }
  const start = parseRangeDateValue(rangeStart);
  const end = parseRangeDateValue(rangeEnd);
  if (!start || !end) return null;
  return { [field]: { $gte: start, $lte: end } };
};

const buildTimeFieldQuery = (field, rangeFilter) => {
  const parts = [];
  if (rangeFilter) {
    parts.push(rangeFilter);
  }
  if (field === 'crt_time') {
    parts.push({ [field]: { $gt: '' } });
  } else {
    parts.push({ [field]: { $exists: true } });
  }
  return parts.length === 1 ? parts[0] : { $and: parts };
};

const toRangeFieldValue = (value) => {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return value;
};

const getDataTimeRange = async (rangeFilter = null, field = 'scrapedAt') => {
  const query = buildTimeFieldQuery(field, rangeFilter);
  const [oldest, newest] = await Promise.all([
    Skin.findOne(query).sort({ [field]: 1 }).lean(),
    Skin.findOne(query).sort({ [field]: -1 }).lean()
  ]);
  return {
    from: oldest ? toRangeFieldValue(oldest[field]) : null,
    to: newest ? toRangeFieldValue(newest[field]) : null
  };
};

// Middleware
app.use(cors());
app.use(express.json());

// Scraping status
let scrapingStatus = {
  isRunning: false,
  progress: {
    currentPage: 0,
    totalPages: 0,
    collectedItems: 0
  },
  startTime: null,
  endTime: null,
  error: null
};

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const syncQueue = [];
let syncWorkerRunning = false;
let currentSyncKey = null;

const shouldTriggerSync = (total, syncState, refresh) => {
  if (refresh) return true;
  if (!syncState) return total === 0;
  if (syncState.status === 'queued' || syncState.status === 'running') return false;
  return total === 0;
};

const enqueueSync = async ({ rangeStart, rangeEnd, reason = 'request', accessToken = '', incremental = false } = {}) => {
  if (!rangeStart || !rangeEnd) return null;
  const key = rangeKey(rangeStart, rangeEnd);
  const now = new Date();
  const syncState = await SyncState.findOneAndUpdate(
    { key },
    {
      $set: {
        rangeStart,
        rangeEnd,
        lastRequestedAt: now,
        status: 'queued',
        incremental
      },
      $setOnInsert: { key }
    },
    { upsert: true, new: true }
  ).lean();
  if (!syncQueue.find(item => item.key === key)) {
    syncQueue.push({ key, rangeStart, rangeEnd, reason, accessToken, incremental });
    setImmediate(runSyncWorker);
  }
  return syncState;
};

const runSyncWorker = async () => {
  if (syncWorkerRunning) return;
  syncWorkerRunning = true;
  try {
    while (syncQueue.length > 0) {
      if (scrapingStatus.isRunning) {
        await delay(1000);
        continue;
      }
      const job = syncQueue.shift();
      if (!job) break;
      currentSyncKey = job.key;
      const now = new Date();
      await SyncState.updateOne(
        { key: job.key },
        {
          $set: {
            status: 'running',
            lastStartedAt: now,
            lastError: null,
            incremental: job.incremental
          }
        }
      );
      try {
        scrapingStatus.isRunning = true;
        scrapingStatus.startTime = Date.now();
        scrapingStatus.progress = { currentPage: 0, totalPages: 0, collectedItems: 0 };
        scrapingStatus.error = null;
        scrapingStatus.endTime = null;

        const { items, upserts, newCount, updatedCount, unchangedCount } = await scrapeAllPagesOnce({
          saveToDb: true,
          rangeStart: job.rangeStart,
          rangeEnd: job.rangeEnd,
          chunkDateRange: false,
          accessTokenOverride: job.accessToken
        });

        const finishedAt = new Date();
        await SyncState.updateOne(
          { key: job.key },
          {
            $set: {
              status: 'success',
              lastFinishedAt: finishedAt,
              lastSuccessAt: finishedAt,
              totalRecords: items.length,
              upserts,
              newCount,
              updatedCount,
              unchangedCount
            }
          }
        );
        scrapingStatus.progress.collectedItems = items.length;
        scrapingStatus.endTime = Date.now();
        scrapingStatus.isRunning = false;
      } catch (error) {
        scrapingStatus.isRunning = false;
        scrapingStatus.error = error.message;
        scrapingStatus.endTime = Date.now();
        await SyncState.updateOne(
          { key: job.key },
          {
            $set: {
              status: 'error',
              lastFinishedAt: new Date(),
              lastError: error.message
            }
          }
        );
      } finally {
        currentSyncKey = null;
      }
    }
  } finally {
    syncWorkerRunning = false;
  }
};

// ==================== API ENDPOINTS ====================

/**
 * GET /api/health
 * Health check endpoint
 */
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    version: '1.0.0'
  });
});

/**
 * POST /api/scrape/all-pages
 * Bắt đầu scrape tất cả các trang
 */
app.post('/api/scrape/all-pages', async (req, res) => {
  if (scrapingStatus.isRunning) {
    return res.status(409).json({
      success: false,
      message: 'Scraping đang chạy. Vui lòng đợi hoặc kiểm tra status.',
      status: scrapingStatus
    });
  }

  // Start scraping in background
  startScrapingAllPages().catch(console.error);

  res.json({
    success: true,
    message: 'Đã bắt đầu quá trình scraping. Sử dụng GET /api/scrape/status để kiểm tra ti���n trình.',
    status: scrapingStatus
  });
});

/**
 * POST /api/scrape/full-sync
 * Cào tất cả trang đồng bộ và trả thẳng toàn bộ dữ liệu
 * Query/body:
 *   - save: true|false (mặc định true) -> có lưu DB hay không
 */
app.post('/api/scrape/full-sync', async (req, res) => {
  if (scrapingStatus.isRunning) {
    return res.status(409).json({
      success: false,
      message: 'Scraping đang chạy. Vui lòng đợi hoặc kiểm tra status.',
      status: scrapingStatus
    });
  }

  const save = (req.query.save ?? req.body?.save ?? 'true').toString() !== 'false';
  const inputStart = req.query.start ?? req.body?.start ?? req.query.from ?? req.body?.from ?? null;
  const inputEnd = req.query.end ?? req.body?.end ?? req.query.to ?? req.body?.to ?? null;
  const incremental = (req.query.incremental ?? req.body?.incremental ?? 'false').toString() === 'true';
  const responseDataMode = String(
    req.query.responseDataMode ?? req.body?.responseDataMode ?? 'range'
  ).toLowerCase();
  const responseRangeField = normalizeRangeField(req.query.rangeField || req.body?.rangeField || DEFAULT_RANGE_FIELD);
  const headerToken =
    req.headers['x-access-token'] ||
    req.headers['access-token'] ||
    req.headers['access_token'] ||
    '';
  const authHeader = req.headers.authorization || '';
  const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
    ? authHeader.slice(7).trim()
    : '';
  const requestToken =
    req.query.access_token ||
    req.query.accessToken ||
    req.body?.access_token ||
    req.body?.accessToken ||
    bearerToken ||
    headerToken ||
    '';
  console.log('🧭 Full-sync input params:', {
    inputStart,
    inputEnd,
    incremental,
    save,
    accessToken: maskToken(requestToken)
  });

  const requestedRangeStart = normalizeDateInput(inputStart, false);
  const requestedRangeEnd = normalizeDateInput(inputEnd, true);
  let rangeStart = requestedRangeStart;
  let rangeEnd = requestedRangeEnd;

  if (incremental) {
    if (!rangeStart || !rangeEnd) {
      const incrementalRange = await buildIncrementalSyncRange(new Date());
      if (incrementalRange?.invalid) {
        const timezone = cfg.syncTimezone || 'Asia/Ho_Chi_Minh';
        return res.status(400).json({
          success: false,
          message: `Range incremental không hợp lệ (${formatDateTimeInTimezone(incrementalRange.rangeStartDate, timezone)} > ${formatDateTimeInTimezone(incrementalRange.rangeEndDate, timezone)})`
        });
      }
      if (!rangeStart && incrementalRange?.rangeStart) {
        rangeStart = incrementalRange.rangeStart;
      }
      if (!rangeEnd && incrementalRange?.rangeEnd) {
        rangeEnd = incrementalRange.rangeEnd;
      }
    }
    if (!rangeStart) {
      return res.status(400).json({
        success: false,
        message: 'Không có dữ liệu trước đó để incremental. Hãy chạy full sync hoặc truyền từ/ngày bắt đầu.',
      });
    }
  }

  const syncKey = rangeStart && rangeEnd ? rangeKey(rangeStart, rangeEnd) : null;

  try {
    scrapingStatus.isRunning = true;
    scrapingStatus.startTime = Date.now();
    scrapingStatus.progress = { currentPage: 0, totalPages: 0, collectedItems: 0 };
    scrapingStatus.error = null;
    scrapingStatus.endTime = null;

    if (syncKey) {
      const now = new Date();
      await SyncState.findOneAndUpdate(
        { key: syncKey },
        {
          $set: {
            rangeStart,
            rangeEnd,
            status: 'running',
            lastRequestedAt: now,
            lastStartedAt: now,
            lastError: null
          },
          $setOnInsert: { key: syncKey }
        },
        { upsert: true }
      );
    }

    const chunkFromEnv = String(process.env.CHUNK_DATE_RANGE ?? 'true') === 'true';
    const { items, upserts, newCount, updatedCount, unchangedCount } = await scrapeAllPagesOnce({
      saveToDb: save,
      rangeStart,
      rangeEnd,
      chunkDateRange: incremental ? false : chunkFromEnv,
      accessTokenOverride: requestToken
    });

    scrapingStatus.progress.collectedItems = items.length;
    scrapingStatus.endTime = Date.now();
    scrapingStatus.isRunning = false;

    if (syncKey) {
      const finishedAt = new Date();
      await SyncState.updateOne(
        { key: syncKey },
        {
          $set: {
            status: 'success',
            lastFinishedAt: finishedAt,
            lastSuccessAt: finishedAt,
            totalRecords: items.length,
            upserts: save ? upserts : 0,
            newCount: save ? newCount : 0,
            updatedCount: save ? updatedCount : 0,
            unchangedCount: save ? unchangedCount : 0
          }
        }
      );
    }

    const dataTimeRange = await getDataTimeRange();
    const displayDataTimeRange = formatDataRangeForDisplay(dataTimeRange);

    let responseData = items;
    let responseRange = rangeStart && rangeEnd ? { start: rangeStart, end: rangeEnd } : null;
    if (save && responseDataMode !== 'scraped') {
      const preferredRangeStart = requestedRangeStart || rangeStart;
      const preferredRangeEnd = requestedRangeEnd || rangeEnd;
      const responseFilter = buildRangeQuery(preferredRangeStart, preferredRangeEnd, responseRangeField);
      responseData = await Skin.find(responseFilter || {})
        .sort({ [responseRangeField]: -1 })
        .lean();
      if (preferredRangeStart && preferredRangeEnd) {
        responseRange = { start: preferredRangeStart, end: preferredRangeEnd };
      }
    }

    return res.json({
      success: true,
      saved: save,
      upserts: save ? upserts : 0,
      newCount: save ? newCount : 0,
      updatedCount: save ? updatedCount : 0,
      unchangedCount: save ? unchangedCount : 0,
      total: items.length,
      totalView: responseData.length,
      rangeField: responseRangeField,
      responseDataMode: save && responseDataMode !== 'scraped' ? 'range' : 'scraped',
      range: responseRange,
      incremental,
      stats: {
        dataTimeRange: displayDataTimeRange
      },
      data: responseData,
      scrapedData: items
    });
  } catch (error) {
    scrapingStatus.isRunning = false;
    scrapingStatus.error = error.message;
    scrapingStatus.endTime = Date.now();
    if (syncKey) {
      await SyncState.updateOne(
        { key: syncKey },
        {
          $set: {
            status: 'error',
            lastFinishedAt: new Date(),
            lastError: error.message
          }
        }
      );
    }
    return res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/scrape/status
 * Kiểm tra trạng thái scraping
 */
app.get('/api/scrape/status', (req, res) => {
  res.json({
    success: true,
    status: scrapingStatus,
    estimatedTimeRemaining: scrapingStatus.isRunning && scrapingStatus.progress.totalPages > 0
      ? Math.ceil(
          ((Date.now() - scrapingStatus.startTime) / scrapingStatus.progress.currentPage) *
          (scrapingStatus.progress.totalPages - scrapingStatus.progress.currentPage) / 1000
        )
      : null
  });
});

/**
 * GET /api/sync/status
 * Trả trạng thái sync cache theo range
 */
app.get('/api/sync/status', async (req, res) => {
  try {
    const inputStart = req.query.start ?? req.query.from ?? null;
    const inputEnd = req.query.end ?? req.query.to ?? null;
    let rangeStart = normalizeDateInput(inputStart, false);
    let rangeEnd = normalizeDateInput(inputEnd, true);
    let syncState = null;
    if (rangeStart && rangeEnd) {
      syncState = await SyncState.findOne({ key: rangeKey(rangeStart, rangeEnd) }).lean();
    } else {
      syncState = await SyncState.findOne().sort({ updatedAt: -1 }).lean();
    }
    res.json({ success: true, sync: syncState || null });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * POST /api/sync/request
 * Yêu cầu sync lại dữ liệu theo range
 */
app.post('/api/sync/request', async (req, res) => {
  try {
    const inputStart = req.query.start ?? req.query.from ?? req.body?.start ?? req.body?.from ?? null;
    const inputEnd = req.query.end ?? req.query.to ?? req.body?.end ?? req.body?.to ?? null;
    const rangeStart = normalizeDateInput(inputStart, false);
    const rangeEnd = normalizeDateInput(inputEnd, true);
    if (!rangeStart || !rangeEnd) {
      return res.status(400).json({ success: false, message: 'Thiếu start/end' });
    }
    const incremental = String(req.query.incremental ?? req.body?.incremental ?? 'false').toLowerCase() === 'true';
    const syncState = await enqueueSync({ rangeStart, rangeEnd, reason: 'manual', incremental });
    res.json({ success: true, sync: syncState });
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

/**
 * GET /api/data
 * Lấy dữ liệu từ MongoDB
 * Query params:
  *   - page: số trang (default: 1)
  *   - limit: số items mỗi trang (default: 50, max: 500)
  *   - search: tìm kiếm (tìm trong id, customerInfo, account, deviceNumber)
 *   - sortBy: sắp xếp theo field (default: rangeField)
  *   - sortOrder: asc hoặc desc (default: desc)
 */
app.get('/api/data', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const parsedLimit = Number.isNaN(Number(req.query.limit)) ? null : Number(req.query.limit);
    const noLimitFlag = String(req.query.noLimit ?? req.query.unlimited ?? 'false').toLowerCase() === 'true';
    const unlimitedRequest = noLimitFlag || (parsedLimit !== null && parsedLimit <= 0);
    const resolvedLimit = unlimitedRequest ? null : Math.min(parsedLimit ?? 50, 500);
    const skip = unlimitedRequest ? 0 : (page - 1) * resolvedLimit;
    const search = req.query.search || '';
    const sortByArg = (req.query.sortBy || '').trim();
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
    const refresh = String(req.query.refresh ?? req.query.sync ?? 'false').toLowerCase() === 'true';
    const inputStart = req.query.start ?? req.query.from ?? null;
    const inputEnd = req.query.end ?? req.query.to ?? null;
    const rangeStart = normalizeDateInput(inputStart, false);
    const rangeEnd = normalizeDateInput(inputEnd, true);
    const headerToken =
      req.headers['x-access-token'] ||
      req.headers['access-token'] ||
      req.headers['access_token'] ||
      '';
    const authHeader = req.headers.authorization || '';
    const bearerToken = authHeader.toLowerCase().startsWith('bearer ')
      ? authHeader.slice(7).trim()
      : '';
    const requestToken =
      req.query.access_token ||
      req.query.accessToken ||
      bearerToken ||
      headerToken ||
      '';
    const rangeField = req.query.rangeField || req.query.field || DEFAULT_RANGE_FIELD;
    const normalizedRangeField = normalizeRangeField(rangeField);
    const rangeFilter = buildRangeQuery(rangeStart, rangeEnd, normalizedRangeField);

    // Build query
    const queryParts = [];
    if (search) {
      queryParts.push({
        $or: [
          { id: { $regex: search, $options: 'i' } },
          { customerInfo: { $regex: search, $options: 'i' } },
          { account: { $regex: search, $options: 'i' } },
          { deviceNumber: { $regex: search, $options: 'i' } }
        ]
      });
    }
    if (rangeFilter) queryParts.push(rangeFilter);
    const query = queryParts.length === 0
      ? {}
      : (queryParts.length === 1 ? queryParts[0] : { $and: queryParts });

    const resolvedSortField = ALLOWED_RANGE_FIELDS.includes(sortByArg) ? sortByArg : normalizedRangeField;
    let dataQuery = Skin.find(query).sort({ [resolvedSortField]: sortOrder });
    if (!(unlimitedRequest)) {
      dataQuery = dataQuery.skip(skip).limit(resolvedLimit);
    }

    let syncState = null;
    let syncKey = null;
    const [total, data, initialSyncState] = await Promise.all([
      Skin.countDocuments(query),
      dataQuery.lean(),
      (rangeStart && rangeEnd)
        ? SyncState.findOne({ key: rangeKey(rangeStart, rangeEnd) }).lean()
        : Promise.resolve(null)
    ]);
    if (rangeStart && rangeEnd) {
      syncKey = rangeKey(rangeStart, rangeEnd);
      syncState = initialSyncState;
      if (shouldTriggerSync(total, syncState, refresh)) {
        syncState = await enqueueSync({
          rangeStart,
          rangeEnd,
          reason: refresh ? 'refresh' : 'cache-miss',
          accessToken: requestToken
        });
      }
    }

    const [dataTimeRange, fullDataTimeRange] = await Promise.all([
      getDataTimeRange(rangeFilter, normalizedRangeField),
      getDataTimeRange(null, normalizedRangeField)
    ]);
    const missingRange = computeMissingRange(rangeStart, rangeEnd, dataTimeRange);
    if (missingRange) {
      await enqueueSync({
        rangeStart: missingRange.start,
        rangeEnd: missingRange.end,
        reason: refresh ? 'refresh-missing' : 'incremental',
        accessToken: requestToken,
        incremental: true
      });
    }
    const statsRange = (dataTimeRange?.from && dataTimeRange?.to)
      ? { start: dataTimeRange.from, end: dataTimeRange.to }
      : (rangeStart && rangeEnd ? { start: rangeStart, end: rangeEnd } : null);
    const displayDataTimeRange = formatDataRangeForDisplay(dataTimeRange);
    const displayFullRange = formatDataRangeForDisplay(fullDataTimeRange);
    const displayStatsRange = formatRangeForDisplay(statsRange);
    res.json({
      success: true,
      data,
      stats: {
        dataTimeRange: displayDataTimeRange,
        fullRange: {
          start: displayFullRange?.from || null,
          end: displayFullRange?.to || null
        },
        range: displayStatsRange
      },
      range: displayStatsRange,
      sync: syncState
        ? {
            key: syncState.key,
            status: syncState.status,
            rangeStart: syncState.rangeStart,
            rangeEnd: syncState.rangeEnd,
            totalRecords: syncState.totalRecords,
            lastRequestedAt: syncState.lastRequestedAt,
            lastStartedAt: syncState.lastStartedAt,
            lastFinishedAt: syncState.lastFinishedAt,
            lastSuccessAt: syncState.lastSuccessAt,
            lastError: syncState.lastError,
            incremental: !!syncState.incremental
          }
        : null,
      pagination: unlimitedRequest
        ? {
            page: 1,
            limit: total,
            total,
            totalPages: 1,
            hasNext: false,
            hasPrev: false
          }
        : {
            page,
            limit: resolvedLimit,
            total,
            totalPages: Math.ceil(total / resolvedLimit),
            hasNext: page * resolvedLimit < total,
            hasPrev: page > 1
          }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * GET /api/customers
 * Truy vấn dữ liệu khách hàng từ collection skins (không thay đổi API cũ).
 * Query params:
 *   - page: số trang (default: 1)
 *   - limit: số items mỗi trang (default: 50, max: 500)
 *   - noLimit=true: trả toàn bộ kết quả khớp filter
 *   - search: tìm kiếm theo tên/sđt/id/account
 *   - start/end hoặc from/to: lọc theo rangeField
 *   - rangeField: scrapedAt|crt_time (default: crt_time)
 *   - sortBy: field sắp xếp
 *   - sortOrder: asc|desc
 *   - includeAnalysisRaw=true: trả thêm analysis raw
 */
app.get('/api/customers', async (req, res) => {
  try {
    const page = Math.max(parseInt(req.query.page) || 1, 1);
    const parsedLimit = Number.isNaN(Number(req.query.limit)) ? null : Number(req.query.limit);
    const noLimitFlag = String(req.query.noLimit ?? req.query.unlimited ?? 'false').toLowerCase() === 'true';
    const unlimitedRequest = noLimitFlag || (parsedLimit !== null && parsedLimit <= 0);
    const resolvedLimit = unlimitedRequest ? null : Math.min(parsedLimit ?? 50, 500);
    const skip = unlimitedRequest ? 0 : (page - 1) * resolvedLimit;
    const search = String(req.query.search || '').trim();
    const sortByArg = String(req.query.sortBy || '').trim();
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
    const includeAnalysisRaw = String(req.query.includeAnalysisRaw || 'false').toLowerCase() === 'true';

    const inputStart = req.query.start ?? req.query.from ?? null;
    const inputEnd = req.query.end ?? req.query.to ?? null;
    const rangeStart = normalizeDateInput(inputStart, false);
    const rangeEnd = normalizeDateInput(inputEnd, true);
    const rangeField = req.query.rangeField || req.query.field || DEFAULT_RANGE_FIELD;
    const normalizedRangeField = normalizeRangeField(rangeField);
    const rangeFilter = buildRangeQuery(rangeStart, rangeEnd, normalizedRangeField);

    const queryParts = [];
    if (search) {
      queryParts.push({
        $or: [
          { customer_nickname: { $regex: search, $options: 'i' } },
          { customer_mobile: { $regex: search, $options: 'i' } },
          { customerInfo: { $regex: search, $options: 'i' } },
          { id: { $regex: search, $options: 'i' } },
          { user_acct: { $regex: search, $options: 'i' } },
          { account: { $regex: search, $options: 'i' } }
        ]
      });
    }
    if (rangeFilter) queryParts.push(rangeFilter);
    const query = queryParts.length === 0
      ? {}
      : (queryParts.length === 1 ? queryParts[0] : { $and: queryParts });

    const sortableFields = new Set([
      'customer_nickname',
      'customer_mobile',
      'customer_age',
      'customer_birthday',
      'customer_sex',
      'user_acct',
      'account',
      'id',
      'createdAt',
      'updatedAt',
      'scrapedAt',
      'crt_time'
    ]);
    const resolvedSortField = sortableFields.has(sortByArg) ? sortByArg : normalizedRangeField;

    const analysisProjection = includeAnalysisRaw
      ? { analysis: 1 }
      : {
          'analysis.skin_type': 1,
          'analysis.ext_water': 1,
          'analysis.collagen': 1,
          'analysis.pore': 1,
          'analysis.spot': 1,
          'analysis.wrinkle': 1,
          'analysis.acne': 1,
          'analysis.blackhead': 1,
          'analysis.dark_circle': 1,
          'analysis.pockmark': 1,
          'analysis.uv_spot': 1,
          'analysis.final_result': 1
        };

    const projection = {
      _id: 0,
      id: 1,
      result_id: 1,
      code: 1,
      customer_nickname: 1,
      customer_mobile: 1,
      customer_sex: 1,
      customer_age: 1,
      customer_birthday: 1,
      customer_location: 1,
      customer_level: 1,
      customer_comments: 1,
      customer_introducer: 1,
      customerInfo: 1,
      gender: 1,
      user_acct: 1,
      account: 1,
      status: 1,
      result_type: 1,
      score: 1,
      crt_time: 1,
      scrapedAt: 1,
      createdAt: 1,
      updatedAt: 1,
      recommendedGoodsIds: 1,
      recommendedGoods: 1,
      ...analysisProjection
    };

    let dataQuery = Skin.find(query, projection).sort({ [resolvedSortField]: sortOrder });
    if (!unlimitedRequest) {
      dataQuery = dataQuery.skip(skip).limit(resolvedLimit);
    }
    const [total, docs, dataTimeRange] = await Promise.all([
      Skin.countDocuments(query),
      dataQuery.lean(),
      getDataTimeRange(rangeFilter, normalizedRangeField)
    ]);

    const pickSkinMetric = (node) => {
      if (!node || typeof node !== 'object') return null;
      return {
        score: node.score ?? null,
        level: node.level ?? null,
        type: node.type ?? null,
        result: node.result ?? null,
        count: node.count ?? null
      };
    };

    const toGoodsIdList = (value) => {
      if (!value) return [];
      if (Array.isArray(value)) {
        return value
          .map((v) => String(v || '').trim())
          .filter(Boolean);
      }
      if (typeof value === 'string') {
        return value
          .split(',')
          .map((v) => v.trim())
          .filter(Boolean);
      }
      return [];
    };

    const data = docs.map((doc) => {
      const analysis = doc.analysis || {};
      const finalResult = analysis.final_result || {};
      const goodsIds = Array.from(
        new Set([
          ...toGoodsIdList(doc.recommendedGoodsIds),
          ...toGoodsIdList(finalResult.goods)
        ])
      );

      return {
        customerId: doc.id || doc.result_id || null,
        code: doc.code || null,
        name: doc.customer_nickname || doc.customerInfo || null,
        mobile: doc.customer_mobile || null,
        sex: doc.customer_sex ?? doc.gender ?? null,
        age: doc.customer_age ?? null,
        birthday: doc.customer_birthday || null,
        location: doc.customer_location || null,
        level: doc.customer_level || null,
        comments: doc.customer_comments || null,
        introducer: doc.customer_introducer || null,
        account: doc.user_acct || doc.account || null,
        status: doc.status ?? null,
        resultType: doc.result_type ?? null,
        score: doc.score ?? null,
        skinCondition: {
          overview: {
            skinType: analysis?.skin_type?.type || finalResult?.skin_result || null,
            hydrationLevel: analysis?.ext_water?.level ?? null,
            hydrationScore: analysis?.ext_water?.score ?? analysis?.ext_water?.result ?? null,
            collagenLevel: analysis?.collagen?.level ?? null,
            collagenScore: analysis?.collagen?.score ?? null
          },
          metrics: {
            sebum: pickSkinMetric(analysis?.skin_type),
            hydration: pickSkinMetric(analysis?.ext_water),
            pores: pickSkinMetric(analysis?.pore),
            spots: pickSkinMetric(analysis?.spot),
            wrinkles: pickSkinMetric(analysis?.wrinkle),
            acne: pickSkinMetric(analysis?.acne),
            blackheads: pickSkinMetric(analysis?.blackhead),
            darkCircles: pickSkinMetric(analysis?.dark_circle),
            collagen: pickSkinMetric(analysis?.collagen),
            pockmark: pickSkinMetric(analysis?.pockmark),
            uvSpot: pickSkinMetric(analysis?.uv_spot)
          }
        },
        recommendedProducts: {
          ids: goodsIds,
          items: Array.isArray(doc.recommendedGoods) ? doc.recommendedGoods : []
        },
        times: {
          crt_time: doc.crt_time || null,
          scrapedAt: doc.scrapedAt || null,
          createdAt: doc.createdAt || null,
          updatedAt: doc.updatedAt || null
        },
        ...(includeAnalysisRaw ? { analysis: doc.analysis || null } : {})
      };
    });

    const displayDataTimeRange = formatDataRangeForDisplay(dataTimeRange);

    return res.json({
      success: true,
      rangeField: normalizedRangeField,
      filters: {
        search: search || null,
        start: rangeStart || null,
        end: rangeEnd || null
      },
      stats: {
        dataTimeRange: displayDataTimeRange
      },
      data,
      pagination: unlimitedRequest
        ? {
            page: 1,
            limit: total,
            total,
            totalPages: 1,
            hasNext: false,
            hasPrev: false
          }
        : {
            page,
            limit: resolvedLimit,
            total,
            totalPages: Math.ceil(total / resolvedLimit),
            hasNext: page * resolvedLimit < total,
            hasPrev: page > 1
          }
    });
  } catch (error) {
    return res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

const SKIN_RANGE_FIELDS = new Set(['crt_time', 'test_time', 'createdAt']);
const SKIN_SORT_FIELDS = new Set([
  'id',
  'result_id',
  'code',
  'status',
  'crt_time',
  'test_time',
  'createdAt',
  'updatedAt',
  'customer_nickname',
  'customer_mobile',
  'customer_sex',
  'customer_age',
  'user_acct'
]);
const REPORT_CACHE_TTL_MS = Math.max(
  30000,
  Number(process.env.REPORT_CACHE_TTL_MS || process.env.SUMMARY_CACHE_TTL_MS || 60000)
);
const skinReportCache = new Map();

const sendApiError = (res, status, message, errorCode, details = null) => {
  return res.status(status).json({
    success: false,
    message,
    errorCode,
    details
  });
};

const parseDayRangeQuery = (from, to, rangeField) => {
  const rangeStartText = `${from} 00:00:00`;
  const rangeEndText = `${to} 23:59:59`;
  if (rangeField === 'createdAt') {
    return {
      createdAt: {
        $gte: new Date(`${from}T00:00:00.000Z`),
        $lte: new Date(`${to}T23:59:59.999Z`)
      }
    };
  }
  if (rangeField === 'test_time') {
    return {
      $or: [
        { test_time: { $gte: rangeStartText, $lte: rangeEndText } },
        { testTime: { $gte: rangeStartText, $lte: rangeEndText } }
      ]
    };
  }
  return { crt_time: { $gte: rangeStartText, $lte: rangeEndText } };
};

const parseSkinRecordsQuery = (req) => {
  const from = String(req.query.from || '').trim();
  const to = String(req.query.to || '').trim();
  const rangeFieldRaw = String(req.query.rangeField || 'crt_time').trim();
  const rangeField = SKIN_RANGE_FIELDS.has(rangeFieldRaw) ? rangeFieldRaw : 'crt_time';
  const datePattern = /^\d{4}-\d{2}-\d{2}$/;
  if (!from || !to) {
    return { error: { status: 400, message: 'Missing required query params: from, to', code: 'INVALID_QUERY' } };
  }
  if (!datePattern.test(from) || !datePattern.test(to)) {
    return { error: { status: 400, message: 'Invalid date format. Expected YYYY-MM-DD for from/to.', code: 'INVALID_QUERY' } };
  }
  if (from > to) {
    return { error: { status: 400, message: '`from` must be less than or equal to `to`.', code: 'INVALID_QUERY' } };
  }

  const pageRaw = req.query.page;
  const page = pageRaw == null ? 1 : Number(pageRaw);
  if (!Number.isFinite(page) || page < 1) {
    return { error: { status: 400, message: 'Invalid page. page must be >= 1.', code: 'INVALID_QUERY' } };
  }

  const pageSizeRaw = req.query.pageSize;
  const pageSize = pageSizeRaw == null ? 100 : Number(pageSizeRaw);
  if (!Number.isFinite(pageSize) || pageSize < 1 || pageSize > 500) {
    return { error: { status: 400, message: 'Invalid pageSize. pageSize must be in range 1..500.', code: 'INVALID_QUERY' } };
  }

  const sortOrderRaw = String(req.query.sortOrder || 'desc').toLowerCase();
  if (!['asc', 'desc'].includes(sortOrderRaw)) {
    return { error: { status: 400, message: 'Invalid sortOrder. Allowed: asc|desc.', code: 'INVALID_QUERY' } };
  }
  const sortOrder = sortOrderRaw === 'asc' ? 1 : -1;

  const sortByRaw = String(req.query.sortBy || 'crt_time').trim();
  const sortBy = SKIN_SORT_FIELDS.has(sortByRaw) ? sortByRaw : 'crt_time';

  return {
    value: {
      from,
      to,
      rangeField,
      page: Number(page),
      pageSize: Number(pageSize),
      sortBy,
      sortOrder
    }
  };
};

const toGoodsIdList = (value) => {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => String(v || '').trim()).filter(Boolean);
  }
  if (typeof value === 'string') {
    return value.split(',').map((v) => v.trim()).filter(Boolean);
  }
  return [];
};

const buildTopGoodsFromCounts = (goodsCounts, totalRecords, limit = 20) => {
  const safeTotal = Number.isFinite(totalRecords) && totalRecords > 0 ? totalRecords : 0;
  const items = [];

  for (const [rawLabel, rawCount] of goodsCounts.entries()) {
    const label = String(rawLabel ?? '').trim();
    if (!label) continue;
    const count = Number(rawCount);
    if (!Number.isFinite(count) || count < 0) continue;
    if (safeTotal > 0 && count > safeTotal) continue;

    let percent = safeTotal > 0 ? Number(((count * 100) / safeTotal).toFixed(2)) : 0;
    if (percent < 0) percent = 0;
    if (percent > 100) percent = 100;

    const expected = safeTotal > 0 ? (count * 100) / safeTotal : 0;
    if (Math.abs(percent - expected) > 0.1) {
      percent = Number(expected.toFixed(2));
    }

    items.push({ label, count, percent });
  }

  return items
    .sort((a, b) => b.count - a.count || a.label.localeCompare(b.label))
    .slice(0, limit);
};

const MULTI_USE_MODULE_KEYS = [
  'skin_type',
  'ext_water',
  'pore',
  'spot',
  'wrinkle',
  'acne',
  'blackhead',
  'dark_circle',
  'collagen',
  'pockmark',
  'uv_spot'
];

const buildModuleGoodsMap = (analysis) => {
  const safeAnalysis = (analysis && typeof analysis === 'object') ? analysis : {};
  const moduleGoodsMap = new Map();
  for (const moduleKey of MULTI_USE_MODULE_KEYS) {
    const moduleNode = safeAnalysis?.[moduleKey];
    const goodsSource = (moduleNode && typeof moduleNode === 'object' && !Array.isArray(moduleNode))
      ? moduleNode.goods
      : moduleNode;
    const goodsSet = new Set(toGoodsIdList(goodsSource));
    if (goodsSet.size > 0) {
      moduleGoodsMap.set(moduleKey, goodsSet);
    }
  }
  return moduleGoodsMap;
};

const addMultiUseStatsFromRecord = (analysis, recordCountMap, moduleSetMap) => {
  const moduleGoodsMap = buildModuleGoodsMap(analysis);
  if (moduleGoodsMap.size === 0) return;

  // Count each goods code at most once per record; keep module set for multi-use check.
  const recordGoodsModules = new Map();
  for (const [moduleKey, goodsSet] of moduleGoodsMap.entries()) {
    for (const goodsCode of goodsSet) {
      if (!recordGoodsModules.has(goodsCode)) {
        recordGoodsModules.set(goodsCode, new Set());
      }
      recordGoodsModules.get(goodsCode).add(moduleKey);
    }
  }

  for (const [goodsCode, modulesInRecord] of recordGoodsModules.entries()) {
    recordCountMap.set(goodsCode, (recordCountMap.get(goodsCode) || 0) + 1);
    if (!moduleSetMap.has(goodsCode)) {
      moduleSetMap.set(goodsCode, new Set());
    }
    const modules = moduleSetMap.get(goodsCode);
    for (const moduleKey of modulesInRecord) {
      modules.add(moduleKey);
    }
  }
};

const normalizeTopMultiUseGoods = (items, totalRecords, contextLabel = 'unknown') => {
  const safeTotal = Number.isFinite(totalRecords) && totalRecords > 0 ? totalRecords : 0;
  return (Array.isArray(items) ? items : [])
    .map((item) => {
      const label = String(item?.label ?? item?.id ?? '').trim();
      if (!label) return null;
      const rawCount = Number(item?.count);
      const boundedCount = Number.isFinite(rawCount)
        ? Math.max(0, Math.min(rawCount, safeTotal))
        : 0;
      const percent = safeTotal > 0 ? Number(((boundedCount * 100) / safeTotal).toFixed(2)) : 0;
      const modules = Array.isArray(item?.modules)
        ? Array.from(new Set(item.modules.map((m) => String(m || '').trim()).filter(Boolean)))
        : [];
      if (rawCount > safeTotal || (item?.percent != null && Number(item.percent) > 100)) {
        console.warn(
          `[${contextLabel}] normalized topMultiUseGoods anomaly: label=${label}, rawCount=${rawCount}, totalRecords=${safeTotal}, rawPercent=${item?.percent}`
        );
      }
      return {
        label,
        count: boundedCount,
        percent,
        ...(modules.length > 0 ? { modules } : {})
      };
    })
    .filter(Boolean);
};

const SUMMARY_MULTI_USE_GOODS_FIELDS = {
  skin_type: '$analysis.skin_type.goods',
  ext_water: '$analysis.ext_water.goods',
  pore: '$analysis.pore.goods',
  spot: '$analysis.spot.goods',
  wrinkle: '$analysis.wrinkle.goods',
  acne: '$analysis.acne.goods',
  blackhead: '$analysis.blackhead.goods',
  dark_circle: '$analysis.dark_circle.goods',
  collagen: '$analysis.collagen.goods',
  pockmark: '$analysis.pockmark.goods',
  uv_spot: '$analysis.uv_spot.goods'
};

const buildSummaryProjectionPipeline = (rangeQuery) => ([
  { $match: rangeQuery },
  {
    $project: {
      _id: 0,
      customer_sex: '$customer_sex',
      customer_age: '$customer_age',
      customer_mobile: '$customer_mobile',
      predictedAge: { $ifNull: ['$analysis.age.result', '$analysis.final_result.age'] },
      skinType: { $ifNull: ['$analysis.skin_type.type', '$analysis.final_result.skin_result'] },
      darkCircleType: '$analysis.dark_circle.type',
      sensitivityType: '$analysis.sensitive.type',
      acneLevel: '$analysis.acne.level',
      poreLevel: '$analysis.pore.level',
      spotLevel: '$analysis.spot.level',
      wrinkleLevel: '$analysis.wrinkle.level',
      finalGoods: '$analysis.final_result.goods',
      moduleGoods: SUMMARY_MULTI_USE_GOODS_FIELDS
    }
  }
]);

const buildProfileProjectionPipeline = (rangeQuery) => ([
  { $match: rangeQuery },
  {
    $project: {
      _id: 0,
      customer_sex: '$customer_sex',
      customer_age: '$customer_age',
      predictedAge: { $ifNull: ['$analysis.age.result', '$analysis.final_result.age'] },
      skinType: { $ifNull: ['$analysis.skin_type.type', '$analysis.final_result.skin_result'] }
    }
  }
]);

const buildConditionsProjectionPipeline = (rangeQuery) => ([
  { $match: rangeQuery },
  {
    $project: {
      _id: 0,
      customer_sex: '$customer_sex',
      acne: '$analysis.acne',
      pore: '$analysis.pore',
      spot: '$analysis.spot',
      wrinkle: '$analysis.wrinkle',
      blackhead: '$analysis.blackhead',
      dark_circle: '$analysis.dark_circle',
      collagen: '$analysis.collagen',
      pockmark: '$analysis.pockmark',
      uv_spot: '$analysis.uv_spot',
      ext_water: '$analysis.ext_water'
    }
  }
]);

const buildRecommendationsProjectionPipeline = (rangeQuery) => ([
  { $match: rangeQuery },
  {
    $project: {
      _id: 0,
      sensitivityType: '$analysis.sensitive.type',
      darkCircleType: '$analysis.dark_circle.type',
      finalGoods: '$analysis.final_result.goods',
      moduleGoods: SUMMARY_MULTI_USE_GOODS_FIELDS,
      acneLevel: '$analysis.acne.level',
      acneScore: '$analysis.acne.score',
      poreLevel: '$analysis.pore.level',
      poreScore: '$analysis.pore.score',
      spotLevel: '$analysis.spot.level',
      spotScore: '$analysis.spot.score',
      wrinkleLevel: '$analysis.wrinkle.level',
      wrinkleScore: '$analysis.wrinkle.score'
    }
  }
]);

const normalizeListRecord = (doc) => {
  const analysis = (doc.analysis && typeof doc.analysis === 'object') ? doc.analysis : {};
  return {
    id: doc.id ?? null,
    result_id: doc.result_id ?? null,
    code: doc.code ?? null,
    status: doc.status ?? null,
    crt_time: doc.crt_time ?? null,
    test_time: doc.test_time ?? doc.testTime ?? null,
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
    image: doc.image ?? null,
    user_acct: doc.user_acct ?? null,
    customer_nickname: doc.customer_nickname ?? null,
    customer_sex: doc.customer_sex ?? null,
    customer_age: doc.customer_age ?? null,
    customer_mobile: doc.customer_mobile ?? null,
    analysis: {
      age: analysis.age || null,
      final_result: analysis.final_result || null
    }
  };
};

const normalizeDetailRecord = (doc) => {
  const analysis = (doc.analysis && typeof doc.analysis === 'object') ? doc.analysis : {};
  return {
    id: doc.id ?? null,
    result_id: doc.result_id ?? null,
    code: doc.code ?? null,
    status: doc.status ?? null,
    crt_time: doc.crt_time ?? null,
    test_time: doc.test_time ?? doc.testTime ?? null,
    createdAt: doc.createdAt ?? null,
    updatedAt: doc.updatedAt ?? null,
    image: doc.image ?? null,
    user_acct: doc.user_acct ?? null,
    customer_nickname: doc.customer_nickname ?? null,
    customer_sex: doc.customer_sex ?? null,
    customer_age: doc.customer_age ?? null,
    customer_mobile: doc.customer_mobile ?? null,
    recommendedGoodsIds: Array.from(
      new Set([
        ...toGoodsIdList(doc.recommendedGoodsIds),
        ...toGoodsIdList(analysis?.final_result?.goods)
      ])
    ),
    recommendedGoods: Array.isArray(doc.recommendedGoods) ? doc.recommendedGoods : [],
    analysis
  };
};

const buildReportCacheKey = (scope, payload) => JSON.stringify({ scope, ...payload });

const getReportCache = (key) => {
  const cached = skinReportCache.get(key);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    skinReportCache.delete(key);
    return null;
  }
  return cached.payload;
};

const setReportCache = (key, payload) => {
  skinReportCache.set(key, {
    payload,
    expiresAt: Date.now() + REPORT_CACHE_TTL_MS
  });
};

/**
 * GET /api/skin-report/summary
 * Aggregated data for dashboard overview.
 */
app.get('/api/skin-report/summary', async (req, res) => {
  const parsed = parseSkinRecordsQuery(req);
  if (parsed.error) {
    return sendApiError(res, parsed.error.status, parsed.error.message, parsed.error.code);
  }
  const { from, to, rangeField } = parsed.value;

  try {
    const cacheKey = buildReportCacheKey('summary', { from, to, rangeField });
    const cached = getReportCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const rangeQuery = parseDayRangeQuery(from, to, rangeField);
    const docs = await Skin.aggregate(buildSummaryProjectionPipeline(rangeQuery)).allowDiskUse(true);
    const totalRecords = docs.length;

    const ageValues = [];
    const reportedAgeValues = [];
    const predictedAgeValues = [];
    const sexCounts = new Map();
    const skinTypeCounts = new Map();
    const severityCounters = {
      acne: new Map(),
      pore: new Map(),
      spot: new Map(),
      wrinkle: new Map()
    };
    const darkCircleTypeCounts = new Map();
    const sensitivityCounts = new Map();
    const multiUseRecordCounts = new Map();
    const canonicalTopGoodsCounts = new Map();
    const multiUseModules = new Map();

    let totalWithReportedAge = 0;
    let totalWithPredictedAge = 0;
    let ageGapSum = 0;
    let ageGapCount = 0;
    let mismatchCount = 0;
    let withPhoneCount = 0;

    const toNumber = (value) => {
      if (value == null || value === '') return null;
      const parsedNum = Number(value);
      return Number.isFinite(parsedNum) ? parsedNum : null;
    };
    const addCount = (bucket, rawKey, inc = 1) => {
      const key = String(rawKey ?? 'unknown').trim() || 'unknown';
      bucket.set(key, (bucket.get(key) || 0) + inc);
    };
    for (const doc of docs) {
      const moduleGoods = (doc.moduleGoods && typeof doc.moduleGoods === 'object') ? doc.moduleGoods : {};
      const canonicalGoods = new Set(toGoodsIdList(doc.finalGoods));
      const reportedAge = toNumber(doc.customer_age);
      const predictedAge = toNumber(doc.predictedAge);
      const chosenAge = predictedAge ?? reportedAge;

      if (reportedAge != null) {
        totalWithReportedAge += 1;
        reportedAgeValues.push(reportedAge);
      }
      if (predictedAge != null) {
        totalWithPredictedAge += 1;
        predictedAgeValues.push(predictedAge);
      }
      if (chosenAge != null) ageValues.push(chosenAge);

      if (reportedAge != null && predictedAge != null) {
        const gap = Math.abs(predictedAge - reportedAge);
        ageGapSum += gap;
        ageGapCount += 1;
        if (gap >= 5) mismatchCount += 1;
      }

      if (doc.customer_mobile && String(doc.customer_mobile).trim()) {
        withPhoneCount += 1;
      }

      addCount(sexCounts, doc.customer_sex ?? 'unknown');
      addCount(skinTypeCounts, doc.skinType ?? 'unknown');
      addCount(darkCircleTypeCounts, doc.darkCircleType ?? 'unknown');
      addCount(sensitivityCounts, doc.sensitivityType ?? 'unknown');
      addMultiUseStatsFromRecord(moduleGoods, multiUseRecordCounts, multiUseModules);

      addCount(severityCounters.acne, doc.acneLevel ?? 'unknown');
      addCount(severityCounters.pore, doc.poreLevel ?? 'unknown');
      addCount(severityCounters.spot, doc.spotLevel ?? 'unknown');
      addCount(severityCounters.wrinkle, doc.wrinkleLevel ?? 'unknown');
      for (const gid of canonicalGoods) {
        canonicalTopGoodsCounts.set(gid, (canonicalTopGoodsCounts.get(gid) || 0) + 1);
      }
    }

    ageValues.sort((a, b) => a - b);
    const ageCount = ageValues.length;
    const ageAverage = ageCount ? ageValues.reduce((sum, v) => sum + v, 0) / ageCount : null;
    const median = ageCount
      ? (ageCount % 2 === 0
          ? (ageValues[(ageCount / 2) - 1] + ageValues[ageCount / 2]) / 2
          : ageValues[Math.floor(ageCount / 2)])
      : null;

    const toDistribution = (bucket) => {
      const list = Array.from(bucket.entries())
        .map(([label, count]) => ({
          label,
          count,
          percent: totalRecords > 0 ? Number(((count * 100) / totalRecords).toFixed(2)) : 0
        }))
        .sort((a, b) => b.count - a.count);
      return list;
    };
    const toSeverityDistribution = (bucket) => {
      return Array.from(bucket.entries())
        .map(([label, count]) => ({
          label: String(label),
          count,
          percent: totalRecords > 0 ? Number(((count * 100) / totalRecords).toFixed(2)) : 0
        }))
        .sort((a, b) => b.count - a.count);
    };

    const topGoods = buildTopGoodsFromCounts(canonicalTopGoodsCounts, totalRecords, 20);

    const rawMultiUseGoods = Array.from(multiUseModules.entries())
      .filter(([, modules]) => modules.size >= 2)
      .map(([id, modules]) => ({
        id,
        modules: Array.from(modules).sort(),
        moduleCount: modules.size,
        count: multiUseRecordCounts.get(id) || 0
      }))
      .sort((a, b) => b.moduleCount - a.moduleCount || b.count - a.count)
      .slice(0, 50);
    const multiUseGoods = normalizeTopMultiUseGoods(rawMultiUseGoods, totalRecords, 'summary');

    const response = {
      success: true,
      message: 'OK',
      meta: {
        from,
        to,
        rangeField,
        totalRecords,
        generatedAt: new Date().toISOString()
      },
      data: {
        totalRecords,
        generatedAt: new Date().toISOString(),
        age: {
          count: ageCount,
          average: ageAverage == null ? null : Number(ageAverage.toFixed(2)),
          median: median == null ? null : Number(median.toFixed(2)),
          min: ageCount ? ageValues[0] : null,
          max: ageCount ? ageValues[ageCount - 1] : null
        },
        sexDistribution: toDistribution(sexCounts),
        skinTypes: toDistribution(skinTypeCounts),
        severity: {
          acne: toSeverityDistribution(severityCounters.acne),
          pore: toSeverityDistribution(severityCounters.pore),
          spot: toSeverityDistribution(severityCounters.spot),
          wrinkle: toSeverityDistribution(severityCounters.wrinkle)
        },
        darkCircleTypes: toDistribution(darkCircleTypeCounts),
        sensitivity: toDistribution(sensitivityCounts),
        topGoods,
        dataQuality: {
          totalWithReportedAge,
          totalWithPredictedAge,
          averageAgeGap: ageGapCount ? Number((ageGapSum / ageGapCount).toFixed(2)) : null,
          mismatchCount,
          mismatchShare: ageGapCount ? Number(((mismatchCount * 100) / ageGapCount).toFixed(2)) : 0,
          withPhoneCount,
          missingPhoneCount: Math.max(0, totalRecords - withPhoneCount)
        },
        issueTrends: {},
        keyInsights: [],
        multiUseGoods
      }
    };

    setReportCache(cacheKey, response);
    return res.json(response);
  } catch (error) {
    return sendApiError(res, 500, 'Internal server error', 'INTERNAL_ERROR', error?.message || null);
  }
});

/**
 * GET /api/skin-report/profile
 * Tab "Nhân khẩu & loại da".
 */
app.get('/api/skin-report/profile', async (req, res) => {
  const parsed = parseSkinRecordsQuery(req);
  if (parsed.error) {
    return sendApiError(res, parsed.error.status, parsed.error.message, parsed.error.code);
  }
  const { from, to, rangeField } = parsed.value;

  try {
    const cacheKey = buildReportCacheKey('profile', { from, to, rangeField });
    const cached = getReportCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const docs = await Skin.aggregate(buildProfileProjectionPipeline(parseDayRangeQuery(from, to, rangeField)))
      .allowDiskUse(true);

    const totalRecords = docs.length;
    const sexCounts = new Map();
    const skinTypeCounts = new Map();
    const ageBuckets = new Map([
      ['<18', 0],
      ['18-24', 0],
      ['25-34', 0],
      ['35-44', 0],
      ['45-54', 0],
      ['55+', 0],
      ['unknown', 0]
    ]);

    const toNumber = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const addCount = (bucket, rawLabel) => {
      const label = String(rawLabel ?? 'unknown').trim() || 'unknown';
      bucket.set(label, (bucket.get(label) || 0) + 1);
    };
    const asDistribution = (bucket) => {
      return Array.from(bucket.entries())
        .map(([label, count]) => ({
          label,
          count,
          percent: totalRecords > 0 ? Number(((count * 100) / totalRecords).toFixed(2)) : 0
        }))
        .sort((a, b) => b.count - a.count);
    };

    for (const doc of docs) {
      addCount(sexCounts, doc.customer_sex ?? 'unknown');
      addCount(skinTypeCounts, doc.skinType ?? 'unknown');

      const predictedAge = toNumber(doc.predictedAge);
      const reportedAge = toNumber(doc.customer_age);
      const age = predictedAge ?? reportedAge;
      if (age == null) {
        ageBuckets.set('unknown', (ageBuckets.get('unknown') || 0) + 1);
      } else if (age < 18) {
        ageBuckets.set('<18', (ageBuckets.get('<18') || 0) + 1);
      } else if (age <= 24) {
        ageBuckets.set('18-24', (ageBuckets.get('18-24') || 0) + 1);
      } else if (age <= 34) {
        ageBuckets.set('25-34', (ageBuckets.get('25-34') || 0) + 1);
      } else if (age <= 44) {
        ageBuckets.set('35-44', (ageBuckets.get('35-44') || 0) + 1);
      } else if (age <= 54) {
        ageBuckets.set('45-54', (ageBuckets.get('45-54') || 0) + 1);
      } else {
        ageBuckets.set('55+', (ageBuckets.get('55+') || 0) + 1);
      }
    }

    const response = {
      success: true,
      message: 'OK',
      meta: {
        from,
        to,
        rangeField,
        generatedAt: new Date().toISOString()
      },
      data: {
        totalRecords,
        sexDistribution: asDistribution(sexCounts),
        skinTypes: asDistribution(skinTypeCounts),
        ageBuckets: asDistribution(ageBuckets)
      }
    };
    setReportCache(cacheKey, response);
    return res.json(response);
  } catch (error) {
    return sendApiError(res, 500, 'Internal server error', 'INTERNAL_ERROR', error?.message || null);
  }
});

/**
 * GET /api/skin-report/conditions
 * Tab "Nhóm vấn đề da".
 */
app.get('/api/skin-report/conditions', async (req, res) => {
  const parsed = parseSkinRecordsQuery(req);
  if (parsed.error) {
    return sendApiError(res, parsed.error.status, parsed.error.message, parsed.error.code);
  }
  const { from, to, rangeField } = parsed.value;

  try {
    const cacheKey = buildReportCacheKey('conditions', { from, to, rangeField });
    const cached = getReportCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const docs = await Skin.aggregate(buildConditionsProjectionPipeline(parseDayRangeQuery(from, to, rangeField)))
      .allowDiskUse(true);
    const totalRecords = docs.length;

    const mainSeverityKeys = ['acne', 'pore', 'spot', 'wrinkle'];
    const issueKeys = ['acne', 'pore', 'spot', 'wrinkle', 'blackhead', 'dark_circle', 'collagen', 'pockmark', 'uv_spot'];
    const severity = {
      acne: new Map(),
      pore: new Map(),
      spot: new Map(),
      wrinkle: new Map()
    };
    const genderTotals = { all: totalRecords, male: 0, female: 0 };
    const issueOccurrence = {};
    const trendBucket = { high: 0, medium: 0, low: 0, scoreSum: 0, scoreCount: 0 };
    const extWaterOccurrence = {
      appearCount: 0,
      share: 0,
      maleCount: 0,
      femaleCount: 0,
      severeCount: 0,
      severeShare: 0,
      levelCounts: [0, 0, 0, 0, 0]
    };
    const extWaterTrend = { high: 0, medium: 0, low: 0, scoreSum: 0, scoreCount: 0 };

    const toNumber = (value) => {
      const n = Number(value);
      return Number.isFinite(n) ? n : null;
    };
    const addLevel = (bucket, level) => {
      const key = String(level ?? 'unknown');
      bucket.set(key, (bucket.get(key) || 0) + 1);
    };

    for (const key of issueKeys) {
      issueOccurrence[key] = {
        appearCount: 0,
        share: 0,
        maleCount: 0,
        femaleCount: 0,
        severeCount: 0,
        severeShare: 0,
        levelCounts: [0, 0, 0, 0, 0]
      };
    }

    for (const doc of docs) {
      const sex = Number(doc.customer_sex);
      const isMale = sex === 1;
      const isFemale = sex === 2;
      if (isMale) genderTotals.male += 1;
      if (isFemale) genderTotals.female += 1;

      for (const key of issueKeys) {
        const node = doc?.[key];
        if (!node || typeof node !== 'object') continue;
        issueOccurrence[key].appearCount += 1;
        if (isMale) issueOccurrence[key].maleCount += 1;
        if (isFemale) issueOccurrence[key].femaleCount += 1;

        const levelNum = toNumber(node.level);
        if (levelNum != null && levelNum >= 1 && levelNum <= 5) {
          issueOccurrence[key].levelCounts[levelNum - 1] += 1;
          if (levelNum >= 4) issueOccurrence[key].severeCount += 1;
          if (levelNum >= 4) trendBucket.high += 1;
          else if (levelNum >= 2) trendBucket.medium += 1;
          else trendBucket.low += 1;
        }

        const scoreNum = toNumber(node.score);
        if (scoreNum != null) {
          trendBucket.scoreSum += scoreNum;
          trendBucket.scoreCount += 1;
        }

        if (mainSeverityKeys.includes(key)) {
          addLevel(severity[key], levelNum ?? 'unknown');
        }
      }

      const extNode = doc?.ext_water;
      if (extNode && typeof extNode === 'object') {
        extWaterOccurrence.appearCount += 1;
        if (isMale) extWaterOccurrence.maleCount += 1;
        if (isFemale) extWaterOccurrence.femaleCount += 1;

        const levelNum = toNumber(extNode.level);
        if (levelNum != null && levelNum >= 1 && levelNum <= 5) {
          extWaterOccurrence.levelCounts[levelNum - 1] += 1;
          if (levelNum >= 4) extWaterOccurrence.severeCount += 1;
          if (levelNum >= 4) extWaterTrend.high += 1;
          else if (levelNum >= 2) extWaterTrend.medium += 1;
          else extWaterTrend.low += 1;
        }

        const scoreNum = toNumber(extNode.score ?? extNode.result ?? extNode.level);
        if (scoreNum != null) {
          extWaterTrend.scoreSum += scoreNum;
          extWaterTrend.scoreCount += 1;
        }
      }
    }

    for (const key of issueKeys) {
      const row = issueOccurrence[key];
      row.share = totalRecords > 0 ? Number(((row.appearCount * 100) / totalRecords).toFixed(2)) : 0;
      row.severeShare = row.appearCount > 0 ? Number(((row.severeCount * 100) / row.appearCount).toFixed(2)) : 0;
    }
    extWaterOccurrence.share = totalRecords > 0
      ? Number(((extWaterOccurrence.appearCount * 100) / totalRecords).toFixed(2))
      : 0;
    extWaterOccurrence.severeShare = extWaterOccurrence.appearCount > 0
      ? Number(((extWaterOccurrence.severeCount * 100) / extWaterOccurrence.appearCount).toFixed(2))
      : 0;

    const toSeverityDist = (bucket) => {
      return Array.from(bucket.entries())
        .map(([label, count]) => ({
          label: String(label),
          count,
          percent: totalRecords > 0 ? Number(((count * 100) / totalRecords).toFixed(2)) : 0
        }))
        .sort((a, b) => b.count - a.count);
    };

    const trendTotal = trendBucket.high + trendBucket.medium + trendBucket.low;
    const issueTrends = {
      highShare: trendTotal > 0 ? Number(((trendBucket.high * 100) / trendTotal).toFixed(2)) : 0,
      mediumShare: trendTotal > 0 ? Number(((trendBucket.medium * 100) / trendTotal).toFixed(2)) : 0,
      lowShare: trendTotal > 0 ? Number(((trendBucket.low * 100) / trendTotal).toFixed(2)) : 0,
      averageScore: trendBucket.scoreCount > 0 ? Number((trendBucket.scoreSum / trendBucket.scoreCount).toFixed(2)) : null,
      ext_water: {
        highShare: (extWaterTrend.high + extWaterTrend.medium + extWaterTrend.low) > 0
          ? Number(((extWaterTrend.high * 100) / (extWaterTrend.high + extWaterTrend.medium + extWaterTrend.low)).toFixed(2))
          : 0,
        mediumShare: (extWaterTrend.high + extWaterTrend.medium + extWaterTrend.low) > 0
          ? Number(((extWaterTrend.medium * 100) / (extWaterTrend.high + extWaterTrend.medium + extWaterTrend.low)).toFixed(2))
          : 0,
        lowShare: (extWaterTrend.high + extWaterTrend.medium + extWaterTrend.low) > 0
          ? Number(((extWaterTrend.low * 100) / (extWaterTrend.high + extWaterTrend.medium + extWaterTrend.low)).toFixed(2))
          : 0,
        averageScore: extWaterTrend.scoreCount > 0
          ? Number((extWaterTrend.scoreSum / extWaterTrend.scoreCount).toFixed(2))
          : null
      }
    };
    issueOccurrence.ext_water = extWaterOccurrence;

    const response = {
      success: true,
      message: 'OK',
      meta: {
        from,
        to,
        rangeField,
        generatedAt: new Date().toISOString()
      },
      data: {
        severity: {
          acne: toSeverityDist(severity.acne),
          pore: toSeverityDist(severity.pore),
          spot: toSeverityDist(severity.spot),
          wrinkle: toSeverityDist(severity.wrinkle)
        },
        issueTrends,
        issueOccurrence,
        genderTotals
      }
    };
    setReportCache(cacheKey, response);
    return res.json(response);
  } catch (error) {
    return sendApiError(res, 500, 'Internal server error', 'INTERNAL_ERROR', error?.message || null);
  }
});

/**
 * GET /api/skin-report/recommendations
 * Tab "Đề xuất & KPI".
 */
app.get('/api/skin-report/recommendations', async (req, res) => {
  const parsed = parseSkinRecordsQuery(req);
  if (parsed.error) {
    return sendApiError(res, parsed.error.status, parsed.error.message, parsed.error.code);
  }
  const { from, to, rangeField } = parsed.value;

  try {
    const cacheKey = buildReportCacheKey('recommendations', { from, to, rangeField });
    const cached = getReportCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }

    const docs = await Skin.aggregate(buildRecommendationsProjectionPipeline(parseDayRangeQuery(from, to, rangeField)))
      .allowDiskUse(true);

    const totalRecords = docs.length;
    const multiUseRecordCounts = new Map();
    const canonicalTopGoodsCounts = new Map();
    const multiUseModules = new Map();
    const sensitivityCounts = new Map();
    const darkCircleTypeCounts = new Map();
    const trend = { high: 0, medium: 0, low: 0, scoreSum: 0, scoreCount: 0 };

    const addCount = (bucket, rawLabel) => {
      const label = String(rawLabel ?? 'unknown').trim() || 'unknown';
      bucket.set(label, (bucket.get(label) || 0) + 1);
    };
    for (const doc of docs) {
      const canonicalGoods = new Set(toGoodsIdList(doc.finalGoods));
      addCount(sensitivityCounts, doc.sensitivityType ?? 'unknown');
      addCount(darkCircleTypeCounts, doc.darkCircleType ?? 'unknown');
      addMultiUseStatsFromRecord(doc.moduleGoods, multiUseRecordCounts, multiUseModules);

      for (const gid of canonicalGoods) {
        canonicalTopGoodsCounts.set(gid, (canonicalTopGoodsCounts.get(gid) || 0) + 1);
      }

      for (const key of ['acne', 'pore', 'spot', 'wrinkle']) {
        const levelNum = Number(doc[`${key}Level`]);
        if (Number.isFinite(levelNum)) {
          if (levelNum >= 4) trend.high += 1;
          else if (levelNum >= 2) trend.medium += 1;
          else trend.low += 1;
        }
        const scoreNum = Number(doc[`${key}Score`]);
        if (Number.isFinite(scoreNum)) {
          trend.scoreSum += scoreNum;
          trend.scoreCount += 1;
        }
      }
    }

    const toDistribution = (bucket) => {
      return Array.from(bucket.entries())
        .map(([label, count]) => ({
          label,
          count,
          percent: totalRecords > 0 ? Number(((count * 100) / totalRecords).toFixed(2)) : 0
        }))
        .sort((a, b) => b.count - a.count);
    };

    const topGoods = buildTopGoodsFromCounts(canonicalTopGoodsCounts, totalRecords, 20);

    const rawTopMultiUseGoods = Array.from(multiUseModules.entries())
      .filter(([, modules]) => modules.size >= 2)
      .map(([label, modules]) => ({
        label,
        count: multiUseRecordCounts.get(label) || 0,
        percent: totalRecords > 0 ? Number((((multiUseRecordCounts.get(label) || 0) * 100) / totalRecords).toFixed(2)) : 0,
        modules: Array.from(modules).sort()
      }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 20);
    const topMultiUseGoods = normalizeTopMultiUseGoods(rawTopMultiUseGoods, totalRecords, 'recommendations');

    const trendTotal = trend.high + trend.medium + trend.low;
    const issueTrends = {
      highShare: trendTotal > 0 ? Number(((trend.high * 100) / trendTotal).toFixed(2)) : 0,
      mediumShare: trendTotal > 0 ? Number(((trend.medium * 100) / trendTotal).toFixed(2)) : 0,
      lowShare: trendTotal > 0 ? Number(((trend.low * 100) / trendTotal).toFixed(2)) : 0,
      averageScore: trend.scoreCount > 0 ? Number((trend.scoreSum / trend.scoreCount).toFixed(2)) : null
    };

    const kpiPlan = [
      {
        title: 'Giảm nhóm mức độ nặng',
        target: `High share <= ${Math.max(0, issueTrends.highShare - 5).toFixed(2)}%`,
        evidence: `Current highShare=${issueTrends.highShare}%`
      },
      {
        title: 'Nâng điểm trung bình các vấn đề chính',
        target: issueTrends.averageScore == null ? 'N/A' : `Average score >= ${(issueTrends.averageScore + 5).toFixed(2)}`,
        evidence: `Current averageScore=${issueTrends.averageScore ?? 'N/A'}`
      },
      {
        title: 'Tăng phủ sản phẩm đa tác dụng',
        target: `Top multi-use goods >= ${Math.min(10, topMultiUseGoods.length + 2)} items`,
        evidence: `Current multi-use count=${topMultiUseGoods.length}`
      }
    ];

    const response = {
      success: true,
      message: 'OK',
      meta: {
        from,
        to,
        rangeField,
        totalRecords,
        generatedAt: new Date().toISOString()
      },
      data: {
        totalRecords,
        topMultiUseGoods,
        topGoods,
        sensitivity: toDistribution(sensitivityCounts),
        darkCircleTypes: toDistribution(darkCircleTypeCounts),
        issueTrends,
        kpiPlan
      }
    };
    setReportCache(cacheKey, response);
    return res.json(response);
  } catch (error) {
    return sendApiError(res, 500, 'Internal server error', 'INTERNAL_ERROR', error?.message || null);
  }
});

/**
 * GET /api/skin-records
 * Paginated records for list view.
 */
app.get('/api/skin-records', async (req, res) => {
  const parsed = parseSkinRecordsQuery(req);
  if (parsed.error) {
    return sendApiError(res, parsed.error.status, parsed.error.message, parsed.error.code);
  }

  const { from, to, rangeField, page, pageSize, sortBy, sortOrder } = parsed.value;
  const search = String(req.query.search || '').trim();
  const sex = req.query.sex != null ? String(req.query.sex).trim() : '';
  const account = String(req.query.account || '').trim();

  try {
    const queryParts = [parseDayRangeQuery(from, to, rangeField)];

    if (search) {
      queryParts.push({
        $or: [
          { id: { $regex: search, $options: 'i' } },
          { result_id: { $regex: search, $options: 'i' } },
          { code: { $regex: search, $options: 'i' } },
          { customer_nickname: { $regex: search, $options: 'i' } },
          { customer_mobile: { $regex: search, $options: 'i' } },
          { user_acct: { $regex: search, $options: 'i' } }
        ]
      });
    }
    if (sex) {
      const numSex = Number(sex);
      if (Number.isFinite(numSex)) {
        queryParts.push({ customer_sex: { $in: [sex, numSex] } });
      } else {
        queryParts.push({ customer_sex: sex });
      }
    }
    if (account) {
      queryParts.push({ user_acct: { $regex: account, $options: 'i' } });
    }

    const query = queryParts.length === 1 ? queryParts[0] : { $and: queryParts };
    const projection = {
      _id: 0,
      id: 1,
      result_id: 1,
      code: 1,
      status: 1,
      crt_time: 1,
      test_time: 1,
      testTime: 1,
      createdAt: 1,
      updatedAt: 1,
      image: 1,
      user_acct: 1,
      customer_nickname: 1,
      customer_sex: 1,
      customer_age: 1,
      customer_mobile: 1,
      'analysis.age': 1,
      'analysis.final_result': 1
    };

    const sort = {};
    if (sortBy === 'test_time') {
      sort.test_time = sortOrder;
      sort.testTime = sortOrder;
    } else {
      sort[sortBy] = sortOrder;
    }

    const skip = (page - 1) * pageSize;
    const [total, docs] = await Promise.all([
      Skin.countDocuments(query),
      Skin.find(query, projection).sort(sort).skip(skip).limit(pageSize).lean()
    ]);

    return res.json({
      success: true,
      message: 'OK',
      meta: {
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        from,
        to,
        rangeField,
        generatedAt: new Date().toISOString()
      },
      data: docs.map(normalizeListRecord)
    });
  } catch (error) {
    return sendApiError(res, 500, 'Internal server error', 'INTERNAL_ERROR', error?.message || null);
  }
});

/**
 * GET /api/skin-records/by-result/:resultId
 * Detail by result_id.
 */
app.get('/api/skin-records/by-result/:resultId', async (req, res) => {
  const resultId = String(req.params.resultId || '').trim();
  if (!resultId) {
    return sendApiError(res, 400, 'Missing resultId', 'INVALID_QUERY');
  }
  try {
    const doc = await Skin.findOne(
      { result_id: resultId },
      {
        _id: 0,
        id: 1,
        result_id: 1,
        code: 1,
        status: 1,
        crt_time: 1,
        test_time: 1,
        testTime: 1,
        createdAt: 1,
        updatedAt: 1,
        image: 1,
        user_acct: 1,
        customer_nickname: 1,
        customer_sex: 1,
        customer_age: 1,
        customer_mobile: 1,
        recommendedGoodsIds: 1,
        recommendedGoods: 1,
        analysis: 1
      }
    ).lean();
    if (!doc) {
      return sendApiError(res, 404, `Record with result_id=${resultId} not found`, 'NOT_FOUND');
    }
    return res.json({
      success: true,
      message: 'OK',
      data: normalizeDetailRecord(doc)
    });
  } catch (error) {
    return sendApiError(res, 500, 'Internal server error', 'INTERNAL_ERROR', error?.message || null);
  }
});

/**
 * GET /api/skin-records/:id
 * Detail by id.
 */
app.get('/api/skin-records/:id', async (req, res) => {
  const idParam = String(req.params.id || '').trim();
  if (!idParam) {
    return sendApiError(res, 400, 'Missing id', 'INVALID_QUERY');
  }
  try {
    const idCandidates = [idParam];
    const num = Number(idParam);
    if (Number.isFinite(num)) idCandidates.push(num);

    const doc = await Skin.findOne(
      { id: { $in: idCandidates } },
      {
        _id: 0,
        id: 1,
        result_id: 1,
        code: 1,
        status: 1,
        crt_time: 1,
        test_time: 1,
        testTime: 1,
        createdAt: 1,
        updatedAt: 1,
        image: 1,
        user_acct: 1,
        customer_nickname: 1,
        customer_sex: 1,
        customer_age: 1,
        customer_mobile: 1,
        recommendedGoodsIds: 1,
        recommendedGoods: 1,
        analysis: 1
      }
    ).lean();
    if (!doc) {
      return sendApiError(res, 404, `Record with id=${idParam} not found`, 'NOT_FOUND');
    }
    return res.json({
      success: true,
      message: 'OK',
      data: normalizeDetailRecord(doc)
    });
  } catch (error) {
    return sendApiError(res, 500, 'Internal server error', 'INTERNAL_ERROR', error?.message || null);
  }
});

/**
 * GET /api/data/view
 * Stream full set of documents that match the query so the UI can display the exact range.
 */
app.get('/api/data/view', async (req, res) => {
  try {
    const debugExplain = String(req.query.debugExplain || req.query.explain || '0') === '1';
    const sortByArg = (req.query.sortBy || '').trim();
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
    const inputStart = req.query.start ?? req.query.from ?? req.query.st ?? null;
    const inputEnd = req.query.end ?? req.query.to ?? req.query.ed ?? null;
    let rangeStart = normalizeDateInput(inputStart, false);
    let rangeEnd = normalizeDateInput(inputEnd, true);
    const rangeField = req.query.rangeField || req.query.field || DEFAULT_RANGE_FIELD;
    const normalizedRangeField = normalizeRangeField(rangeField);
    const rangeFilter = buildRangeQuery(rangeStart, rangeEnd, normalizedRangeField);

    const search = req.query.search || '';
    const buildQuery = (overrideFilter) => {
      const parts = [];
      if (search) {
        parts.push({
          $or: [
            { id: { $regex: search, $options: 'i' } },
            { customerInfo: { $regex: search, $options: 'i' } },
            { account: { $regex: search, $options: 'i' } },
            { deviceNumber: { $regex: search, $options: 'i' } }
          ]
        });
      }
      if (overrideFilter) parts.push(overrideFilter);
      if (parts.length === 0) return {};
      return parts.length === 1 ? parts[0] : { $and: parts };
    };

    let currentRangeField = normalizedRangeField;
    let currentRangeFilter = rangeFilter;
    if ((!rangeStart || !rangeEnd) && normalizedRangeField) {
      const autoRange = await getLatestMonthRange(normalizedRangeField);
      if (autoRange) {
        if (!rangeStart) rangeStart = autoRange.start;
        if (!rangeEnd) rangeEnd = autoRange.end;
        const autoFilter = buildRangeQuery(rangeStart, rangeEnd, normalizedRangeField);
        if (autoFilter) {
          currentRangeFilter = autoFilter;
        }
      }
    }
    let query = buildQuery(currentRangeFilter);
    let total = await Skin.countDocuments(query);

    if (
      total === 0 &&
      normalizedRangeField === 'scrapedAt' &&
      rangeFilter
    ) {
      const fallbackFilter = buildRangeQuery(rangeStart, rangeEnd, 'crt_time');
      if (fallbackFilter) {
        const fallbackQuery = buildQuery(fallbackFilter);
        const fallbackTotal = await Skin.countDocuments(fallbackQuery);
        if (fallbackTotal > 0) {
          currentRangeField = 'crt_time';
          currentRangeFilter = fallbackFilter;
          query = fallbackQuery;
          total = fallbackTotal;
        }
      }
    }

    const effectiveSortField = ALLOWED_RANGE_FIELDS.includes(sortByArg)
      ? sortByArg
      : currentRangeField;

    if (debugExplain) {
      const explain = await Skin.find(query)
        .sort({ [effectiveSortField]: sortOrder })
        .explain('executionStats');
      return res.json({
        success: true,
        debugExplain: true,
        query,
        sort: { [effectiveSortField]: sortOrder },
        total,
        explain
      });
    }

    const cursor = Skin.find(query)
      .sort({ [effectiveSortField]: sortOrder })
      .lean()
      .cursor();

    const dataTimeRange = await getDataTimeRange(currentRangeFilter, currentRangeField);
    const statsRange = (dataTimeRange?.from && dataTimeRange?.to)
      ? { start: dataTimeRange.from, end: dataTimeRange.to }
      : (rangeStart && rangeEnd ? { start: rangeStart, end: rangeEnd } : null);
    const displayDataTimeRange = formatDataRangeForDisplay(dataTimeRange);
    const displayStatsRange = formatRangeForDisplay(statsRange);

    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const meta = {
      success: true,
      total,
      range: displayStatsRange,
      dataTimeRange: displayDataTimeRange
    };
    const metaJson = JSON.stringify(meta);
    res.write(`${metaJson.slice(0, -1)},"data":[`);

    let first = true;
    for await (const doc of cursor) {
      const chunk = `${first ? '' : ','}${JSON.stringify(doc)}`;
      first = false;
      if (!res.write(chunk)) {
        await once(res, 'drain');
      }
    }

    res.write(']}');
    res.end();
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    } else {
      console.error('Data view stream failed:', error);
      res.end();
    }
  }
});

/**
 * GET /api/data/stats
 * Thống kê dữ liệu
 */
app.get('/api/data/stats', async (req, res) => {
  try {
    const inputStart = req.query.start ?? req.query.from ?? null;
    const inputEnd = req.query.end ?? req.query.to ?? null;
    const rangeStart = normalizeDateInput(inputStart, false);
    const rangeEnd = normalizeDateInput(inputEnd, true);
    const rangeField = req.query.rangeField || req.query.field || DEFAULT_RANGE_FIELD;
    const normalizedRangeField = normalizeRangeField(rangeField);
    const rangeFilter = buildRangeQuery(rangeStart, rangeEnd, normalizedRangeField);
    const cacheKey = buildReportCacheKey('data-stats', {
      start: rangeStart || null,
      end: rangeEnd || null,
      rangeField: normalizedRangeField
    });
    const cached = getReportCache(cacheKey);
    if (cached) {
      return res.json(cached);
    }
    const baseMatch = rangeFilter ? { $match: rangeFilter } : null;
    const [
      total,
      byGender,
      byAccount,
      byStatus,
      oldest,
      newest,
      dataTimeRange,
      lastSync
    ] = await Promise.all([
      Skin.countDocuments(rangeFilter || {}),
      Skin.aggregate([
        ...(baseMatch ? [baseMatch] : []),
        { $group: { _id: '$gender', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      Skin.aggregate([
        ...(baseMatch ? [baseMatch] : []),
        { $group: { _id: '$account', count: { $sum: 1 } } },
        { $sort: { count: -1 } },
        { $limit: 10 }
      ]),
      Skin.aggregate([
        ...(baseMatch ? [baseMatch] : []),
        { $group: { _id: '$testStatus', count: { $sum: 1 } } },
        { $sort: { count: -1 } }
      ]),
      Skin.findOne(rangeFilter || {}).sort({ [normalizedRangeField]: 1 }).lean(),
      Skin.findOne(rangeFilter || {}).sort({ [normalizedRangeField]: -1 }).lean(),
      getDataTimeRange(rangeFilter, normalizedRangeField),
      SyncState.findOne({ status: 'success' }).sort({ lastSuccessAt: -1 }).lean()
    ]);
    const displayDataTimeRange = formatDataRangeForDisplay(dataTimeRange);

    const response = {
      success: true,
      stats: {
        total,
        byGender,
        byAccount,
        byStatus,
        oldestRecord: oldest ? oldest[normalizedRangeField] : null,
        newestRecord: newest ? newest[normalizedRangeField] : null,
        dataTimeRange: displayDataTimeRange,
        lastSync: lastSync
          ? {
              rangeStart: lastSync.rangeStart,
              rangeEnd: lastSync.rangeEnd,
              totalRecords: lastSync.totalRecords,
              lastSuccessAt: lastSync.lastSuccessAt,
              lastError: lastSync.lastError
            }
          : null
      }
    };
    setReportCache(cacheKey, response);
    res.json(response);
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

/**
 * GET /api/data/export
 * Export dữ liệu ra JSON hoặc CSV
 * Query params:
 *   - format: json hoặc csv (default: json)
 */
app.get('/api/data/export', async (req, res) => {
  try {
    const format = req.query.format || 'json';
    const search = req.query.search || '';
    const inputStart = req.query.start ?? req.query.from ?? null;
    const inputEnd = req.query.end ?? req.query.to ?? null;
    const rangeStart = normalizeDateInput(inputStart, false);
    const rangeEnd = normalizeDateInput(inputEnd, true);
    const rangeFilter = buildRangeQuery(rangeStart, rangeEnd);

    const queryParts = [];
    if (search) {
      queryParts.push({
        $or: [
          { id: { $regex: search, $options: 'i' } },
          { customerInfo: { $regex: search, $options: 'i' } },
          { account: { $regex: search, $options: 'i' } },
          { deviceNumber: { $regex: search, $options: 'i' } }
        ]
      });
    }
    if (rangeFilter) queryParts.push(rangeFilter);
    const query = queryParts.length === 0
      ? {}
      : (queryParts.length === 1 ? queryParts[0] : { $and: queryParts });

    const timestamp = new Date().toISOString().split('T')[0];

    if (format === 'csv') {
      const total = await Skin.countDocuments(query);
      if (total === 0) {
        return res.status(404).json({ message: 'No data to export' });
      }

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="skin-data-${timestamp}.csv"`);
      const headers = ['ID', 'Customer Info', 'Gender', 'Device Number', 'Account', 'Test Time', 'Test Status', 'Remarks', 'Image', 'URL'];
      res.write(`${headers.join(',')}\n`);

      const projection = {
        _id: 0,
        id: 1,
        customerInfo: 1,
        gender: 1,
        deviceNumber: 1,
        account: 1,
        testTime: 1,
        testStatus: 1,
        remarks: 1,
        image: 1,
        url: 1
      };
      const cursor = Skin.find(query, projection).lean().cursor();
      for await (const item of cursor) {
        const row = [
          item.id || '',
          `"${(item.customerInfo || '').replace(/"/g, '""')}"`,
          item.gender || '',
          item.deviceNumber || '',
          item.account || '',
          item.testTime || '',
          item.testStatus || '',
          `"${(item.remarks || '').replace(/"/g, '""')}"`,
          item.image || '',
          item.url || ''
        ].join(',');
        if (!res.write(`${row}\n`)) {
          await once(res, 'drain');
        }
      }
      res.end();
    } else {
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Content-Disposition', `attachment; filename="skin-data-${timestamp}.json"`);
      const cursor = Skin.find(query).lean().cursor();
      res.write('[');
      let first = true;
      for await (const doc of cursor) {
        const chunk = `${first ? '' : ','}${JSON.stringify(doc)}`;
        first = false;
        if (!res.write(chunk)) {
          await once(res, 'drain');
        }
      }
      res.write(']');
      res.end();
    }
  } catch (error) {
    if (!res.headersSent) {
      res.status(500).json({
        success: false,
        message: error.message
      });
    } else {
      console.error('Export stream failed:', error);
      res.end();
    }
  }
});

/**
 * DELETE /api/data
 * Xóa dữ liệu (có thể filter)
 */
app.delete('/api/data', async (req, res) => {
  try {
    const { ids, confirm } = req.body;

    if (!confirm || confirm !== 'yes') {
      return res.status(400).json({
        success: false,
        message: 'Cần xác nhận bằng cách gửi { confirm: "yes" }'
      });
    }

    let result;
    if (ids && Array.isArray(ids) && ids.length > 0) {
      // Xóa theo danh sách IDs
      result = await Skin.deleteMany({ id: { $in: ids } });
    } else {
      // Xóa tất cả
      result = await Skin.deleteMany({});
    }

    res.json({
      success: true,
      message: `Đã xóa ${result.deletedCount} records`,
      deletedCount: result.deletedCount
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

// ==================== SCRAPING FUNCTION ====================

async function startScrapingAllPages() {
  scrapingStatus.isRunning = true;
  scrapingStatus.startTime = Date.now();
  scrapingStatus.progress = { currentPage: 0, totalPages: 0, collectedItems: 0 };
  scrapingStatus.error = null;
  scrapingStatus.endTime = null;

  console.log('🧭 Browser executablePath:', cfg.execPath);
  const browser = await puppeteer.launch({
    headless: cfg.headless,
    executablePath: cfg.execPath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage'
    ]
  });

  const page = await browser.newPage();

  try {
    // Navigate và login
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36');
    await page.setViewport({ width: 1366, height: 850, deviceScaleFactor: 1 });
    
    console.log('🌐 Navigating to target URL...');
    await page.goto(cfg.targetUrl, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeout || 60000 });

    if (cfg.forceAccessToken) {
      console.log('🔐 Using FORCE_ACCESS_TOKEN');
      await applyAccessToken(page, cfg.forceAccessToken);
      await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/', {
        waitUntil: 'domcontentloaded',
        timeout: cfg.navTimeout || 60000
      });
    }

    // Handle authentication
    if (!cfg.forceAccessToken && (cfg.auth.email || cfg.auth.username)) {
      console.log('🔐 Attempting login...');
      await handleAuthentication(page);
    }

    await logSessionPrefs(page, 'before records');

    // Navigate to records list page
    console.log('📋 Navigating to records list page...');
    await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/#/skinmgr/recordsList', {
      waitUntil: 'domcontentloaded',
      timeout: cfg.navTimeout || 60000
    });
    
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Extract all pages
    console.log('🚀 Starting full pagination extraction...');
    const reAuth = async () => {
      const readAuthSnapshot = async () => {
        try {
          return await page.evaluate(() => {
            const cookieToken = document.cookie
              .split(';')
              .map(s => s.trim())
              .find(s => s.startsWith('access_token=') || s.startsWith('accessToken='));
            const cookieValue = cookieToken ? cookieToken.split('=').slice(1).join('=') : '';
            const token =
              localStorage.getItem('access_token') ||
              localStorage.getItem('accessToken') ||
              localStorage.getItem('token') ||
              sessionStorage.getItem('access_token') ||
              sessionStorage.getItem('accessToken') ||
              sessionStorage.getItem('token') ||
              cookieValue ||
              '';
            const tid =
              localStorage.getItem('x-tid') ||
              localStorage.getItem('tid') ||
              sessionStorage.getItem('x-tid') ||
              sessionStorage.getItem('tid') ||
              '';
            const locale =
              localStorage.getItem('locale') ||
              sessionStorage.getItem('locale') ||
              '';
            return { token, tid, locale };
          });
        } catch (_) {
          return { token: '', tid: '', locale: '' };
        }
      };

      console.log('🔐 Re-authenticating after session expiry...');
      const before = await readAuthSnapshot();
      try {
        await page.evaluate(() => {
          localStorage.clear();
          sessionStorage.clear();
        });
      } catch (_) {}
      try {
        const cookies = await page.cookies();
        if (cookies.length > 0) {
          await page.deleteCookie(...cookies);
        }
      } catch (_) {}

      await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/', {
        waitUntil: 'domcontentloaded',
        timeout: cfg.navTimeout || 60000
      });
      await handleAuthentication(page);
      let after = await readAuthSnapshot();
      const waitStart = Date.now();
      while (!after.token && Date.now() - waitStart < 15000) {
        await new Promise(r => setTimeout(r, 500));
        after = await readAuthSnapshot();
      }
      if (before.token && after.token && before.token === after.token) {
        console.log('⚠️  Token did not change after re-login');
      }
      await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/#/skinmgr/recordsList', {
        waitUntil: 'domcontentloaded',
        timeout: cfg.navTimeout || 60000
      });
      await new Promise(resolve => setTimeout(resolve, 3000));
      try {
        const auth = await readAuthSnapshot();
        const headers = {};
        if (auth.token) headers.access_token = auth.token;
        if (auth.tid) headers['x-tid'] = auth.tid;
        if (auth.locale) headers.locale = auth.locale;
        headers.language = auth.locale || 'en';
        let cookieHeader = '';
        try {
          const cookies = await page.cookies();
          cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
        } catch (_) {}
        if (cookieHeader) headers.cookie = cookieHeader;
        if (auth.token) {
          await applyAccessToken(page, auth.token);
        }
        return { headers };
      } catch (e) {
        console.log('⚠️  Could not read refreshed token:', e.message);
        return null;
      }
    };
    const items = await extractAllPages(page, {
      onAuthExpired: reAuth,
      forceHeaders: cfg.forceHeaders,
      bootstrapApiConfig: cfg.forceAccessToken
        ? buildBootstrapApiConfig(cfg.forceAccessToken, cfg.forceHeaders)
        : null
    });

    console.log(`📦 Extracted ${items.length} items total`);

    // Persist to MongoDB
    console.log('💾 Saving to database...');
    let upserts = 0;
    const crypto = await import('node:crypto');
    
    for (const item of items) {
      const hashedKey = crypto.createHash('sha1').update(Skin.keyFor(item)).digest('hex');
      await Skin.updateOne(
        { hashedKey },
        { $set: { ...item, hashedKey, scrapedAt: new Date() } },
        { upsert: true }
      );
      upserts++;
    }

    console.log(`💾 Upserted ${upserts} records`);

    scrapingStatus.progress.collectedItems = items.length;
    scrapingStatus.endTime = Date.now();

    console.log('✅ Scraping completed successfully');

  } catch (error) {
    console.error('❌ Scraping error:', error);
    scrapingStatus.error = error.message;
    scrapingStatus.endTime = Date.now();
  } finally {
    scrapingStatus.isRunning = false;
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function scrapeAllPagesOnce({
  saveToDb = true,
  rangeStart = null,
  rangeEnd = null,
  chunkDateRange = true,
  accessTokenOverride = ''
} = {}) {
  const browser = await puppeteer.launch({
    headless: cfg.headless,
    executablePath: cfg.execPath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage'
    ]
  });

  const page = await browser.newPage();

  try {
    // Navigate và login
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36');
    await page.setViewport({ width: 1366, height: 850, deviceScaleFactor: 1 });

    console.log('🌐 Navigating to target URL...');
    await page.goto(cfg.targetUrl, { waitUntil: 'domcontentloaded', timeout: cfg.navTimeout || 60000 });

    const overrideToken = normalizeAccessToken(accessTokenOverride);
    const forceToken = normalizeAccessToken(cfg.forceAccessToken);
    const tokenToUse = overrideToken || forceToken;

    if (tokenToUse) {
      console.log(`🔐 Using ${overrideToken ? 'REQUEST_ACCESS_TOKEN' : 'FORCE_ACCESS_TOKEN'}: ${maskToken(tokenToUse)}`);
      await applyAccessToken(page, tokenToUse);
      await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/', {
        waitUntil: 'domcontentloaded',
        timeout: cfg.navTimeout || 60000
      });
    }

    // Handle authentication
    if (!tokenToUse && (cfg.auth.email || cfg.auth.username)) {
      console.log('🔐 Attempting login...');
      await handleAuthentication(page);
    }

    await logSessionPrefs(page, 'before records');

    // Navigate to records list page
    console.log('📋 Navigating to records list page...');
    await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/#/skinmgr/recordsList', {
      waitUntil: 'domcontentloaded',
      timeout: cfg.navTimeout || 60000
    });

    await new Promise(resolve => setTimeout(resolve, 3000));

    // Extract all pages
    console.log('🚀 Starting full pagination extraction...');
    const useRange = Boolean(rangeStart && rangeEnd);
    const items = await extractAllPages(page, {
      onAuthExpired: async () => {
        const readAuthSnapshot = async () => {
          try {
            return await page.evaluate(() => {
              const cookieToken = document.cookie
                .split(';')
                .map(s => s.trim())
                .find(s => s.startsWith('access_token=') || s.startsWith('accessToken='));
              const cookieValue = cookieToken ? cookieToken.split('=').slice(1).join('=') : '';
              const token =
                localStorage.getItem('access_token') ||
                localStorage.getItem('accessToken') ||
                localStorage.getItem('token') ||
                sessionStorage.getItem('access_token') ||
                sessionStorage.getItem('accessToken') ||
                sessionStorage.getItem('token') ||
                cookieValue ||
                '';
              const tid =
                localStorage.getItem('x-tid') ||
                localStorage.getItem('tid') ||
                sessionStorage.getItem('x-tid') ||
                sessionStorage.getItem('tid') ||
                '';
              const locale =
                localStorage.getItem('locale') ||
                sessionStorage.getItem('locale') ||
                '';
              return { token, tid, locale };
            });
          } catch (_) {
            return { token: '', tid: '', locale: '' };
          }
        };

        console.log('🔐 Re-authenticating after session expiry...');
        const before = await readAuthSnapshot();
        try {
          await page.evaluate(() => {
            localStorage.clear();
            sessionStorage.clear();
          });
        } catch (_) {}
        try {
          const cookies = await page.cookies();
          if (cookies.length > 0) {
            await page.deleteCookie(...cookies);
          }
        } catch (_) {}
        await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/', {
          waitUntil: 'domcontentloaded',
          timeout: cfg.navTimeout || 60000
        });
        if (tokenToUse) {
          await applyAccessToken(page, tokenToUse);
        } else {
          await handleAuthentication(page);
        }
        let after = await readAuthSnapshot();
        const waitStart = Date.now();
        while (!after.token && Date.now() - waitStart < 15000) {
          await new Promise(r => setTimeout(r, 500));
          after = await readAuthSnapshot();
        }
        if (before.token && after.token && before.token === after.token) {
          console.log('⚠️  Token did not change after re-login');
        }
        await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/#/skinmgr/recordsList', {
          waitUntil: 'domcontentloaded',
          timeout: cfg.navTimeout || 60000
        });
        await new Promise(resolve => setTimeout(resolve, 3000));
        try {
          const auth = await readAuthSnapshot();
          const headers = {};
          if (auth.token) headers.access_token = auth.token;
          if (auth.tid) headers['x-tid'] = auth.tid;
          if (auth.locale) headers.locale = auth.locale;
          headers.language = auth.locale || 'en';
          let cookieHeader = '';
          try {
            const cookies = await page.cookies();
            cookieHeader = cookies.map(c => `${c.name}=${c.value}`).join('; ');
          } catch (_) {}
          if (cookieHeader) headers.cookie = cookieHeader;
          if (auth.token) {
            await applyAccessToken(page, auth.token);
          }
          return { headers };
        } catch (e) {
          console.log('⚠️  Could not read refreshed token:', e.message);
          return null;
        }
      },
      forceHeaders: cfg.forceHeaders,
      bootstrapApiConfig: tokenToUse
        ? buildBootstrapApiConfig(tokenToUse, cfg.forceHeaders)
        : null,
      ...(useRange
        ? {
            forceDateRange: true,
            forceDateStart: rangeStart,
            forceDateEnd: rangeEnd,
            chunkDateRange,
            chunkDateStart: rangeStart,
            chunkDateEnd: rangeEnd
          }
        : {})
    });

    console.log(`📦 Extracted ${items.length} items total`);

    // Persist to MongoDB (optional)
    let upserts = 0;
    let newCount = 0;
    let updatedCount = 0;
    let unchangedCount = 0;
    if (saveToDb) {
      console.log('💾 Saving to database...');
      const crypto = await import('node:crypto');
      const batchSize = Number(process.env.DB_BULK_BATCH_SIZE || 500);
      const now = new Date();
      const ops = items.map((item) => {
        const hashedKey = crypto.createHash('sha1').update(Skin.keyFor(item)).digest('hex');
        return {
          updateOne: {
            filter: { hashedKey },
            update: { $set: { ...item, hashedKey, scrapedAt: now } },
            upsert: true
          }
        };
      });

      console.log(`💾 DB bulk write: ops=${ops.length}, batchSize=${batchSize}`);
      console.time('db-save');
      for (let i = 0; i < ops.length; i += batchSize) {
        const batch = ops.slice(i, i + batchSize);
        const result = await Skin.bulkWrite(batch, { ordered: false });
        upserts += batch.length;
        newCount += result?.upsertedCount || 0;
        updatedCount += result?.modifiedCount || 0;
      }
      console.timeEnd('db-save');
      unchangedCount = Math.max(0, upserts - newCount - updatedCount);
      console.log(
        `💾 DB write stats: processed=${upserts}, new=${newCount}, updated=${updatedCount}, unchanged=${unchangedCount}`
      );
      if (upserts > 0) {
        const perSecond = (upserts / Math.max(1, (Date.now() - now.getTime()) / 1000)).toFixed(1);
        console.log(`💾 DB throughput: ~${perSecond} ops/sec`);
      }
      console.log(`💾 Upserted ${upserts} records`);
    }

    console.log('✅ Scrape once completed');
    return { items, upserts, newCount, updatedCount, unchangedCount };
  } catch (error) {
    console.error('❌ Scrape once error:', error);
    throw error;
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

async function handleAuthentication(page) {
  if (cfg.auth?.useApiLogin && !cfg.auth?.preferUiLogin) {
    const token = await fetchAccessTokenViaApi();
    if (token) {
      await applyAccessToken(page, token);
      try {
        await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/', {
          waitUntil: 'domcontentloaded',
          timeout: cfg.navTimeout || 60000
        });
      } catch (_) {}
      console.log('✅ Authentication completed (API token)');
      return;
    }
  }

  const loginSelectors = [
    'input[placeholder="请输入手机号码或用户名"]',
    'input[placeholder*="username" i]',
    'input[type="email"]',
    'input[name="email"]',
    'input[name="username"]'
  ];
  
  let needsLogin = false;
  for (const selector of loginSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 5000 });
      needsLogin = true;
      break;
    } catch (e) {}
  }
  
  if (needsLogin && cfg.auth) {
    try {
      const email = cfg.auth.email || cfg.auth.username;
      if (email) {
        await page.type('input[placeholder="请输入手机号码或用户名"]', email);
      }
      
      if (cfg.auth.password) {
        await page.type('input[placeholder="请输入密码"]', cfg.auth.password);
      }
      
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const loginBtn = buttons.find(btn => 
          btn.textContent.includes('登录') || 
          btn.textContent.includes('Login') ||
          btn.textContent.includes('Sign in')
        );
        if (loginBtn) loginBtn.click();
      });
      
      await new Promise(resolve => setTimeout(resolve, 5000));
      const token = await readAuthTokenFromPage(page);
      if (token) {
        await applyAccessToken(page, token);
        console.log(`✅ Authentication completed (UI token: ${maskToken(token)})`);
      } else {
        console.log('✅ Authentication completed');
      }
    } catch (error) {
      console.log('❌ Authentication failed:', error.message);
    }
  }
}

// ==================== START SERVER ====================

(async () => {
  // Connect to MongoDB
  try {
    await connectDB(cfg.mongoUri);
    console.log('✅ MongoDB connected');
  } catch (error) {
    console.error('❌ MongoDB connection failed:', error.message);
    process.exit(1);
  }

  if (cfg.cron && cron.validate(cfg.cron)) {
    const cronTimezone = cfg.syncTimezone || 'Asia/Ho_Chi_Minh';
    cron.schedule(cfg.cron, async () => {
      const now = new Date();
      const timezone = cronTimezone;
      const timezoneNow = now.toLocaleString('en-US', { timeZone: timezone });
      console.log(`🕒 Cron tick at server=${now.toLocaleString()} | ${timezone}=${timezoneNow}`);
      if (scrapingStatus.isRunning) {
        console.log('⏭️  Cron sync skipped: scraping is already running');
        return;
      }
      if (!isWithinSyncWindow(now)) {
        console.log(
          `⏭️  Cron sync skipped at ${timezoneNow} ${timezone} (outside window ${cfg.syncWindow.startHour}:00-${cfg.syncWindow.endHour}:00)`
        );
        return;
      }
      const incrementalRange = await buildIncrementalSyncRange(now);
      if (!incrementalRange) {
        console.log('⏭️  Cron sync skipped: no latest record time found to build range');
        return;
      }
      if (incrementalRange.invalid) {
        const tz = cfg.syncTimezone || 'Asia/Ho_Chi_Minh';
        console.log(
          `⏭️  Cron sync skipped: computed range is invalid (${formatDateTimeInTimezone(incrementalRange.rangeStartDate, tz)} > ${formatDateTimeInTimezone(incrementalRange.rangeEndDate, tz)}), latest=${incrementalRange.anchor?.latestRaw || 'n/a'} (${incrementalRange.anchor?.sourceField || 'unknown'})`
        );
        return;
      }
      await enqueueSync({
        rangeStart: incrementalRange.rangeStart,
        rangeEnd: incrementalRange.rangeEnd,
        reason: 'cron'
      });
      console.log(
        `✅ Cron sync enqueued: ${incrementalRange.rangeStart} -> ${incrementalRange.rangeEnd} (anchor=${incrementalRange.anchor?.sourceField || 'unknown'})`
      );
    }, { timezone: cronTimezone });
    console.log(
      `⏱️  Cron sync scheduled: ${cfg.cron} (window ${cfg.syncWindow.startHour}:00-${cfg.syncWindow.endHour}:00, timezone ${cronTimezone})`
    );
  }

  // Start server
  app.listen(PORT, () => {
    console.log(`🚀 API Server running at http://localhost:${PORT}`);
    console.log(`📚 API Documentation:`);
    console.log(`   GET  /api/health - Health check`);
    console.log(`   POST /api/scrape/all-pages - Start scraping all pages`);
    console.log(`   POST /api/scrape/full-sync - Scrape all pages and return data`);
    console.log(`   GET  /api/scrape/status - Check scraping status`);
    console.log(`   GET  /api/sync/status - Check sync status`);
    console.log(`   POST /api/sync/request - Request background sync`);
    console.log(`   GET  /api/data - Get data (with pagination, search, sort)`);
    console.log(`   GET  /api/customers - Query customer-focused data`);
    console.log(`   GET  /api/skin-report/summary - Aggregated dashboard summary`);
    console.log(`   GET  /api/skin-report/profile - Demographic and skin-type tab data`);
    console.log(`   GET  /api/skin-report/conditions - Condition tab data`);
    console.log(`   GET  /api/skin-report/recommendations - Recommendations/KPI tab data`);
    console.log(`   GET  /api/skin-records - Raw skin records for FE list/detail`);
    console.log(`   GET  /api/skin-records/:id - Record detail by id`);
    console.log(`   GET  /api/skin-records/by-result/:resultId - Record detail by result_id`);
    console.log(`   GET  /api/data/stats - Get statistics`);
    console.log(`   GET  /api/data/export?format=json|csv - Export data`);
    console.log(`   DELETE /api/data - Delete data`);
    console.log(`\n🔗 Frontend có thể kết nối tại: http://localhost:${PORT}`);
  });
})();
