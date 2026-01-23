import puppeteer from 'puppeteer';
import { cfg } from './src/config.js';
import { connectDB, Skin } from './src/db.js';
import { fanOut } from './src/services.js';
import { extractViaDOM, extractViaNetwork } from './src/utils/extractors.js';
import { extractTableData } from './src/utils/table-extractor.js';
import { autoScroll } from './src/utils/scroll.js';
import crypto from 'node:crypto';

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

async function handleAuthentication(page) {
  // Kiểm tra xem có cần đăng nhập không
  const loginSelectors = [
    'input[placeholder="请输入手机号码或用户名"]',
    'input[placeholder*="username" i]',
    'input[placeholder*="email" i]',
    'input[type="email"]',
    'input[type="text"][placeholder*="email" i]',
    'input[type="text"][placeholder*="username" i]',
    'input[name="email"]',
    'input[name="username"]',
    'input[name="login"]'
  ];
  
  let needsLogin = false;
  for (const selector of loginSelectors) {
    try {
      await page.waitForSelector(selector, { timeout: 5000 });
      needsLogin = true;
      console.log(`✅ Found login field: ${selector}`);
      break;
    } catch (e) {
      // Continue checking other selectors
    }
  }
  
  if (needsLogin && cfg.auth) {
    console.log('🔐 Detected login form, attempting authentication...');
    
    try {
      // Tìm và điền email/username
      const emailSelectors = [
        'input[placeholder="请输入手机号码或用户名"]',
        'input[placeholder*="username" i]',
        'input[placeholder*="email" i]',
        'input[type="email"]',
        'input[type="text"][placeholder*="email" i]',
        'input[name="email"]',
        'input[name="username"]',
        'input[name="login"]'
      ];
      
      for (const selector of emailSelectors) {
        try {
          await page.type(selector, cfg.auth.email || cfg.auth.username);
          console.log(`✅ Email/Username entered in: ${selector}`);
          break;
        } catch (e) {
          // Try next selector
        }
      }
      
      // Tìm và điền password
      const passwordSelectors = [
        'input[placeholder="请输入密码"]',
        'input[type="password"]',
        'input[name="password"]'
      ];
      
      for (const selector of passwordSelectors) {
        try {
          await page.type(selector, cfg.auth.password);
          console.log(`✅ Password entered in: ${selector}`);
          break;
        } catch (e) {
          // Try next selector
        }
      }
      
      // Tìm và click nút đăng nhập
      const loginButtonSelectors = [
        'button:contains("登录")',
        'button:contains("Login")',
        'button:contains("Sign in")',
        'button:contains("Đăng nhập")',
        'button[type="submit"]',
        'input[type="submit"]',
        '.login-btn',
        '.signin-btn'
      ];
      
      for (const selector of loginButtonSelectors) {
        try {
          await page.click(selector);
          console.log(`✅ Login button clicked: ${selector}`);
          break;
        } catch (e) {
          // Try next selector
        }
      }
      
      // Đợi đăng nhập thành công
      await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });
      console.log('✅ Authentication successful');
      
    } catch (error) {
      console.error('❌ Authentication failed:', error.message);
      throw error;
    }
  }
}

async function persist(items) {
  if (!items.length) return 0;
  let upserts = 0;
  for (const it of items) {
    const hashedKey = crypto.createHash('sha1').update(Skin.keyFor(it)).digest('hex');
    await Skin.updateOne(
      { hashedKey },
      { $set: { ...it, hashedKey, scrapedAt: new Date() } },
      { upsert: true }
    );
    upserts++;
  }
  return upserts;
}

async function runOnce() {
  console.log('\n🔎 Start scrape @', new Date().toISOString());
  const browser = await launchBrowser();
  const page = await browser.newPage();

  try {
    await navigate(page, cfg.targetUrl);
    
    // Handle authentication if needed
    await handleAuthentication(page);

    // If the page is an infinite list, scroll to trigger XHRs / DOM fill
    await autoScroll(page, cfg.scroll.steps, cfg.scroll.delayMs);

    let items = [];
    if (cfg.strategy === 'DOM') {
      // Try table extraction first
      items = await extractTableData(page);
      if (items.length === 0) {
        // Fallback to original DOM extraction
        items = await extractViaDOM(page, cfg.selectors);
      }
    } else {
      // NETWORK: wait for initial data to load, then extract
      console.log('⏳ Waiting for API calls to complete...');
      await new Promise(resolve => setTimeout(resolve, 5000)); // Wait 5 seconds for initial data
      
      const initial = await extractViaNetwork(page);
      console.log(`📦 Initial extraction: ${initial.length} items`);
      
      // Scroll to trigger more data loading
      await autoScroll(page, Math.max(2, Math.floor(cfg.scroll.steps / 2)), cfg.scroll.delayMs);
      
      // Wait a bit more for additional data
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const more = await extractViaNetwork(page);
      console.log(`📦 Additional extraction: ${more.length} items`);
      
      items = [...initial, ...more];
    }

    // Deduplicate by forming a key on the app side
    const seen = new Set();
    items = items.filter(x => {
      const k = `${x.title}|${x.image}|${x.url}|${x.sourceId || ''}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });

    console.log(`📦 Extracted ${items.length} items`);

    // Persist
    const upserts = await persist(items);
    console.log(`💾 Upserted ${upserts} records`);

    // Fan-out
    await fanOut(cfg.endpoints, items);
    console.log('✅ Done');
  } catch (e) {
    console.error('❌ Run error:', e.message);
  } finally {
    await page.close().catch(() => {});
    await browser.close().catch(() => {});
  }
}

// Continuous scraping function
async function runContinuous() {
  console.log('🚀 Starting CONTINUOUS scraper...');
  console.log('📋 Configuration:');
  console.log('- Target URL:', cfg.targetUrl);
  console.log('- Strategy:', cfg.strategy);
  console.log('- Interval: 30 seconds');
  console.log('- Press Ctrl+C to stop');
  
  await connectDB(cfg.mongoUri);
  
  // Run immediately
  await runOnce();
  
  // Then run every 30 seconds
  setInterval(async () => {
    try {
      await runOnce();
    } catch (error) {
      console.error('❌ Continuous run error:', error.message);
    }
  }, 30000); // 30 seconds
}

// Handle graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Stopping continuous scraper...');
  process.exit(0);
});

runContinuous();

