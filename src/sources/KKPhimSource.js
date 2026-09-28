/**
 * KKPhimSource - Adapter cho kkphim.com
 *
 * API docs:
 *   GET https://kkphim.com/api/danh-sach/phim-moi?page={n}
 *   GET https://kkphim.com/api/phim/{slug}
 */

const BaseSource = require('./BaseSource');

class KKPhimSource extends BaseSource {
  constructor(config) {
    super(config);
    this.baseUrl = config.baseUrl || 'https://kkphim.com/api';
    this._name = 'kkphim';
  }

  name() {
    return this._name;
  }

  async listMovies(page = 1) {
    const res = await this.axios.get('/danh-sach/phim-moi', {
      params: { page },
    });
    const data = res.data?.data?.items || res.data?.items || [];
    return data.map((m) => ({
      slug: m.slug,
      name: m.name,
      origin_name: m.origin_name,
      year: m.year,
    }));
  }

  async getMovieDetail(slug) {
    const res = await this.axios.get(`/phim/${slug}`);
    if (!res.data?.data) return null;
    return res.data.data;
  }

  // KkPhim trả về cấu trúc gần giống OPhim nên dùng chung normalize
  normalizeDetail(raw) {
    return new OPhimNormalizer().normalize(raw);
  }
}

class OPhimNormalizer {
  normalize(raw) {
    const { movie: movieInfo, episodes } = raw;
    if (!movieInfo) return null;
    return {
      tmdb: {
        type: movieInfo.tmdb?.type || null,
        id: movieInfo.tmdb?.id || '',
        season: movieInfo.tmdb?.season || null,
        vote_average: movieInfo.tmdb?.vote_average || 0,
        vote_count: movieInfo.tmdb?.vote_count || 0,
        trailer_url: movieInfo.trailer_url || '',
      },
      imdb: movieInfo.imdb || { id: '' },
      created: { time: movieInfo.created?.time || new Date() },
      modified: { time: movieInfo.modified?.time || new Date() },
      name: movieInfo.name,
      origin_name: movieInfo.origin_name || movieInfo.name,
      content: movieInfo.content || '',
      type: movieInfo.type || 'series',
      status: movieInfo.status || 'completed',
      thumb_url: movieInfo.thumb_url || '',
      poster_url: movieInfo.poster_url || '',
      backdrop_url: movieInfo.backdrop_url || '',
      trailer_url: movieInfo.trailer_url || '',
      time: movieInfo.time || '60 phút/tập',
      episode_current: movieInfo.episode_current || '',
      episode_total: movieInfo.episode_total || '',
      quality: movieInfo.quality || 'HD',
      lang: movieInfo.lang || 'Vietsub',
      slug: movieInfo.slug,
      year: movieInfo.year || new Date().getFullYear(),
      view: movieInfo.view || 0,
      actor: movieInfo.actor || [],
      director: movieInfo.director || [''],
      category: movieInfo.category || [],
      country: movieInfo.country || [],
      is_copyright: movieInfo.is_copyright || false,
      chieurap: movieInfo.chieurap || false,
      sub_docquyen: movieInfo.sub_docquyen || false,
      episodes: episodes || [],
    };
  }
}

module.exports = KKPhimSource;
