import puppeteer from 'puppeteer';

async function testRealScraping() {
  console.log('🚀 Testing real scraping...');
  
  const browser = await puppeteer.launch({ 
    headless: false, // Show browser for debugging
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
    
    // Check page content
    const pageTitle = await page.title();
    console.log('Page title:', pageTitle);
    
    // Check for table
    const tableExists = await page.$('table tbody tr');
    console.log('Table exists:', !!tableExists);
    
    if (tableExists) {
      const rowCount = await page.$$eval('table tbody tr', rows => rows.length);
      console.log('Row count:', rowCount);
      
      // Extract first row as sample
      const firstRow = await page.$('table tbody tr');
      if (firstRow) {
        console.log('First row data:');
        try {
          const id = await firstRow.$eval('td:nth-child(2)', el => el.textContent?.trim() || '');
          console.log('ID:', id);
        } catch (e) {
          console.log('ID: Error -', e.message);
        }
        
        try {
          const picture = await firstRow.$eval('td:nth-child(3) img', el => el.src || '');
          console.log('Picture:', picture);
        } catch (e) {
          console.log('Picture: Error -', e.message);
        }
        
        try {
          const customerInfo = await firstRow.$eval('td:nth-child(4)', el => el.textContent?.trim() || '');
          console.log('Customer Info:', customerInfo);
        } catch (e) {
          console.log('Customer Info: Error -', e.message);
        }
      }
    } else {
      console.log('❌ No table found');
      // Take screenshot for debugging
      await page.screenshot({ path: 'debug-real-page.png' });
      console.log('Screenshot saved as debug-real-page.png');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await browser.close();
  }
}

testRealScraping();
