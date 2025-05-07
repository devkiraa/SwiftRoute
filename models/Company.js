// models/Company.js
const mongoose = require('mongoose');

const AddressSchema = new mongoose.Schema({
    street: { type: String, trim: true, default: '' },
    city: { type: String, trim: true, default: '' },
    state: { type: String, trim: true, default: '' },
    pincode: { type: String, trim: true, default: '' },
    country: { type: String, trim: true, default: 'India' }
}, { _id: false });

const BankDetailsSchema = new mongoose.Schema({
    bankName: { type: String, trim: true },
    accountNumber: { type: String, trim: true },
    ifscCode: { type: String, trim: true, uppercase: true },
    branchName: { type: String, trim: true },
    upiId: { type: String, trim: true } // For GPAY etc.
}, { _id: false });

const CompanySchema = new mongoose.Schema({
    companyName: { type: String, required: true, trim: true, unique: true },
    contactEmail: { type: String, required: true, trim: true, lowercase: true },
    mobileNumber: { type: String, trim: true },
    gstin: { type: String, trim: true, uppercase: true, unique: true, sparse: true }, // GSTIN should be unique if present
    fssaiLicenseNo: { type: String, trim: true }, // For food businesses
    // Other licenses as needed

    address: { type: AddressSchema, default: () => ({}) },
    billingAddress: { type: AddressSchema, default: () => ({}) }, // Can be same as address

    bankDetails: { type: BankDetailsSchema, default: () => ({}) },

    subscriptionPlan: { type: String, enum: ['basic', 'premium', 'enterprise'], default: 'basic' },
    createdDate: { type: Date, default: Date.now },
    // Logo URL can be added later
    // logoUrl: { type: String }
});

module.exports = mongoose.model('Company', CompanySchema);