import 'dotenv/config';
import fs from 'node:fs';
import puppeteer from 'puppeteer';

let forceHeaders = {};
const rawForceHeaders = process.env.FORCE_HEADERS_JSON || '';
if (rawForceHeaders) {
  try {
    const parsed = JSON.parse(rawForceHeaders);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      forceHeaders = parsed;
    }
  } catch (_) {
    forceHeaders = {};
  }
}

const defaultExecPath = typeof puppeteer.executablePath === 'function' ? puppeteer.executablePath() : undefined;
const envExecPath = process.env.PUPPETEER_EXECUTABLE_PATH;
let resolvedExecPath = envExecPath;
if (envExecPath) {
  try {
    fs.accessSync(envExecPath, fs.constants.X_OK);
  } catch (err) {
    console.warn(
      `PUPPETEER_EXECUTABLE_PATH (${envExecPath}) does not exist/is not executable; falling back to Puppeteer default.`
    );
    resolvedExecPath = undefined;
  }
}

export const cfg = {
  targetUrl: process.env.TARGET_URL || 'https://zm.bitmoji-zmlh.com/skinmgr/#/skinmgr/recordsList',
  strategy: (process.env.EXTRACTION_STRATEGY || 'NETWORK').toUpperCase(),
  selectors: {
    list: process.env.LIST_ITEM_SELECTOR || 'table tbody tr',            // Target data rows
    // Correct column mapping based on ACTUAL table structure (11 columns)
    id: process.env.ID_SELECTOR || 'td:nth-child(2)',                    // ID (4933415) - column 2
    picture: process.env.PICTURE_SELECTOR || 'td:nth-child(3) img',      // 检测图片 - column 3
    customerInfo: process.env.CUSTOMER_INFO_SELECTOR || 'td:nth-child(4)', // 客户资料 - column 4
    gender: process.env.GENDER_SELECTOR || 'td:nth-child(5)',            // 性别 - column 5
    deviceNumber: process.env.DEVICE_NUMBER_SELECTOR || 'td:nth-child(6)', // 设备编号 - column 6
    account: process.env.ACCOUNT_SELECTOR || 'td:nth-child(7)',          // 所属账号 - column 7
    testTime: process.env.TEST_TIME_SELECTOR || 'td:nth-child(8)',       // 检测时间 - column 8
    testStatus: process.env.TEST_STATUS_SELECTOR || 'td:nth-child(9)',   // 检测状态 - column 9
    remarks: process.env.REMARKS_SELECTOR || 'td:nth-child(10)',         // 备注 - column 10
    operation: process.env.OPERATION_SELECTOR || 'td:nth-child(11)',     // 操作 - column 11
    // Links
    viewProfileLink: process.env.VIEW_PROFILE_LINK_SELECTOR || 'td:nth-child(4) a', // View profile link
    // Legacy selectors for backward compatibility
    title: process.env.TITLE_SELECTOR || 'td:nth-child(4)',              // Same as customerInfo
    img: process.env.IMAGE_SELECTOR || 'td:nth-child(3) img',            // Same as picture
    link: process.env.LINK_SELECTOR || 'td:nth-child(4) a',              // Same as viewProfileLink
    phone: process.env.PHONE_SELECTOR || 'td:nth-child(2)',              // Same as id for legacy
    device: process.env.DEVICE_SELECTOR || 'td:nth-child(6)'             // Same as deviceNumber
  },
  scroll: {
    steps: Number(process.env.SCROLL_STEPS || 0),
    delayMs: Number(process.env.SCROLL_DELAY_MS || 600)
  },
  mongoUri: process.env.MONGO_URI,
  endpoints: [process.env.SERVER_A_ENDPOINT, process.env.SERVER_B_ENDPOINT].filter(Boolean),
  cron: process.env.CRON_EXPR || '*/10 * * * *',
  headless: String(process.env.HEADLESS || 'true') === 'true',
  navTimeout: Number(process.env.NAV_TIMEOUT_MS || 60000),
  waitUntil: process.env.WAIT_UNTIL || 'networkidle2',
  execPath: resolvedExecPath || defaultExecPath,
  sourceTimezone: process.env.DATA_SOURCE_TIMEZONE || 'Asia/Shanghai',
  displayTimezone: process.env.DATA_DISPLAY_TIMEZONE || 'Asia/Ho_Chi_Minh',
  auth: {
    email: process.env.AUTH_EMAIL,
    username: process.env.AUTH_USERNAME,
    password: process.env.AUTH_PASSWORD,
    clientId: process.env.AUTH_CLIENT_ID || '93dc94c23d83c2ca',
    appType: process.env.AUTH_APP_TYPE || 'zmskin',
    codeToken: process.env.AUTH_CODE_TOKEN || '-1',
    useApiLogin: String(process.env.AUTH_USE_API_LOGIN ?? 'true') === 'true',
    preferUiLogin: String(process.env.AUTH_PREFER_UI_LOGIN ?? 'false') === 'true'
  },
  forceAccessToken: process.env.FORCE_ACCESS_TOKEN || '',
  forceLocale: process.env.FORCE_LOCALE || '',
  forceLanguage: process.env.FORCE_LANGUAGE || '',
  forceWeidu: process.env.FORCE_WEIDU || '',
  forceHeaders
};
