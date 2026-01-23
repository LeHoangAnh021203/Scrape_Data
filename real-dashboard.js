import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Data store
let scrapedData = [];
let stats = {
  totalRequests: 0,
  totalItems: 0,
  lastUpdate: null,
  successRate: 100
};

// Scraping function
async function scrapeData() {
  const browser = await puppeteer.launch({ 
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    console.log('🌐 Navigating to login page...');
    await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/', { waitUntil: 'networkidle2', timeout: 60000 });
    
    console.log('🔐 Logging in...');
    await page.type('input[type="text"]', 'admin@facewashfox.com');
    await page.type('input[type="password"]', 'rW7SEu8J80R');
    await page.click('button[type="button"]');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log('🌐 Navigating to records list...');
    await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/#/skinmgr/recordsList', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Extract data
    console.log('🔍 Extracting data...');
    const rows = await page.$$('table tbody tr');
    console.log(`Found ${rows.length} rows`);
    
    const extractedData = [];
    for (const row of rows) {
      try {
        const id = await row.$eval('td:nth-child(2)', el => el.textContent?.trim() || '');
        const picture = await row.$eval('td:nth-child(3) img', el => el.src || '');
        const customerInfo = await row.$eval('td:nth-child(4)', el => el.textContent?.trim() || '');
        const gender = await row.$eval('td:nth-child(5)', el => el.textContent?.trim() || '');
        const deviceNumber = await row.$eval('td:nth-child(6)', el => el.textContent?.trim() || '');
        const account = await row.$eval('td:nth-child(7)', el => el.textContent?.trim() || '');
        const testTime = await row.$eval('td:nth-child(8)', el => el.textContent?.trim() || '');
        const testStatus = await row.$eval('td:nth-child(9)', el => el.textContent?.trim() || '');
        const remarks = await row.$eval('td:nth-child(10)', el => el.textContent?.trim() || '');
        const operation = await row.$eval('td:nth-child(11)', el => el.textContent?.trim() || '');
        const viewProfileLink = await row.$eval('td:nth-child(4) a', el => el.href || '');
        
        if (id || customerInfo || deviceNumber) {
          extractedData.push({
            id,
            picture,
            customerInfo,
            gender,
            deviceNumber,
            account,
            testTime,
            testStatus,
            remarks,
            operation,
            viewProfileLink
          });
        }
      } catch (e) {
        // Skip invalid rows
      }
    }
    
    console.log(`📊 Extracted ${extractedData.length} items`);
    
    // Update data store
    scrapedData = extractedData;
    stats.totalRequests++;
    stats.totalItems = extractedData.length;
    stats.lastUpdate = new Date().toISOString();
    
    return { success: true, data: extractedData, stats };
    
  } catch (error) {
    console.error('❌ Scraping error:', error.message);
    return { success: false, message: error.message };
  } finally {
    await browser.close();
  }
}

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/scrape', async (req, res) => {
  console.log('🚀 Starting real scraping...');
  const result = await scrapeData();
  res.json(result);
});

app.get('/api/data', (req, res) => {
  res.json({ data: scrapedData, stats });
});

app.post('/api/clear', (req, res) => {
  scrapedData = [];
  stats = { totalRequests: 0, totalItems: 0, lastUpdate: null, successRate: 100 };
  res.json({ success: true, message: 'Data cleared' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Real Dashboard running at http://localhost:${PORT}`);
  console.log('📊 Open your browser and navigate to http://localhost:3000');
  console.log('🔍 This dashboard will scrape REAL data from the website');
});

// Auto-scrape on startup
setTimeout(async () => {
  console.log('🚀 Auto-starting real scraping...');
  await scrapeData();
}, 2000);