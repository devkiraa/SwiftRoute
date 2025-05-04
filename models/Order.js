// models/Order.js
const mongoose = require('mongoose');

const OrderItemSchema = new mongoose.Schema({
  itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true },
  quantity: { type: Number, required: true, min: 1 },
  priceAtOrder: { type: Number, required: true } // Price per unit at time of order
});

const OrderSchema = new mongoose.Schema({
  // Link to store receiving the order
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true },
  // Link to warehouse fulfilling the order
  warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true }, // <-- ADDED

  // Link to registered customer OR store direct customer info
  customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // <-- Optional now? Decide based on requirements. Let's keep it optional for now.
  customerName: { type: String }, // <-- ADDED (Required if customerId is null?)
  customerPhone: { type: String }, // <-- ADDED

  orderItems: [OrderItemSchema],
  totalAmount: { type: Number, required: true },

  shippingAddress: { type: String, required: true }, // Address string
  shippingLocation: { // <-- ADDED for geocoded coords
      type: { type: String, enum: ['Point'], default: 'Point' },
      coordinates: { type: [Number], index: '2dsphere' } // [longitude, latitude]
  },

  orderStatus: { type: String, enum: ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'], default: 'pending' },
  placedDate: { type: Date, default: Date.now },
  updatedDate: { type: Date, default: Date.now },

  // Who placed the order (useful if placed by staff)
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },

  // Delivery details
  assignedDeliveryPartnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null }, // <-- ADDED
  deliveryBatchId: { type: String } // Or ObjectId ref if using a Batch model later

  // Add other fields like notes, payment status etc. if needed
});

// Indexing shippingLocation for geospatial queries later
OrderSchema.index({ shippingLocation: '2dsphere' });

module.exports = mongoose.model('Order', OrderSchema);