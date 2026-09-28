/**
 * Movie Country Junction Model
 * Many-to-many relationship between movies and countries
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const movieCountrySchema = new Schema({
  movieId: {
    type: Schema.Types.ObjectId,
    ref: 'Movie',
    required: true,
    index: true
  },
  countryId: {
    type: Schema.Types.ObjectId,
    ref: 'Country',
    required: true,
    index: true
  }
}, {
  timestamps: true
});

// Unique compound index
movieCountrySchema.index({ movieId: 1, countryId: 1 }, { unique: true });

// Static method to set countries for a movie
movieCountrySchema.statics.setCountries = async function(movieId, countryIds) {
  // Delete existing countries for this movie
  await this.deleteMany({ movieId });
  
  // Add new countries
  if (countryIds && countryIds.length > 0) {
    const items = countryIds.map(countryId => ({ movieId, countryId }));
    await this.insertMany(items, { ordered: false }).catch(err => {
      if (err.code !== 11000) throw err;
    });
  }
};

// Static method to get countries for a movie
movieCountrySchema.statics.getCountriesForMovie = async function(movieId) {
  const items = await this.find({ movieId }).populate('countryId').lean();
  return items.map(item => item.countryId).filter(coun => coun !== null);
};

// Use hot-reload safe pattern to prevent registration errors
const MovieCountry = mongoose.models.MovieCountry || mongoose.model('MovieCountry', movieCountrySchema);

module.exports = MovieCountry;
