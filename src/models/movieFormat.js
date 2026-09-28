/**
 * Movie Format Junction Model
 * Source: movie_streaming_dbdiagram_v3.dbml
 *
 * Many-to-many relationship between movies and formats.
 * A movie can have multiple formats (e.g., FHD, HD, 4K).
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const movieFormatSchema = new Schema({
  movieId: {
    type: Schema.Types.ObjectId,
    ref: 'Movie',
    required: true
  },
  formatId: {
    type: Schema.Types.ObjectId,
    ref: 'Format',
    required: true
  }
}, {
  timestamps: true
});

// Unique compound index: movieId + formatId
// Prevents duplicate format assignments
movieFormatSchema.index(
  { movieId: 1, formatId: 1 },
  { unique: true, name: 'unique_movie_format' }
);

// Index for finding formats by movie
movieFormatSchema.index({ movieId: 1 });

// Index for finding movies by format
movieFormatSchema.index({ formatId: 1 });

// Compound index for format-based movie listing
movieFormatSchema.index(
  { formatId: 1, movieId: 1 },
  { name: 'idx_format_movies' }
);

/**
 * Static method to add format to movie
 */
movieFormatSchema.statics.addFormat = async function(movieId, formatId) {
  try {
    const item = await this.create({ movieId, formatId });
    return item;
  } catch (error) {
    // Ignore duplicate key error
    if (error.code === 11000) {
      return this.findOne({ movieId, formatId });
    }
    throw error;
  }
};

/**
 * Static method to remove format from movie
 */
movieFormatSchema.statics.removeFormat = async function(movieId, formatId) {
  return this.deleteOne({ movieId, formatId });
};

/**
 * Static method to set formats for a movie (replace all)
 */
movieFormatSchema.statics.setFormats = async function(movieId, formatIds) {
  // Delete existing
  await this.deleteMany({ movieId });
  
  // Create new
  if (formatIds && formatIds.length > 0) {
    const items = formatIds.map(formatId => ({ movieId, formatId }));
    await this.insertMany(items);
  }
};

/**
 * Static method to get formats for a movie
 */
movieFormatSchema.statics.getFormatsForMovie = async function(movieId) {
  const Format = mongoose.model('Format');
  const items = await this.find({ movieId }).lean();
  const formatIds = items.map(item => item.formatId);
  return Format.find({ _id: { $in: formatIds } }).lean();
};

/**
 * Static method to get movies by format
 */
movieFormatSchema.statics.getMoviesByFormat = async function(formatId) {
  const items = await this.find({ formatId }).lean();
  return items.map(item => item.movieId);
};

/**
 * Static method to get movie count per format
 */
movieFormatSchema.statics.getMovieCountPerFormat = async function() {
  return this.aggregate([
    {
      $group: {
        _id: '$formatId',
        count: { $sum: 1 }
      }
    }
  ]);
};

movieFormatSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

// Use hot-reload safe pattern to prevent registration errors
const MovieFormat = mongoose.models.MovieFormat || mongoose.model('MovieFormat', movieFormatSchema);

module.exports = MovieFormat;
