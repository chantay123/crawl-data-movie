/**
 * NguoncSource - Adapter cho phim.nguonc.com
 *
 * API docs (verified):
 *   GET https://phim.nguonc.com/api/films/phim-moi-cap-nhat?page={n}
 *   GET https://phim.nguonc.com/api/film/{slug}
 *
 * Response shapes:
 *   - list:   { items: [...], totalPages, currentPage, ... }
 *   - detail: { id, slug, name, original_name, thumb_url, poster_url,
 *               description, total_episodes, current_episode, time,
 *               quality, language, director, casts (CSV), created,
 *               modified, category: { groupName: { list:[{id,name}, ...] } },
 *               episodes: [ { server_name, items:[{name,slug,embed}, ...] } ] }
 */

const BaseSource = require('./BaseSource');
const logger = require('../utils/logger');

class NguoncSource extends BaseSource {
  constructor(config) {
    super(config);
    this.baseUrl = (config.baseUrl || 'https://phim.nguonc.com/api').replace(/\/$/, '');
    this._name = 'nguonc';
  }

  name() {
    return this._name;
  }

  async listMovies(page = 1) {
    const res = await this.axios.get('/films/phim-moi-cap-nhat', {
      params: { page },
    });
    const items = res.data?.items || res.data?.data?.items || [];
    return items
      .filter((m) => m && m.slug && typeof m.slug === 'string')
      .map((m) => ({
        slug: m.slug,
        name: m.name,
        origin_name: m.original_name || m.name,
        year: parseInt(m.year, 10) || new Date().getFullYear(),
      }));
  }

  async getMovieDetail(slug) {
    if (!slug || typeof slug !== 'string' || !slug.trim()) {
      return null;
    }
    try {
      const res = await this.axios.get(`/film/${encodeURIComponent(slug.trim())}`);
      return res.data?.movie || res.data?.data?.movie || res.data || null;
    } catch (err) {
      if (err.message?.includes('Invalid URL') || err.code === 'ERR_INVALID_URL') {
        logger.error(`[nguonc] Invalid slug: "${slug}" (chars=${JSON.stringify([...slug])})`);
      }
      throw err;
    }
  }

  // Helper: flatten category groups (Định dạng, Thể loại, Quốc gia, Năm) -> mảng {id,name,slug}
  // Phân loại theo tên nhóm nếu biết: "Quốc gia" -> countries, "Thể loại" -> category chính
  _flattenCategories(categoryObj) {
    if (!categoryObj || typeof categoryObj !== 'object') return [];
    const out = [];
    for (const groupKey of Object.keys(categoryObj)) {
      const group = categoryObj[groupKey];
      const list = Array.isArray(group) ? group : group?.list;
      if (!Array.isArray(list)) continue;
      const groupName = (group?.group?.name || '').toLowerCase();
      for (const item of list) {
        out.push({
          id: item.id || '',
          name: item.name || '',
          slug: (item.name || '').toString().toLowerCase().replace(/\s+/g, '-'),
          group: groupName,
        });
      }
    }
    return out;
  }

  // Lấy categories kèm gán group để tách quốc gia và năm
  _splitCategories(categories) {
    const category = [];
    const country = [];
    const years = [];
    const formats = [];
    
    for (const c of categories) {
      const groupLower = (c.group || '').toLowerCase();
      
      if (groupLower.includes('quốc gia') || groupLower === 'country') {
        country.push(c);
      } else if (groupLower.includes('năm') || groupLower === 'year') {
        years.push(c);
      } else if (groupLower.includes('định dạng') || groupLower === 'format' || groupLower === 'quality') {
        formats.push(c);
      } else {
        // Chỉ thể loại thực sự (Action, Drama...) mới vào category
        category.push(c);
      }
    }
    
    return { category, country, years, formats };
  }

  // Helper: split CSV "casts" thành mảng
  _splitCasts(castsStr) {
    if (!castsStr) return [];
    if (Array.isArray(castsStr)) return castsStr;
    return castsStr
      .toString()
      .split(/,\s*/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  normalizeDetail(raw) {
    if (!raw) return null;
    const movieInfo = raw;

    const allCats = this._flattenCategories(movieInfo.category);
    const { category, country, years, formats } = this._splitCategories(allCats);

    // Extract year from years array or use movieInfo.year as fallback
    let finalYear = parseInt(movieInfo.year, 10) || new Date().getFullYear();
    if (years.length > 0) {
      const yearFromCategory = parseInt(years[0].name, 10);
      if (!isNaN(yearFromCategory) && yearFromCategory >= 1900 && yearFromCategory <= 2100) {
        finalYear = yearFromCategory;
      }
    }

    // Extract quality from formats array or use movieInfo.quality as fallback
    let finalQuality = movieInfo.quality || 'HD';
    if (formats.length > 0 && formats[0].name) {
      finalQuality = formats[0].name;
    }

    return {
      tmdb: { 
        type: null, 
        id: '', 
        season: null, 
        vote_average: 0, 
        vote_count: 0,
        trailer_url: movieInfo.trailer_url || ''
      },
      imdb: { id: '' },
      created: { time: movieInfo.created ? new Date(movieInfo.created) : new Date() },
      modified: { time: movieInfo.modified ? new Date(movieInfo.modified) : new Date() },
      name: movieInfo.name,
      origin_name: movieInfo.original_name || movieInfo.name,
      content: movieInfo.description || '',
      type: movieInfo.type || (movieInfo.total_episodes > 1 ? 'series' : 'single'),
      status: movieInfo.current_episode && movieInfo.total_episodes
        ? (String(movieInfo.current_episode).toLowerCase().includes('full') ||
           parseInt(String(movieInfo.current_episode).replace(/\D/g, ''), 10) >= movieInfo.total_episodes
            ? 'completed'
            : 'ongoing')
        : 'completed',
      thumb_url: movieInfo.thumb_url || '',
      poster_url: movieInfo.poster_url || '',
      backdrop_url: movieInfo.backdrop_url || '',
      trailer_url: movieInfo.trailer_url || '',
      time: movieInfo.time || '60 phút/tập',
      episode_current: movieInfo.current_episode || '',
      episode_total: movieInfo.total_episodes ? String(movieInfo.total_episodes) : '',
      quality: finalQuality,
      lang: movieInfo.language || 'Vietsub',
      notify: '',
      showtimes: '',
      slug: movieInfo.slug,
      year: finalYear,
      view: movieInfo.view || 0,
      actor: this._splitCasts(movieInfo.casts),
      director: movieInfo.director ? movieInfo.director.split(/,\s*/).filter(Boolean) : [''],
      category,
      country,
      is_copyright: false,
      chieurap: false,
      sub_docquyen: false,
      // nguonc dùng "items" trong episodes (không phải server_data) và "embed" (không phải link_embed/link_m3u8)
      episodes: Array.isArray(movieInfo.episodes)
        ? movieInfo.episodes.map((s) => ({
            server_name: s.server_name || 'Server',
            server_data: Array.isArray(s.items)
              ? s.items.map((e) => ({
                  name: e.name,
                  slug: e.slug,
                  filename: e.slug || '',
                  link_embed: e.embed || '',
                  link_m3u8: '',
                }))
              : [],
          }))
        : [],
    };
  }
}

module.exports = NguoncSource;
