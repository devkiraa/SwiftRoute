// models/FuelLog.js
const mongoose = require('mongoose');
const Vehicle = require('./Vehicle'); // To access FUEL_TYPES enum

const FuelLogSchema = new mongoose.Schema({
    vehicleId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Vehicle', 
        required: true, 
        index: true 
    },
    driverId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'User', 
        required: true, 
        index: true 
    },
    companyId: { // Denormalized for easier querying/reporting later
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Company', 
        required: true, 
        index: true 
    },
    logDate: { // When the fuel was added
        type: Date, 
        default: Date.now 
    },
    odometerReading: { // Odometer reading at the time of fueling
        type: Number, 
        required: [true, "Odometer reading is required."],
        min: [0, "Odometer reading cannot be negative."]
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
    fuelTypeFilled: { // Optional: useful if vehicle supports multiple types
        type: String, 
        enum: Vehicle.FUEL_TYPES // Use enum from Vehicle model
    },
    receiptImageUrl: { // Optional: For uploading receipt later
        type: String 
    },
    notes: { 
        type: String, 
        trim: true 
    },
    createdDate: { // When the log entry was created in the system
        type: Date, 
        default: Date.now 
    }
});

module.exports = mongoose.model('FuelLog', FuelLogSchema);