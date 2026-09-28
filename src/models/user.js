/**
 * User Model
 * Source: movie-streaming-optimized-v2.dbml
 * 
 * This model stores core user profile data and authentication information.
 */
const mongoose = require('mongoose');
const Schema = mongoose.Schema;
const ENUMS = require('../constants/enums');

const userSchema = new Schema({
  fullname: {
    type: String,
    required: true,
    trim: true
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  passwordHash: {
    type: String,
    default: null,
    select: false // Don't include password hash in queries by default
  },
  address: {
    type: String,
    maxlength: 500,
    default: null
  },
  phone: {
    type: String,
    maxlength: 20,
    default: null
  },
  dateOfBirth: {
    type: Date,
    default: null
  },
  avatar: {
    type: String,
    default: '/img/avatar.png'
  },
  cloudinaryPublicId: {
    type: String,
    default: null
  },
  bio: {
    type: String,
    default: ''
  },
  favoriteGenres: [{
    type: String
  }],
  isVerified: {
    type: Boolean,
    default: false
  },
  emailVerifiedAt: {
    type: Date,
    default: null
  },
  isActive: {
    type: Boolean,
    default: true
  },
  lastLoginAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Index for email lookups
userSchema.index({ email: 1 }, { unique: true });

// Index for status filtering
userSchema.index({ isActive: 1 });

// Index for sorting
userSchema.index({ createdAt: -1 });

// Static method to find user with password hash (for authentication)
userSchema.statics.findByEmailWithPassword = async function(email) {
  return this.findOne({ email: email.toLowerCase() })
    .select('+passwordHash');
};

// Static method to find active user by ID
userSchema.statics.findActiveById = async function(id) {
  return this.findOne({ _id: id, isActive: true });
};

// Update last login timestamp
userSchema.methods.updateLastLogin = async function() {
  this.lastLoginAt = new Date();
  return this.save();
};

// JSON transform to remove sensitive fields
userSchema.set('toJSON', {
  transform: function(doc, ret) {
    delete ret.passwordHash;
    delete ret.__v;
    ret.id = ret._id;
    delete ret._id;
    return ret;
  }
});

// Use hot-reload safe pattern to prevent registration errors
const User = mongoose.models.User || mongoose.model('User', userSchema);

module.exports = User;
