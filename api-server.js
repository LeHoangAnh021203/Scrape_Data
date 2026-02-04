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

const parseDateInput = (value) => {
  if (!value) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return new Date(`${raw}T00:00:00`);
  }
  if (/^\d{4}-\d{1,2}$/.test(raw)) {
    const [y, m] = raw.split('-').map(Number);
    if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) return null;
    return new Date(y, m - 1, 1, 0, 0, 0, 0);
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(raw)) {
    return new Date(raw.replace(' ', 'T') + ':00');
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

  let rangeStart = normalizeDateInput(inputStart, false);
  let rangeEnd = normalizeDateInput(inputEnd, true);

  if (incremental) {
    const latestByCrt = await Skin.findOne({ crt_time: { $gt: '' } })
      .sort({ crt_time: -1 })
      .lean();
    const latestByTest = !latestByCrt
      ? await Skin.findOne({ testTime: { $gt: '' } }).sort({ testTime: -1 }).lean()
      : null;
    const latest = latestByCrt?.crt_time || latestByTest?.testTime || null;
    if (!rangeStart && latest) {
      const latestDate = parseDateInput(latest);
      if (latestDate) {
        // Nhích lên 1 phút để tránh lấy trùng bản ghi đã có.
        rangeStart = formatDateTime(new Date(latestDate.getTime() + 60 * 1000));
      }
    }
    if (!rangeEnd) rangeEnd = formatDateTime(new Date());
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

    return res.json({
      success: true,
      saved: save,
      upserts: save ? upserts : 0,
      newCount: save ? newCount : 0,
      updatedCount: save ? updatedCount : 0,
      unchangedCount: save ? unchangedCount : 0,
      total: items.length,
      range: rangeStart && rangeEnd ? { start: rangeStart, end: rangeEnd } : null,
      incremental,
      stats: {
        dataTimeRange: displayDataTimeRange
      },
      data: items
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
 *   - sortBy: sắp xếp theo field (default: scrapedAt)
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
    const rangeField = (req.query.rangeField || req.query.field || 'scrapedAt').trim();
    const allowedFields = ['scrapedAt', 'crt_time'];
    const normalizedRangeField = allowedFields.includes(rangeField) ? rangeField : 'scrapedAt';
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

    // Get total count
    const total = await Skin.countDocuments(query);

    // Get data
    const resolvedSortField = allowedFields.includes(sortByArg) ? sortByArg : normalizedRangeField;
    let dataQuery = Skin.find(query).sort({ [resolvedSortField]: sortOrder });
    if (!(unlimitedRequest)) {
      dataQuery = dataQuery.skip(skip).limit(resolvedLimit);
    }
    const data = await dataQuery.lean();

    let syncState = null;
    let syncKey = null;
    if (rangeStart && rangeEnd) {
      syncKey = rangeKey(rangeStart, rangeEnd);
      syncState = await SyncState.findOne({ key: syncKey }).lean();
      if (shouldTriggerSync(total, syncState, refresh)) {
        syncState = await enqueueSync({
          rangeStart,
          rangeEnd,
          reason: refresh ? 'refresh' : 'cache-miss',
          accessToken: requestToken
        });
      }
    }

    const dataTimeRange = await getDataTimeRange(rangeFilter, normalizedRangeField);
    const fullDataTimeRange = await getDataTimeRange(null, normalizedRangeField);
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
 * GET /api/data/view
 * Stream full set of documents that match the query so the UI can display the exact range.
 */
app.get('/api/data/view', async (req, res) => {
  try {
    const sortByArg = (req.query.sortBy || '').trim();
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
    const inputStart = req.query.start ?? req.query.from ?? req.query.st ?? null;
    const inputEnd = req.query.end ?? req.query.to ?? req.query.ed ?? null;
    const rangeStart = normalizeDateInput(inputStart, false);
    const rangeEnd = normalizeDateInput(inputEnd, true);
    const rangeField = (req.query.rangeField || req.query.field || 'scrapedAt').trim();
    const allowedFields = ['scrapedAt', 'crt_time'];
    const normalizedRangeField = allowedFields.includes(rangeField) ? rangeField : 'scrapedAt';
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

    const effectiveSortField = allowedFields.includes(sortByArg)
      ? sortByArg
      : currentRangeField;
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
    const rangeField = (req.query.rangeField || req.query.field || 'scrapedAt').trim();
    const allowedFields = ['scrapedAt', 'crt_time'];
    const normalizedRangeField = allowedFields.includes(rangeField) ? rangeField : 'scrapedAt';
    const rangeFilter = buildRangeQuery(rangeStart, rangeEnd, normalizedRangeField);
    const baseMatch = rangeFilter ? { $match: rangeFilter } : null;
    const total = await Skin.countDocuments(rangeFilter || {});
    const byGender = await Skin.aggregate([
      ...(baseMatch ? [baseMatch] : []),
      { $group: { _id: '$gender', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);
    const byAccount = await Skin.aggregate([
      ...(baseMatch ? [baseMatch] : []),
      { $group: { _id: '$account', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 10 }
    ]);
    const byStatus = await Skin.aggregate([
      ...(baseMatch ? [baseMatch] : []),
      { $group: { _id: '$testStatus', count: { $sum: 1 } } },
      { $sort: { count: -1 } }
    ]);

    const oldest = await Skin.findOne(rangeFilter || {}).sort({ [normalizedRangeField]: 1 }).lean();
    const newest = await Skin.findOne(rangeFilter || {}).sort({ [normalizedRangeField]: -1 }).lean();
    const dataTimeRange = await getDataTimeRange(rangeFilter, normalizedRangeField);
    const displayDataTimeRange = formatDataRangeForDisplay(dataTimeRange);
    const lastSync = await SyncState.findOne({ status: 'success' })
      .sort({ lastSuccessAt: -1 })
      .lean();

    res.json({
      success: true,
      stats: {
        total,
        byGender,
        byAccount,
        byStatus,
        oldestRecord: oldest ? oldest.scrapedAt : null,
        newestRecord: newest ? newest.scrapedAt : null,
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
    });
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

    const data = await Skin.find(query).lean();
    const timestamp = new Date().toISOString().split('T')[0];

    if (format === 'csv') {
      if (data.length === 0) {
        return res.status(404).json({ message: 'No data to export' });
      }

      const headers = ['ID', 'Customer Info', 'Gender', 'Device Number', 'Account', 'Test Time', 'Test Status', 'Remarks', 'Image', 'URL'];
      const csvRows = [
        headers.join(','),
        ...data.map(item => [
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
        ].join(','))
      ];

      res.setHeader('Content-Type', 'text/csv');
      res.setHeader('Content-Disposition', `attachment; filename="skin-data-${timestamp}.csv"`);
      res.send(csvRows.join('\n'));
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
      for (const item of items) {
        const hashedKey = crypto.createHash('sha1').update(Skin.keyFor(item)).digest('hex');
        const result = await Skin.updateOne(
          { hashedKey },
          { $set: { ...item, hashedKey, scrapedAt: new Date() } },
          { upsert: true }
        );
        upserts++;
        if (result.upsertedCount && result.upsertedCount > 0) {
          newCount += result.upsertedCount;
        } else if (result.modifiedCount && result.modifiedCount > 0) {
          updatedCount += result.modifiedCount;
        } else {
          unchangedCount += 1;
        }
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
    cron.schedule(cfg.cron, async () => {
      if (scrapingStatus.isRunning) return;
      const latestByCrt = await Skin.findOne({ crt_time: { $gt: '' } })
        .sort({ crt_time: -1 })
        .lean();
      const latestByTest = !latestByCrt
        ? await Skin.findOne({ testTime: { $gt: '' } }).sort({ testTime: -1 }).lean()
        : null;
      const latest = latestByCrt?.crt_time || latestByTest?.testTime || null;
      const latestDate = parseDateInput(latest);
      if (!latestDate) return;
      const rangeStart = formatDateTime(new Date(latestDate.getTime() + 60 * 1000));
      const rangeEnd = formatDateTime(new Date());
      await enqueueSync({ rangeStart, rangeEnd, reason: 'cron' });
    });
    console.log(`⏱️  Cron sync scheduled: ${cfg.cron}`);
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
    console.log(`   GET  /api/data/stats - Get statistics`);
    console.log(`   GET  /api/data/export?format=json|csv - Export data`);
    console.log(`   DELETE /api/data - Delete data`);
    console.log(`\n🔗 Frontend có thể kết nối tại: http://localhost:${PORT}`);
  });
})();
