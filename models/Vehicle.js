// models/Vehicle.js
const mongoose = require('mongoose');

const VEHICLE_TYPES = ['bike', 'scooter', 'car_hatchback', 'car_sedan', 'car_suv', 'van_small', 'van_large', 'truck_mini', 'truck_light', 'truck_heavy', 'other'];
const FUEL_TYPES = ['petrol', 'diesel', 'cng', 'electric', 'hybrid', 'other'];

const VehicleSchema = new mongoose.Schema({
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    vehicleNumber: { // e.g., "KL05AZ1234"
        type: String,
        required: [true, "Vehicle registration number is required."],
        trim: true,
        uppercase: true,
        // We'll enforce uniqueness per company in the route logic, as compound unique index with ref is tricky
    },
    type: {
        type: String,
        required: [true, "Vehicle type is required."],
        enum: VEHICLE_TYPES
    },
    modelName: { // e.g., "Tata Ace Gold", "Honda Activa 6G"
        type: String,
        trim: true,
        required: [true, "Vehicle model or make is required."]
    },
    fuelType: {
        type: String,
        enum: FUEL_TYPES
    },
    capacityVolume: { // Optional: e.g., in cubic meters or liters
        type: Number,
        min: 0
    },
    capacityWeight: { // Optional: e.g., in kg
        type: Number,
        min: 0
    },
    initialOdometer: { // Odometer reading when vehicle was added to the system
        type: Number,
        default: 0,
        min: 0
    },
    currentOdometer: { // Last known odometer reading, updated by logs
        type: Number,
        default: function() { return this.initialOdometer; }, // Defaults to initialOdometer
        min: 0
    },
    assignedDriverId: { // Tracks the driver CURRENTLY assigned/using this vehicle (if any)
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
        sparse: true // Allows multiple nulls if not assigned
    },
    isActive: { // If the vehicle is currently operational and available for assignment
        type: Boolean,
        default: true
    },
    notes: {
        type: String,
        trim: true
    },
    createdDate: {
        type: Date,
        default: Date.now
    },
    lastUpdated: {
        type: Date,
        default: Date.now
    }
});

// Middleware to update `lastUpdated` on save
VehicleSchema.pre('save', function(next) {
    this.lastUpdated = new Date();
    next();
});

// To ensure vehicleNumber is unique per company, we'll handle this in the route logic
// as compound unique indexes with refs require a bit more nuance or a plugin.
// A simple unique index on vehicleNumber would make it unique across all companies.
// VehicleSchema.index({ companyId: 1, vehicleNumber: 1 }, { unique: true }); // Consider adding this later

module.exports = mongoose.model('Vehicle', VehicleSchema);
module.exports.VEHICLE_TYPES = VEHICLE_TYPES;
module.exports.FUEL_TYPES = FUEL_TYPES;