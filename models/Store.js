// models/Store.js
const mongoose = require('mongoose');

const StoreSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  storeName: { type: String, required: true },
  address: { type: String, required: true },
  phone: { type: String },                 // Contact number for the store
  email: { type: String },                 // Optional email
  location: {
    type: { type: String, enum: ['Point'], default: 'Point', required: true },
    coordinates: { type: [Number], required: true } // [longitude, latitude]
  },
  deliveryWindow: { type: String },        // e.g., "9:00-17:00"
  createdDate: { type: Date, default: Date.now }
  // Additional fields such as store type, manager, etc.
});

StoreSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Store', StoreSchema);
