/**
 * Format Model - New Master Data
 * Clean Architecture - MongoDB Best Practices
 * 
 * Master data for movie quality/formats.
 * Examples: FHD, HD, CAM, Trailer, BluRay
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const formatSchema = new Schema({
  name: {
    type: String,
    required: true,
    maxlength: 100,
    trim: true
  },
  slug: {
    type: String,
    required: true,
    maxlength: 100,
    trim: true,
    lowercase: true
  },
  description: {
    type: String,
    maxlength: 255,
    default: ''
  },
  sortOrder: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// ============================================================
// INDEXES
// ============================================================

formatSchema.index({ name: 1 }, { unique: true });
formatSchema.index({ slug: 1 }, { unique: true });
formatSchema.index({ sortOrder: 1 }, { name: 'idx_sort_order' });

// ============================================================
// PRE-SAVE HOOK
// ============================================================

formatSchema.pre('save', function(next) {
  if (this.isModified('name') && !this.slug) {
    this.slug = this.name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
  }
  next();
});

// ============================================================
// STATIC METHODS
// ============================================================

/**
 * Find or create format
 */
formatSchema.statics.findOrCreate = async function(data) {
  let format = await this.findOne({ slug: data.slug });
  
  if (!format) {
    format = await this.create(data);
  }
  
  return format;
};

/**
 * Find by name (case insensitive)
 */
formatSchema.statics.findByName = async function(name) {
  return this.findOne({ 
    name: { $regex: new RegExp(`^${name}$`, 'i') } 
  });
};

/**
 * Get all formats sorted
 */
formatSchema.statics.getAllSorted = async function() {
  return this.find().sort({ sortOrder: 1, name: 1 }).lean();
};

// ============================================================
// JSON TRANSFORM
// ============================================================

formatSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    ret.id = ret._id;
    delete ret._id;
    delete ret.__v;
    return ret;
  }
});

// Use hot-reload safe pattern to prevent registration errors
const Format = mongoose.models.Format || mongoose.model('Format', formatSchema);

module.exports = Format;
