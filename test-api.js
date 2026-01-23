import axios from 'axios';

const API_BASE = 'http://localhost:3001';

// Test colors
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m'
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

async function testAPI() {
  log('\n🧪 ========== TESTING API SERVER ==========\n', 'cyan');

  try {
    // Test 1: Health Check
    log('1️⃣  Testing Health Check...', 'blue');
    try {
      const health = await axios.get(`${API_BASE}/api/health`);
      log(`   ✅ Health Check: ${JSON.stringify(health.data)}\n`, 'green');
    } catch (error) {
      log(`   ❌ Health Check Failed: ${error.message}\n`, 'red');
      log('   ⚠️  Make sure API server is running: npm run api\n', 'yellow');
      return;
    }

    // Test 2: Get Stats
    log('2️⃣  Testing Get Stats...', 'blue');
    try {
      const stats = await axios.get(`${API_BASE}/api/data/stats`);
      log(`   ✅ Total Records: ${stats.data.stats.total}`, 'green');
      log(`   ✅ By Gender: ${JSON.stringify(stats.data.stats.byGender)}`, 'green');
      log('');
    } catch (error) {
      log(`   ⚠️  Get Stats: ${error.message} (Might be empty database)\n`, 'yellow');
    }

    // Test 3: Get Data
    log('3️⃣  Testing Get Data...', 'blue');
    try {
      const data = await axios.get(`${API_BASE}/api/data?page=1&limit=5`);
      log(`   ✅ Found ${data.data.data.length} items`, 'green');
      log(`   ✅ Total: ${data.data.pagination.total} records`, 'green');
      if (data.data.data.length > 0) {
        log(`   ✅ Sample: ${JSON.stringify(data.data.data[0], null, 2).substring(0, 200)}...`, 'green');
      }
      log('');
    } catch (error) {
      log(`   ⚠️  Get Data: ${error.message}\n`, 'yellow');
    }

    // Test 4: Check Scraping Status
    log('4️⃣  Testing Scraping Status...', 'blue');
    try {
      const status = await axios.get(`${API_BASE}/api/scrape/status`);
      log(`   ✅ Status: ${JSON.stringify(status.data.status, null, 2)}`, 'green');
      log('');
    } catch (error) {
      log(`   ⚠️  Status Check: ${error.message}\n`, 'yellow');
    }

    // Test 5: Try to start scraping (will fail if already running)
    log('5️⃣  Testing Start Scraping...', 'blue');
    log('   ℹ️  This will start actual scraping process (if not already running)', 'yellow');
    try {
      const scrape = await axios.post(`${API_BASE}/api/scrape/all-pages`);
      log(`   ✅ Scraping Started: ${scrape.data.message}`, 'green');
      log(`   ✅ Status: ${JSON.stringify(scrape.data.status, null, 2)}`, 'green');
      log('');
      log('   📊 Monitor progress with:', 'cyan');
      log('      curl http://localhost:3001/api/scrape/status\n', 'cyan');
    } catch (error) {
      if (error.response && error.response.status === 409) {
        log(`   ℹ️  Scraping already running: ${error.response.data.message}`, 'yellow');
      } else {
        log(`   ⚠️  Start Scraping: ${error.message}`, 'yellow');
      }
      log('');
    }

    log('✅ ========== ALL TESTS COMPLETED ==========\n', 'green');
    log('📚 API Documentation: See API_DOCUMENTATION.md', 'cyan');
    log('🔗 Frontend Base URL: http://localhost:3001\n', 'cyan');

  } catch (error) {
    log(`\n❌ Test Error: ${error.message}`, 'red');
    if (error.code === 'ECONNREFUSED') {
      log('\n⚠️  API Server is not running!', 'yellow');
      log('   Start it with: npm run api\n', 'yellow');
    }
  }
}

testAPI();


