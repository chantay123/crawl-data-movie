/**
 * Country Model
 * Represents movie/series countries of origin
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const countrySchema = new Schema({
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
countrySchema.index({ slug: 1 }, { unique: true });
countrySchema.index({ name: 1 }, { unique: true });
countrySchema.index({ isActive: 1 });

// Static method to find or create
countrySchema.statics.findOrCreate = async function(data) {
  let country = await this.findOne({ slug: data.slug });
  if (!country) {
    country = await this.create(data);
  }
  return country;
};

// Use hot-reload safe pattern to prevent registration errors
const Country = mongoose.models.Country || mongoose.model('Country', countrySchema);

module.exports = Country;
