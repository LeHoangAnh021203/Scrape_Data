// Custom extractor for table data
export async function extractTableData(page) {
  console.log('🔍 Extracting table data...');
  
  try {
    // Wait for table to load - try both table structures
    await page.waitForSelector('table tbody tr', { timeout: 10000 });
    
    const items = await page.evaluate(() => {
      const tables = document.querySelectorAll('table');
      let targetTable = null;
      
      // Find the table with data (the one with rows but no headers)
      for (const table of tables) {
        const tbody = table.querySelector('tbody');
        if (tbody && tbody.querySelectorAll('tr').length > 0) {
          const thead = table.querySelector('thead');
          if (!thead || thead.querySelectorAll('th').length === 0) {
            targetTable = table;
            break;
          }
        }
      }
      
      if (!targetTable) {
        console.log('No suitable table found');
        return [];
      }
      
      const rows = targetTable.querySelectorAll('tbody tr');
      const results = [];
      const seen = new Set(); // To prevent duplicates
      
      console.log(`Found ${rows.length} rows in target table`);
      
      rows.forEach((row, index) => {
        try {
          const cells = row.querySelectorAll('td');
          if (cells.length < 6) return; // Skip incomplete rows
          
          // Actual mapping based on debug output:
          // Column 0: Account/Email (parcmall@facewashfox.com)
          // Column 1: Phone (0889866666)
          // Column 2: Number/Count (2, 5, 1)
          // Column 3: Number/Count (0, 1)
          // Column 4: Account/Email (parcmall@facewashfox.com)
          // Column 5: Device Number (S2CDD7AD, S2404F74)
          
          const account = cells[0]?.textContent?.trim() || '';
          const phone = cells[1]?.textContent?.trim() || '';
          const count1 = cells[2]?.textContent?.trim() || '';
          const count2 = cells[3]?.textContent?.trim() || '';
          const account2 = cells[4]?.textContent?.trim() || '';
          const deviceNumber = cells[5]?.textContent?.trim() || '';
          
          // Extract image if present (might be in any cell)
          const pictureImg = row.querySelector('img');
          
          // Extract view link if present
          const viewLink = row.querySelector('a[href*="view"]')?.href || '';
          
          // Create unique key to prevent duplicates
          const uniqueKey = `${account}_${deviceNumber}_${phone}`;
          
          // Only include records with valid data and not already seen
          if ((account || deviceNumber) && !seen.has(uniqueKey)) {
            seen.add(uniqueKey);
            
            results.push({
              id: uniqueKey,
              title: account || `Device ${deviceNumber}`,
              image: pictureImg?.src || '',
              url: viewLink,
              sourceId: uniqueKey,
              phone: phone,
              gender: '', // Not available in this table
              deviceNumber: deviceNumber,
              account: account,
              testTime: '', // Not available in this table
              testStatus: '', // Not available in this table
              remarks: '',
              // Additional fields for better data mapping
              customerName: account,
              customerPhone: phone,
              deviceId: deviceNumber,
              email: account,
              status: 'Unknown',
              testDate: '',
              count1: count1,
              count2: count2,
              account2: account2
            });
          }
        } catch (error) {
          console.log('Error processing row:', error);
        }
      });
      
      return results;
    });
    
    console.log(`📦 Extracted ${items.length} items from table`);
    return items;
    
  } catch (error) {
    console.error('❌ Table extraction error:', error.message);
    return [];
  }
}






