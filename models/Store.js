// models/Store.js
const mongoose = require('mongoose');

// Re-using AddressSchema if defined in a shared utility or define it again here
const AddressSchema = new mongoose.Schema({ /* ... same as in Company.js ... */ }, { _id: false });


const StoreSchema = new mongoose.Schema({
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true },
    storeName: { type: String, required: true, trim: true },
    address: { type: AddressSchema, default: () => ({}) }, // Using the nested schema
    phone: { type: String, trim: true },
    email: { type: String, trim: true, lowercase: true },
    gstin: { type: String, trim: true, uppercase: true }, // Store's own GSTIN, if applicable
    stateCode: { type: String, trim: true }, // For GST purposes
    location: {
        type: { type: String, enum: ['Point'], default: 'Point' }, // 'required: true' removed for flexibility
        coordinates: { type: [Number], index: '2dsphere' } // [longitude, latitude]
    },
    deliveryWindow: { type: String, trim: true },
    createdDate: { type: Date, default: Date.now }
});

StoreSchema.index({ location: '2dsphere' });

module.exports = mongoose.model('Store', StoreSchema);