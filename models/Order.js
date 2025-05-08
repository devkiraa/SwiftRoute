// models/Order.js
const mongoose = require('mongoose');

const OrderItemSchema = new mongoose.Schema({
    itemId: { type: mongoose.Schema.Types.ObjectId, ref: 'Item', required: true },
    quantity: { type: Number, required: true, min: 1 },
    priceAtOrder: { type: Number, required: true } // Price per unit at the time of order
}, { _id: false });

const OrderSchema = new mongoose.Schema({
    storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store', required: true, index: true },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true, index: true },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true }, // Link to registered customer if applicable
    customerName: { type: String, required: true, trim: true }, // Always store name for quick access
    customerPhone: { type: String, trim: true },
    
    orderItems: [OrderItemSchema],
    totalAmount: { type: Number, required: true },

    shippingAddress: { type: String, required: true }, // Denormalized from Store or entered manually? Assumed from store for now.
    shippingLocation: { // GeoJSON Point for mapping
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number], index: '2dsphere' } // [longitude, latitude]
    },

    orderStatus: {
        type: String,
        enum: ['pending', 'confirmed', 'shipped', 'delivered', 'cancelled'],
        default: 'pending',
        required: true,
        index: true
    },

    // --- NEW PAYMENT FIELDS ---
    paymentStatus: {
        type: String,
        enum: ['pending', 'paid', 'partial', 'credit'], // credit = agreement to pay later
        default: 'pending',
        required: true,
        index: true
    },
    paymentMethod: {
        type: String,
        enum: ['cash', 'upi', 'cheque', 'credit', 'card', 'other', 'unknown'], // Added card/other/unknown
        default: 'unknown' // Default until explicitly recorded
    },
    amountCollected: { // Running total of amount collected for this order
        type: Number,
        default: 0,
        min: 0
    },
    paymentCollectedBy: { // Driver who recorded the (last) payment
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User' 
    }, 
    paymentTimestamp: { // Timestamp of when the (last) payment was recorded
        type: Date 
    }, 
    paymentNotes: { // e.g., Cheque number, UPI transaction ID, credit terms
        type: String, 
        trim: true 
    },
    // --- END NEW PAYMENT FIELDS ---

    placedDate: { type: Date, default: Date.now },
    updatedDate: { type: Date, default: Date.now },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // User who created order
    lastUpdatedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // User who last updated status/details
    assignedDeliveryPartnerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true },
    
    // Optionally track related trip
    tripLogId: { type: mongoose.Schema.Types.ObjectId, ref: 'TripLog', index: true }

}, { timestamps: true }); // Adds createdAt, updatedAt

// Middleware to update `updatedDate`
OrderSchema.pre('save', function(next) { this.updatedDate = new Date(); next(); });
OrderSchema.pre('findOneAndUpdate', function(next) { this.set({ updatedDate: new Date() }); next(); });

module.exports = mongoose.model('Order', OrderSchema);