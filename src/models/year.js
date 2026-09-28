/**
 * Year Model
 * Represents movie release years
 * Structure: name, slug, description, isActive (like Category, Country, Format)
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const yearSchema = new Schema({
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 10
  },
  slug: {
    type: String,
    required: true,
    trim: true,
    lowercase: true,
    maxlength: 10
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
yearSchema.index({ slug: 1 }, { unique: true });
yearSchema.index({ name: 1 }, { unique: true });
yearSchema.index({ isActive: 1 });

/**
 * Auto-generate slug from name if not provided
 */
yearSchema.pre('save', function(next) {
  if (this.isModified('name') && !this.slug) {
    this.slug = this.name.toLowerCase();
  }
  next();
});

/**
 * Static method to find or create by year value (e.g., "2026")
 * @param {String|Number} yearValue - Year to find or create
 */
yearSchema.statics.findOrCreate = async function(yearValue) {
  const name = String(yearValue);
  const slug = name.toLowerCase();
  
  let year = await this.findOne({ slug });
  if (!year) {
    year = await this.create({ name, slug });
  }
  return year;
};

/**
 * Static method to find by name (case insensitive)
 * @param {String|Number} yearValue - Year to find
 */
yearSchema.statics.findByName = async function(yearValue) {
  return this.findOne({ 
    name: String(yearValue) 
  });
};

/**
 * Static method to get all active years sorted by name descending
 */
yearSchema.statics.getAllActive = async function() {
  return this.find({ isActive: true })
    .sort({ name: -1 })
    .lean();
};

// Use hot-reload safe pattern to prevent registration errors
const Year = mongoose.models.Year || mongoose.model('Year', yearSchema);

module.exports = Year;
