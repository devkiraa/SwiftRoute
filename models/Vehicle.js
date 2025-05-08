// models/Vehicle.js
const mongoose = require('mongoose');

const VEHICLE_TYPES = ['bike', 'scooter', 'car_hatchback', 'car_sedan', 'car_suv', 'van_small', 'van_large', 'truck_mini', 'truck_light', 'truck_heavy', 'other'];
const FUEL_TYPES = ['petrol', 'diesel', 'cng', 'electric', 'hybrid', 'other'];

// Example Regex for Indian Vehicle Number (adjust as needed for variations)
// Allows formats like KL05AZ1234, KL5AZ1234, KL05A1234 etc. Needs refinement for perfect accuracy.
const vehicleNumberRegex = /^[A-Z]{2}[0-9]{1,2}[A-Z]{1,2}[0-9]{1,4}$/;

const VehicleSchema = new mongoose.Schema({
    companyId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'Company',
        required: true,
        index: true
    },
    vehicleNumber: { 
        type: String,
        required: [true, "Vehicle registration number is required."],
        trim: true,
        uppercase: true,
        // match: [vehicleNumberRegex, 'Invalid vehicle number format (e.g., KL05AZ1234).'], // Optional regex validation
        // Uniqueness per company checked in route logic
    },
    type: {
        type: String,
        required: [true, "Vehicle type is required."],
        enum: { values: VEHICLE_TYPES, message: 'Invalid vehicle type: {VALUE}' }
    },
    modelName: { 
        type: String,
        trim: true,
        required: [true, "Vehicle model or make is required."]
    },
    fuelType: {
        type: String,
        enum: { values: FUEL_TYPES, message: 'Invalid fuel type: {VALUE}' }
    },
    capacityVolume: { 
        type: Number,
        min: [0, 'Capacity Volume cannot be negative.']
    },
    capacityWeight: { 
        type: Number, 
        min: [0, 'Capacity Weight cannot be negative.']
    },
    initialOdometer: { 
        type: Number,
        default: 0,
        min: [0, 'Initial Odometer cannot be negative.']
    },
    currentOdometer: { 
        type: Number,
        default: function() { return this.initialOdometer; }, 
        min: [0, 'Current Odometer cannot be negative.']
        // Validation that current >= initial happens implicitly or during updates
    },
    assignedDriverId: { 
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        default: null,
        sparse: true 
    },
    isActive: { 
        type: Boolean,
        default: true
    },
    notes: {
        type: String,
        trim: true
    },
    createdDate: { type: Date, default: Date.now },
    lastUpdated: { type: Date, default: Date.now }
});

VehicleSchema.pre('save', function(next) { this.lastUpdated = new Date(); next(); });
VehicleSchema.pre('findOneAndUpdate', function(next) { this.set({ lastUpdated: new Date() }); next(); }); // Add for updates

module.exports = mongoose.model('Vehicle', VehicleSchema);
module.exports.VEHICLE_TYPES = VEHICLE_TYPES;
module.exports.FUEL_TYPES = FUEL_TYPES;