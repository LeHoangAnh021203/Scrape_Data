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

// Scraping function with fixed login
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
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log('🔐 Logging in with correct selectors...');
    // Click on the first dropdown to select login type
    await page.click('input[placeholder="请选择"]');
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Type username in the second input
    await page.type('input[placeholder="请输入手机号码或用户名"]', 'admin@facewashfox.com');
    
    // Type password in the third input
    await page.type('input[placeholder="请输入密码"]', 'rW7SEu8J80R');
    
    // Click login button
    await page.click('button.el-button.btn1.el-button--primary');
    
    console.log('⏳ Waiting for login to complete...');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log('🌐 Navigating to records list...');
    await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/#/skinmgr/recordsList', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Extract data
    console.log('🔍 Extracting data...');
    const tables = await page.$$('table');
    console.log(`Found ${tables.length} tables`);
    
    const extractedData = [];
    
    // Find table with data (usually table 2)
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      const rows = await table.$$('tr');
      console.log(`Table ${i + 1}: ${rows.length} rows`);
      
      if (rows.length > 1) {
        console.log(`Using table ${i + 1} for data extraction`);
        
        // Extract all data rows (skip header row)
        for (let rowIndex = 1; rowIndex < rows.length; rowIndex++) {
          const row = rows[rowIndex];
          const cells = await row.$$('td');
          
          if (cells.length >= 11) {
            try {
              const id = await cells[1].evaluate(el => el.textContent?.trim() || '');
              const picture = await cells[2].$eval('img', el => el.src || '');
              const customerInfo = await cells[3].evaluate(el => el.textContent?.trim() || '');
              const gender = await cells[4].evaluate(el => el.textContent?.trim() || '');
              const deviceNumber = await cells[5].evaluate(el => el.textContent?.trim() || '');
              const account = await cells[6].evaluate(el => el.textContent?.trim() || '');
              const testTime = await cells[7].evaluate(el => el.textContent?.trim() || '');
              const testStatus = await cells[8].evaluate(el => el.textContent?.trim() || '');
              const remarks = await cells[9].evaluate(el => el.textContent?.trim() || '');
              const operation = await cells[10].evaluate(el => el.textContent?.trim() || '');
              let viewProfileLink = '';
              try {
                const linkElement = await cells[3].$('a');
                if (linkElement) {
                  viewProfileLink = await linkElement.evaluate(el => el.href || '');
                }
              } catch (e) {
                // No link found, that's okay
              }
              
              if (id) {
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
              console.log(`Error extracting row ${rowIndex}: ${e.message}`);
            }
          }
        }
        break; // Use the first table with data
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
  console.log('🚀 Starting real scraping with fixed login...');
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
  console.log(`🚀 Working Dashboard running at http://localhost:${PORT}`);
  console.log('📊 Open your browser and navigate to http://localhost:3000');
  console.log('🔍 This dashboard will scrape REAL data with fixed login');
});

// Auto-scrape on startup
setTimeout(async () => {
  console.log('🚀 Auto-starting real scraping...');
  await scrapeData();
}, 2000);
