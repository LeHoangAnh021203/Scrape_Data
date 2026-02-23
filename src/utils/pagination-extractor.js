// Advanced pagination extractor - Lấy dữ liệu từ tất cả các trang
export async function extractAllPages(page, options = {}) {
  console.log('🔍 Starting pagination extraction...');
  const delay = ms => new Promise(r => setTimeout(r, ms));
  const collectedData = [];
  let rawCount = 0;
  let dupCount = 0;
  const seenKeys = new Set();
  let apiConfig = null;
  let apiMeta = null;
  let firstListLength = null;
  const clearDateFilters = options.clearDateFilters ??
    String(process.env.CLEAR_DATE_FILTERS || 'false') === 'true';
  const debugApiRequests = options.debugApiRequests ??
    String(process.env.DEBUG_API_REQUESTS || 'false') === 'true';
  const debugEmptyPages = options.debugEmptyPages ??
    String(process.env.DEBUG_EMPTY_PAGES || 'false') === 'true';
  const onAuthExpired = options.onAuthExpired || null;
  const maxAuthRetries = Number(options.maxAuthRetries ?? process.env.MAX_AUTH_RETRIES ?? 2);
  const reauthEveryPages = Number(options.reauthEveryPages ?? process.env.REAUTH_EVERY_PAGES ?? 50);
  const forceDateOffsetMinutes = Number(options.forceDateOffsetMinutes ?? process.env.FORCE_DATE_OFFSET_MINUTES ?? 0);
  const forcePageSize = Number(options.forcePageSize ?? process.env.FORCE_PAGE_SIZE ?? 0);
  const maxFetchRetries = Number(options.maxFetchRetries ?? process.env.MAX_FETCH_RETRIES ?? 5);
  const useNodeFetch = options.useNodeFetch ??
    String(process.env.USE_NODE_FETCH ?? 'true') === 'true';
  const enrichGoods = options.enrichGoods ??
    String(process.env.ENRICH_GOODS ?? 'true') === 'true';
  let emptyPageStop = Number(options.emptyPageStop ?? process.env.EMPTY_PAGE_STOP ?? 5);
  const pageDelayMs = Number(options.pageDelayMs ?? process.env.PAGE_DELAY_MS ?? 800);
  const errorDelayMs = Number(options.errorDelayMs ?? process.env.ERROR_DELAY_MS ?? 2000);
  if (!Number.isFinite(emptyPageStop) || emptyPageStop < 1) emptyPageStop = 3;
  const forceHeaders = options.forceHeaders && typeof options.forceHeaders === 'object' && !Array.isArray(options.forceHeaders)
    ? options.forceHeaders
    : null;
  if (debugApiRequests) {
    console.log(`🧪 useNodeFetch=${useNodeFetch}`);
  }
  const forceDateRange = options.forceDateRange ??
    String(process.env.FORCE_DATE_RANGE || 'false') === 'true';
  const bootstrapApiConfig = options.bootstrapApiConfig || null;
  const chunkDateRange = options.chunkDateRange ??
    String(process.env.CHUNK_DATE_RANGE || 'false') === 'true';
  const chunkDateStart = options.chunkDateStart ||
    process.env.CHUNK_DATE_START ||
    process.env.FORCE_DATE_START ||
    '1970-01-01 00:00';
  const chunkDateEnd = options.chunkDateEnd ||
    process.env.CHUNK_DATE_END ||
    process.env.FORCE_DATE_END ||
    '2099-12-31 23:59';
  const forceDateStart = options.forceDateStart ||
    process.env.FORCE_DATE_START ||
    '1970-01-01 00:00';
  const forceDateEnd = options.forceDateEnd ||
    process.env.FORCE_DATE_END ||
    '2099-12-31 23:59';
  const startKeys = [
    'st',
    'starttime',
    'startdate',
    'begintime',
    'begindate',
    'testtimestart',
    'testtimebegin',
    'fromdate',
    'datefrom',
    'timefrom',
    'start'
  ];
  const endKeys = [
    'ed',
    'endtime',
    'enddate',
    'finishtime',
    'finishdate',
    'testtimeend',
    'testtimefinish',
    'todate',
    'dateto',
    'timeto',
    'end'
  ];

  const parsePayload = (postData) => {
    if (!postData) return null;
    try {
      return JSON.parse(postData);
    } catch (_) {
      try {
        const params = new URLSearchParams(postData);
        return Object.fromEntries(params.entries());
      } catch (_) {
        return null;
      }
    }
  };

  const findKey = (obj, candidates) => {
    if (!obj) return null;
    for (const key of candidates) {
      if (Object.prototype.hasOwnProperty.call(obj, key)) return key;
    }
    return null;
  };

  const sanitizePayload = (payload) => {
    if (!payload || typeof payload !== 'object') return payload;
    if (!clearDateFilters) return payload;

    const dateKeys = new Set([
      'starttime',
      'endtime',
      'startdate',
      'enddate',
      'begintime',
      'finishtime',
      'begindate',
      'finishdate',
      'testtimestart',
      'testtimeend',
      'testtimebegin',
      'testtimefinish',
      'fromdate',
      'todate',
      'datefrom',
      'dateto',
      'timefrom',
      'timeto',
      'st',
      'ed',
      'start',
      'end'
    ]);

    const sanitized = { ...payload };
    const removed = [];
    for (const key of Object.keys(sanitized)) {
      const lower = key.toLowerCase();
      if (dateKeys.has(lower)) {
        removed.push(key);
        delete sanitized[key];
      }
    }

    if (removed.length > 0) {
      console.log(`🧹 CLEAR_DATE_FILTERS enabled, removed keys: ${removed.join(', ')}`);
    }

    return sanitized;
  };

  const readPayloadDate = (payload, keys) => {
    if (!payload || typeof payload !== 'object') return null;
    for (const key of keys) {
      if (payload[key]) return payload[key];
    }
    return null;
  };

  const readMetaDate = (meta, keys) => {
    if (!meta || typeof meta !== 'object') return null;
    for (const key of keys) {
      if (meta[key]) return meta[key];
    }
    return null;
  };

  const parseDateTime = (value) => {
    const [datePart, timePart = '00:00'] = String(value).split(' ');
    const [y, m, d] = datePart.split('-').map(Number);
    const [hh = 0, mm = 0] = timePart.split(':').map(Number);
    return new Date(y, m - 1, d, hh, mm, 0, 0);
  };

  const formatDateTime = (date) => {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
  };

  const applyOffsetToDate = (date) => {
    if (!date || !forceDateOffsetMinutes) {
      return date;
    }
    const offsetDate = new Date(date.getTime());
    offsetDate.setMinutes(offsetDate.getMinutes() + forceDateOffsetMinutes);
    return offsetDate;
  };

  const formatWithOffset = (value) => {
    if (!value) return value;
    const date = typeof value === 'string' ? parseDateTime(value) : value;
    if (!date || Number.isNaN(date.getTime())) return value;
    return formatDateTime(applyOffsetToDate(date));
  };

  const applyForcedDateRange = (payload) => {
    if (!payload || typeof payload !== 'object' || !forceDateRange) return payload;
    const updated = { ...payload };
    const startValue = formatWithOffset(forceDateStart) ?? forceDateStart;
    const endValue = formatWithOffset(forceDateEnd) ?? forceDateEnd;
    let changed = false;
    for (const key of startKeys) {
      if (key in updated || key === 'st') {
        updated[key] = startValue;
        changed = true;
      }
    }
    for (const key of endKeys) {
      if (key in updated || key === 'ed') {
        updated[key] = endValue;
        changed = true;
      }
    }
    if (changed) {
      console.log(`🗓️ FORCE_DATE_RANGE enabled: ${startValue} -> ${endValue}`);
    }
    return updated;
  };

  const applyDateRange = (payload, start, end) => {
    if (!payload || typeof payload !== 'object') return payload;
    const updated = { ...payload };
    const startValue = formatWithOffset(start) ?? start;
    const endValue = formatWithOffset(end) ?? end;
    for (const key of startKeys) {
      if (key in updated || key === 'st') updated[key] = startValue;
    }
    for (const key of endKeys) {
      if (key in updated || key === 'ed') updated[key] = endValue;
    }
    return updated;
  };

  const addMonths = (date, count) => {
    const d = new Date(date.getTime());
    d.setMonth(d.getMonth() + count);
    return d;
  };

  const endOfMonth = (date) => {
    const d = new Date(date.getFullYear(), date.getMonth() + 1, 0, 23, 59, 0, 0);
    return d;
  };

  const buildMonthlyChunks = (start, end) => {
    const chunks = [];
    let cursor = new Date(start.getTime());
    while (cursor <= end) {
      const chunkStart = new Date(cursor.getTime());
      const chunkEnd = endOfMonth(cursor);
      const actualEnd = chunkEnd > end ? end : chunkEnd;
      chunks.push({
        start: formatDateTime(chunkStart),
        end: formatDateTime(actualEnd)
      });
      cursor = addMonths(cursor, 1);
      cursor.setDate(1);
      cursor.setHours(0, 0, 0, 0);
    }
    return chunks;
  };

  const sanitizeHeaders = (headers) => {
    if (!headers || typeof headers !== 'object') return headers;
    const redacted = { ...headers };
    for (const key of Object.keys(redacted)) {
      const lower = key.toLowerCase();
      if (lower === 'cookie' || lower === 'authorization') {
        redacted[key] = '<redacted>';
      }
    }
    return redacted;
  };

  const buildDedupKey = (item) => {
    if (!item || typeof item !== 'object') return null;
    const primary = item.result_id ?? item.id ?? null;
    if (primary != null && primary !== '') return String(primary);
    const parts = [
      item.code,
      item.device_no,
      item.deviceNumber,
      item.device_number,
      item.account,
      item.user_account,
      item.test_time,
      item.testTime,
      item.created_at,
      item.create_time,
      item.customer_info,
      item.customerInfo
    ].filter(v => v != null && String(v).trim() !== '');
    if (parts.length > 0) return parts.map(v => String(v)).join('|');
    return JSON.stringify(item);
  };

  const pushUnique = (item) => {
    rawCount += 1;
    const key = buildDedupKey(item);
    if (key) {
      if (seenKeys.has(key)) {
        dupCount += 1;
        return;
      }
      seenKeys.add(key);
    }
    collectedData.push(item);
  };

  const collectGoodsIds = (value, bucket) => {
    if (!value) return;
    if (Array.isArray(value)) {
      for (const item of value) {
        collectGoodsIds(item, bucket);
      }
      return;
    }
    if (typeof value === 'string') {
      for (const token of value.split(',')) {
        const id = String(token || '').trim();
        if (id) bucket.add(id);
      }
      return;
    }
    if (typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'goods') {
        collectGoodsIds(child, bucket);
        continue;
      }
      if (child && typeof child === 'object') {
        collectGoodsIds(child, bucket);
      }
    }
  };

  try {
    const ensureUiPageSize100 = async () => {
      if (!forcePageSize || forcePageSize !== 100) return false;
      try {
        const changed = await page.evaluate(async () => {
          const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));
          const sizeSelect = document.querySelector('.el-pagination__sizes .el-select');
          if (!sizeSelect) return false;
          sizeSelect.click();
          await sleep(300);
          const options = Array.from(document.querySelectorAll('.el-select-dropdown__item'));
          const option = options.find(opt => opt.textContent && opt.textContent.includes('100'));
          if (!option) return false;
          option.click();
          await sleep(300);
          return true;
        });
        if (changed) {
          await delay(1200);
        }
        return changed;
      } catch (_) {
        return false;
      }
    };

    const triggerApiRequest = async () => {
      // Try to trigger a list reload so we can capture API payload/total
      await ensureUiPageSize100();

      const triggered = await page.evaluate(() => {
        const clickIf = (el) => {
          if (!el) return false;
          el.click();
          return true;
        };
        const clickByText = (texts) => {
          const buttons = Array.from(document.querySelectorAll('button'));
          const found = buttons.find(btn =>
            texts.some(t => btn.textContent && btn.textContent.trim().includes(t))
          );
          return clickIf(found);
        };

        // Try pagination next/prev to force API call
        const next = document.querySelector('.el-pagination .btn-next');
        const prev = document.querySelector('.el-pagination .btn-prev');
        if (next && !next.disabled && !next.classList.contains('disabled')) {
          next.click();
          return 'next';
        }
        if (prev && !prev.disabled && !prev.classList.contains('disabled')) {
          prev.click();
          return 'prev';
        }

        // Try refresh/search buttons
        if (clickByText(['刷新', 'Refresh', 'Tải lại', 'Search', '查询', '搜索'])) return 'button';

        // Try clicking page 1 explicitly
        const firstPage = document.querySelector('.el-pager li.number');
        if (firstPage) {
          firstPage.click();
          return 'page';
        }

        return null;
      });

      if (triggered) {
        await delay(2000);
        if (triggered === 'next') {
          await page.evaluate(() => {
            const prev = document.querySelector('.el-pagination .btn-prev');
            if (prev && !prev.disabled && !prev.classList.contains('disabled')) prev.click();
          });
          await delay(2000);
        }
      } else {
        await delay(1000);
      }
    };

    const responseHandler = async (response) => {
      try {
        const url = typeof response?.url === 'function' ? response.url() : null;
        if (!url || !url.includes('/skinMgrSrv/record/list')) return;

        const headers = typeof response?.headers === 'function' ? response.headers() : {};
        const contentType = headers['content-type'] || '';
        if (!contentType.includes('application/json')) return;

        const data = await response.json().catch(() => null);
        const list = data?.data?.list;
        if (!Array.isArray(list)) return;

        const apiTotal = data?.data?.total ?? data?.data?.totalCount ?? null;
        const apiPageNum = data?.data?.pageNum ?? data?.data?.page ?? null;
        const apiPageSize = data?.data?.pageSize ?? data?.data?.page_size ?? data?.data?.limit ?? list.length;

        if (!apiConfig) {
          const req = response.request();
          const headers = req.headers ? req.headers() : {};
          const parsedPayload = parsePayload(req.postData && req.postData());
          apiConfig = {
            url,
            method: (req.method && req.method()) || 'POST',
            headers: {
              ...(headers || {}),
              ...(forceHeaders || {})
            },
            payload: applyForcedDateRange(sanitizePayload(parsedPayload))
          };
          if (Array.isArray(list) && firstListLength == null) {
            firstListLength = list.length;
          }
          if (debugApiRequests) {
            console.log('🧾 API request URL:', apiConfig.url);
            console.log('🧾 API request method:', apiConfig.method);
            console.log('🧾 API request headers:', sanitizeHeaders(apiConfig.headers));
          }
          if (apiConfig.payload) {
            console.log('🧾 API payload (first request):', apiConfig.payload);
          } else {
            console.log('🧾 API payload (first request): <empty>');
          }
        }

        if (!apiMeta) {
          apiMeta = {
            total: apiTotal,
            pageNum: apiPageNum,
            pageSize: apiPageSize
          };
        }
        if (debugApiRequests && data?.data) {
          const dataKeys = Object.keys(data.data || {});
          console.log('🧾 API response data keys:', dataKeys);
          if (data?.data?.filter || data?.data?.query || data?.data?.params) {
            console.log('🧾 API response filter/meta:', {
              filter: data.data.filter,
              query: data.data.query,
              params: data.data.params
            });
          }
        }

        console.log(
          `✅ API /skinMgrSrv/record/list: +${list.length} items | collected=${collectedData.length}` +
          (apiTotal != null ? ` | apiTotal=${apiTotal}` : '')
        );
      } catch (_) {
        // Ignore errors
      }
    };

    const refreshApiConfig = async () => {
      const prevConfig = apiConfig;
      const prevMeta = apiMeta;
      apiConfig = null;
      apiMeta = null;
      page.on('response', responseHandler);
      try {
        await triggerApiRequest();
        const waitStart = Date.now();
        while (!apiConfig && Date.now() - waitStart < 20000) {
          await delay(pageDelayMs);
        }
      } catch (e) {
        console.log('⚠️  Failed to refresh API config:', e.message);
      } finally {
        page.off('response', responseHandler);
      }
      if (!apiConfig && prevConfig) {
        apiConfig = prevConfig;
        apiMeta = prevMeta;
        return prevConfig;
      }
      return apiConfig;
    };

    page.on('response', responseHandler);

    await triggerApiRequest();

    // Wait for the first API response to capture config/total
    const waitStart = Date.now();
    while (!apiConfig && Date.now() - waitStart < 20000) {
      await delay(pageDelayMs);
    }

    page.off('response', responseHandler);

    if ((!apiConfig || !apiMeta) && bootstrapApiConfig?.url) {
      console.log('🧪 Using bootstrap API config');
      try {
        const { default: axios } = await import('axios');
        const bootMethod = (bootstrapApiConfig.method || 'POST').toUpperCase();
        const bootHeaders = {
          ...(bootstrapApiConfig.headers || {}),
          ...(forceHeaders || {})
        };
        const bootContentType = bootstrapApiConfig.contentType || bootHeaders['content-type'] || 'application/x-www-form-urlencoded;charset=UTF-8';
        const bootPayload = applyForcedDateRange(sanitizePayload(bootstrapApiConfig.payload || {}));

        const axiosOptions = {
          method: bootMethod,
          url: bootstrapApiConfig.url,
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': bootContentType,
            ...bootHeaders
          },
          timeout: 30000,
          validateStatus: () => true
        };
        if (bootMethod === 'GET') {
          axiosOptions.params = bootPayload || {};
        } else if (bootContentType.includes('application/json')) {
          axiosOptions.data = bootPayload || {};
        } else {
          const params = new URLSearchParams();
          Object.entries(bootPayload || {}).forEach(([k, v]) => {
            if (v != null) params.set(k, String(v));
          });
          axiosOptions.data = params.toString();
        }

        const res = await axios(axiosOptions);
        const data = res?.data;
        const dataKeys = data && typeof data === 'object' ? Object.keys(data) : [];
        const innerKeys = data?.data && typeof data.data === 'object' ? Object.keys(data.data) : [];
        console.log(`🧪 Bootstrap API status: ${res?.status || 'n/a'}; keys=${dataKeys.join(',') || 'n/a'}; dataKeys=${innerKeys.join(',') || 'n/a'}`);
        if (data?.code && data.code !== 0) {
          console.log(`⚠️  Bootstrap API code=${data.code} msg=${data?.msg || 'n/a'}`);
        }
        const list = data?.data?.list;
        const total = data?.data?.total ?? data?.data?.totalCount ?? null;
        const pageNum = data?.data?.pageNum ?? data?.data?.page ?? null;
        const pageSize = data?.data?.pageSize ?? data?.data?.page_size ?? data?.data?.limit ?? (Array.isArray(list) ? list.length : null);
        if (!total || !pageSize) {
          console.log(`⚠️  Bootstrap missing total/pageSize (total=${total ?? 'n/a'}, pageSize=${pageSize ?? 'n/a'})`);
        }

        apiConfig = {
          url: bootstrapApiConfig.url,
          method: bootMethod,
          headers: bootHeaders,
          payload: bootPayload
        };
        apiMeta = {
          total,
          pageNum,
          pageSize
        };
        if (Array.isArray(list)) {
          for (const item of list) pushUnique(item);
        }
      } catch (err) {
        console.log(`⚠️  Bootstrap API failed: ${err?.message || err}`);
      }
    }

    if (!apiConfig || !apiMeta) {
      console.log('⚠️  Không lấy được API config/total. Trả về dữ liệu đã thu thập.');
      return collectedData;
    }

    const pageKey = findKey(apiConfig.payload, [
      'pageNum',
      'page',
      'pageNo',
      'pageIndex',
      'current',
      'currentPage',
      'page_number',
      'pageNumber'
    ]);
    const sizeKey = findKey(apiConfig.payload, [
      'pageSize',
      'size',
      'limit',
      'page_limit',
      'page_size',
      'rows'
    ]);
    const effectivePageKey = pageKey || 'page';
    const effectiveSizeKey = sizeKey || 'pageSize';

    let needSequentialFetch = false;
    let fallbackPageSize = null;
    let total = apiMeta.total ?? null;
    let pageSize = forcePageSize || (apiMeta.pageSize ?? (sizeKey ? Number(apiConfig.payload?.[sizeKey]) : null));
    const currentPage = apiMeta.pageNum ?? (pageKey ? Number(apiConfig.payload?.[pageKey]) : 1);
    if (!total || !pageSize) {
      fallbackPageSize = forcePageSize || firstListLength || apiMeta?.pageSize || 10;
      console.log('⚠️  Thiếu total/pageSize từ API. Fallback sang sequential fetch.');
      pageSize = fallbackPageSize;
      needSequentialFetch = true;
    }
    let totalPages = total && pageSize ? Math.ceil(total / pageSize) : 0;

  let contentType = apiConfig.headers?.['content-type'] || 'application/json';
  const allowedHeaderKeys = [
    'access_token',
    'access-token',
    'authorization',
    'accept-language',
    'cookie',
    'language',
    'locale',
    'origin',
    'referer',
    'user-agent',
    'x-tid'
  ];
  const getHeaderValue = (headers, key) => {
    if (!headers) return null;
    const target = key.toLowerCase();
    for (const [k, v] of Object.entries(headers)) {
      if (k.toLowerCase() === target) return v;
    }
    return null;
  };
  let baseHeaders = {};
  for (const key of allowedHeaderKeys) {
    if (apiConfig.headers?.[key]) baseHeaders[key] = apiConfig.headers[key];
  }
    let basePayload = applyForcedDateRange(sanitizePayload(apiConfig.payload || {}));
    if (forcePageSize) {
      basePayload[effectiveSizeKey] = forcePageSize;
    }

    const fetchPageRaw = async (pageNum, payloadOverride) => {
    if (!apiConfig || !apiConfig.url) {
        return {
          list: [],
          total: null,
          pageSize: null,
          pageNum: null,
          meta: { code: null, message: 'Missing apiConfig', keys: [], dataKeys: [] }
        };
    }
    const payload = { ...basePayload, ...(payloadOverride || {}) };
    payload[effectivePageKey] = pageNum;
    if (!payload[effectiveSizeKey]) payload[effectiveSizeKey] = pageSize;
    const payloadStart = readPayloadDate(payload, startKeys);
    const payloadEnd = readPayloadDate(payload, endKeys);
    if (payloadStart || payloadEnd) {
      console.log(`📅 Payload range: ${payloadStart || 'n/a'} -> ${payloadEnd || 'n/a'}`);
    }
    const finalPayload = payload;
    if (debugApiRequests && pageNum === 1) {
      console.log('🧾 API payload (page request):', finalPayload);
      console.log(`🧪 Node fetch enabled: ${useNodeFetch}`);
    }

    let attempts = 0;
    let fetchAttempts = 0;
    const fetchViaNode = async () => {
      try {
        const { default: axios } = await import('axios');
        const https = await import('node:https');
        const http = await import('node:http');
        const cookies = await page.cookies();
        const forcedCookieHeader = getHeaderValue(apiConfig.headers, 'cookie');
        let cookieHeader = forcedCookieHeader || cookies.map(c => `${c.name}=${c.value}`).join('; ');
        const headers = {
          accept: 'application/json, text/plain, */*',
          'content-type': contentType,
          referer: getHeaderValue(apiConfig.headers, 'referer') || 'https://zm.bitmoji-zmlh.com/skinmgr/',
          connection: 'keep-alive'
        };
        const originHeader = getHeaderValue(apiConfig.headers, 'origin');
        const acceptLangHeader = getHeaderValue(apiConfig.headers, 'accept-language');
        const userAgentHeader = getHeaderValue(apiConfig.headers, 'user-agent');
        if (originHeader) headers.origin = originHeader;
        if (acceptLangHeader) headers['accept-language'] = acceptLangHeader;
        if (userAgentHeader) headers['user-agent'] = userAgentHeader;
        if (baseHeaders.access_token) headers.access_token = baseHeaders.access_token;
        if (baseHeaders['access-token']) headers['access-token'] = baseHeaders['access-token'];
        if (baseHeaders.authorization) headers.authorization = baseHeaders.authorization;
        if (baseHeaders.locale) headers.locale = baseHeaders.locale;
        if (baseHeaders.language) headers.language = baseHeaders.language;
        if (baseHeaders['x-tid']) {
          const rawTid = String(baseHeaders['x-tid']);
          const tidPrefix = rawTid.includes('-') ? rawTid.split('-')[0] : rawTid;
          headers['x-tid'] = `${tidPrefix}-${Date.now()}`;
        }
        if (cookieHeader && !/access_token=/.test(cookieHeader) && baseHeaders.access_token) {
          const encoded = encodeURIComponent(String(baseHeaders.access_token));
          cookieHeader = `${cookieHeader}; access_token=${encoded}`;
        }
        if (cookieHeader) headers.cookie = cookieHeader;

        const method = (apiConfig.method || 'POST').toUpperCase();
        const axiosOptions = {
          method,
          url: apiConfig.url,
          headers,
          timeout: 30000,
          maxRedirects: 5,
          validateStatus: () => true,
          httpAgent: new http.Agent({ keepAlive: true }),
          httpsAgent: new https.Agent({ keepAlive: true })
        };
        if (method === 'GET') {
          axiosOptions.params = finalPayload || {};
        } else if (contentType.includes('application/json')) {
          axiosOptions.data = finalPayload || {};
        } else {
          const params = new URLSearchParams();
          Object.entries(finalPayload || {}).forEach(([k, v]) => {
            if (v != null) params.set(k, String(v));
          });
          axiosOptions.data = params.toString();
        }
        const res = await axios(axiosOptions);
        if (res?.data != null) return res.data;
        return { __fetchError: `Empty response (status ${res?.status})` };
      } catch (err) {
        const status = err?.response?.status;
        const code = err?.code;
        const message = err?.message || err;
        const details = [];
        if (code) details.push(`code ${code}`);
        if (status) details.push(`status ${status}`);
        return { __fetchError: details.length ? `${message} (${details.join(', ')})` : String(message) };
      }
    };

    while (true) {
      let result;
      const runPageFetch = async () => {
        return page.evaluate(
          async ({ url, method, payload, contentType, headers }) => {
            const resolvedHeaders = { ...(headers || {}) };
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
            resolvedHeaders.access_token ||
            resolvedHeaders['access-token'] ||
            resolvedHeaders.authorization;
          if (token) {
            resolvedHeaders.access_token = token;
          } else {
            delete resolvedHeaders.access_token;
            delete resolvedHeaders['access-token'];
            delete resolvedHeaders.authorization;
          }

          const tid =
            localStorage.getItem('x-tid') ||
            localStorage.getItem('tid') ||
            sessionStorage.getItem('x-tid') ||
            sessionStorage.getItem('tid');
          if (tid) resolvedHeaders['x-tid'] = tid;
          if (resolvedHeaders['x-tid']) {
            const rawTid = String(resolvedHeaders['x-tid']);
            const tidPrefix = rawTid.includes('-') ? rawTid.split('-')[0] : rawTid;
            resolvedHeaders['x-tid'] = `${tidPrefix}-${Date.now()}`;
          }

          const locale =
            localStorage.getItem('locale') ||
            sessionStorage.getItem('locale');
          if (locale && !resolvedHeaders.locale) resolvedHeaders.locale = locale;

          const unsafe = ['cookie', 'referer', 'origin', 'accept-language', 'user-agent', 'accept-encoding'];
          for (const key of Object.keys(resolvedHeaders)) {
            if (unsafe.includes(key.toLowerCase())) {
              delete resolvedHeaders[key];
            }
          }

          const opts = {
            method: method || 'POST',
            headers: resolvedHeaders,
            credentials: 'include'
          };
          if (opts.method.toUpperCase() === 'GET') {
            const u = new URL(url);
            Object.entries(payload || {}).forEach(([k, v]) => {
              if (v != null) u.searchParams.set(k, String(v));
            });
            const res = await fetch(u.toString(), opts);
            return res.json();
          }
          if (!opts.headers['content-type']) {
            opts.headers['content-type'] = contentType;
          }
          if (contentType.includes('application/json')) {
            opts.body = JSON.stringify(payload || {});
          } else {
            const params = new URLSearchParams();
            Object.entries(payload || {}).forEach(([k, v]) => {
                if (v != null) params.set(k, String(v));
              });
              opts.body = params.toString();
            }
            try {
              const res = await fetch(url, opts);
              return res.json();
            } catch (err) {
              return { __fetchError: String(err?.message || err) };
            }
          },
          {
            url: apiConfig.url,
            method: apiConfig.method,
            payload: finalPayload,
            contentType,
            headers: baseHeaders
          }
        );
      };

      if (useNodeFetch) {
        if (debugApiRequests && pageNum === 1) {
          console.log(`🧪 Node fetch page ${pageNum}`);
        }
        result = await fetchViaNode();
        if (result?.__fetchError) {
          const errMessage = String(result.__fetchError);
          if (/ECONNRESET|aborted|terminated/i.test(errMessage)) {
            if (debugApiRequests) {
              console.log('🧪 Node fetch reset; trying browser fetch fallback...');
            }
            try {
              result = await runPageFetch();
            } catch (err) {
              result = { __fetchError: String(err?.message || err) };
            }
          }
        }
        if (result?.__fetchError) {
          fetchAttempts += 1;
          console.log(`⚠️  Fetch failed (attempt ${fetchAttempts}/${maxFetchRetries}): ${result.__fetchError}`);
          if (fetchAttempts <= maxFetchRetries) {
            if (onAuthExpired) {
              try {
                await onAuthExpired();
              } catch (err) {
                console.log(`⚠️  Re-auth failed: ${err?.message || err}`);
              }
              await refreshApiConfig();
            }
            await delay(errorDelayMs * fetchAttempts);
            continue;
          }
          return {
            list: [],
            total: null,
            pageSize: null,
            pageNum: null,
            meta: { code: null, message: result.__fetchError, keys: [], dataKeys: [] }
          };
        }
      } else {
        try {
          result = await runPageFetch();
        } catch (err) {
          const nodeResult = await fetchViaNode();
          if (!nodeResult?.__fetchError) {
            result = nodeResult;
          } else {
            fetchAttempts += 1;
            console.log(`⚠️  Eval failed (attempt ${fetchAttempts}/${maxFetchRetries}): ${err.message}`);
            if (fetchAttempts <= maxFetchRetries) {
              if (onAuthExpired) {
                try {
                  await onAuthExpired();
                } catch (reauthErr) {
                  console.log(`⚠️  Re-auth failed: ${reauthErr?.message || reauthErr}`);
                }
                await refreshApiConfig();
              }
              await delay(errorDelayMs * fetchAttempts);
              continue;
            }
            return {
              list: [],
              total: null,
              pageSize: null,
              pageNum: null,
              meta: { code: null, message: err.message, keys: [], dataKeys: [] }
            };
          }
        }

        if (result?.__fetchError) {
          fetchAttempts += 1;
          console.log(`⚠️  Fetch failed (attempt ${fetchAttempts}/${maxFetchRetries}): ${result.__fetchError}`);
          if (fetchAttempts <= maxFetchRetries) {
            await delay(errorDelayMs * fetchAttempts);
            continue;
          }
          return {
            list: [],
            total: null,
            pageSize: null,
            pageNum: null,
            meta: { code: null, message: result.__fetchError, keys: [], dataKeys: [] }
          };
        }
      }

      if (debugApiRequests && pageNum === 1) {
        console.log('🧾 API payload (page request):', finalPayload);
      }

      const code = result?.code ?? result?.status ?? null;
        const msg = String(result?.msg ?? result?.message ?? '');
        if ((code === 10001 || msg.includes('登录已过期') || /login/i.test(msg)) &&
            onAuthExpired && attempts < maxAuthRetries) {
          if (debugApiRequests) {
            try {
              const authState = await page.evaluate(() => {
                const cookieHasToken = document.cookie.includes('access_token=') ||
                  document.cookie.includes('accessToken=');
                const localHasToken = Boolean(
                  localStorage.getItem('access_token') ||
                  localStorage.getItem('accessToken') ||
                  localStorage.getItem('token')
                );
                const sessionHasToken = Boolean(
                  sessionStorage.getItem('access_token') ||
                  sessionStorage.getItem('accessToken') ||
                  sessionStorage.getItem('token')
                );
                return { cookieHasToken, localHasToken, sessionHasToken };
              });
              console.log('🧪 Auth state before re-login:', authState);
            } catch (_) {}
          }
          attempts += 1;
          console.log('🔐 Session expired, re-authenticating...');
          const refreshed = await onAuthExpired();
          if (refreshed?.headers) {
            const updated = {};
            for (const key of allowedHeaderKeys) {
              if (refreshed.headers[key]) updated[key] = refreshed.headers[key];
            }
            baseHeaders = { ...baseHeaders, ...updated };
            apiConfig.headers = { ...(apiConfig.headers || {}), ...updated };
          }
          await ensureUiPageSize100();
          const refreshedConfig = await refreshApiConfig();
          if (refreshedConfig?.headers) {
            const updated = {};
            for (const key of allowedHeaderKeys) {
              if (refreshedConfig.headers[key]) updated[key] = refreshedConfig.headers[key];
            }
            baseHeaders = { ...baseHeaders, ...updated };
            apiConfig.headers = { ...(apiConfig.headers || {}), ...updated };
            contentType = apiConfig.headers?.['content-type'] || contentType;
            basePayload = applyForcedDateRange(sanitizePayload(apiConfig.payload || {}));
            if (forcePageSize) {
              basePayload[effectiveSizeKey] = forcePageSize;
            }
          }
          continue;
        }

        const data = result?.data || {};
        if (debugApiRequests && pageNum === 1) {
          const metaSource = data?.filter || data?.query || data?.params || null;
          const metaStart = readMetaDate(metaSource, startKeys);
          const metaEnd = readMetaDate(metaSource, endKeys);
          if (metaStart || metaEnd) {
            console.log(`🧭 API meta range: ${metaStart || 'n/a'} -> ${metaEnd || 'n/a'}`);
          } else if (metaSource) {
            console.log('🧭 API meta keys:', Object.keys(metaSource));
          }
        }
        if (code === 10001) {
          console.log('⚠️  API trả code 10001: session expired');
        }
        return {
          list: data?.list || [],
          total: data?.total ?? data?.totalCount ?? null,
          pageSize: data?.pageSize ?? data?.page_size ?? data?.limit ?? null,
          pageNum: data?.pageNum ?? data?.page ?? null,
          meta: debugEmptyPages ? {
            code,
            message: msg || null,
            keys: Object.keys(result || {}),
            dataKeys: Object.keys(data || {})
          } : null
        };
      }
    };

    const fetchSequentialPages = async (pageSizeFallback) => {
      if (!pageSizeFallback) pageSizeFallback = forcePageSize || firstListLength || 10;
      let pageNum = 1;
      let consecutiveEmpty = 0;
      while (consecutiveEmpty < emptyPageStop) {
        const pageResult = await fetchPageRaw(pageNum, { [effectiveSizeKey]: pageSizeFallback });
        const list = Array.isArray(pageResult.list) ? pageResult.list : [];
        if (list.length === 0) {
          consecutiveEmpty += 1;
          await delay(pageDelayMs);
        } else {
          consecutiveEmpty = 0;
          for (const item of list) pushUnique(item);
          if (list.length < pageSizeFallback) {
            break;
          }
        }
        pageNum += 1;
      }
    };

    if (needSequentialFetch) {
      await fetchSequentialPages(fallbackPageSize);
      return collectedData;
    }

    if (chunkDateRange) {
      const startDate = parseDateTime(chunkDateStart);
      const endDate = parseDateTime(chunkDateEnd);
      const chunks = buildMonthlyChunks(startDate, endDate);
      console.log(`🧩 CHUNK_DATE_RANGE enabled: ${chunks.length} month(s)`);

      for (const chunk of chunks) {
        console.log(`📆 Đang lấy dữ liệu: ${chunk.start} -> ${chunk.end}`);
        const chunkPayload = applyDateRange(basePayload, chunk.start, chunk.end);
        const first = await fetchPageRaw(1, chunkPayload);
        if (forcePageSize && first.pageSize && first.pageSize !== forcePageSize) {
          console.log(`⚠️  API trả pageSize=${first.pageSize} (yêu cầu ${forcePageSize}).`);
        }
        let chunkTotal = first.total ?? 0;
        let chunkPageSize = first.pageSize || pageSize;
        let chunkPages = chunkPageSize ? Math.ceil(chunkTotal / chunkPageSize) : 0;
        console.log(
          `🧮 Chunk total=${chunkTotal} pageSize=${chunkPageSize} pages=${chunkPages} firstItems=${Array.isArray(first.list) ? first.list.length : 0}`
        );
        if (chunkTotal === 0) {
          console.log('🧾 Chunk payload (empty):', chunkPayload);
        }

        const addList = (list) => {
          if (!Array.isArray(list)) return;
          for (const item of list) pushUnique(item);
        };

        addList(first.list);
        if (chunkTotal && collectedData.length >= chunkTotal) {
          console.log(`ℹ️  Reached chunkTotal=${chunkTotal}, continuing until empty/short page.`);
        }
        let emptyStreak = 0;
        for (let p = 2; p <= chunkPages; p++) {
          console.log(`📄 Đang gọi API trang ${p}/${chunkPages}...`);
          if (onAuthExpired && reauthEveryPages > 0 && p % reauthEveryPages === 0) {
            console.log(`🔐 Periodic re-auth @ page ${p}`);
            await onAuthExpired();
            await ensureUiPageSize100();
            const refreshedConfig = await refreshApiConfig();
            if (refreshedConfig?.headers) {
              const updated = {};
              for (const key of allowedHeaderKeys) {
                if (refreshedConfig.headers[key]) updated[key] = refreshedConfig.headers[key];
              }
              baseHeaders = { ...baseHeaders, ...updated };
              apiConfig.headers = { ...(apiConfig.headers || {}), ...updated };
              contentType = apiConfig.headers?.['content-type'] || contentType;
              basePayload = applyForcedDateRange(sanitizePayload(apiConfig.payload || {}));
              if (forcePageSize) {
                basePayload[effectiveSizeKey] = forcePageSize;
              }
            }
          }
          const pagePayload = { ...chunkPayload, [effectivePageKey]: p };
          if (!pagePayload[effectiveSizeKey]) pagePayload[effectiveSizeKey] = chunkPageSize;
          const pageResult = await fetchPageRaw(p, pagePayload);
          const pageListLen = Array.isArray(pageResult.list) ? pageResult.list.length : 0;
          const fetchErrorMessage = pageResult?.meta?.message || '';
          const isFetchError = /Failed to fetch|ECONN|timeout|Empty response|aborted|terminated|network/i.test(fetchErrorMessage);
          if (isFetchError) {
            if (debugEmptyPages) {
              console.log(`⚠️  Fetch error page ${p}/${chunkPages}: ${fetchErrorMessage}`);
            }
            await delay(errorDelayMs);
            continue;
          }
          addList(pageResult.list);
          if (pageResult.total != null && Number(pageResult.total) !== Number(chunkTotal)) {
            const prevTotal = chunkTotal;
            chunkTotal = Number(pageResult.total);
            if (!Number.isNaN(chunkTotal) && chunkPageSize) {
              chunkPages = Math.ceil(chunkTotal / chunkPageSize);
            }
            console.log(`🧭 Chunk total updated: ${prevTotal} -> ${chunkTotal} (page ${p})`);
          }
          if (pageResult.pageSize && Number(pageResult.pageSize) !== Number(chunkPageSize)) {
            const prevSize = chunkPageSize;
            const newSize = Number(pageResult.pageSize);
            if (!Number.isNaN(newSize) && newSize > 0) {
              if (forcePageSize && newSize !== forcePageSize) {
                console.log(`⚠️  Server ignored forcePageSize=${forcePageSize}, using ${newSize} for pagination.`);
              }
              chunkPageSize = newSize;
              chunkPages = chunkTotal ? Math.ceil(chunkTotal / chunkPageSize) : chunkPages;
              console.log(`🧭 Chunk pageSize updated: ${prevSize} -> ${chunkPageSize} (page ${p})`);
            }
          }
          if (pageListLen > 0 && pageListLen < chunkPageSize) {
            console.log(`🛑 Page ${p} returned ${pageListLen} < ${chunkPageSize}, stopping this chunk.`);
            break;
          }
          if (!pageResult.list || pageResult.list.length === 0) {
            emptyStreak += 1;
            if (emptyStreak >= emptyPageStop) {
              console.log(`🛑 ${emptyStreak} empty pages in a row, stopping this chunk.`);
              break;
            }
          } else {
            emptyStreak = 0;
          }
          if (chunkTotal && collectedData.length >= chunkTotal) {
            console.log(`ℹ️  Reached chunkTotal=${chunkTotal}, continuing until empty/short page.`);
          }
          if (debugEmptyPages && (!pageResult.list || pageResult.list.length === 0)) {
            console.log(`⚠️  Empty page ${p}/${chunkPages}`, {
              payload: pagePayload,
              total: pageResult.total,
              pageSize: pageResult.pageSize,
              pageNum: pageResult.pageNum,
              meta: pageResult.meta
            });
          }
          await delay(pageDelayMs);
        }
      }
    } else {
      const firstPageCheck = await fetchPageRaw(currentPage, basePayload);
      if (firstPageCheck.total != null && firstPageCheck.total !== total) {
        console.log(`🧭 Override apiTotal ${total ?? 'n/a'} -> ${firstPageCheck.total} (from first page)`);
        total = firstPageCheck.total;
      }
      if (firstPageCheck.pageSize && firstPageCheck.pageSize !== pageSize) {
        console.log(`⚠️  API trả pageSize=${firstPageCheck.pageSize} (yêu cầu ${pageSize}).`);
        if (forcePageSize && firstPageCheck.pageSize !== forcePageSize) {
          console.log(`⚠️  Server ignored forcePageSize=${forcePageSize}, using ${firstPageCheck.pageSize} for pagination.`);
        }
        pageSize = firstPageCheck.pageSize;
        if (basePayload && effectiveSizeKey) {
          basePayload[effectiveSizeKey] = pageSize;
        }
        totalPages = Math.ceil(total / pageSize);
      }
      totalPages = Math.ceil(total / pageSize);
      console.log(`🚀 API báo tổng ${total} records, ${totalPages} trang. Bắt đầu lấy dữ liệu...`);
      if (Array.isArray(firstPageCheck.list) && firstPageCheck.list.length > 0) {
        for (const item of firstPageCheck.list) pushUnique(item);
      }
      if (total && collectedData.length >= total) {
        console.log(`ℹ️  Reached apiTotal=${total}, continuing until empty/short page.`);
      }
      let emptyStreak = 0;
      for (let p = 1; p <= totalPages; p++) {
        if (p === currentPage) continue;
        console.log(`📄 Đang gọi API trang ${p}/${totalPages}...`);
        if (onAuthExpired && reauthEveryPages > 0 && p % reauthEveryPages === 0) {
          console.log(`🔐 Periodic re-auth @ page ${p}`);
          await onAuthExpired();
          await ensureUiPageSize100();
          const refreshedConfig = await refreshApiConfig();
          if (refreshedConfig?.headers) {
            const updated = {};
            for (const key of allowedHeaderKeys) {
              if (refreshedConfig.headers[key]) updated[key] = refreshedConfig.headers[key];
            }
            baseHeaders = { ...baseHeaders, ...updated };
            apiConfig.headers = { ...(apiConfig.headers || {}), ...updated };
            contentType = apiConfig.headers?.['content-type'] || contentType;
            basePayload = applyForcedDateRange(sanitizePayload(apiConfig.payload || {}));
            if (forcePageSize) {
              basePayload[effectiveSizeKey] = forcePageSize;
            }
          }
        }
        const pageResult = await fetchPageRaw(p);
        const pageListLen = Array.isArray(pageResult.list) ? pageResult.list.length : 0;
        const fetchErrorMessage = pageResult?.meta?.message || '';
        const isFetchError = /Failed to fetch|ECONN|timeout|Empty response|aborted|terminated|network/i.test(fetchErrorMessage);
        if (isFetchError) {
          if (debugEmptyPages) {
            console.log(`⚠️  Fetch error page ${p}/${totalPages}: ${fetchErrorMessage}`);
          }
          await delay(errorDelayMs);
          continue;
        }
        if (pageListLen > 0) {
          for (const item of pageResult.list) pushUnique(item);
        }
        if (pageResult.total != null && Number(pageResult.total) !== Number(total)) {
          const prevTotal = total;
          total = Number(pageResult.total);
          if (!Number.isNaN(total) && pageSize) {
            totalPages = Math.ceil(total / pageSize);
          }
          console.log(`🧭 Total updated: ${prevTotal ?? 'n/a'} -> ${total} (page ${p})`);
        }
        if (pageResult.pageSize && Number(pageResult.pageSize) !== Number(pageSize)) {
          const prevSize = pageSize;
          const newSize = Number(pageResult.pageSize);
          if (!Number.isNaN(newSize) && newSize > 0) {
            if (forcePageSize && newSize !== forcePageSize) {
              console.log(`⚠️  Server ignored forcePageSize=${forcePageSize}, using ${newSize} for pagination.`);
            }
            pageSize = newSize;
            if (basePayload && effectiveSizeKey) {
              basePayload[effectiveSizeKey] = pageSize;
            }
            totalPages = total ? Math.ceil(total / pageSize) : totalPages;
            console.log(`🧭 PageSize updated: ${prevSize} -> ${pageSize} (page ${p})`);
          }
        }
        if (pageListLen > 0 && pageListLen < pageSize) {
          console.log(`🛑 Page ${p} returned ${pageListLen} < ${pageSize}, stopping.`);
          break;
        }
        if (!pageResult.list || pageResult.list.length === 0) {
          emptyStreak += 1;
          if (emptyStreak >= emptyPageStop) {
            console.log(`🛑 ${emptyStreak} empty pages in a row, stopping.`);
            break;
          }
        } else {
          emptyStreak = 0;
        }
        if (total && collectedData.length >= total) {
          console.log(`ℹ️  Reached apiTotal=${total}, continuing until empty/short page.`);
        }
        if (debugEmptyPages && (!pageResult.list || pageResult.list.length === 0)) {
          console.log(`⚠️  Empty page ${p}/${totalPages}`, {
            payload: { [effectivePageKey]: p },
            total: pageResult.total,
            pageSize: pageResult.pageSize,
            pageNum: pageResult.pageNum,
            meta: pageResult.meta
          });
        }
        await delay(pageDelayMs);
      }
    }

    if (total != null && collectedData.length !== total) {
      console.log(`🧭 Corrected apiTotal ${total} -> ${collectedData.length} (unique count)`);
      total = collectedData.length;
    }

    if (enrichGoods && collectedData.length > 0 && apiConfig?.url) {
      const goodsMap = new Map();
      const toGoodsUrl = (baseUrl) => {
        const urlObj = new URL(baseUrl);
        urlObj.pathname = '/skinMgrSrv/goods/list';
        urlObj.search = '';
        return urlObj.toString();
      };
      const goodsUrl = toGoodsUrl(apiConfig.url);
      const normalizeGoodsItem = (item) => {
        if (!item || typeof item !== 'object') return null;
        const id = item.id != null ? String(item.id) : '';
        if (!id) return null;
        const pic = item.goods_pic || item.pic || item.image || '';
        const image = pic && !String(pic).startsWith('http')
          ? `https://zm.bitmoji-zmlh.com/fileSvr/get/${pic}`
          : (pic || '');
        return {
          id,
          name: item.goods_name || item.name || item.title || '',
          image,
          price: item.price || item.sale_price || item.goods_price || '',
          category: item.type || item.category || ''
        };
      };
      const parseGoodsResponse = (result) => {
        const data = result?.data || result || {};
        const list = Array.isArray(data?.list)
          ? data.list
          : (Array.isArray(data?.data?.list) ? data.data.list : []);
        const total = data?.total ?? data?.data?.total ?? null;
        const pageSize = data?.pageSize ?? data?.data?.pageSize ?? null;
        return { list, total, pageSize };
      };
      const fetchGoodsPage = async (pageNum = 1, pageSizeValue = 200) => {
        const payload = {
          code: '-1',
          page: String(pageNum),
          pageSize: String(pageSizeValue),
          weidu: 'all'
        };
        try {
          const { default: axios } = await import('axios');
          const params = new URLSearchParams();
          Object.entries(payload).forEach(([k, v]) => {
            if (v != null) params.set(k, String(v));
          });
          const headers = {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/x-www-form-urlencoded;charset=UTF-8',
            referer: getHeaderValue(apiConfig.headers, 'referer') || 'https://zm.bitmoji-zmlh.com/skinmgr/',
            ...(baseHeaders || {})
          };
          const res = await axios({
            method: 'POST',
            url: goodsUrl,
            headers,
            data: params.toString(),
            timeout: 30000,
            validateStatus: () => true
          });
          return parseGoodsResponse(res?.data);
        } catch (err) {
          if (pageNum === 1) {
            console.log(`⚠️  goods/list fetch failed: ${err?.message || err}`);
          }
          return { list: [], total: null, pageSize: null };
        }
      };

      const firstGoodsPage = await fetchGoodsPage(1, 200);
      for (const raw of firstGoodsPage.list || []) {
        const normalized = normalizeGoodsItem(raw);
        if (normalized) goodsMap.set(normalized.id, normalized);
      }
      const goodsTotal = Number(firstGoodsPage.total || 0);
      const goodsPageSize = Number(firstGoodsPage.pageSize || 0);
      if (goodsTotal > 0 && goodsPageSize > 0 && goodsTotal > goodsMap.size) {
        const goodsPages = Math.ceil(goodsTotal / goodsPageSize);
        for (let p = 2; p <= goodsPages; p++) {
          const nextPage = await fetchGoodsPage(p, goodsPageSize);
          for (const raw of nextPage.list || []) {
            const normalized = normalizeGoodsItem(raw);
            if (normalized) goodsMap.set(normalized.id, normalized);
          }
        }
      }

      if (goodsMap.size > 0) {
        for (const item of collectedData) {
          const ids = new Set();
          collectGoodsIds(item?.analysis, ids);
          if (ids.size === 0) {
            const fallback = item?.goods || item?.analysis?.final_result?.goods || null;
            collectGoodsIds(fallback, ids);
          }
          const goodsIds = Array.from(ids);
          if (goodsIds.length === 0) continue;
          item.recommendedGoodsIds = goodsIds;
          item.recommendedGoods = goodsIds
            .map(id => goodsMap.get(id))
            .filter(Boolean);
        }
        console.log(`🛍️  goods/list enriched: catalog=${goodsMap.size}, records=${collectedData.length}`);
      } else {
        console.log('⚠️  goods/list returned empty catalog, skip enrichment');
      }
    }

    console.log(`🎉 Hoàn tất! Tổng cộng: ${collectedData.length} bản ghi.`);
    console.log(`📊 Raw items seen: ${rawCount}`);
    if (dupCount > 0) {
      console.log(`🧾 Duplicates skipped: ${dupCount}`);
    }
    return collectedData;
  } catch (error) {
    console.error('❌ Lỗi trong quá trình extract pagination:', error.message);
    return collectedData;
  }
}

// Extract dữ liệu từ trang hiện tại
async function extractCurrentPageData(page) {
  try {
    const data = await page.evaluate(() => {
      const rows = document.querySelectorAll('table tbody tr');
      const results = [];

      rows.forEach(row => {
        try {
          const cells = row.querySelectorAll('td');
          if (cells.length < 6) return;

          const id = cells[1]?.textContent?.trim() || '';
          const picture = row.querySelector('td:nth-child(3) img')?.src || '';
          const customerInfo = cells[3]?.textContent?.trim() || '';
          const gender = cells[4]?.textContent?.trim() || '';
          const deviceNumber = cells[5]?.textContent?.trim() || '';
          const account = cells[6]?.textContent?.trim() || '';
          const testTime = cells[7]?.textContent?.trim() || '';
          const testStatus = cells[8]?.textContent?.trim() || '';
          const remarks = cells[9]?.textContent?.trim() || '';
          const viewLink = row.querySelector('td:nth-child(4) a')?.href || '';

          results.push({
            id,
            title: customerInfo || `Device ${deviceNumber}`,
            image: picture,
            url: viewLink,
            sourceId: `${id}_${deviceNumber}_${account}`,
            customerInfo,
            gender,
            deviceNumber,
            account,
            testTime,
            testStatus,
            remarks,
            operation: cells[10]?.textContent?.trim() || '',
            viewProfileLink: viewLink
          });
        } catch (e) {
          // Skip error rows
        }
      });

      return results;
    });

    return data;
  } catch (error) {
    console.error('❌ Error extracting current page data:', error.message);
    return [];
  }
}

// Normalize dữ liệu từ API response
// NOTE: Trước đây có normalizeApiData() để map về schema rút gọn.
// Hiện tại cần trả về JSON đầy đủ giống file export nên không normalize nữa.
