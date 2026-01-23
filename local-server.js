import express from 'express';
import cors from 'cors';

const app = express();
const PORT = 3002;

// Middleware
app.use(cors());
app.use(express.json());

// Store để lưu data nhận được
let receivedData = [];
let stats = {
  totalRequests: 0,
  totalItems: 0,
  lastUpdate: null
};

// Route để nhận data từ scraper
app.post('/api/skins', (req, res) => {
  const data = req.body;
  const timestamp = new Date().toISOString();
  
  console.log(`📥 Received ${Array.isArray(data) ? data.length : 1} items at ${timestamp}`);
  
  if (Array.isArray(data)) {
    receivedData.push(...data);
    stats.totalItems += data.length;
  } else {
    receivedData.push(data);
    stats.totalItems += 1;
  }
  
  stats.totalRequests++;
  stats.lastUpdate = timestamp;
  
  res.json({ 
    success: true, 
    message: `Received ${Array.isArray(data) ? data.length : 1} items`,
    timestamp 
  });
});

// Route để xem tất cả data
app.get('/api/skins', (req, res) => {
  res.json({
    stats,
    data: receivedData,
    count: receivedData.length
  });
});

// Route để xem stats
app.get('/api/stats', (req, res) => {
  res.json(stats);
});

// Route để xóa data
app.delete('/api/skins', (req, res) => {
  receivedData = [];
  stats = {
    totalRequests: 0,
    totalItems: 0,
    lastUpdate: null
  };
  res.json({ success: true, message: 'Data cleared' });
});

// Route chính để xem data
app.get('/', (req, res) => {
  const html = `
<!DOCTYPE html>
<html>
<head>
    <title>Bitmoji Scraper Results</title>
    <style>
        body { font-family: Arial, sans-serif; margin: 20px; }
        .stats { background: #f0f0f0; padding: 15px; border-radius: 5px; margin-bottom: 20px; }
        .item { border: 1px solid #ddd; padding: 10px; margin: 10px 0; border-radius: 5px; }
        .item img { max-width: 100px; max-height: 100px; margin-right: 10px; }
        .controls { margin: 20px 0; }
        .controls button { margin-right: 10px; padding: 10px 15px; }
        .refresh { background: #007bff; color: white; border: none; border-radius: 3px; }
        .clear { background: #dc3545; color: white; border: none; border-radius: 3px; }
    </style>
</head>
<body>
    <h1>🔍 Bitmoji Scraper Results</h1>
    
    <div class="stats">
        <h3>📊 Statistics</h3>
        <p><strong>Total Requests:</strong> <span id="totalRequests">${stats.totalRequests}</span></p>
        <p><strong>Total Items:</strong> <span id="totalItems">${stats.totalItems}</span></p>
        <p><strong>Last Update:</strong> <span id="lastUpdate">${stats.lastUpdate || 'Never'}</span></p>
    </div>
    
    <div class="controls">
        <button class="refresh" onclick="location.reload()">🔄 Refresh</button>
        <button class="clear" onclick="clearData()">🗑️ Clear Data</button>
    </div>
    
    <h3>📦 Scraped Items (${receivedData.length})</h3>
    <div id="items">
        ${receivedData.map((item, i) => `
            <div class="item">
                <h4>Item ${i + 1}</h4>
                <p><strong>Title:</strong> ${item.title || 'N/A'}</p>
                <p><strong>Image:</strong> ${item.image ? `<img src="${item.image}" alt="Image">` : 'N/A'}</p>
                <p><strong>URL:</strong> ${item.url ? `<a href="${item.url}" target="_blank">${item.url}</a>` : 'N/A'}</p>
                <p><strong>Source ID:</strong> ${item.sourceId || 'N/A'}</p>
            </div>
        `).join('')}
    </div>
    
    <script>
        function clearData() {
            if (confirm('Are you sure you want to clear all data?')) {
                fetch('/api/skins', { method: 'DELETE' })
                    .then(() => location.reload());
            }
        }
        
        // Auto refresh every 30 seconds
        setTimeout(() => location.reload(), 30000);
    </script>
</body>
</html>
  `;
  res.send(html);
});

app.listen(PORT, () => {
  console.log(`🚀 Local server running at 
    
    http://localhost:${PORT}`);
  console.log(`📊 View results at http://localhost:${PORT}`);
  console.log(`📥 API endpoint: http://localhost:${PORT}/api/skins`);
});
