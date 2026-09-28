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
    enum: ['manual', 'ophim', 'kkphim', 'nguonc', 'tmdb', 'import'],
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
  const existing = await this.findOne({ movieId, directorId });
  if (existing) return existing;
  
  return await this.create({
    movieId,
    directorId,
    role: options.role || 'director',
    order: options.order || 0,
    isMain: options.isMain !== undefined ? options.isMain : true,
    source: options.source || 'manual'
  });
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
movieDirectorSchema.statics.setDirectors = async function(movieId, directors) {
  // directors = [{ directorId, role, order, isMain }]
  
  // Remove all existing
  await this.deleteMany({ movieId });
  
  // Add new ones
  if (!directors || directors.length === 0) return [];
  
  const docs = directors.map((director, index) => ({
    movieId,
    directorId: director.directorId,
    role: director.role || 'director',
    order: director.order !== undefined ? director.order : index,
    isMain: director.isMain !== undefined ? director.isMain : true,
    source: director.source || 'manual'
  }));
  
  return await this.insertMany(docs);
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
