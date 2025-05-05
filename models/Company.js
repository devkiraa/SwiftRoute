// models/Company.js
const mongoose = require('mongoose');

const AddressSchema = new mongoose.Schema({
    street: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    country: { type: String, trim: true, default: 'India' } // Default to India
}, { _id: false }); // No separate ID for subdocument

const CompanySchema = new mongoose.Schema({
    companyName: {
        type: String,
        required: true,
        trim: true,
        unique: true // Ensure company names are unique
    },
    contactEmail: {
        type: String,
        required: true,
        trim: true,
        lowercase: true,
        // Add unique: true if emails must be unique across companies
    },
    mobileNumber: { // <-- ADDED
        type: String,
        trim: true
        // Add validation if needed
    },
    gstin: { // <-- ADDED (Goods and Services Tax Identification Number - India specific)
        type: String,
        trim: true,
        uppercase: true
        // Add validation for format if needed (e.g., regex)
        // unique: true // GSTIN should be unique
    },
    address: AddressSchema, // <-- ADDED Nested Address
    billingAddress: AddressSchema, // <-- ADDED Nested Billing Address
    subscriptionPlan: {
        type: String,
        enum: ['basic', 'premium', 'enterprise'], // Added enterprise example
        default: 'basic'
    },
    createdDate: {
        type: Date,
        default: Date.now
    },
    // Add other company details as needed (website, industry, etc.)
});

module.exports = mongoose.model('Company', CompanySchema);