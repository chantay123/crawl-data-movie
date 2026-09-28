/**
 * Movie Year Junction Model
 * Many-to-many relationship between movies and years
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const movieYearSchema = new Schema({
  movieId: {
    type: Schema.Types.ObjectId,
    ref: 'Movie',
    required: true,
    index: true
  },
  yearId: {
    type: Schema.Types.ObjectId,
    ref: 'Year',
    required: true,
    index: true
  }
}, {
  timestamps: true
});

// Unique compound index
movieYearSchema.index({ movieId: 1, yearId: 1 }, { unique: true });

// Static method to set year for a movie (usually just one year)
movieYearSchema.statics.setYear = async function(movieId, yearId) {
  // Delete existing year for this movie
  await this.deleteMany({ movieId });
  
  // Add new year
  if (yearId) {
    await this.create({ movieId, yearId });
  }
};

// Static method to get year for a movie
movieYearSchema.statics.getYearForMovie = async function(movieId) {
  const item = await this.findOne({ movieId }).populate('yearId').lean();
  return item ? item.yearId : null;
};

// Use hot-reload safe pattern to prevent registration errors
const MovieYear = mongoose.models.MovieYear || mongoose.model('MovieYear', movieYearSchema);

module.exports = MovieYear;
