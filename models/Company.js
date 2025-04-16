// models/Company.js
const mongoose = require('mongoose');

const CompanySchema = new mongoose.Schema({
  companyName: { type: String, required: true },
  contactEmail: { type: String, required: true },
  subscriptionPlan: { type: String, enum: ['basic', 'premium'], default: 'basic' },
  website: { type: String },               // Optional website URL
  phone: { type: String },                 // Optional phone number
  address: { type: String },               // Physical address for the company
  createdDate: { type: Date, default: Date.now },
  // Optionally, a list of associated users can be referenced here or via User model
});

module.exports = mongoose.model('Company', CompanySchema);
