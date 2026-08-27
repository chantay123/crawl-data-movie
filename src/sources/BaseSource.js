/**
 * BaseSource - Interface chung cho mọi nguồn crawl
 *
 * Mỗi nguồn cần implement:
 *   - name(): trả về tên nguồn (vd: 'ophim')
 *   - listMovies(page): lấy danh sách phim theo trang
 *   - getMovieDetail(slug): lấy chi tiết 1 phim
 *   - normalizeDetail(raw): convert dữ liệu thô → schema chuẩn
 */

class BaseSource {
  constructor(config = {}) {
    this.config = config;
    const baseURL = (config.baseUrl || this.baseUrl || '').replace(/\/$/, '');
    this.baseUrl = baseURL;
    this.axios = require('axios').create({
      baseURL,
      timeout: 30000,
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/json',
      },
    });
    this.axios.interceptors.response.use(
      (res) => {
        const ct = (res.headers?.['content-type'] || '').toLowerCase();
        if (!ct.includes('application/json')) {
          const preview = String(res.data || '').slice(0, 120).replace(/\s+/g, ' ');
          throw new Error(
            `Non-JSON response (${ct || 'unknown'}): ${preview}`
          );
        }
        return res;
      },
      (err) => {
        const status = err.response?.status;
        const preview = err.response?.data
          ? String(err.response.data).slice(0, 120).replace(/\s+/g, ' ')
          : '';
        if (status) {
          err.message = `HTTP ${status} ${err.response.statusText || ''}${preview ? ` - ${preview}` : ''}`.trim();
        }
        return Promise.reject(err);
      }
    );
  }

  name() {
    throw new Error('Source must implement name()');
  }

  async listMovies(page) {
    throw new Error('Source must implement listMovies(page)');
  }

  async getMovieDetail(slug) {
    throw new Error('Source must implement getMovieDetail(slug)');
  }

  normalizeDetail(raw) {
    throw new Error('Source must implement normalizeDetail(raw)');
  }
}

module.exports = BaseSource;
