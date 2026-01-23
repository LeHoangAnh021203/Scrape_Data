import fetch from 'node-fetch';

async function forceRefresh() {
  console.log('🔄 Force refreshing dashboard data...');
  
  try {
    // Clear data first
    console.log('🗑️ Clearing old data...');
    const clearResponse = await fetch('http://localhost:3000/api/clear', { method: 'POST' });
    const clearResult = await clearResponse.json();
    console.log('Clear result:', clearResult);
    
    // Wait a bit
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Scrape new data
    console.log('🚀 Scraping new data...');
    const scrapeResponse = await fetch('http://localhost:3000/api/scrape', { method: 'POST' });
    const scrapeResult = await scrapeResponse.json();
    console.log('Scrape result:', scrapeResult.success ? `✅ ${scrapeResult.data.length} items` : `❌ ${scrapeResult.message}`);
    
    // Get final data
    console.log('📊 Getting final data...');
    const dataResponse = await fetch('http://localhost:3000/api/data');
    const dataResult = await dataResponse.json();
    console.log(`📋 Final data: ${dataResult.data.length} items`);
    console.log(`📊 Stats: ${dataResult.stats.totalItems} total items, ${dataResult.stats.totalRequests} requests`);
    
    if (dataResult.data.length > 0) {
      console.log('✅ Dashboard ready with fresh data!');
      console.log('🌐 Open http://localhost:3000 in your browser');
      console.log('🔄 If you still see old data, try hard refresh (Cmd+Shift+R)');
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

forceRefresh();
