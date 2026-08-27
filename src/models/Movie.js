const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const movieSchema = new Schema(
  {
    tmdb: {
      type: { type: String, default: null },
      id: { type: String, default: '' },
      season: { type: Number, default: null },
      vote_average: { type: Number, default: 0 },
      vote_count: { type: Number, default: 0 },
    },
    imdb: {
      id: { type: String, default: '' },
    },
    created: {
      time: { type: Date, default: Date.now },
    },
    modified: {
      time: { type: Date, default: Date.now },
    },
    name: { type: String, required: true },
    origin_name: { type: String, required: true },
    content: { type: String, default: '' },
    type: { type: String, default: 'series' },
    status: { type: String, default: 'completed' },
    thumb_url: { type: String, default: '' },
    trailer_url: { type: String, default: '' },
    time: { type: String, default: '60 phút/tập' },
    episode_current: { type: String, default: '' },
    episode_total: { type: String, default: '' },
    quality: { type: String, default: 'HD' },
    lang: { type: String, default: 'Vietsub' },
    notify: { type: String, default: '' },
    showtimes: { type: String, default: '' },
    slug: { type: String, required: true, unique: true },
    year: { type: Number, required: true },
    view: { type: Number, default: 0 },
    actor: [{ type: String }],
    director: [{ type: String }],
    category: [
      {
        id: { type: String },
        name: { type: String },
        slug: { type: String },
      },
    ],
    country: [
      {
        id: { type: String },
        name: { type: String },
        slug: { type: String },
      },
    ],
    is_copyright: { type: Boolean, default: false },
    chieurap: { type: Boolean, default: false },
    poster_url: { type: String, default: '' },
    sub_docquyen: { type: Boolean, default: false },
    isHidden: { type: Boolean, default: false },
    episodes: [
      {
        server_name: { type: String, required: true },
        server_data: [
          {
            name: { type: String, required: true },
            slug: { type: String, required: true },
            filename: { type: String, required: true },
            link_embed: { type: String, default: '' },
            link_m3u8: { type: String, default: '' },
          },
        ],
      },
    ],
    // Metadata từ crawler
    _source: { type: String, default: 'unknown' },
    _crawledAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('Movie', movieSchema);
