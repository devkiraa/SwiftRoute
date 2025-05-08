// models/Supplier.js
const mongoose = require('mongoose');

const AddressSchema = new mongoose.Schema({
    street: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    country: { type: String, default: 'India', trim: true }
}, { _id: false });

const SupplierSchema = new mongoose.Schema({
    companyId: { // Which company this supplier belongs to/is managed by
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    supplierName: {
        type: String,
        required: [true, 'Supplier name is required.'],
        trim: true,
        index: true
    },
    contactPerson: {
        type: String,
        trim: true
    },
    email: {
        type: String,
        trim: true,
        lowercase: true
        // Optional: Add validation for email format
    },
    phone: {
        type: String,
        trim: true
    },
    address: AddressSchema,
    gstin: {
        type: String,
        trim: true,
        uppercase: true,
        maxlength: 15
        // Optional: Add validation pattern for GSTIN
    },
    notes: {
        type: String,
        trim: true
    },
    isActive: { // To deactivate suppliers instead of deleting if needed later
        type: Boolean,
        default: true
    },
    createdDate: { type: Date, default: Date.now },
    lastUpdated: { type: Date, default: Date.now }
});

// Compound index for uniqueness within a company (optional but good practice)
SupplierSchema.index({ companyId: 1, supplierName: 1 }, { unique: true, partialFilterExpression: { supplierName: { $type: "string" } } }); 

// Middleware to update `lastUpdated`
SupplierSchema.pre('save', function(next) { this.lastUpdated = new Date(); next(); });
SupplierSchema.pre('findOneAndUpdate', function(next) { this.set({ lastUpdated: new Date() }); next(); }); // For PUT updates

module.exports = mongoose.model('Supplier', SupplierSchema);