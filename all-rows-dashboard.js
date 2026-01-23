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

// Scraping function that includes ALL rows
async function scrapeData() {
  const browser = await puppeteer.launch({ 
    headless: false, // Show browser for debugging
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    console.log('🌐 Navigating to login page...');
    await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/', { 
      waitUntil: 'networkidle2', 
      timeout: 60000 
    });
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log('🔐 Logging in...');
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
    await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/#/skinmgr/recordsList', { 
      waitUntil: 'networkidle2', 
      timeout: 60000 
    });
    
    // Wait for page to fully load
    await new Promise(resolve => setTimeout(resolve, 8000));
    
    console.log('🔍 Looking for tables...');
    
    // Find all tables
    const tables = await page.$$('table');
    console.log(`Found ${tables.length} tables`);
    
    if (tables.length === 0) {
      console.log('❌ No tables found');
      return [];
    }
    
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
    
    if (dataTable && maxRows > 0) {
      console.log(`Using table with ${maxRows} rows for data extraction`);
      
      const rows = await dataTable.$$('tbody tr');
      const extractedData = [];
      
      // Extract ALL rows including the first one (index 0)
      for (let i = 0; i < rows.length; i++) {
        try {
          const row = rows[i];
          
          // Extract data from each cell
          const cells = await row.$$('td');
          console.log(`Row ${i}: ${cells.length} cells`);
          
          if (cells.length >= 11) {
            // Extract ALL columns (0-10)
            const column0 = await cells[0].evaluate(el => el.textContent?.trim() || '');
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
            
            // Check if this row has valid data (not header)
            if (id && id !== 'ID' && !isNaN(parseInt(id))) {
              extractedData.push({
                rowIndex: i, // Add row index for debugging
                column0,
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
              
              console.log(`✅ Extracted item ${i}: Row ${i}, Column0: "${column0}", ID: ${id}, Time: ${testTime}`);
            } else {
              console.log(`⚠️ Row ${i} appears to be header or invalid data: ID="${id}"`);
            }
          } else {
            console.log(`❌ Row ${i} has only ${cells.length} cells`);
          }
        } catch (e) {
          console.error(`Error extracting row ${i}:`, e.message);
        }
      }
      
      scrapedData = extractedData;
      stats.totalItems = extractedData.length;
      stats.lastUpdate = new Date().toISOString();
      stats.totalRequests++;
      
      console.log(`📊 Extracted ${extractedData.length} items from ALL rows`);
      console.log(`⏰ Last update: ${stats.lastUpdate}`);
      
      return extractedData;
    } else {
      console.log('❌ No data table found');
      return [];
    }
    
  } catch (error) {
    console.error('❌ Scraping error:', error.message);
    return [];
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
    console.log('🚀 Manual scraping requested...');
    const data = await scrapeData();
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
  console.log(`🚀 All Rows Dashboard running at http://localhost:${PORT}`);
  console.log('📊 Open your browser and navigate to http://localhost:3000');
  console.log('🔍 This dashboard will extract ALL rows including the first one');
  
  // Auto-start scraping once
  console.log('🚀 Auto-starting initial scraping...');
  scrapeData().then(() => {
    console.log('✅ Initial scraping completed');
  }).catch(error => {
    console.error('❌ Initial scraping failed:', error.message);
  });
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  process.exit(0);
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down gracefully...');
  process.exit(0);
});
