// models/FuelLog.js
const mongoose = require('mongoose');
const Vehicle = require('./Vehicle'); // To access FUEL_TYPES enum

const FuelLogSchema = new mongoose.Schema({
    vehicleId: { type: mongoose.Schema.Types.ObjectId, ref: 'Vehicle', required: true, index: true },
    driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    companyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Company', required: true, index: true },
    logDate: { type: Date, default: Date.now },
    odometerReading: { 
        type: Number, 
        required: [true, "Odometer reading is required."],
        min: [0, "Odometer reading cannot be negative."]
        // Note: Validation that this >= vehicle.currentOdometer happens in the route handler
    },
    fuelQuantityLiters: { 
        type: Number, 
        required: [true, "Fuel quantity (in Liters) is required."], 
        min: [0.1, "Fuel quantity must be positive."] 
    },
    fuelCostTotalINR: { 
        type: Number, 
        required: [true, "Total fuel cost (in INR) is required."], 
        min: [0, "Fuel cost cannot be negative."]
    },
    fuelTypeFilled: { 
        type: String, 
        enum: Vehicle.FUEL_TYPES 
    },
    receiptImageUrl: { type: String },
    notes: { type: String, trim: true },
    createdDate: { type: Date, default: Date.now }
}, { timestamps: true }); // Using timestamps option adds createdAt/updatedAt automatically

module.exports = mongoose.model('FuelLog', FuelLogSchema);