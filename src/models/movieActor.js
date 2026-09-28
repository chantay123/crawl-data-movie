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
    enum: ['manual', 'ophim', 'kkphim', 'nguonc', 'tmdb', 'import'],
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
  const existing = await this.findOne({ movieId, actorId });
  if (existing) return existing;
  
  return await this.create({
    movieId,
    actorId,
    role: options.role || 'supporting',
    characterName: options.characterName || '',
    order: options.order || 0,
    isMain: options.isMain || false,
    source: options.source || 'manual'
  });
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
movieActorSchema.statics.setActors = async function(movieId, actors) {
  // actors = [{ actorId, role, characterName, order, isMain }]
  
  // Remove all existing
  await this.deleteMany({ movieId });
  
  // Add new ones
  if (!actors || actors.length === 0) return [];
  
  const docs = actors.map((actor, index) => ({
    movieId,
    actorId: actor.actorId,
    role: actor.role || 'supporting',
    characterName: actor.characterName || '',
    order: actor.order !== undefined ? actor.order : index,
    isMain: actor.isMain || false,
    source: actor.source || 'manual'
  }));
  
  return await this.insertMany(docs);
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
