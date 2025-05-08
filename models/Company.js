// models/Company.js
const mongoose = require('mongoose');

const AddressSchema = new mongoose.Schema({
    street: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    country: { type: String, default: 'India', trim: true }
}, { _id: false }); // No separate ID for subdocument

const CompanySchema = new mongoose.Schema({
    companyName: {
        type: String,
        required: true,
        unique: true,
        trim: true
    },
    contactEmail: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
        // Add unique constraint if one email per company allowed
    },
    mobileNumber: {
        type: String,
        trim: true
    },
    address: AddressSchema,
    billingAddress: AddressSchema,
    gstin: {
        type: String,
        trim: true,
        uppercase: true,
        // Optional: Add validation pattern for GSTIN
    },
    subscriptionPlan: {
        type: String,
        enum: ['free', 'basic', 'pro', 'premium'], // <-- ADD 'premium' HERE
        default: 'free'
    },
    // --- NEW FIELD ---
    upiId: { // Primary UPI ID for receiving payments
        type: String,
        trim: true,
        // Example: 1234567890@upi, businessname@okaxis, etc.
    },
    // --- END NEW FIELD ---
    bankDetails: { // Optional: Keep existing if needed
        accountName: String,
        accountNumber: String,
        bankName: String,
        ifscCode: String,
    },
    fssaiLicenseNo: { type: String, trim: true }, // If applicable
    createdDate: {
        type: Date,
        default: Date.now
    },
    lastUpdated: {
        type: Date,
        default: Date.now
    }
});

// Middleware to update `lastUpdated` on save/update
CompanySchema.pre('save', function(next) { this.lastUpdated = new Date(); next(); });
CompanySchema.pre('findOneAndUpdate', function(next) { this.set({ lastUpdated: new Date() }); next(); });

module.exports = mongoose.model('Company', CompanySchema);