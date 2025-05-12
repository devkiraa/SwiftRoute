// models/User.js
const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
    username: { type: String, required: true, trim: true }, // Can be Google display name
    email: { type: String, required: true, unique: true, trim: true, lowercase: true },
    password: { type: String }, // Password is no longer strictly required if using Google OAuth
    role: {
        type: String,
        enum: ['warehouse_owner', 'store_owner', 'employee', 'delivery_partner', 'admin', 'customer'],
        required: true
    },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store' },
    avatarUrl: { type: String, default: 'https://i.pinimg.com/736x/3f/94/70/3f9470b34a8e3f526dbdb022f9f19cf7.jpg'},
    phone: { type: String, trim: true },
    currentVehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', default: null },
    
    // --- NEW FIELDS FOR GOOGLE AUTH ---
    googleId: { 
        type: String, 
        unique: true, // Each Google ID must be unique
        sparse: true, // Allows multiple null values (for users not using Google)
        index: true 
    },
    // --- END NEW FIELDS ---

    isActive: { type: Boolean, default: true }, // Added for user management
    createdDate: { type: Date, default: Date.now },
    lastLogin: { type: Date }
});

// Make username not strictly unique if multiple Google users might have similar display names
// Or, implement logic to make it unique (e.g., append numbers)
UserSchema.index({ email: 1 }); // Ensure email is indexed

module.exports = mongoose.model('User', UserSchema);