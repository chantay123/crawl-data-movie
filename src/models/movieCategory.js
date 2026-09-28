/**
 * Movie Category Junction Model
 * Many-to-many relationship between movies and categories
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const movieCategorySchema = new Schema({
  movieId: {
    type: Schema.Types.ObjectId,
    ref: 'Movie',
    required: true,
    index: true
  },
  categoryId: {
    type: Schema.Types.ObjectId,
    ref: 'Category',
    required: true,
    index: true
  }
}, {
  timestamps: true
});

// Unique compound index
movieCategorySchema.index({ movieId: 1, categoryId: 1 }, { unique: true });

// Static method to set categories for a movie
movieCategorySchema.statics.setCategories = async function(movieId, categoryIds) {
  // Delete existing categories for this movie
  await this.deleteMany({ movieId });
  
  // Add new categories
  if (categoryIds && categoryIds.length > 0) {
    const items = categoryIds.map(categoryId => ({ movieId, categoryId }));
    await this.insertMany(items, { ordered: false }).catch(err => {
      if (err.code !== 11000) throw err;
    });
  }
};

// Static method to get categories for a movie
movieCategorySchema.statics.getCategoriesForMovie = async function(movieId) {
  const items = await this.find({ movieId }).populate('categoryId').lean();
  return items.map(item => item.categoryId).filter(cat => cat !== null);
};

// Use hot-reload safe pattern to prevent registration errors
const MovieCategory = mongoose.models.MovieCategory || mongoose.model('MovieCategory', movieCategorySchema);

module.exports = MovieCategory;
