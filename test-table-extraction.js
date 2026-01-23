import puppeteer from 'puppeteer';

async function testTableExtraction() {
  console.log('🔍 Testing table extraction...');
  
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
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Get all tables
    const tables = await page.$$('table');
    console.log(`Found ${tables.length} tables`);
    
    for (let i = 0; i < tables.length; i++) {
      const table = tables[i];
      const rows = await table.$$('tr');
      console.log(`\nTable ${i + 1}: ${rows.length} rows`);
      
      if (rows.length > 1) {
        console.log('This table has data rows!');
        
        // Extract first data row (skip header)
        const firstDataRow = rows[1];
        const cells = await firstDataRow.$$('td');
        console.log(`First data row has ${cells.length} cells`);
        
        const extractedData = [];
        for (let j = 0; j < cells.length; j++) {
          try {
            const content = await cells[j].evaluate(el => el.textContent?.trim() || '');
            console.log(`Cell ${j + 1}: "${content}"`);
            
            // Check for image in this cell
            const img = await cells[j].$('img');
            if (img) {
              const imgSrc = await img.evaluate(el => el.src || '');
              console.log(`  Image src: "${imgSrc}"`);
            }
          } catch (e) {
            console.log(`Cell ${j + 1}: Error - ${e.message}`);
          }
        }
        
        // Try to extract all data rows from this table
        console.log('\nExtracting all data from this table...');
        for (let rowIndex = 1; rowIndex < Math.min(rows.length, 6); rowIndex++) {
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
                  operation
                });
              }
            } catch (e) {
              console.log(`Error extracting row ${rowIndex}: ${e.message}`);
            }
          }
        }
        
        console.log(`\n✅ Successfully extracted ${extractedData.length} items from table ${i + 1}`);
        if (extractedData.length > 0) {
          console.log('Sample item:', extractedData[0]);
        }
        break; // Use the first table with data
      }
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  } finally {
    await browser.close();
  }
}

testTableExtraction();
