# Movie Crawler

Hệ thống crawl dữ liệu phim từ nhiều nguồn API phim Việt Nam (OPhim, KKPhim, Nguonc...) và lưu vào **MongoDB** với **schema chuẩn hóa**.

> **Architect Decision:** Crawler và Backend **dùng chung database** và **shared models** để đảm bảo data consistency.

---

## 🏗️ Kiến trúc

### Database Architecture
```
Shared Database: movie-api
├── movies (main collection)
├── categories (master data)
├── countries (master data)
├── formats (master data)
├── movie_categories (junction table - many-to-many)
└── movie_countries (junction table - many-to-many)
```

### Folder Structure
```text
crawler/
├── src/
│   ├── models/
│   │   └── index.js           # Import models từ backend (shared)
│   ├── services/
│   │   ├── MovieService.js    # Business logic: save movies với relationships
│   │   └── CrawlerService.js  # Orchestrator: crawl pages, fetch details
│   ├── sources/               # Adapters cho từng nguồn
│   │   ├── BaseSource.js
│   │   ├── OPhimSource.js
│   │   ├── KKPhimSource.js
│   │   └── NguoncSource.js
│   ├── utils/
│   │   ├── db.js             # MongoDB connection
│   │   ├── logger.js
│   │   └── jsonBackup.js
│   ├── constants/
│   │   └── enums.js          # Import từ backend (shared)
│   ├── config.js
│   └── index.js
├── scripts/
│   ├── crawl-ophim.js
│   ├── crawl-all.js
│   ├── test-database-connection.js
│   └── migrate-to-normalized-schema.js
├── DATABASE_ARCHITECTURE.md   # 📚 Chi tiết kiến trúc database
├── package.json
└── .env
```

---

## 🚀 Cài đặt

### 1. Yêu cầu
- **Node.js >= 18**
- **MongoDB** (local hoặc Atlas)
- Backend đã setup (để shared models)

### 2. Cài dependencies
```bash
cd crawler
npm install
```

### 3. Cấu hình `.env`
```bash
cp .env.example .env
```

**Quan trọng:** Đảm bảo `MONGODB_URI` giống với backend:

```bash
# Crawler .env
MONGODB_URI='mongodb://127.0.0.1:27017/movie-api'
MONGODB_NAME=movie-api

# Backend .env (phải giống)
MONGODB_URI='mongodb://127.0.0.1:27017/movie-api'
```

### 4. Test kết nối database
```bash
npm run test:db
```

Output mong đợi:
```
✅ Connected to MongoDB: mongodb://127.0.0.1:27017/movie-api
   Database: movie-api
   Models Loaded: 6
✓ Movie: 0 documents (collection: movies)
✓ Category: 0 documents (collection: categories)
✓ Country: 0 documents (collection: countries)
...
```

---

## 📋 Các lệnh chạy

### Crawl phim
```bash
# Crawl 1 trang từ OPhim
npm run crawl:ophim

# Crawl tất cả trang từ OPhim (theo TOTAL_PAGES trong .env)
npm run crawl:ophim:all

# Crawl từ KKPhim
npm run crawl:kkphim

# Crawl từ Nguonc
npm run crawl:nguonc

# Crawl tất cả nguồn (theo ENABLE_* trong .env)
npm run crawl:all
```

### Test & Migration
```bash
# Test database connection
npm run test:db

# Migrate data cũ sang normalized schema
npm run migrate

# Test API endpoints
npm run test:endpoints
```

### Development
```bash
# Dev mode với auto-restart
npm run dev

# Start API server (Swagger UI)
npm run server
```

---

## 🎯 Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                      CRAWLER DATA FLOW                       │
└─────────────────────────────────────────────────────────────┘

OPhim API (ophim1.com)
    ↓
OPhimSource.listMovies(page)        → Get movie list
    ↓
OPhimSource.getMovieDetail(slug)    → Get full details
    ↓
OPhimSource.normalizeDetail(raw)    → Transform to standard format
    ↓
CrawlerService._fetchDetails()      → Concurrent fetching (p-limit)
    ↓
MovieService.saveMovie()            → Business logic
    ↓
    ├─→ _transformMovieData()       → Map to backend schema
    ├─→ Movie.findOneAndUpdate()    → Upsert movie
    ├─→ _handleCategories()         → Create/link categories
    │   ├─→ Category.upsert
    │   └─→ MovieCategory.insert
    ├─→ _handleCountries()          → Create/link countries
    │   ├─→ Country.upsert
    │   └─→ MovieCountry.insert
    └─→ _handleFormat()             → Create format
        └─→ Format.upsert
    ↓
MongoDB (shared database)
    ↓
Backend API có thể query ngay lập tức
```

---

## 📊 Schema Mapping

### Source Data (OPhim API) → Backend Schema

| Source Field | Backend Field | Note |
|--------------|---------------|------|
| `movie.name` | `name` | ✓ |
| `movie.origin_name` | `originName` | ✓ |
| `movie.slug` | `slug` | Unique index |
| `movie.type` | `type` | Map: series/single/tvshows/hoathinh |
| `movie.category[]` | → Categories + MovieCategory | Normalized |
| `movie.country[]` | → Countries + MovieCountry | Normalized |
| `movie.quality` | `quality` + Format | Master data |
| `movie.thumb_url` | `thumbUrl` | ✓ |
| `movie.poster_url` | `posterUrl` | ✓ |
| `movie.trailer_url` | `trailerUrl` | ✓ |
| `movie.actor[]` | `actor[]` | Embedded array |
| `movie.director[]` | `director[]` | Embedded array |
| `episodes[]` | `episodes[]` | Embedded array |
| `movie.tmdb` | `tmdbType`, `tmdbId`, etc. | Flattened |
| `movie.imdb` | `imdbId` | Flattened |

---

## 🔥 Key Features

### 1. **Shared Models với Backend**
```javascript
// crawler/src/models/index.js
const Movie = require('../../backend/src/models/movie');
const Category = require('../../backend/src/models/category');
// → Dùng chung schema, không duplicate code
```

### 2. **Normalized Relationships**
```javascript
// Before (embedded)
{
  "_id": "...",
  "category": [{"name": "Action"}, {"name": "Drama"}]
}

// After (normalized)
movies: { "_id": "...", "name": "Movie" }
categories: { "_id": "c1", "name": "Action" }
movie_categories: { "movieId": "...", "categoryId": "c1" }
```

### 3. **Transaction Support**
```javascript
const session = await mongoose.startSession();
session.startTransaction();
try {
  await Movie.create(..., { session });
  await MovieCategory.insertMany(..., { session });
  await session.commitTransaction();
} catch (error) {
  await session.abortTransaction();
}
```

### 4. **Smart Upsert Strategy**
- Movies: Upsert by `slug` hoặc `source + sourceId`
- Categories/Countries: Upsert by `slug`
- Junction tables: Replace strategy (delete + insert)

### 5. **Episode Merging**
```javascript
// Existing movie có episodes cũ
// New crawl data có episodes mới
// → Merge: giữ cũ + thêm mới (không duplicate)
MovieService.updateEpisodes(movieId, newEpisodes);
```

---

## 📈 Ví dụ Output

```bash
$ npm run crawl:ophim

[ophim] Crawling page 1...
✓ Created movie: Venom: Kèo Cuối (venom-keo-cuoi) [Categories: 2, Countries: 1]
✓ Created movie: Avatar 2 (avatar-2) [Categories: 3, Countries: 1]
✓ Updated movie: One Piece (one-piece) [Categories: 2, Countries: 1]
Updated episodes: One Piece (+5 episodes)
[ophim] Page 1: +18 new, ~6 updated

========================================
Crawl Summary
========================================
Source: ophim
Total Pages Crawled: 1
New Movies: 18
Updated Movies: 6
Errors: 0
Duration: 45s
```

---

## 🛠️ Advanced Usage

### 1. Query Movies với Relationships

```javascript
const MovieService = require('./src/services/MovieService');

// Get movie với categories và countries
const movie = await MovieService.getMovieWithRelations(movieId);

console.log(movie.name);        // "Venom: Kèo Cuối"
console.log(movie.categories);  // [{ name: "Action", slug: "action" }, ...]
console.log(movie.countries);   // [{ name: "USA", slug: "usa" }]
```

### 2. Backend Query Examples

```javascript
// Get movies by category
const MovieCategory = require('./models/movieCategory');
const categoryId = '...';
const movieIds = await MovieCategory.getMoviesByCategory(categoryId);

// Get popular categories
const stats = await MovieCategory.aggregate([
  { $group: { _id: '$categoryId', count: { $sum: 1 } } },
  { $sort: { count: -1 } },
  { $limit: 10 }
]);
```

### 3. Cron Job Setup

```bash
# /etc/cron.d/movie-crawler
0 3 * * * cd /path/to/crawler && npm run crawl:all >> /var/log/crawler.log 2>&1
```

---

## 📚 Documentation

- **[DATABASE_ARCHITECTURE.md](./DATABASE_ARCHITECTURE.md)** - Chi tiết về kiến trúc database
- **[.env.example](./.env.example)** - Tất cả environment variables

---

## ⚠️ Important Notes

### 1. Database Consistency
- Crawler và Backend **PHẢI** dùng chung `MONGODB_URI`
- Không được tự ý thay đổi schema trong crawler
- Mọi thay đổi schema phải làm ở backend trước

### 2. Error Handling
- Transaction tự động rollback khi có lỗi
- Failed movies được log nhưng không block toàn bộ crawl
- Retry logic: không có (tránh infinite loop)

### 3. Performance
- Concurrency: 5 requests đồng thời (có thể tăng trong `.env`)
- Page delay: 1500ms (tránh rate limit)
- Transaction overhead: ~10-15ms per movie

### 4. Data Migration
Nếu đã có data cũ với embedded categories/countries:
```bash
# Backup trước
mongodump --uri="mongodb://localhost:27017/movie-api"

# Run migration
npm run migrate

# Verify
npm run test:db
```

---

## 🤝 Backend Integration

Backend không cần thay đổi gì, chỉ cần:

1. **Query movies bình thường:**
   ```javascript
   const movies = await Movie.find({ type: 'series' }).limit(24);
   ```

2. **Query với relationships:**
   ```javascript
   const categories = await MovieCategory.getCategoriesForMovie(movieId);
   const countries = await MovieCountry.getCountriesForMovie(movieId);
   ```

3. **Aggregate queries:**
   ```javascript
   const topCategories = await MovieCategory.getMovieCountPerCategory();
   ```

---

## 🐛 Troubleshooting

| Lỗi | Nguyên nhân | Giải pháp |
|-----|-------------|-----------|
| `Cannot find module '../../backend/src/models/movie'` | Path không đúng | Đảm bảo folder structure: `MovieStreaming/crawler` và `MovieStreaming/backend` |
| `Transaction failed` | MongoDB không hỗ trợ transactions (standalone) | Dùng MongoDB replica set hoặc Atlas |
| `Duplicate key error` | Race condition | Bình thường, được handle trong code |
| `ECONNREFUSED 27017` | MongoDB chưa chạy | `mongod` hoặc start MongoDB service |

---

## 📞 Contact

- Issues: [GitHub Issues](#)
- Documentation: See `DATABASE_ARCHITECTURE.md`

---

**Built with 💪 by Senior Backend Developer**
*Shared Database Architecture - September 2026*
