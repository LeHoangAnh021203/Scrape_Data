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
    
    console.log('🔍 Extracting data...');
    
    // Find all tables
    const tables = await page.$$('table');
    console.log(`Found ${tables.length} tables`);
    
    let dataTable = null;
    let maxRows = 0;
    
    for (let i = 0; i < tables.length; i++) {
      const rows = await tables[i].$$('tbody tr');
      console.log(`Table ${i + 1}: ${rows.length} rows`);
      
      if (rows.length > maxRows) {
        maxRows = rows.length;
        dataTable = tables[i];
      }
    }
    
    if (dataTable && maxRows > 1) {
      console.log(`Using table with ${maxRows} rows for data extraction`);
      
      const rows = await dataTable.$$('tbody tr');
      const extractedData = [];
      
      // Skip header row, start from index 1
      for (let i = 1; i < rows.length; i++) {
        try {
          const row = rows[i];
          
          // Extract data from each cell
          const cells = await row.$$('td');
          if (cells.length >= 11) {
            const id = await cells[1].evaluate(el => el.textContent?.trim() || '');
            const picture = await cells[2].evaluate(el => {
              const img = el.querySelector('img');
              return img ? img.src : '';
            });
            const customerInfo = await cells[3].evaluate(el => el.textContent?.trim() || '');
            const gender = await cells[4].evaluate(el => el.textContent?.trim() || '');
            const deviceNumber = await cells[5].evaluate(el => el.textContent?.trim() || '');
            const account = await cells[6].evaluate(el => el.textContent?.trim() || '');
            const testTime = await cells[7].evaluate(el => el.textContent?.trim() || '');
            const testStatus = await cells[8].evaluate(el => el.textContent?.trim() || '');
            const remarks = await cells[9].evaluate(el => el.textContent?.trim() || '');
            const operation = await cells[10].evaluate(el => el.textContent?.trim() || '');
            
            // Try to get view profile link
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
          }
        } catch (e) {
          console.error(`Error extracting row ${i}:`, e.message);
        }
      }
      
      scrapedData = extractedData;
      stats.totalItems = extractedData.length;
      stats.lastUpdate = new Date().toISOString();
      stats.totalRequests++;
      
      console.log(`📊 Extracted ${extractedData.length} items`);
    } else {
      console.log('❌ No data table found');
    }
    
  } catch (error) {
    console.error('❌ Scraping error:', error.message);
  } finally {
    await browser.close();
  }
}

// API Routes
app.get('/api/data', (req, res) => {
  res.json({
    success: true,
    data: scrapedData,
    stats: stats
  });
});

app.post('/api/scrape', async (req, res) => {
  try {
    await scrapeData();
    res.json({
      success: true,
      data: scrapedData,
      stats: stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: error.message
    });
  }
});

app.post('/api/clear', (req, res) => {
  scrapedData = [];
  stats = {
    totalRequests: 0,
    totalItems: 0,
    lastUpdate: null,
    successRate: 100
  };
  res.json({ success: true });
});

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Simple Working Dashboard running at http://localhost:${PORT}`);
  console.log('📊 Open your browser and navigate to http://localhost:3000');
  console.log('🔍 This dashboard will scrape REAL data with fixed login');
  
  // Auto-start scraping once
  console.log('🚀 Auto-starting real scraping...');
  scrapeData().then(() => {
    console.log('✅ Initial scraping completed');
  }).catch(error => {
    console.error('❌ Initial scraping failed:', error.message);
  });
});
