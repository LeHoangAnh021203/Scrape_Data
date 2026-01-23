import puppeteer from 'puppeteer';

async function testLoginPage() {
  console.log('🔍 Testing login page...');
  
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
    
    // Check page title
    const pageTitle = await page.title();
    console.log('Page title:', pageTitle);
    
    // Check for login form elements
    const usernameInput = await page.$('input[type="text"]');
    const passwordInput = await page.$('input[type="password"]');
    const loginButton = await page.$('button[type="button"]');
    const submitButton = await page.$('button[type="submit"]');
    
    console.log('Username input found:', !!usernameInput);
    console.log('Password input found:', !!passwordInput);
    console.log('Button type="button" found:', !!loginButton);
    console.log('Button type="submit" found:', !!submitButton);
    
    // Check for other possible selectors
    const allInputs = await page.$$('input');
    console.log(`Total inputs found: ${allInputs.length}`);
    
    for (let i = 0; i < allInputs.length; i++) {
      const input = allInputs[i];
      const type = await input.evaluate(el => el.type);
      const placeholder = await input.evaluate(el => el.placeholder || '');
      const name = await input.evaluate(el => el.name || '');
      console.log(`Input ${i + 1}: type="${type}", placeholder="${placeholder}", name="${name}"`);
    }
    
    const allButtons = await page.$$('button');
    console.log(`Total buttons found: ${allButtons.length}`);
    
    for (let i = 0; i < allButtons.length; i++) {
      const button = allButtons[i];
      const type = await button.evaluate(el => el.type || '');
      const text = await button.evaluate(el => el.textContent?.trim() || '');
      const className = await button.evaluate(el => el.className || '');
      console.log(`Button ${i + 1}: type="${type}", text="${text}", class="${className}"`);
    }
    
    // Take screenshot
    await page.screenshot({ path: 'login-page-debug.png' });
    console.log('📸 Screenshot saved as login-page-debug.png');
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await browser.close();
  }
}

testLoginPage();
