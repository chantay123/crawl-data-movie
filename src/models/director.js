const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const directorSchema = new Schema({
  // ============================================================
  // BASIC INFO (required)
  // ============================================================
  name: {
    type: String,
    required: true,
    maxlength: 255,
    trim: true,
    index: true
  },
  slug: {
    type: String,
    required: true,
    unique: true,
    maxlength: 300,
    trim: true,
    lowercase: true,
    index: true
  },
  
  // ============================================================
  // ESSENTIAL INFO
  // ============================================================
  profileImage: {
    type: String,
    maxlength: 500,
    default: ''
  },
  dateOfBirth: {
    type: Date,
    default: null
  },
  gender: {
    type: String,
    enum: ['male', 'female', 'other', 'unknown'],
    default: 'unknown'
  },
  
  // ============================================================
  // STATISTICS (cached)
  // ============================================================
  movieCount: {
    type: Number,
    default: 0,
    min: 0
  },
  
  // ============================================================
  // STATUS
  // ============================================================
  isActive: {
    type: Boolean,
    default: true,
    index: true
  },
  
  // ============================================================
  // METADATA
  // ============================================================
  source: {
    type: String,
    enum: ['manual', 'ophim', 'kkphim', 'nguonc', 'tmdb', 'import'],
    default: 'manual'
  },
  externalId: {
    type: String,
    maxlength: 100,
    default: ''
  }
}, {
  timestamps: true,
  collection: 'directors'
});

// ============================================================
// INDEXES
// ============================================================
directorSchema.index({ name: 'text' });
directorSchema.index({ movieCount: -1 });
directorSchema.index({ slug: 1, isActive: 1 });

// ============================================================
// VIRTUALS
// ============================================================
directorSchema.virtual('age').get(function() {
  if (!this.dateOfBirth) return null;
  const today = new Date();
  const birthDate = new Date(this.dateOfBirth);
  let age = today.getFullYear() - birthDate.getFullYear();
  const monthDiff = today.getMonth() - birthDate.getMonth();
  if (monthDiff < 0 || (monthDiff === 0 && today.getDate() < birthDate.getDate())) {
    age--;
  }
  return age;
});

// ============================================================
// STATICS
// ============================================================

// Find or create director by name
directorSchema.statics.findOrCreate = async function(name) {
  if (!name || typeof name !== 'string') return null;
  
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
  
  let director = await this.findOne({ slug });
  
  if (!director) {
    director = await this.create({
      name: name.trim(),
      slug,
      source: 'manual'
    });
  }
  
  return director;
};

// Find or create director by name, enrich với dữ liệu TMDB
directorSchema.statics.findOrCreateFromTMDB = async function(tmdbPerson) {
  if (!tmdbPerson || !tmdbPerson.name) return null;

  const slug = tmdbPerson.name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();

  let director = await this.findOne({
    $or: [
      { externalId: String(tmdbPerson.tmdbId), source: 'tmdb' },
      { slug }
    ]
  });

  const profileImage = tmdbPerson.profilePath
    ? `https://image.tmdb.org/t/p/w500${tmdbPerson.profilePath}`
    : '';

  if (!director) {
    director = await this.create({
      name: tmdbPerson.name.trim(),
      slug,
      profileImage,
      dateOfBirth: tmdbPerson.birthday ? new Date(tmdbPerson.birthday) : null,
      gender: tmdbPerson.gender || 'unknown',
      source: 'tmdb',
      externalId: tmdbPerson.tmdbId ? String(tmdbPerson.tmdbId) : ''
    });
  } else {
    // Cập nhật ảnh/thông tin nếu đang thiếu
    let changed = false;
    if (!director.profileImage && profileImage) { director.profileImage = profileImage; changed = true; }
    if (!director.dateOfBirth && tmdbPerson.birthday) { director.dateOfBirth = new Date(tmdbPerson.birthday); changed = true; }
    if (!director.externalId && tmdbPerson.tmdbId) { director.externalId = String(tmdbPerson.tmdbId); director.source = 'tmdb'; changed = true; }
    if (changed) await director.save();
  }

  return director;
};

// Update movie count
directorSchema.methods.updateMovieCount = async function() {
  const MovieDirector = require('./movieDirector');
  const count = await MovieDirector.countDocuments({ directorId: this._id });
  this.movieCount = count;
  await this.save();
  return count;
};

// ============================================================
// HOOKS
// ============================================================

// Auto-generate slug before save
directorSchema.pre('save', function(next) {
  if (this.isModified('name') && !this.slug) {
    this.slug = this.name
      .toLowerCase()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();
  }
  next();
});

// ============================================================
// JSON TRANSFORM
// ============================================================
directorSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    delete ret.__v;
    return ret;
  }
});

// Use hot-reload safe pattern to prevent registration errors
const Director = mongoose.models.Director || mongoose.model('Director', directorSchema);

module.exports = Director;
