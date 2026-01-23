import puppeteer from 'puppeteer';

async function analyzePageStructure() {
  console.log('🔍 Analyzing page structure...');
  
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
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Analyze page structure
    console.log('\n📊 Page Analysis:');
    
    // Check for tables
    const tables = await page.$$('table');
    console.log(`Found ${tables.length} tables`);
    
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      const rows = await table.$$('tr');
      console.log(`Table ${i + 1}: ${rows.length} rows`);
      
      if (rows.length > 0) {
        const firstRow = rows[0];
        const cells = await firstRow.$$('td, th');
        console.log(`  - ${cells.length} cells in first row`);
        
        // Get cell content
        for (let j = 0; j < Math.min(cells.length, 5); j++) {
          try {
            const content = await cells[j].evaluate(el => el.textContent?.trim() || '');
            console.log(`    Cell ${j + 1}: "${content}"`);
          } catch (e) {
            console.log(`    Cell ${j + 1}: Error`);
          }
        }
      }
    }
    
    // Check for other data containers
    const divs = await page.$$('div[class*="table"], div[class*="list"], div[class*="row"]');
    console.log(`\nFound ${divs.length} potential data containers`);
    
    // Check for images
    const images = await page.$$('img');
    console.log(`Found ${images.length} images`);
    
    // Check for any data rows
    const dataRows = await page.$$('[class*="row"], [class*="item"], [class*="card"]');
    console.log(`Found ${dataRows.length} potential data rows`);
    
    // Take screenshot
    await page.screenshot({ path: 'analyzed-page.png' });
    console.log('\n📸 Screenshot saved as analyzed-page.png');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await browser.close();
  }
}

analyzePageStructure();
