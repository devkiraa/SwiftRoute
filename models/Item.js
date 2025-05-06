// models/Item.js
const mongoose = require('mongoose');

const ItemSchema = new mongoose.Schema({
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    name: { type: String, required: true },
    sku: { type: String, index: true, unique: true },
    quantity: { type: Number, default: 0, min: 0 },
    description: { type: String },
    unitPrice: { type: Number, required: true, min: 0 },
    sellingPrice: { type: Number, required: true, min: 0 },
    perishable: { type: Boolean, default: false },
    expiryDate: { type: Date },
    createdDate: { type: Date, default: Date.now },
    lastUpdated: { type: Date, default: Date.now }
});

ItemSchema.pre('save', function(next) {
    if (this.isNew || !this.sku) {
        const baseSku = this.name.trim()
            .toUpperCase()
            .replace(/\s+/g, '/')
            .replace(/[^A-Z0-9/]+/g, '') || 'ITEM';

        const companyCode = this.companyId.toString().slice(-4).toUpperCase();
        const timestamp = Date.now().toString().slice(-6);

        this.sku = `${companyCode}/${baseSku}/${timestamp}`;
    }
    this.lastUpdated = new Date();
    next();
});

module.exports = mongoose.model('Item', ItemSchema);
