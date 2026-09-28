const mongoose = require('mongoose');
const { Schema } = mongoose;
const ENUMS = require('../constants/enums');

const reportSchema = new Schema(
    {
        userId: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            required: true
        },
        targetType: {
            type: String,
            enum: ENUMS.REPORT_TARGET_TYPE,
            required: true
        },
        targetId: {
            type: Schema.Types.ObjectId,
            required: true
        },
        reason: { type: String, required: true, trim: true },
        description: { type: String, default: '' },
        status: {
            type: String,
            enum: ENUMS.REPORT_STATUS,
            default: 'pending'
        },
        adminResponse: { type: String, default: '' },
        resolvedBy: {
            type: Schema.Types.ObjectId,
            ref: 'User',
            default: null
        },
        resolvedAt: { type: Date, default: null }
    },
    {
        timestamps: true,
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

// DBML
reportSchema.index({ targetType: 1, targetId: 1 });

// Use hot-reload safe pattern to prevent registration errors
const Report = mongoose.models.Report || mongoose.model('Report', reportSchema);

module.exports = Report;
