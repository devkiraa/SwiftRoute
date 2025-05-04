// models/User.js
const mongoose = require('mongoose');

const UserSchema = new mongoose.Schema({
  username: { type: String, required: true, unique: true },
  email: { type: String, required: true, unique: true },
  password: { type: String, required: true },  // Hashed password
  role: { 
    type: String, 
    enum: ['warehouse_owner', 'store_owner', 'employee', 'delivery_partner', 'admin'], 
    required: true 
  },
  // For a warehouse owner, link to the company; for store users, link to the store.
  companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company' },
  storeId: { type: mongoose.Schema.Types.ObjectId, ref: 'Store' },
  avatarUrl: { type: String },
  createdDate: { type: Date, default: Date.now },
  // Additional fields such as phone, address etc.
});

module.exports = mongoose.model('User', UserSchema);
