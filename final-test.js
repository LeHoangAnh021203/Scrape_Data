import puppeteer from 'puppeteer';

async function finalTest() {
  console.log('🚀 Final test with working logic...');
  
  const browser = await puppeteer.launch({ 
    headless: true, // Use headless for final test
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
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Extract data using working logic
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
    
    if (extractedData.length > 0) {
      console.log('✅ SUCCESS! Data extracted:');
      console.log('Sample item:', extractedData[0]);
      console.log('All items:', extractedData.map(item => ({ id: item.id, customerInfo: item.customerInfo, gender: item.gender })));
    } else {
      console.log('❌ No data extracted');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await browser.close();
  }
}

finalTest();
