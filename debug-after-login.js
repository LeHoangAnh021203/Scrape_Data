import puppeteer from 'puppeteer';

async function debugAfterLogin() {
  console.log('🔍 Debugging after login...');
  
  const browser = await puppeteer.launch({ 
    headless: false, // Show browser for debugging
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    console.log('🌐 Navigating to login page...');
    await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log('🔐 Logging in...');
    await page.click('input[placeholder="请选择"]');
    await new Promise(resolve => setTimeout(resolve, 1000));
    await page.type('input[placeholder="请输入手机号码或用户名"]', 'admin@facewashfox.com');
    await page.type('input[placeholder="请输入密码"]', 'rW7SEu8J80R');
    await page.click('button.el-button.btn1.el-button--primary');
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    console.log('🌐 Navigating to records list...');
    await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/#/skinmgr/recordsList', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 10000)); // Wait longer
    
    // Debug page structure
    console.log('\n📊 Page Analysis after login:');
    
    const pageTitle = await page.title();
    console.log('Page title:', pageTitle);
    
    const currentUrl = page.url();
    console.log('Current URL:', currentUrl);
    
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
    
    // Check for any data elements
    const dataElements = await page.$$('[class*="row"], [class*="item"], [class*="card"], [class*="list"], [class*="data"]');
    console.log(`\nFound ${dataElements.length} potential data elements`);
    
    if (dataElements.length > 0) {
      console.log('First few elements:');
      for (let i = 0; i < Math.min(dataElements.length, 3); i++) {
        const element = dataElements[i];
        const className = await element.evaluate(el => el.className || '');
        const content = await element.evaluate(el => el.textContent?.trim().substring(0, 100) || '');
        console.log(`  Element ${i + 1}: class="${className}", content="${content}"`);
      }
    }
    
    // Check for images
    const images = await page.$$('img');
    console.log(`\nFound ${images.length} images`);
    
    if (images.length > 0) {
      console.log('First few images:');
      for (let i = 0; i < Math.min(images.length, 3); i++) {
        const img = images[i];
        const src = await img.evaluate(el => el.src || '');
        const alt = await img.evaluate(el => el.alt || '');
        console.log(`  Image ${i + 1}: src="${src}", alt="${alt}"`);
      }
    }
    
    // Check for any loading indicators
    const loadingElements = await page.$$('[class*="loading"], [class*="spinner"], [class*="load"]');
    console.log(`\nFound ${loadingElements.length} loading indicators`);
    
    // Take screenshot
    await page.screenshot({ path: 'debug-after-login.png' });
    console.log('\n📸 Screenshot saved as debug-after-login.png');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await browser.close();
  }
}

debugAfterLogin();
