/**
 * OpenAPI 3.0 specification cho Crawler REST API
 * Phục vụ cho Swagger UI tại /docs
 */

module.exports = {
  openapi: '3.0.3',
  info: {
    title: 'Movie Crawler API',
    version: '1.0.0',
    description: `
REST API + Swagger UI cho Movie Crawler.

Cho phép:
- Xem danh sách phim đã crawl trong MongoDB
- Trigger crawl OPhim/KKPhim/Nguonc theo trang hoặc toàn bộ
- Theo dõi tiến trình các job crawl đang chạy nền

Crawler gốc (CLI) vẫn hoạt động độc lập qua \`npm start\` — API này chỉ là wrapper bổ sung.
`,
    contact: { name: 'Movie Crawler' },
    license: { name: 'MIT' },
  },
  servers: [
    { url: 'http://localhost:3000', description: 'Local dev' },
  ],
  tags: [
    { name: 'health', description: 'Health check & status' },
    { name: 'sources', description: 'Danh sách nguồn crawl' },
    { name: 'movies', description: 'Query phim trong MongoDB' },
    { name: 'crawl', description: 'Trigger crawl job (background)' },
    { name: 'jobs', description: 'Theo dõi job crawl' },
  ],
  paths: {
    '/health': {
      get: {
        tags: ['health'],
        summary: 'Health check',
        description: 'Kiểm tra server + trạng thái kết nối MongoDB + danh sách nguồn đang bật',
        responses: {
          200: {
            description: 'OK',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/sources': {
      get: {
        tags: ['sources'],
        summary: 'Danh sách nguồn crawl',
        description: 'Trả về các nguồn OPhim / KKPhim / Nguonc kèm trạng thái enabled',
        responses: {
          200: {
            description: 'OK',
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      },
    },
    '/movies': {
      get: {
        tags: ['movies'],
        summary: 'Danh sách phim trong DB',
        parameters: [
          { in: 'query', name: 'page', schema: { type: 'integer', default: 1 } },
          { in: 'query', name: 'limit', schema: { type: 'integer', default: 20 } },
          { in: 'query', name: 'source', schema: { type: 'string' } },
          { in: 'query', name: 'q', schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'OK' },
        },
      },
    },
    '/movies/stats': {
      get: {
        tags: ['movies'],
        summary: 'Thống kê số phim theo _source',
        responses: { 200: { description: 'OK' } },
      },
    },
    '/movies/{slug}': {
      get: {
        tags: ['movies'],
        summary: 'Chi tiết 1 phim theo slug',
        parameters: [
          { in: 'path', name: 'slug', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'OK' },
          404: { description: 'Movie not found' },
        },
      },
    },
    '/crawl/page': {
      post: {
        tags: ['crawl'],
        summary: 'Crawl 1 trang của 1 nguồn (background job)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['source'],
            properties: {
              source: { type: 'string', enum: ['ophim', 'kkphim', 'nguonc'] },
              page: { type: 'integer', default: 1 },
            },
          } } },
        },
        responses: {
          202: { description: 'Job queued' },
          400: { description: 'Bad request' },
        },
      },
    },
    '/crawl/all': {
      post: {
        tags: ['crawl'],
        summary: 'Crawl toàn bộ trang của 1 nguồn (background job)',
        requestBody: {
          required: true,
          content: { 'application/json': { schema: {
            type: 'object',
            required: ['source'],
            properties: {
              source: { type: 'string', enum: ['ophim', 'kkphim', 'nguonc'] },
              totalPages: { type: 'integer', default: 3337, description: 'Số trang tối đa. Nếu bỏ trống sẽ dùng TOTAL_PAGES từ .env (3337).' },
            },
          } } },
        },
        responses: {
          202: { description: 'Job queued' },
          400: { description: 'Bad request' },
        },
      },
    },
    '/jobs': {
      get: {
        tags: ['jobs'],
        summary: 'Danh sách job crawl',
        responses: { 200: { description: 'OK' } },
      },
    },
    '/jobs/{id}': {
      get: {
        tags: ['jobs'],
        summary: 'Chi tiết 1 job',
        parameters: [
          { in: 'path', name: 'id', required: true, schema: { type: 'string' } },
        ],
        responses: {
          200: { description: 'OK' },
          404: { description: 'Job not found' },
        },
      },
    },
  },
  components: {
    schemas: {
      Movie: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          origin_name: { type: 'string' },
          slug: { type: 'string' },
          year: { type: 'integer' },
          content: { type: 'string' },
          type: { type: 'string', example: 'series' },
          status: { type: 'string', example: 'completed' },
          thumb_url: { type: 'string' },
          poster_url: { type: 'string' },
          episode_current: { type: 'string' },
          episode_total: { type: 'string' },
          quality: { type: 'string', example: 'HD' },
          lang: { type: 'string', example: 'Vietsub' },
          actor: { type: 'array', items: { type: 'string' } },
          director: { type: 'array', items: { type: 'string' } },
          category: { type: 'array', items: { type: 'object' } },
          country: { type: 'array', items: { type: 'object' } },
          episodes: { type: 'array', items: { type: 'object' } },
          _source: { type: 'string' },
          _crawledAt: { type: 'string', format: 'date-time' },
          createdAt: { type: 'string', format: 'date-time' },
          updatedAt: { type: 'string', format: 'date-time' },
        },
      },
      Job: {
        type: 'object',
        properties: {
          id: { type: 'string', example: 'job_1724610000000_1' },
          name: { type: 'string', enum: ['crawl-page', 'crawl-all'] },
          source: { type: 'string', enum: ['ophim', 'kkphim', 'nguonc'] },
          status: { type: 'string', enum: ['running', 'completed', 'failed'] },
          totalPages: { type: 'integer' },
          currentPage: { type: 'integer' },
          saved: { type: 'integer', description: 'Số phim mới lưu' },
          updated: { type: 'integer', description: 'Số phim cũ được update tập' },
          errors: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                page: { type: 'integer' },
                error: { type: 'string' },
              },
            },
          },
          startedAt: { type: 'string', format: 'date-time' },
          finishedAt: { type: 'string', format: 'date-time', nullable: true },
          lastPage: { type: 'integer', description: 'Trang cuối cùng đã xử lý trước khi dừng (do auto-stop hoặc đủ totalPages)' },
        },
      },
    },
  },
};
