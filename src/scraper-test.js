import puppeteer from 'puppeteer';
import { cfg } from './config.js';
import { extractViaDOM, extractViaNetwork } from './utils/extractors.js';
import { autoScroll } from './utils/scroll.js';

function ua() {
  return 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36';
}

async function launchBrowser() {
  return puppeteer.launch({
    headless: cfg.headless,
    executablePath: cfg.execPath,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-dev-shm-usage'
    ]
  });
}

async function navigate(page, url) {
  await page.setUserAgent(ua());
  await page.setViewport({ width: 1366, height: 850, deviceScaleFactor: 1 });
  await page.setJavaScriptEnabled(true);
  await page.goto(url, { waitUntil: cfg.waitUntil, timeout: cfg.navTimeout });
}

async function runTest() {
  console.log('🔎 Starting test scrape @', new Date().toISOString());
  console.log('Target URL:', cfg.targetUrl);
  console.log('Strategy:', cfg.strategy);
  
  const browser = await launchBrowser();
  const page = await browser.newPage();

  try {
    await navigate(page, cfg.targetUrl);
    console.log('✅ Page loaded successfully');

    // Scroll to trigger content loading
    await autoScroll(page, cfg.scroll.steps, cfg.scroll.delayMs);
    console.log('✅ Scrolling completed');

    let items = [];
    if (cfg.strategy === 'DOM') {
      console.log('📋 Using DOM extraction strategy');
      items = await extractViaDOM(page, cfg.selectors);
    } else {
      console.log('🌐 Using NETWORK extraction strategy');
      const initial = await extractViaNetwork(page);
      await autoScroll(page, Math.max(2, Math.floor(cfg.scroll.steps / 2)), cfg.scroll.delayMs);
      const more = await extractViaNetwork(page);
      items = [...initial, ...more];
    }

    // Deduplicate
    const seen = new Set();
    items = items.filter(x => {
      const k = `${x.title}|${x.image}|${x.url}|${x.sourceId || ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    console.log(`📦 Extracted ${items.length} items`);
    
    if (items.length > 0) {
      console.log('📋 Sample items:');
      items.slice(0, 3).forEach((item, i) => {
        console.log(`  ${i + 1}. Title: ${item.title || 'N/A'}`);
        console.log(`     Image: ${item.image || 'N/A'}`);
        console.log(`     URL: ${item.url || 'N/A'}`);
        console.log(`     Source ID: ${item.sourceId || 'N/A'}`);
        console.log('     ---');
      });
    } else {
      console.log('⚠️  No items extracted. This might be normal if:');
      console.log('   - The page requires authentication');
      console.log('   - The selectors need adjustment');
      console.log('   - The page structure is different than expected');
    }

    console.log('✅ Test completed successfully');
  } catch (e) {
    console.error('❌ Test error:', e.message);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

runTest();
