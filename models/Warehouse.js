// models/Warehouse.js
const mongoose = require('mongoose');

// Re-usable Address Schema (if not already in a shared file)
const AddressSchemaSub = new mongoose.Schema({
    street: { type: String, trim: true },
    city: { type: String, trim: true },
    state: { type: String, trim: true },
    pincode: { type: String, trim: true },
    country: { type: String, default: 'India', trim: true }
}, { _id: false });

const WarehouseSchema = new mongoose.Schema({
    companyId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Company', 
        required: [true, "Company association is required."], 
        index: true 
    },
    name: { 
        type: String, 
        required: [true, "Warehouse name is required."],
        trim: true,
        index: true
    },
    address: AddressSchemaSub, // Using the sub-schema for detailed address
    location: { // GeoJSON Point
        type: { 
            type: String, 
            enum: ['Point'], 
            // required: true // Make optional if address is primary
        },
        coordinates: { 
            type: [Number], // [longitude, latitude]
            // required: true // Make optional
            validate: { // Custom validator for coordinates array
                validator: function(v) {
                    return Array.isArray(v) && v.length === 2 && typeof v[0] === 'number' && typeof v[1] === 'number';
                },
                message: 'Coordinates must be an array of two numbers [longitude, latitude].'
            }
        } 
    },
    phone: { 
        type: String, 
        trim: true 
    },
    email: { 
        type: String, 
        trim: true, 
        lowercase: true 
        // Optional: Add email format validation
    },
    capacity: { // Example: square footage or pallet capacity
        type: Number, 
        default: 0,
        min: [0, "Capacity cannot be negative."]
    },
    // Add other fields as needed from your form/routes:
    // e.g., manager, operatingHours etc.
    isActive: {
        type: Boolean,
        default: true
    },
    createdDate: { type: Date, default: Date.now },
    lastUpdated: { type: Date, default: Date.now }
});

// Create a 2dsphere index if you plan to do geospatial queries
WarehouseSchema.index({ location: '2dsphere' });
// Compound index for uniqueness of name within a company
WarehouseSchema.index({ companyId: 1, name: 1 }, { unique: true, partialFilterExpression: { name: { $type: "string" } } });


// Middleware to update `lastUpdated`
WarehouseSchema.pre('save', function(next) {
    this.lastUpdated = new Date();
    // If coordinates are provided but type is not set, set type to 'Point'
    if (this.location && this.location.coordinates && this.location.coordinates.length === 2 && !this.location.type) {
        this.location.type = 'Point';
    }
    next();
});

WarehouseSchema.pre('findOneAndUpdate', function(next) {
    const update = this.getUpdate();
    if (update.$set) {
        update.$set.lastUpdated = new Date();
    } else {
        this.set({ lastUpdated: new Date() });
    }
    // Handle location type if coordinates are being updated
    if (update.$set && update.$set['location.coordinates'] && update.$set['location.coordinates'].length === 2) {
        if (!update.$set['location.type']) {
             this.set({ 'location.type': 'Point' });
        }
    } else if (update.location && update.location.coordinates && update.location.coordinates.length === 2 && !update.location.type) {
         this.set({ 'location.type': 'Point' });
    }
    next();
});


module.exports = mongoose.model('Warehouse', WarehouseSchema);