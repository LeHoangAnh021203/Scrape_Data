import puppeteer from 'puppeteer';

async function waitForData() {
  console.log('⏳ Waiting for data to load...');
  
  const browser = await puppeteer.launch({ 
    headless: false,
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
    
    // Wait longer for data to load
    console.log('⏳ Waiting for data to load (30 seconds)...');
    await new Promise(resolve => setTimeout(resolve, 30000));
    
    // Check for tables again
    const tables = await page.$$('table');
    console.log(`Found ${tables.length} tables after waiting`);
    
    if (tables.length > 0) {
      const table = tables[0];
      const rows = await table.$$('tr');
      console.log(`Table has ${rows.length} rows`);
      
      if (rows.length > 1) {
        console.log('✅ Data loaded successfully!');
        
        // Extract first data row
        const firstDataRow = rows[1]; // Skip header
        const cells = await firstDataRow.$$('td');
        console.log(`First data row has ${cells.length} cells`);
        
        for (let i = 0; i < Math.min(cells.length, 5); i++) {
          try {
            const content = await cells[i].evaluate(el => el.textContent?.trim() || '');
            console.log(`Cell ${i + 1}: "${content}"`);
          } catch (e) {
            console.log(`Cell ${i + 1}: Error`);
          }
        }
      }
    } else {
      console.log('❌ Still no tables found');
      
      // Check for any data elements
      const dataElements = await page.$$('[class*="row"], [class*="item"], [class*="card"], [class*="list"]');
      console.log(`Found ${dataElements.length} potential data elements`);
      
      if (dataElements.length > 0) {
        console.log('First element classes:', await dataElements[0].evaluate(el => el.className));
        console.log('First element content:', await dataElements[0].evaluate(el => el.textContent?.trim().substring(0, 100) || ''));
      }
    }
    
    // Take final screenshot
    await page.screenshot({ path: 'final-page.png' });
    console.log('📸 Final screenshot saved as final-page.png');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await browser.close();
  }
}

waitForData();
