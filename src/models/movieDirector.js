const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const movieDirectorSchema = new Schema({
  movieId: {
    type: Schema.Types.ObjectId,
    ref: 'Movie',
    required: true,
    index: true
  },
  directorId: {
    type: Schema.Types.ObjectId,
    ref: 'Director',
    required: true,
    index: true
  },
  
  // ============================================================
  // ROLE INFO
  // ============================================================
  role: {
    type: String,
    enum: ['director', 'co-director', 'assistant-director', 'other'],
    default: 'director'
  },
  order: {
    type: Number,
    default: 0,
    min: 0 // 0 = first billing, 1 = second billing, etc.
  },
  
  // ============================================================
  // METADATA
  // ============================================================
  isMain: {
    type: Boolean,
    default: true
  },
  source: {
    type: String,
    enum: ['manual', 'ophim', 'kkphim', 'nguonc', 'tmdb', 'wikipedia', 'wikidata', 'import'],
    default: 'manual'
  }
}, {
  timestamps: true,
  collection: 'moviedirectors'
});

// ============================================================
// INDEXES
// ============================================================
movieDirectorSchema.index({ movieId: 1, directorId: 1 }, { unique: true });
movieDirectorSchema.index({ directorId: 1, createdAt: -1 });
movieDirectorSchema.index({ movieId: 1, order: 1 });

// ============================================================
// STATIC METHODS
// ============================================================

// Add director to movie
movieDirectorSchema.statics.addDirector = async function(movieId, directorId, options = {}) {
  try {
    const existing = await this.findOne({ movieId, directorId });
    if (existing) return existing;

    // Sanitize source — chỉ cho phép các giá trị trong enum
    const ALLOWED_SOURCES = ['manual', 'ophim', 'kkphim', 'nguonc', 'tmdb', 'wikipedia', 'wikidata', 'import'];
    const rawSource = options.source || 'manual';
    const source = ALLOWED_SOURCES.includes(rawSource) ? rawSource : 'manual';

    return await this.create({
      movieId,
      directorId,
      role: options.role || 'director',
      order: options.order || 0,
      isMain: options.isMain !== undefined ? options.isMain : true,
      source,
    });
  } catch (err) {
    // KHÔNG throw — caller sẽ log warning và tiếp tục pipeline
    console.warn(`[MovieDirector.addDirector] failed for movieId=${movieId} directorId=${directorId}: ${err.message}`);
    return null;
  }
};

// Remove director from movie
movieDirectorSchema.statics.removeDirector = async function(movieId, directorId) {
  return await this.deleteOne({ movieId, directorId });
};

// Get all directors for a movie
movieDirectorSchema.statics.getMovieDirectors = async function(movieId, options = {}) {
  const query = this.find({ movieId })
    .populate('directorId')
    .sort({ order: 1, createdAt: 1 });
  
  if (options.limit) query.limit(options.limit);
  
  return await query;
};

// Get all movies for a director
movieDirectorSchema.statics.getDirectorMovies = async function(directorId, options = {}) {
  const query = this.find({ directorId })
    .populate('movieId')
    .sort({ createdAt: -1 });
  
  if (options.limit) query.limit(options.limit);
  
  return await query;
};

// Set directors for a movie (replace all)
// directors = [{ directorId, role, order, isMain, source }]
//
// QUY TẮC (theo yêu cầu):
//   - Một director lỗi KHÔNG được fail toàn bộ quá trình save
//   - Sanitize `source` trước khi insert (loại bỏ giá trị không hợp lệ)
//   - Dùng ordered:false để 1 row lỗi không rollback các row khác
movieDirectorSchema.statics.setDirectors = async function(movieId, directors) {
  // Remove all existing
  try {
    await this.deleteMany({ movieId });
  } catch (err) {
    console.warn(`[MovieDirector.setDirectors] deleteMany failed for movieId=${movieId}: ${err.message}`);
    // Tiếp tục — không throw
  }

  if (!directors || directors.length === 0) return [];

  const ALLOWED_SOURCES = ['manual', 'ophim', 'kkphim', 'nguonc', 'tmdb', 'wikipedia', 'wikidata', 'import'];
  const ALLOWED_ROLES = ['director', 'co-director', 'assistant-director', 'other'];

  // Lọc + sanitize TỪNG record. Nếu record không hợp lệ → bỏ qua, log warning.
  const docs = [];
  for (let index = 0; index < directors.length; index++) {
    const director = directors[index] || {};
    if (!director.directorId) {
      console.warn(`[MovieDirector.setDirectors] skip record[${index}]: missing directorId`);
      continue;
    }
    const rawSource = director.source || 'manual';
    const source = ALLOWED_SOURCES.includes(rawSource) ? rawSource : 'manual';
    const rawRole = director.role || 'director';
    const role = ALLOWED_ROLES.includes(rawRole) ? rawRole : 'director';

    docs.push({
      movieId,
      directorId: director.directorId,
      role,
      order: typeof director.order === 'number' ? director.order : index,
      isMain: director.isMain !== undefined ? !!director.isMain : true,
      source,
    });
  }

  if (docs.length === 0) return [];

  try {
    // ordered:false → nếu 1 row fail validation, các row khác vẫn insert thành công
    return await this.insertMany(docs, { ordered: false });
  } catch (err) {
    if (err && err.insertedDocs && Array.isArray(err.insertedDocs)) {
      console.warn(`[MovieDirector.setDirectors] partial insert for movieId=${movieId}: ${err.message}`);
      return err.insertedDocs;
    }
    console.warn(`[MovieDirector.setDirectors] insertMany failed for movieId=${movieId}: ${err.message}`);
    return [];
  }
};

// Count movies for a director
movieDirectorSchema.statics.countDirectorMovies = async function(directorId) {
  return await this.countDocuments({ directorId });
};

// ============================================================
// HOOKS
// ============================================================

// Update director's movie count after save
movieDirectorSchema.post('save', async function(doc) {
  try {
    const Director = require('./director');
    const director = await Director.findById(doc.directorId);
    if (director) {
      await director.updateMovieCount();
    }
  } catch (err) {
    console.error('Error updating director movie count:', err);
  }
});

// Update director's movie count after delete
movieDirectorSchema.post('deleteOne', async function(doc) {
  try {
    if (doc && doc.directorId) {
      const Director = require('./director');
      const director = await Director.findById(doc.directorId);
      if (director) {
        await director.updateMovieCount();
      }
    }
  } catch (err) {
    console.error('Error updating director movie count:', err);
  }
});

// Use hot-reload safe pattern to prevent registration errors
const MovieDirector = mongoose.models.MovieDirector || mongoose.model('MovieDirector', movieDirectorSchema);

module.exports = MovieDirector;
