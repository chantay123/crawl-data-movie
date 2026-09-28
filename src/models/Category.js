/**
 * Category Model
 * Represents movie/series categories (genres)
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const categorySchema = new Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  slug: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    maxlength: 100
  },
  description: {
    type: String,
    maxlength: 500,
    default: ''
  },
  isActive: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

// Indexes
categorySchema.index({ slug: 1 }, { unique: true });
categorySchema.index({ name: 1 }, { unique: true });
categorySchema.index({ isActive: 1 });

// Static method to find or create
categorySchema.statics.findOrCreate = async function(data) {
  let category = await this.findOne({ slug: data.slug });
  if (!category) {
    category = await this.create(data);
  }
  return category;
};

// Use hot-reload safe pattern to prevent registration errors
const Category = mongoose.models.Category || mongoose.model('Category', categorySchema);

module.exports = Category;
