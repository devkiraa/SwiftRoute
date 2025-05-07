// models/User.js
const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true, trim: true },
  email: { type: String, required: true, unique: true, trim: true, lowercase: true },
  password: { type: String, required: true },  // Hashed password
  role: {
    type: String,
    enum: ['warehouse_owner', 'store_owner', 'employee', 'delivery_partner', 'admin', 'customer'], // Added admin based on your structure
    required: true
  },
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store' },
  avatarUrl: { type: String, default: 'https://i.pinimg.com/736x/3f/94/70/3f9470b34a8e3f526dbdb022f9f19cf7.jpg'}, // Default avatar
  createdDate: { type: Date, default: Date.now },
  // Additional fields such as phone, address etc.
  phone: { type: String, trim: true },

  // --- NEW FIELD FOR DELIVERY PARTNERS ---
  currentVehicleId: { // The vehicle the delivery partner is currently using
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Vehicle',
    default: null
  }
});

module.exports = mongoose.model('User', UserSchema);