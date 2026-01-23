#!/usr/bin/env node
/**
 * Quick test script để kiểm tra API server
 * Chạy: node test-api-quick.js
 */

const API_BASE = 'http://localhost:3001';

async function quickTest() {
  console.log('🧪 Testing API Server...\n');

  try {
    // Test 1: Health
    console.log('1. Testing /api/health...');
    const health = await fetch(`${API_BASE}/api/health`).then(r => r.json());
    console.log('   ✅', health);
    
    // Test 2: Status
    console.log('\n2. Testing /api/scrape/status...');
    const status = await fetch(`${API_BASE}/api/scrape/status`).then(r => r.json());
    console.log('   ✅', JSON.stringify(status.status, null, 2));
    
    // Test 3: Data
    console.log('\n3. Testing /api/data...');
    const data = await fetch(`${API_BASE}/api/data?page=1&limit=5`).then(r => r.json());
    console.log(`   ✅ Found ${data.data?.length || 0} items`);
    console.log(`   ✅ Total: ${data.pagination?.total || 0} records`);
    
    // Test 4: Stats
    console.log('\n4. Testing /api/data/stats...');
    const stats = await fetch(`${API_BASE}/api/data/stats`).then(r => r.json());
    console.log(`   ✅ Total: ${stats.stats?.total || 0} records`);
    
    console.log('\n✅ All tests passed! API server is working correctly.\n');
    console.log('📝 Frontend base URL should be:', API_BASE);
    
  } catch (error) {
    console.error('\n❌ Error:', error.message);
    
    if (error.code === 'ECONNREFUSED') {
      console.error('\n⚠️  API Server is not running!');
      console.error('   Start it with: npm run api\n');
    } else {
      console.error('\n⚠️  Check if API server is running on port 3001\n');
    }
    
    process.exit(1);
  }
}

quickTest();


