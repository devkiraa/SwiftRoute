// models/Item.js
const mongoose = require('mongoose');

const ItemSchema = new mongoose.Schema({
  warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
  name: { type: String, required: true },
  sku: { type: String, unique: true, required: true },
  quantity: { type: Number, default: 0 },
  description: { type: String },
  price: { type: Number, required: true }, // Price per unit
  perishable: { type: Boolean, default: false },
  expiryDate: { type: Date },              // Only applicable if perishable is true
  createdDate: { type: Date, default: Date.now }
  // Additional metadata fields can be added (e.g., category, manufacturer, etc.)
});

module.exports = mongoose.model('Item', ItemSchema);
