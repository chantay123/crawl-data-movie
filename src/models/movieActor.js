const mongoose = require('mongoose');
const Schema = mongoose.Schema;

const movieActorSchema = new Schema({
  movieId: {
    type: Schema.Types.ObjectId,
    ref: 'Movie',
    required: true,
    index: true
  },
  actorId: {
    type: Schema.Types.ObjectId,
    ref: 'Actor',
    required: true,
    index: true
  },
  
  // ============================================================
  // ROLE INFO
  // ============================================================
  role: {
    type: String,
    enum: ['lead', 'supporting', 'cameo', 'extra', 'voice', 'other'],
    default: 'supporting'
  },
  characterName: {
    type: String,
    maxlength: 255,
    trim: true,
    default: ''
  },
  order: {
    type: Number,
    default: 0,
    min: 0 // 0 = first billing, 1 = second billing, etc.
  },
  
  // ============================================================
  // METADATA
  // ============================================================
  isMain: {
    type: Boolean,
    default: false
  },
  source: {
    type: String,
    enum: ['manual', 'ophim', 'kkphim', 'nguonc', 'tmdb', 'wikipedia', 'wikidata', 'import'],
    default: 'manual'
  }
}, {
  timestamps: true,
  collection: 'movieactors'
});

// ============================================================
// INDEXES
// ============================================================
movieActorSchema.index({ movieId: 1, actorId: 1 }, { unique: true });
movieActorSchema.index({ actorId: 1, createdAt: -1 });
movieActorSchema.index({ movieId: 1, order: 1 });
movieActorSchema.index({ isMain: 1 });

// ============================================================
// STATIC METHODS
// ============================================================

// Add actor to movie
movieActorSchema.statics.addActor = async function(movieId, actorId, options = {}) {
  try {
    const existing = await this.findOne({ movieId, actorId });
    if (existing) return existing;

    // Sanitize source — chỉ cho phép các giá trị trong enum
    const ALLOWED_SOURCES = ['manual', 'ophim', 'kkphim', 'nguonc', 'tmdb', 'wikipedia', 'wikidata', 'import'];
    const rawSource = options.source || 'manual';
    const source = ALLOWED_SOURCES.includes(rawSource) ? rawSource : 'manual';

    return await this.create({
      movieId,
      actorId,
      role: options.role || 'supporting',
      characterName: options.characterName || '',
      order: options.order || 0,
      isMain: options.isMain || false,
      source,
    });
  } catch (err) {
    // KHÔNG throw — caller sẽ log warning và tiếp tục pipeline
    console.warn(`[MovieActor.addActor] failed for movieId=${movieId} actorId=${actorId}: ${err.message}`);
    return null;
  }
};

// Remove actor from movie
movieActorSchema.statics.removeActor = async function(movieId, actorId) {
  return await this.deleteOne({ movieId, actorId });
};

// Get all actors for a movie
movieActorSchema.statics.getMovieActors = async function(movieId, options = {}) {
  const query = this.find({ movieId })
    .populate('actorId')
    .sort({ order: 1, createdAt: 1 });
  
  if (options.limit) query.limit(options.limit);
  
  return await query;
};

// Get all movies for an actor
movieActorSchema.statics.getActorMovies = async function(actorId, options = {}) {
  const query = this.find({ actorId })
    .populate('movieId')
    .sort({ createdAt: -1 });
  
  if (options.limit) query.limit(options.limit);
  
  return await query;
};

// Set actors for a movie (replace all)
// actors = [{ actorId, role, characterName, order, isMain, source }]
//
// QUY TẮC (theo yêu cầu):
//   - Một actor lỗi KHÔNG được fail toàn bộ quá trình save
//   - Sanitize `source` trước khi insert (loại bỏ giá trị không hợp lệ)
//   - Dùng ordered:false để 1 row lỗi không rollback các row khác
movieActorSchema.statics.setActors = async function(movieId, actors) {
  // Remove all existing
  try {
    await this.deleteMany({ movieId });
  } catch (err) {
    console.warn(`[MovieActor.setActors] deleteMany failed for movieId=${movieId}: ${err.message}`);
    // Tiếp tục — không throw
  }

  if (!actors || actors.length === 0) return [];

  const ALLOWED_SOURCES = ['manual', 'ophim', 'kkphim', 'nguonc', 'tmdb', 'wikipedia', 'wikidata', 'import'];
  const ALLOWED_ROLES = ['lead', 'supporting', 'cameo', 'extra', 'voice', 'other'];

  // Lọc + sanitize TỪNG record. Nếu record không hợp lệ → bỏ qua, log warning.
  const docs = [];
  for (let index = 0; index < actors.length; index++) {
    const actor = actors[index] || {};
    if (!actor.actorId) {
      console.warn(`[MovieActor.setActors] skip record[${index}]: missing actorId`);
      continue;
    }
    const rawSource = actor.source || 'manual';
    const source = ALLOWED_SOURCES.includes(rawSource) ? rawSource : 'manual';
    const rawRole = actor.role || 'supporting';
    const role = ALLOWED_ROLES.includes(rawRole) ? rawRole : 'supporting';

    docs.push({
      movieId,
      actorId: actor.actorId,
      role,
      characterName: typeof actor.characterName === 'string' ? actor.characterName : '',
      order: typeof actor.order === 'number' ? actor.order : index,
      isMain: !!actor.isMain,
      source,
    });
  }

  if (docs.length === 0) return [];

  try {
    // ordered:false → nếu 1 row fail validation, các row khác vẫn insert thành công
    return await this.insertMany(docs, { ordered: false });
  } catch (err) {
    // Có thể có vài row bị validation fail — log warning, trả về các row thành công
    if (err && err.insertedDocs && Array.isArray(err.insertedDocs)) {
      console.warn(`[MovieActor.setActors] partial insert for movieId=${movieId}: ${err.message}`);
      return err.insertedDocs;
    }
    console.warn(`[MovieActor.setActors] insertMany failed for movieId=${movieId}: ${err.message}`);
    return [];
  }
};

// Get main cast for a movie
movieActorSchema.statics.getMainCast = async function(movieId, limit = 5) {
  return await this.find({ movieId })
    .populate('actorId')
    .sort({ order: 1 })
    .limit(limit);
};

// Count movies for an actor
movieActorSchema.statics.countActorMovies = async function(actorId) {
  return await this.countDocuments({ actorId });
};

// ============================================================
// HOOKS
// ============================================================

// Update actor's movie count after save
movieActorSchema.post('save', async function(doc) {
  try {
    const Actor = require('./actor');
    const actor = await Actor.findById(doc.actorId);
    if (actor) {
      await actor.updateMovieCount();
    }
  } catch (err) {
    console.error('Error updating actor movie count:', err);
  }
});

// Update actor's movie count after delete
movieActorSchema.post('deleteOne', async function(doc) {
  try {
    if (doc && doc.actorId) {
      const Actor = require('./actor');
      const actor = await Actor.findById(doc.actorId);
      if (actor) {
        await actor.updateMovieCount();
      }
    }
  } catch (err) {
    console.error('Error updating actor movie count:', err);
  }
});

// Use hot-reload safe pattern to prevent registration errors
const MovieActor = mongoose.models.MovieActor || mongoose.model('MovieActor', movieActorSchema);

module.exports = MovieActor;
