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
    enum: ['manual', 'ophim', 'kkphim', 'nguonc', 'tmdb', 'wikipedia', 'wikidata', 'import'],
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

// Find or create director từ Wikidata data (qid + name + profileImage + gender + dateOfBirth)
// QUY TẮC:
//   - Idempotent theo (externalId + source='wikidata')
//   - Nếu đã tồn tại → CHỈ cập nhật field khi dữ liệu mới hợp lệ (không ghi đè null/unknown)
//   - Không tạo collection mới, dùng đúng schema Director hiện tại
directorSchema.statics.findOrCreateFromWikidata = async function(wikidataData) {
  if (!wikidataData || !wikidataData.name) return null;

  const wName = String(wikidataData.name).trim();
  const wQid = wikidataData.qid ? String(wikidataData.qid).trim() : '';

  // Slug theo tên (mirror pattern của findOrCreate / findOrCreateFromTMDB)
  const slug = wName
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .trim();

  // Gender hợp lệ
  const VALID_GENDERS = new Set(['male', 'female', 'other', 'unknown']);
  const wGender = wikidataData.gender && VALID_GENDERS.has(String(wikidataData.gender))
    ? String(wikidataData.gender)
    : null;

  // ProfileImage hợp lệ (chuỗi non-empty)
  const wImage = (typeof wikidataData.profileImage === 'string' && wikidataData.profileImage.trim())
    ? wikidataData.profileImage.trim()
    : null;

  // DateOfBirth hợp lệ (Date object)
  let wDob = null;
  if (wikidataData.dateOfBirth) {
    if (wikidataData.dateOfBirth instanceof Date && !isNaN(wikidataData.dateOfBirth.getTime())) {
      wDob = wikidataData.dateOfBirth;
    } else if (typeof wikidataData.dateOfBirth === 'string') {
      const parsed = new Date(wikidataData.dateOfBirth);
      if (!isNaN(parsed.getTime())) wDob = parsed;
    }
  }

  try {
    // Tìm director theo (externalId + source) trước → idempotent theo QID
    let director = null;
    if (wQid) {
      director = await this.findOne({ externalId: wQid, source: 'wikidata' });
    }
    // Fallback: tìm theo slug (case director đã tồn tại với source khác)
    if (!director) {
      director = await this.findOne({ slug });
    }

    if (!director) {
      // CHƯA tồn tại → tạo mới với những field hợp lệ
      const doc = {
        name: wName,
        slug,
        source: 'wikidata',
        externalId: wQid || '',
        isActive: true,
        movieCount: 0,
        // Defaults cho schema hiện tại
        profileImage: '',
        gender: 'unknown',
        dateOfBirth: null,
      };
      if (wImage) doc.profileImage = wImage;
      if (wGender) doc.gender = wGender;
      if (wDob) doc.dateOfBirth = wDob;
      director = await this.create(doc);
      return director;
    }

    // ĐÃ tồn tại → CHỈ cập nhật field khi dữ liệu mới hợp lệ
    let changed = false;

    // name: cập nhật nếu thiếu/khác rõ ràng
    if (!director.name || director.name !== wName) {
      director.name = wName;
      changed = true;
    }

    // profileImage: chỉ set nếu chưa có
    if (wImage && (!director.profileImage || !director.profileImage.trim())) {
      director.profileImage = wImage;
      changed = true;
    }

    // gender: chỉ set nếu chưa hợp lệ / unknown
    if (wGender && (!director.gender || director.gender === 'unknown')) {
      director.gender = wGender;
      changed = true;
    }

    // dateOfBirth: chỉ set nếu chưa có
    if (wDob && !director.dateOfBirth) {
      director.dateOfBirth = wDob;
      changed = true;
    }

    // externalId: chỉ set nếu chưa có
    if (wQid && !director.externalId) {
      director.externalId = wQid;
      // Nếu director đang là manual thì promote source → wikidata
      if (!director.source || director.source === 'manual') {
        director.source = 'wikidata';
      }
      changed = true;
    }

    if (changed) await director.save();
    return director;
  } catch (err) {
    console.warn(`[Director.findOrCreateFromWikidata] failed for "${wName}": ${err.message}`);
    return null;
  }
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
