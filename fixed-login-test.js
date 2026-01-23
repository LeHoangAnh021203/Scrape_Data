import puppeteer from 'puppeteer';

async function testFixedLogin() {
  console.log('🔍 Testing fixed login...');
  
  const browser = await puppeteer.launch({ 
    headless: false, // Show browser for debugging
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1920, height: 1080 });
    
    console.log('🌐 Navigating to login page...');
    await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/', { waitUntil: 'networkidle2', timeout: 60000 });
    
    // Wait for page to load
    await new Promise(resolve => setTimeout(resolve, 3000));
    
    console.log('🔐 Attempting login with correct selectors...');
    
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
    
    // Check if login was successful
    const currentUrl = page.url();
    console.log('Current URL after login:', currentUrl);
    
    // Check for error messages
    const errorMessage = await page.$('.el-message--error, .error-message, .login-error');
    if (errorMessage) {
      const errorText = await errorMessage.evaluate(el => el.textContent?.trim() || '');
      console.log('❌ Login error:', errorText);
    } else {
      console.log('✅ No error messages found');
    }
    
    // Try to navigate to records list
    console.log('🌐 Navigating to records list...');
    await page.goto('https://zm.bitmoji-zmlh.com/skinmgr/#/skinmgr/recordsList', { waitUntil: 'networkidle2', timeout: 60000 });
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Check for data
    const tables = await page.$$('table');
    console.log(`Found ${tables.length} tables after login`);
    
    if (tables.length > 0) {
      const table = tables[0];
      const rows = await table.$$('tr');
      console.log(`Table has ${rows.length} rows`);
      
      if (rows.length > 1) {
        console.log('✅ Data found! Login successful!');
      }
    }
    
    // Take screenshot
    await page.screenshot({ path: 'fixed-login-result.png' });
    console.log('📸 Screenshot saved as fixed-login-result.png');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await browser.close();
  }
}

testFixedLogin();
