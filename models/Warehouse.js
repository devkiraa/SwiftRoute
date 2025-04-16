// models/Warehouse.js
const mongoose = require('mongoose');

const WarehouseSchema = new mongoose.Schema({
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
  location: {
    type: { type: String, enum: ['Point'], required: true },
    coordinates: { type: [Number], required: true } // [longitude, latitude]
  },
  capacity: { type: Number, default: 0 },
  name: { type: String, required: true }, // e.g. "Main Warehouse"
  // Additional fields such as operating hours, contact info, etc. can be added here.
});

WarehouseSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Warehouse', WarehouseSchema);
