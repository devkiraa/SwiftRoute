// models/TripLog.js
const mongoose = require('mongoose');

const TripLogSchema = new mongoose.Schema({
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
    companyId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Company', 
        required: true, 
        index: true 
    },
    tripStartDate: { 
        type: Date, 
        required: true,
        default: Date.now 
    },
    startOdometer: { 
        type: Number, 
        required: [true, "Start odometer reading is required."] 
    },
    tripEndDate: { 
        type: Date 
    },
    endOdometer: { 
        type: Number 
    },
    // Store IDs of orders associated with this specific trip/run
    ordersOnTrip: [{ 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Order' 
    }], 
    status: { 
        type: String, 
        enum: ['active', 'completed'], 
        default: 'active',
        required: true
    },
    notes: { 
        type: String, 
        trim: true 
    },
    // Calculated fields (can be added later or calculated on the fly)
    // totalDistance: { type: Number }, 
    // totalDurationMinutes: { type: Number },
}, { timestamps: true }); // Adds createdAt and updatedAt

// Index to quickly find active trips for a driver/vehicle
TripLogSchema.index({ driverId: 1, vehicleId: 1, status: 1 }); 

module.exports = mongoose.model('TripLog', TripLogSchema);