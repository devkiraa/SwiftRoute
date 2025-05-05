// models/Item.js
const mongoose = require('mongoose');
// Slugify is no longer needed for this specific SKU format
// const slugify = require('slugify');

const ItemSchema = new mongoose.Schema({
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    warehouseId: { type: mongoose.Schema.Types.ObjectId, ref: 'Warehouse', required: true },
    name: { type: String, required: true },
    sku: { type: String, index: true }, // required: false, unique is handled by index + hook
    quantity: { type: Number, default: 0, min: 0 },
    description: { type: String },
    unitPrice: { type: Number, required: true, min: 0 },
    sellingPrice: { type: Number, required: true, min: 0 },
    perishable: { type: Boolean, default: false },
    expiryDate: { type: Date },
    createdDate: { type: Date, default: Date.now },
    lastUpdated: { type: Date, default: Date.now }
});

// Compound index for company-specific SKU uniqueness
ItemSchema.index({ companyId: 1, sku: 1 }, { unique: true });

// Middleware to auto-generate SKU before saving
ItemSchema.pre('save', async function(next) {
    // Only generate SKU for brand new documents OR if sku is missing/empty
    if (this.isNew || !this.sku) {
        console.log(`Generating SKU for item: ${this.name}`);

        // --- New SKU Generation Logic ---
        let baseSku = this.name.trim() // Remove leading/trailing whitespace
                          .toUpperCase() // Convert to uppercase (like A4/80/GSM)
                          .replace(/\s+/g, '/'); // Replace one or more spaces with a single slash

        // Optional: Remove characters other than letters, numbers, and slashes
        baseSku = baseSku.replace(/[^A-Z0-9/]+/g, '');

        // Ensure baseSku is not empty after replacements
        if (!baseSku) {
            baseSku = `ITEM-${Date.now().toString().slice(-6)}`; // Fallback SKU
        }
        // --- End New SKU Logic ---

        let uniqueSku = baseSku;
        let counter = 1;
        console.log(`Generated Base SKU: ${baseSku}`);

        try {
            // Check for uniqueness within the company
            // Use 'this.constructor' instead of 'mongoose.models.Item' inside middleware for reliability
            while (await this.constructor.findOne({ sku: uniqueSku, companyId: this.companyId })) {
                uniqueSku = `${baseSku}-${counter}`;
                counter++;
                console.log(`SKU collision, trying: ${uniqueSku}`);
                // Safety break
                if (counter > 100) { throw new Error("Could not generate unique SKU after 100 attempts.");}
            }
            this.sku = uniqueSku;
            console.log(`Final unique SKU generated: ${this.sku}`);
        } catch (error) {
             console.error("Error during SKU uniqueness check:", error);
             return next(error); // Halt saving on error
        }
    }
    // Update lastUpdated timestamp
    this.lastUpdated = new Date();
    next();
});


module.exports = mongoose.model('Item', ItemSchema);