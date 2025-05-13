// models/Store.js
const mongoose = require('mongoose');

// Explicitly define AddressSchema for clarity and correctness within this model
const AddressSchemaSub = new mongoose.Schema({
    street: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    country: { type: String, default: 'India', trim: true }
}, { _id: false }); // _id: false for subdocuments unless you need them

const StoreSchema = new mongoose.Schema({
    companyId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Company', 
        required: [true, "Company is required for the store."] 
    },
    storeName: { 
        type: String, 
        required: [true, "Store name is required."], 
        trim: true 
    },
    address: { // Use the defined sub-schema
        type: AddressSchemaSub, 
        default: () => ({}) // Ensures address path exists
    }, 
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    gstin: { type: String, trim: true, uppercase: true, maxlength: 15 },
    stateCode: { type: String, trim: true, maxlength: 2 }, // For GST, e.g., "29" for Karnataka
    location: {
        type: { type: String, enum: ['Point'], default: 'Point' },
        coordinates: { type: [Number] } // [longitude, latitude]
    },
    deliveryWindow: { type: String, trim: true }, // E.g., "9 AM - 6 PM"
    isActive: { type: Boolean, default: true }, // Added for consistency
    createdDate: { type: Date, default: Date.now },
    lastUpdated: { type: Date, default: Date.now }
});

StoreSchema.index({ location: '2dsphere' });
StoreSchema.index({ companyId: 1, storeName: 1 }, { unique: true, partialFilterExpression: { storeName: { $type: "string" } } });

StoreSchema.pre('save', function(next) { this.lastUpdated = new Date(); next(); });
StoreSchema.pre('findOneAndUpdate', function(next) { this.set({ lastUpdated: new Date() }); next(); });

module.exports = mongoose.model('Store', StoreSchema);