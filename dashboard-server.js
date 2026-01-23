import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractViaDOM } from './src/utils/extractors.js';
import { cfg } from './src/config.js';
import puppeteer from 'puppeteer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());

// In-memory data store
let scrapedData = [];
let stats = {
  totalRequests: 0,
  totalItems: 0,
  lastUpdate: null,
  successRate: 100
};

// API endpoints
app.get('/api/data', (req, res) => {
  res.json({
    data: scrapedData,
    stats: stats
  });
});

app.get('/api/stats', (req, res) => {
  res.json(stats);
});

app.post('/api/scrape', async (req, res) => {
  try {
    console.log('🚀 Starting scraping process...');
    
    const browser = await puppeteer.launch({
      headless: true,
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
      // Navigate to target URL
      await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36');
      await page.setViewport({ width: 1366, height: 850, deviceScaleFactor: 1 });
      await page.setJavaScriptEnabled(true);
      
      await page.goto(cfg.targetUrl, { waitUntil: 'networkidle2', timeout: 60000 });
      console.log('✅ Page loaded successfully');
      
      // Login if needed
      if (cfg.auth.email) {
        console.log('🔐 Attempting login...');
        
        try {
          await page.waitForSelector('input[placeholder="请输入手机号码或用户名"]', { timeout: 10000 });
          
          await page.click('input[placeholder="请输入手机号码或用户名"]');
          await page.keyboard.down('Control');
          await page.keyboard.press('KeyA');
          await page.keyboard.up('Control');
          await page.type('input[placeholder="请输入手机号码或用户名"]', cfg.auth.email);
          
          await page.click('input[placeholder="请输入密码"]');
          await page.keyboard.down('Control');
          await page.keyboard.press('KeyA');
          await page.keyboard.up('Control');
          await page.type('input[placeholder="请输入密码"]', cfg.auth.password);
          
          await page.evaluate(() => {
            const buttons = Array.from(document.querySelectorAll('button, input[type="submit"]'));
            const loginBtn = buttons.find(btn => 
              btn.textContent.includes('登录') || 
              btn.textContent.includes('Login') ||
              btn.textContent.includes('Sign in') ||
              btn.className.includes('btn')
            );
            if (loginBtn) {
              loginBtn.click();
              return true;
            }
            return false;
          });
          
          await new Promise(resolve => setTimeout(resolve, 5000));
          console.log('✅ Login completed');
        } catch (e) {
          console.log('❌ Login failed:', e.message);
        }
      }
      
      // Navigate to Records List page first
      console.log('🌐 Navigating to Records List page...');
      await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/#/skinmgr/recordsList', { waitUntil: 'networkidle2', timeout: 60000 });
      console.log('✅ Records List page loaded');
      
      // Wait for content to load
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Extract data
      console.log('🔍 Extracting data...');
      const extractedData = await extractViaDOM(page, cfg.selectors);
      console.log(`📊 Extracted ${extractedData.length} items`);
      
      // Update data store
      scrapedData = extractedData;
      stats.totalRequests++;
      stats.totalItems = extractedData.length;
      stats.lastUpdate = new Date().toISOString();
      stats.successRate = 100;
      
      res.json({
        success: true,
        message: `Successfully scraped ${extractedData.length} items`,
        data: extractedData,
        stats: stats
      });
      
    } finally {
      await browser.close();
    }
    
  } catch (error) {
    console.error('❌ Scraping error:', error.message);
    res.status(500).json({
      success: false,
      message: 'Scraping failed: ' + error.message
    });
  }
});

app.delete('/api/data', (req, res) => {
  scrapedData = [];
  stats.totalRequests = 0;
  stats.totalItems = 0;
  stats.lastUpdate = null;
  
  res.json({
    success: true,
    message: 'Data cleared successfully'
  });
});

app.get('/api/export', (req, res) => {
  if (scrapedData.length === 0) {
    return res.status(404).json({ message: 'No data to export' });
  }
  
  const csvContent = [
    ['ID', 'Account', 'Phone', 'Yesterday', 'Today', 'Store', 'Device', 'Test Time', 'Status', 'Remarks'],
    ...scrapedData.map(item => [
      item.id || '',
      item.account || '',
      item.phone || '',
      item.yesterday || '',
      item.today || '',
      item.store || '',
      item.device || '',
      item.testTime || '',
      item.testStatus || '',
      item.remarks || ''
    ])
  ].map(row => row.join(',')).join('\n');
  
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="scraped-data-${new Date().toISOString().split('T')[0]}.csv"`);
  res.send(csvContent);
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Dashboard server running at http://localhost:${PORT}`);
  console.log(`📊 Open your browser and navigate to http://localhost:${PORT}`);
});
