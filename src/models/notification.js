const mongoose = require('mongoose');
const { Schema } = mongoose;
const ENUMS = require('../constants/enums');

const notificationSchema = new Schema(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true,
            index: true
        },
        type: {
            type: String,
            enum: ENUMS.NOTIFICATION_TYPE,
            required: true,
            index: true
        },
        title: { type: String, required: true, trim: true },
        content: { type: String, default: '' },
        data: { type: Schema.Types.Mixed, default: null },
        isRead: { type: Boolean, default: false, index: true },
        readAt: { type: Date, default: null }
    },
    {
        timestamps: { createdAt: true, updatedAt: false },
        toJSON: {
            virtuals: true,
            transform: (doc, ret) => {
                ret.id = ret._id;
                delete ret._id;
                delete ret.__v;
                return ret;
            }
        }
    }
);

// DBML: (userId, isRead, createdAt)
notificationSchema.index({ userId: 1, isRead: 1, createdAt: -1 });
notificationSchema.index({ createdAt: -1 });

// Use hot-reload safe pattern to prevent registration errors
const Notification = mongoose.models.Notification || mongoose.model('Notification', notificationSchema);

module.exports = Notification;
