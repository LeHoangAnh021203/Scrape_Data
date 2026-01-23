import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Sample data
let scrapedData = [
  {
    id: "4933592",
    picture: "https://zm.yiyuan.ai/fileSvr/get/sy-prd-skin3/20250913/7eab8e095088917de29ce110735d168f-4503599965879996.jpg_20x20.jpg",
    customerInfo: "Quoc khanh 0896236252  查看资料",
    gender: "男",
    deviceNumber: "S2294105",
    account: "mvtranphudanang@facewashfox.com",
    testTime: "2025-09-13 14:37:46",
    testStatus: "成功",
    remarks: "添加备注",
    operation: "查看详情 删除 导出图片",
    viewProfileLink: ""
  },
  {
    id: "4933575",
    picture: "https://zm.yiyuan.ai/fileSvr/get/sy-prd-skin3/20250913/5a9f4470567bbd502fd0e1c72692f263-4503599965879301.jpg_20x20.jpg",
    customerInfo: "Bui.binh.minh 08546464664  查看资料",
    gender: "男",
    deviceNumber: "S2F3B468",
    account: "store.hn1@facewashfox.com",
    testTime: "2025-09-13 14:36:37",
    testStatus: "成功",
    remarks: "添加备注",
    operation: "查看详情 删除 导出图片",
    viewProfileLink: ""
  },
  {
    id: "4933474",
    picture: "https://zm.yiyuan.ai/fileSvr/get/sy-prd-skin3/20250913/64d74eb9a0e6d654253859994096335b-4503599965875063.jpg_20x20.jpg",
    customerInfo: "Hai van 0908791990  查看资料",
    gender: "女",
    deviceNumber: "S25F9FDD",
    account: "midtown@facewashfox.com",
    testTime: "2025-09-13 14:28:58",
    testStatus: "成功",
    remarks: "添加备注",
    operation: "查看详情 删除 导出图片",
    viewProfileLink: ""
  },
  {
    id: "4933415",
    picture: "https://zm.yiyuan.ai/fileSvr/get/sy-prd-skin3/20250913/552761382c3e69755ce8bd0d63958aed-4503599965872797.jpg_20x20.jpg",
    customerInfo: "Nguyen cao thuy anh 0908810305  查看资料",
    gender: "女",
    deviceNumber: "S24A9008",
    account: "crescentmall@facewashfox.com",
    testTime: "2025-09-13 14:24:05",
    testStatus: "成功",
    remarks: "添加备注",
    operation: "查看详情 删除 导出图片",
    viewProfileLink: ""
  },
  {
    id: "4933414",
    picture: "https://zm.yiyuan.ai/fileSvr/get/sy-prd-skin3/20250913/04c44e78e95711485b2bbafe4004e406-4503599965872607.jpg_20x20.jpg",
    customerInfo: "Do tuong duy 0989796531  查看资料",
    gender: "男",
    deviceNumber: "S2E3F366",
    account: "store.sg1@facewashfox.com",
    testTime: "2025-09-13 14:23:40",
    testStatus: "成功",
    remarks: "添加备注",
    operation: "查看详情 删除 导出图片",
    viewProfileLink: ""
  }
];

let stats = {
  totalRequests: 1,
  totalItems: scrapedData.length,
  lastUpdate: new Date().toISOString(),
  successRate: 100
};

// Routes
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.post('/api/scrape', (req, res) => {
  console.log('🚀 Simulating scraping...');
  // Simulate scraping delay
  setTimeout(() => {
    stats.totalRequests++;
    stats.lastUpdate = new Date().toISOString();
    res.json({ success: true, data: scrapedData, stats });
  }, 1000);
});

app.get('/api/data', (req, res) => {
  res.json({ data: scrapedData, stats });
});

app.post('/api/clear', (req, res) => {
  scrapedData = [];
  stats = { totalRequests: 0, totalItems: 0, lastUpdate: null, successRate: 100 };
  res.json({ success: true, message: 'Data cleared' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Simple Dashboard running at http://localhost:${PORT}`);
  console.log('📊 Open your browser and navigate to http://localhost:3000');
  console.log('📋 Sample data loaded with', scrapedData.length, 'items');
});
