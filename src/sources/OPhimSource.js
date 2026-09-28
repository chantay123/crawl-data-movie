/**
 * OPhimSource - Adapter cho ophim1.com
 *
 * API docs:
 *   GET https://ophim1.com/v1/api/danh-sach/phim-moi?page={n}
 *   GET https://ophim1.com/v1/api/phim/{slug}
 */

const BaseSource = require('./BaseSource');

class OPhimSource extends BaseSource {
  constructor(config) {
    super(config);
    this.baseUrl = config.baseUrl || 'https://ophim1.com/v1/api';
    this._name = 'ophim';
  }

  name() {
    return this._name;
  }

  async listMovies(page = 1) {
    const res = await this.axios.get('/danh-sach/phim-moi', {
      params: { page },
    });
    const data = res.data?.data?.items || [];
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

  normalizeDetail(raw) {
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
      imdb: { id: movieInfo.imdb?.id || '' },
      created: { time: movieInfo.created?.time || new Date() },
      modified: { time: movieInfo.modified?.time || new Date() },
      name: movieInfo.name,
      origin_name: movieInfo.origin_name,
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
      notify: movieInfo.notify || '',
      showtimes: movieInfo.showtimes || '',
      slug: movieInfo.slug,
      year: movieInfo.year || new Date().getFullYear(),
      view: movieInfo.view || 0,
      actor: Array.isArray(movieInfo.actor) ? movieInfo.actor : [],
      director: Array.isArray(movieInfo.director) ? movieInfo.director : [''],
      category: (movieInfo.category || []).map((c) => ({
        id: c.id || '',
        name: c.name || '',
        slug: c.slug || '',
      })),
      country: (movieInfo.country || []).map((c) => ({
        id: c.id || '',
        name: c.name || '',
        slug: c.slug || '',
      })),
      is_copyright: movieInfo.is_copyright || false,
      chieurap: movieInfo.chieurap || false,
      sub_docquyen: movieInfo.sub_docquyen || false,
      episodes: (episodes || []).map((s) => ({
        server_name: s.server_name,
        server_data: s.server_data.map((e) => ({
          name: e.name,
          slug: e.slug,
          filename: e.filename,
          link_embed: e.link_embed,
          link_m3u8: e.link_m3u8,
        })),
      })),
    };
  }
}

module.exports = OPhimSource;
