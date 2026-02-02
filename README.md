# Bitmoji SPA Scraper

A production-ready scraper for JavaScript SPAs that extracts data and sends it to multiple servers in parallel with MongoDB persistence.

## Features

- **Puppeteer** for JavaScript-rendered pages
- **Dual extraction strategies**: DOM selectors or Network JSON capture
- **Infinite scroll** / pagination support
- **MongoDB** persistence with idempotent upserts
- **Parallel fan-out** to multiple servers with retry logic
- **Environment-based** configuration
- **Cron scheduling** for automated runs

## Quick Start

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   - Edit `.env` file with your settings
   - Set your MongoDB URI
   - Configure target endpoints for fan-out

3. **Run the scraper:**
   ```bash
npm run dev
```

If you hit heap issues during scraping or API runs, start the server with a larger V8 heap:

```bash
NODE_OPTIONS="--max-old-space-size=4096" npx nodemon api-server.js
```

## Configuration

The scraper supports two extraction strategies:

### Network Strategy (Recommended for SPAs)
- Captures JSON responses from XHR/Fetch requests
- More stable for JavaScript-heavy applications
- Set `EXTRACTION_STRATEGY=NETWORK` in `.env`

### DOM Strategy
- Uses CSS selectors to extract data from rendered HTML
- Set `EXTRACTION_STRATEGY=DOM` and configure selectors in `.env`

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `TARGET_URL` | URL to scrape | `https://zm.bitmoji-zmlh.com/skinmgr/#/` |
| `EXTRACTION_STRATEGY` | `DOM` or `NETWORK` | `NETWORK` |
| `SCROLL_STEPS` | Number of scroll steps for pagination | `10` |
| `SCROLL_DELAY_MS` | Delay between scroll steps (ms) | `600` |
| `MONGO_URI` | MongoDB connection string | `mongodb://127.0.0.1:27017/bitmoji` |
| `SERVER_A_ENDPOINT` | First fan-out endpoint | Required |
| `SERVER_B_ENDPOINT` | Second fan-out endpoint | Optional |
| `CRON_EXPR` | Cron schedule | `*/10 * * * *` (every 10 minutes) |
| `HEADLESS` | Run browser in headless mode | `true` |
| `DATA_SOURCE_TIMEZONE` | Timezone that `crt_time` values originate from (used for timezone conversion) | `Asia/Shanghai` |
| `DATA_DISPLAY_TIMEZONE` | Timezone used when reporting ranges back to clients | `Asia/Ho_Chi_Minh` |

## Project Structure

```
bitmoji-scraper/
├─ .env                 # Environment configuration
├─ package.json
├─ src/
│  ├─ config.js         # Runtime configuration
│  ├─ db.js             # MongoDB connection & schema
│  ├─ services.js       # Fan-out services with retry
│  ├─ scraper.js        # Main orchestrator
│  └─ utils/
│     ├─ extractors.js  # DOM & Network extractors
│     └─ scroll.js      # Infinite scroll helper
└─ README.md
```

## Troubleshooting

### Nothing extracted (DOM strategy)
- Check selectors in browser DevTools
- Test selectors in console: `$$('.skin-card').length`
- Consider switching to NETWORK strategy

### Nothing extracted (Network strategy)
- Check Network tab for JSON responses
- Verify XHR endpoints are being called
- Adjust scroll settings to trigger more requests

-### Detection/Blocking
- Ensure Puppeteer can launch its bundled browser; the scraper now defaults to `puppeteer.executablePath()` so you rarely need to set `PUPPETEER_EXECUTABLE_PATH` manually unless you have a custom Chrome install or version requirement.
- Add random delays between actions
- Consider using stealth plugins

### Range filtering
- `GET /api/data` và `/api/data/stats` hỗ trợ `start`/`from` + `end`/`to`.  
- Thêm `rangeField=scrapedAt` (mặc định) hoặc `rangeField=crt_time` nếu bạn muốn lọc theo `crt_time` thay vì thời điểm `scrapedAt`.  
- Thống kê trả về (fullRange/dataTimeRange) sẽ phản ánh trường mà bạn chọn.
- `GET /api/data` có thêm `noLimit=true` (hoặc `limit=0`/`limit` là số âm) để tắt phân trang và trả về toàn bộ bản ghi khớp query (nhớ kiểm tra dung lượng khi gọi trong một khoảng lớn).
- `GET /api/data/view` stream trực tiếp tập kết quả cho UI với metadata range/total, nên dễ hiển thị các bản ghi trong range mà không cần trang hóa (range + search + rangeField giống `/api/data`).  
  - Nếu không truyền `start`/`end`, endpoint sẽ tự lấy tháng mới nhất có bản ghi và stream range đó.  
  - `buildRangeQuery` tự xét `rangeField=crt_time` là string nên dùng `st`/`ed` raw, còn `rangeField=scrapedAt` dùng Date/bộ lọc bình thường; cả hai đều đã có index.  
  - Nếu không truyền `rangeField`, endpoint sẽ cố gắng lọc theo `scrapedAt` trước rồi fallback sang `crt_time` nếu range đó trả về 0 bản ghi.
- ### Render deployment
- Sau khi Render chạy `npm install`, script `postinstall` sẽ cài Puppeteer và gọi `scripts/link-chrome.sh` để chmod Chrome, tạo symlink `/opt/render/.cache/puppeteer/bin/chrome` và in log đường dẫn; nếu đổi version Chrome thì chỉ cần cập nhật đường dẫn trong script trước khi redeploy.  

## Legal Notice

Always check the target site's Terms of Service and robots.txt. Only scrape data you're authorized to use. Implement respectful rate limiting.

## License

///////////////////////////

npm run dev: khởi động hệ thống và tự động đăng nhập

npx nodemon api-server.js: bắt đầu sever API và cho phép FE kết nối với hệ thống
