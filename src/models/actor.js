const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const actorSchema = new Schema({
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
  collection: 'actors'
});

// ============================================================
// INDEXES
// ============================================================
actorSchema.index({ name: 'text' });
actorSchema.index({ movieCount: -1 });
actorSchema.index({ slug: 1, isActive: 1 });

// ============================================================
// VIRTUALS
// ============================================================
actorSchema.virtual('age').get(function() {
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

// Find or create actor by name
actorSchema.statics.findOrCreate = async function(name) {
  if (!name || typeof name !== 'string') return null;
  
  const slug = name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();
  
  let actor = await this.findOne({ slug });
  
  if (!actor) {
    actor = await this.create({
      name: name.trim(),
      slug,
      source: 'manual'
    });
  }
  
  return actor;
};

// Find or create actor by name, enrich với dữ liệu TMDB
actorSchema.statics.findOrCreateFromTMDB = async function(tmdbPerson) {
  if (!tmdbPerson || !tmdbPerson.name) return null;

  const slug = tmdbPerson.name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();

  let actor = await this.findOne({
    $or: [
      { externalId: String(tmdbPerson.tmdbId), source: 'tmdb' },
      { slug }
    ]
  });

  const profileImage = tmdbPerson.profilePath
    ? `https://image.tmdb.org/t/p/w500${tmdbPerson.profilePath}`
    : '';

  if (!actor) {
    actor = await this.create({
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
    if (!actor.profileImage && profileImage) { actor.profileImage = profileImage; changed = true; }
    if (!actor.dateOfBirth && tmdbPerson.birthday) { actor.dateOfBirth = new Date(tmdbPerson.birthday); changed = true; }
    if (!actor.externalId && tmdbPerson.tmdbId) { actor.externalId = String(tmdbPerson.tmdbId); actor.source = 'tmdb'; changed = true; }
    if (changed) await actor.save();
  }

  return actor;
};

// Update movie count
actorSchema.methods.updateMovieCount = async function() {
  const MovieActor = require('./movieActor');
  const count = await MovieActor.countDocuments({ actorId: this._id });
  this.movieCount = count;
  await this.save();
  return count;
};

// ============================================================
// HOOKS
// ============================================================

// Auto-generate slug before save
actorSchema.pre('save', function(next) {
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
actorSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    delete ret.__v;
    return ret;
  }
});

// Use hot-reload safe pattern to prevent registration errors
const Actor = mongoose.models.Actor || mongoose.model('Actor', actorSchema);

module.exports = Actor;
