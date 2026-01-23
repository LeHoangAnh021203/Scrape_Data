// Two strategies: DOM-based (selectors) and Network-based (capture JSON)

export async function extractViaDOM(page, selectors) {
  // Ensure list exists before reading
  await page.waitForSelector(selectors.list, { timeout: 15000 });
  const items = await page.$$eval(selectors.list, (rows, sel) => {
    function pick(el, selector, attr) {
      const node = selector ? el.querySelector(selector) : el;
      if (!node) return '';
      return attr ? node.getAttribute(attr) || '' : (node.textContent || '').trim();
    }
    return rows.map(el => ({
      // Core fields matching the ACTUAL table structure (10 columns)
      id: pick(el, sel.id), // ID (4932530)
      picture: pick(el, sel.picture, 'src'), // Picture thumbnail
      customerInfo: pick(el, sel.customerInfo), // Customer Information
      gender: pick(el, sel.gender), // gender (female/male)
      deviceNumber: pick(el, sel.deviceNumber), // Device number (S25F9FDD)
      account: pick(el, sel.account), // Account (midtown@facewashfox.com)
      testTime: pick(el, sel.testTime), // Test Time (2025-09-13 13:13:17)
      testStatus: pick(el, sel.testStatus), // Test Status (Success)
      remarks: pick(el, sel.remarks), // Remarks (Mark)
      operation: pick(el, sel.operation), // Operation (View Details, Delete, etc.)
      // Links
      viewProfileLink: pick(el, sel.viewProfileLink, 'href'), // View profile link
      // Legacy fields for backward compatibility
      title: pick(el, sel.customerInfo), // Same as customerInfo
      image: pick(el, sel.picture, 'src'), // Same as picture
      url: pick(el, sel.viewProfileLink, 'href'), // Same as viewProfileLink
      phone: pick(el, sel.id), // Same as id for legacy
      device: pick(el, sel.deviceNumber), // Same as deviceNumber
      // Generate sourceId
      sourceId: `${pick(el, sel.id)}_${pick(el, sel.deviceNumber)}_${pick(el, sel.account)}`,
      type: 'reports_item'
    })).filter(x => x.id || x.customerInfo || x.deviceNumber); // Filter out empty rows
  }, selectors);
  return items;
}

export async function extractViaNetwork(page) {
  const collected = [];
  const seen = new Set();

  function tryCollectJson(url, json) {
    if (!json) return;
    
    // Specific handling for known API endpoints
    if (url.includes('/skinMgrSrv/goods/list') && json.list) {
      console.log(`📦 Found goods list with ${json.list.length} items`);
      for (const item of json.list) {
        const title = item.goods_name || item.name || '';
        const image = item.goods_pic ? `https://zm.bitmoji-zmlh.com/fileSvr/get/${item.goods_pic}` : '';
        const url = item.url || '';
        const sourceId = String(item.id || '');
        const key = `${title}|${image}|${url}|${sourceId}`;
        if (!seen.has(key) && (title || image || url || sourceId)) {
          collected.push({ 
            title, 
            image, 
            url, 
            sourceId,
            price: item.price || '',
            type: 'goods'
          });
          seen.add(key);
        }
      }
    }
    
    if (url.includes('/skinMgrSrv/record/list') && json.data && json.data.list) {
      console.log(`📊 Found records list with ${json.data.list.length} items`);
      for (const item of json.data.list) {
        const title = `Record ${item.code || item.id}`;
        const image = item.image || '';
        const url = item.url || '';
        const sourceId = String(item.id || item.result_id || '');
        const key = `${title}|${image}|${url}|${sourceId}`;
        if (!seen.has(key) && (title || image || url || sourceId)) {
          collected.push({ 
            title, 
            image, 
            url, 
            sourceId,
            code: item.code || '',
            type: 'record'
          });
          seen.add(key);
        }
      }
    }
    
    // Generic handling for other arrays
    const arrays = [];
    if (Array.isArray(json)) arrays.push(json);
    else if (json && typeof json === 'object') {
      for (const v of Object.values(json)) if (Array.isArray(v)) arrays.push(v);
    }
    for (const arr of arrays) {
      for (const it of arr) {
        const title = it.title || it.name || it.label || it.goods_name || '';
        const image = it.image || it.img || it.thumbnail || it.goods_pic || '';
        const url = it.url || it.link || '';
        const sourceId = String(it.id || it._id || it.key || it.code || '');
        const key = `${title}|${image}|${url}|${sourceId}`;
        if (!seen.has(key) && (title || image || url || sourceId)) {
          collected.push({ title, image, url, sourceId });
          seen.add(key);
        }
      }
    }
  }

  const handler = async (resp) => {
    try {
      const req = resp.request();
      const url = req.url();
      // Only parse likely JSON/XHR endpoints
      const ct = resp.headers()['content-type'] || '';
      if (!(ct.includes('application/json') || url.includes('/api') || url.includes('json') || url.includes('/skinMgrSrv/'))) return;
      const json = await resp.json().catch(() => null);
      tryCollectJson(url, json);
    } catch (_) {}
  };

  page.on('response', handler);

  // Wait a bit to allow XHRs to fire
  await new Promise(resolve => setTimeout(resolve, 2000));

  // Return a snapshot; caller can wait more or scroll before calling
  return collected;
}
