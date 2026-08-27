# Movie Crawler

Project tách riêng từ `MovieStreaming/backend`, chuyên crawl dữ liệu phim từ nhiều nguồn API phim Việt Nam (OPhim, KKPhim, Nguonc...) và lưu vào **MongoDB** + xuất **JSON backup**.

> Chạy **độc lập hoàn toàn** với `frontend/` và `backend/`, chỉ cần Node.js 18+ và MongoDB.

---

## 📁 Cấu trúc

```text
crawler/
├── src/
│   ├── models/          # Mongoose models (Movie, Category)
│   ├── services/        # CrawlerService (orchestrator)
│   ├── sources/         # Adapter cho từng nguồn (OPhim, KKPhim, Nguonc)
│   ├── utils/           # Logger, helpers (jsonBackup, logger)
│   ├── config.js        # Load env, cấu hình chung
│   └── index.js         # Entry point
├── scripts/             # CLI chạy nhanh từng nguồn
├── data/                # JSON backup (tự sinh)
├── package.json
└── .env.example
```

---

## 🚀 Cài đặt

### 1. Chuẩn bị môi trường

Yêu cầu: **Node.js >= 18**, **MongoDB** (local hoặc Atlas).

### 2. Cài dependencies

```bash
cd crawler
npm install
```

### 3. Tạo file `.env`

```bash
cp .env.example .env
```

Mở `.env` và chỉnh các thông số chính:

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `MONGODB_URI` | `mongodb://localhost:27017/movie_crawler` | Connection string MongoDB |
| `TOTAL_PAGES` | `1500` | Số trang muốn crawl mỗi nguồn |
| `PAGE_DELAY_MS` | `500` | Delay giữa các trang (tránh bị rate-limit) |
| `DETAIL_CONCURRENCY` | `5` | Số request chi tiết chạy song song |
| `ENABLE_OPHIM` | `true` | Bật/tắt nguồn OPhim |
| `ENABLE_KKPHIM` | `true` | Bật/tắt nguồn KKPhim |
| `ENABLE_NGUONC` | `true` | Bật/tắt nguồn Nguonc |
| `OPHIM_BASE_URL` | `https://ophim1.com` | URL gốc OPhim (đổi nếu domain đổi) |
| `KKPHIM_BASE_URL` | `https://kkphim.com` | URL gốc KKPhim |
| `NGUONC_BASE_URL` | `https://nguonc.com` | URL gốc Nguonc |
| `JSON_BACKUP` | `true` | Có ghi thêm file JSON ở `data/` không |
| `JSON_OUTPUT_DIR` | `./data` | Thư mục backup JSON |
| `LOG_LEVEL` | `info` | `error`, `warn`, `info`, `debug` |

### 4. Khởi động MongoDB (nếu chạy local)

```bash
mongod
```

---

## ▶️ Các lệnh chạy

Tất cả lệnh đều phải đứng trong thư mục `crawler/`.

### Chạy mặc định — theo cấu hình trong `.env`

```bash
npm start
```

→ Bật/tắt nguồn qua `ENABLE_*`, số trang qua `TOTAL_PAGES`.

### Crawl từng nguồn riêng

```bash
npm run crawl:ophim       # Chỉ OPhim (1 trang)
npm run crawl:ophim:all   # OPhim - toàn bộ trang trong TOTAL_PAGES
npm run crawl:kkphim      # Chỉ KKPhim
npm run crawl:nguonc      # Chỉ Nguonc
```

### Crawl tất cả nguồn đang enable

```bash
npm run crawl:all
```

### Export MongoDB → JSON

```bash
npm run export:json
```

### Test kết nối các endpoint nguồn

```bash
npm run test:endpoints
```

### Dev mode (tự restart khi sửa code)

```bash
npm run dev
```

---

## 📋 Ví dụ output khi chạy

```text
[ophim] Crawling page 1...
[ophim] Page 1: +24 new, ~0 updated
[ophim] Page 2: +18 new, ~6 updated
...
[ophim] DONE. Total: +12000 new, ~3000 updated
Backup written to ./data/ophim-2026-08-25.json
```

---

## 🌐 Các nguồn crawl

| Nguồn | URL mặc định | Đặc điểm |
|---|---|---|
| OPhim | `ophim1.com` | JSON chuẩn, miễn phí, nhiều phim nhất |
| KKPhim | `kkphim.com` | Open source CMS, có embed sẵn |
| Nguonc | `nguonc.com` | Tương thích cấu trúc OPhim |

---

## 📦 Schema lưu trữ (MongoDB)

Collection `movies` và `categories` giữ nguyên schema như bản gốc ở `backend/src/models/`, **không phụ thuộc Elasticsearch** nên chạy nhẹ hơn.

---

## 🛑 Tắt dừng an toàn

Nhấn `Ctrl+C` một lần, tiến trình sẽ:

1. Hoàn tất trang đang crawl
2. Đóng kết nối MongoDB
3. Thoát clean (không mất dữ liệu đã lưu)

---

## ⚠️ Lỗi thường gặp

| Lỗi | Nguyên nhân | Cách xử |
|---|---|---|
| `ECONNREFUSED 127.0.0.1:27017` | MongoDB chưa chạy | Chạy `mongod` trước |
| `401/403` từ API nguồn | Domain trong `.env` đã cũ | Đổi `*_BASE_URL` theo nguồn chính thức |
| `Cannot find module 'mongoose'` | Chưa `npm install` | Chạy lại `npm install` |
| Treo ở trang đầu | Sai URL nguồn | Kiểm tra `*_BASE_URL`, dùng `npm run test:endpoints` |

---

## 🔌 Tích hợp lại với backend cũ

Project crawler này chỉ làm nhiệm vụ **ghi dữ liệu**. Backend cũ vẫn đọc từ MongoDB như bình thường. Có thể:

- Chạy cronjob tách riêng:

  ```cron
  0 3 * * *  cd /path/to/crawler && npm run crawl:all
  ```

- Hoặc dùng Docker Compose gộp 3 service: `frontend`, `backend`, `crawler`