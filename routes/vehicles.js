// routes/vehicles.js
const express = require('express');
const mongoose = require('mongoose');
const Vehicle = require('../models/Vehicle'); // Ensure this path is correct
const User = require('../models/User');       // For populating assignedDriverId

const router = express.Router();

// Middleware: Ensure user is authenticated
function ensureAuthenticated(req, res, next) {
    if (res.locals.loggedInUser) return next();
    console.log("User not authenticated (vehicles route), redirecting to login.");
    res.redirect('/login');
}

// Middleware: Ensure user is admin or warehouse owner
async function ensureAdminOrOwner(req, res, next) {
    const loggedInUser = res.locals.loggedInUser;
    if (!loggedInUser) return res.status(401).send("Authentication required.");

    if (loggedInUser.role === 'admin') return next(); 

    if (loggedInUser.role === 'warehouse_owner') {
        if (!loggedInUser.companyId) {
            console.log("Access Denied: Warehouse owner not associated with a company.");
            return res.status(403).render('error_page', { title: "Access Denied", message: "You are not associated with a company.", layout: './layouts/dashboard_layout' });
        }
        // Further checks for specific vehicle ownership will be done in individual routes
        return next();
    }
    console.log(`Access Denied: Role ${loggedInUser.role} cannot access vehicle management.`);
    res.status(403).render('error_page', { title: "Access Denied", message: "You do not have permission to manage vehicles.", layout: './layouts/dashboard_layout' });
}

router.use(ensureAuthenticated, ensureAdminOrOwner);

// GET /vehicles - List all vehicles for the company
router.get('/', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        let query = {};
        if (loggedInUser.role === 'warehouse_owner') {
            query.companyId = loggedInUser.companyId._id || loggedInUser.companyId;
        }
        // For Admin, query is empty, showing all. Or add a company filter for Admin if desired.

        const vehicles = await Vehicle.find(query)
            .populate('assignedDriverId', 'username')
            .sort({ isActive: -1, vehicleNumber: 1 }) // Show active ones first
            .lean();

        res.render('vehicles/index', {
            title: 'Manage Vehicles',
            vehicles: vehicles,
            success_msg: req.query.success, // For flash-like messages
            error_msg: req.query.error,
            layout: './layouts/dashboard_layout'
        });
    } catch (err) {
        console.error("Error fetching vehicles:", err);
        res.status(500).render('error_page', { title: "Server Error", message: "Failed to load vehicles.", layout: './layouts/dashboard_layout' });
    }
});

// GET /vehicles/new - Show form to add a new vehicle
router.get('/new', (req, res) => {
    res.render('vehicles/form', {
        title: 'Add New Vehicle',
        vehicle: {},        // Data for a new vehicle is empty
        formData: {},       // For repopulating form on error, initially empty
        isEditing: false,
        vehicleTypes: Vehicle.VEHICLE_TYPES,
        fuelTypes: Vehicle.FUEL_TYPES,
        layout: './layouts/dashboard_layout'
    });
});

// POST /vehicles - Create a new vehicle
router.post('/', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    // Admin might need a way to specify companyId if they manage multiple
    // For now, warehouse_owner's companyId is used.
    const companyId = loggedInUser.companyId?._id || loggedInUser.companyId;

    if (!companyId) { // Should be caught by middleware for warehouse_owner
        return res.status(400).render('vehicles/form', { /* ... error handling ... */ });
    }

    const { vehicleNumber, type, modelName, fuelType, capacityVolume, capacityWeight, initialOdometer, notes } = req.body;

    try {
        const upperVehicleNumber = vehicleNumber.toUpperCase().trim();
        if (!upperVehicleNumber) {
             throw new mongoose.Error.ValidationError(null).addError('vehicleNumber', new mongoose.Error.ValidatorError({ message: 'Vehicle number cannot be empty.' }));
        }

        const existingVehicle = await Vehicle.findOne({ companyId: companyId, vehicleNumber: upperVehicleNumber });
        if (existingVehicle) {
            throw new mongoose.Error.ValidationError(null).addError('vehicleNumber', new mongoose.Error.ValidatorError({ message: `Vehicle number '${upperVehicleNumber}' already exists for this company.` }));
        }
        
        const currentOdo = initialOdometer ? Number(initialOdometer) : 0;

        const newVehicle = new Vehicle({
            companyId,
            vehicleNumber: upperVehicleNumber,
            type,
            modelName,
            fuelType: fuelType || undefined, // Allow empty fuelType if not selected
            capacityVolume: capacityVolume ? Number(capacityVolume) : undefined,
            capacityWeight: capacityWeight ? Number(capacityWeight) : undefined,
            initialOdometer: currentOdo,
            currentOdometer: currentOdo, // Current odometer starts same as initial
            notes,
            isActive: true // New vehicles are active by default
        });

        await newVehicle.save();
        console.log(`Vehicle ${newVehicle.vehicleNumber} created for company ${companyId}`);
        req.flash('success_msg', `Vehicle '${newVehicle.vehicleNumber}' added successfully.`);
        res.redirect('/vehicles');

    } catch (err) {
        console.error("Error creating vehicle:", err);
        let errorMessage = "Failed to add vehicle. Please check your inputs.";
        if (err.name === 'ValidationError') {
            errorMessage = Object.values(err.errors).map(val => val.message).join(' ');
        } else if (err.message) {
            errorMessage = err.message;
        }
        res.status(400).render('vehicles/form', {
            title: 'Add New Vehicle',
            vehicle: {}, // Pass empty vehicle for add form context
            formData: req.body, // Repopulate form with submitted data
            isEditing: false,
            vehicleTypes: Vehicle.VEHICLE_TYPES,
            fuelTypes: Vehicle.FUEL_TYPES,
            error: errorMessage,
            layout: './layouts/dashboard_layout'
        });
    }
});

// GET /vehicles/:id/edit - Show form to edit a vehicle
router.get('/:id/edit', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        const vehicle = await Vehicle.findById(req.params.id).lean();

        if (!vehicle) {
            return res.status(404).render('error_page', { title: "Not Found", message: "Vehicle not found.", layout: './layouts/dashboard_layout' });
        }

        if (loggedInUser.role === 'warehouse_owner' && vehicle.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
            return res.status(403).render('error_page', { title: "Access Denied", message: "You do not have permission to edit this vehicle.", layout: './layouts/dashboard_layout' });
        }

        res.render('vehicles/form', {
            title: 'Edit Vehicle',
            vehicle: vehicle,         // Current data of the vehicle being edited
            formData: vehicle,        // Pre-fill formData with current vehicle data
            isEditing: true,
            vehicleTypes: Vehicle.VEHICLE_TYPES,
            fuelTypes: Vehicle.FUEL_TYPES,
            layout: './layouts/dashboard_layout'
        });
    } catch (err) {
        console.error("Error fetching vehicle for edit:", err);
        res.status(500).render('error_page', { title: "Server Error", message: "Failed to load vehicle for editing.", layout: './layouts/dashboard_layout' });
    }
});

// PUT /vehicles/:id - Update an existing vehicle
router.put('/:id', async (req, res) => {
    const vehicleId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;
    const { vehicleNumber, type, modelName, fuelType, capacityVolume, capacityWeight, notes, isActive } = req.body;

    try {
        const vehicleToUpdate = await Vehicle.findById(vehicleId);
        if (!vehicleToUpdate) {
             return res.redirect('/vehicles?error=Vehicle+not+found');
        }

        if (loggedInUser.role === 'warehouse_owner' && vehicleToUpdate.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
            return res.redirect('/vehicles?error=Access+Denied');
        }

        const upperVehicleNumber = vehicleNumber.toUpperCase().trim();
        if (!upperVehicleNumber) {
             throw new mongoose.Error.ValidationError(null).addError('vehicleNumber', new mongoose.Error.ValidatorError({ message: 'Vehicle number cannot be empty.' }));
        }

        if (upperVehicleNumber !== vehicleToUpdate.vehicleNumber) {
            const existingVehicle = await Vehicle.findOne({
                companyId: vehicleToUpdate.companyId,
                vehicleNumber: upperVehicleNumber,
                _id: { $ne: vehicleId } 
            });
            if (existingVehicle) {
                 throw new mongoose.Error.ValidationError(null).addError('vehicleNumber', new mongoose.Error.ValidatorError({ message: `Vehicle number '${upperVehicleNumber}' already exists.` }));
            }
        }

        vehicleToUpdate.vehicleNumber = upperVehicleNumber;
        vehicleToUpdate.type = type;
        vehicleToUpdate.modelName = modelName;
        vehicleToUpdate.fuelType = fuelType || undefined;
        vehicleToUpdate.capacityVolume = capacityVolume ? Number(capacityVolume) : undefined;
        vehicleToUpdate.capacityWeight = capacityWeight ? Number(capacityWeight) : undefined;
        vehicleToUpdate.notes = notes;
        vehicleToUpdate.isActive = (isActive === 'on' || isActive === true); // Handle checkbox
        // initialOdometer is not changed here. currentOdometer will be updated by logs.
        vehicleToUpdate.lastUpdated = new Date();

        await vehicleToUpdate.save();
        console.log(`Vehicle ${vehicleToUpdate.vehicleNumber} updated.`);
        req.flash('success_msg', `Vehicle ${vehicleToManage.vehicleNumber} ${statusMsg} successfully.`);
        res.redirect('/vehicles');

    } catch (err) {
        console.error("Error updating vehicle:", err);
        let errorMessage = "Failed to update vehicle. Please check your inputs.";
        if (err.name === 'ValidationError') {errorMessage = Object.values(err.errors).map(val => val.message).join(' ');}
        else if (err.message) {errorMessage = err.message;}

        // For re-rendering form, pass original vehicle data if possible for context, and req.body as formData
        req.flash('error_msg', `Failed to update vehicle status: ${err.message}`);
        res.redirect('/vehicles');
        const vehicleDataForForm = await Vehicle.findById(vehicleId).lean() || { ...req.body, _id: vehicleId }; // Fallback
        res.status(400).render('vehicles/form', {
            title: 'Edit Vehicle', 
            vehicle: vehicleDataForForm, // Original or minimal data for form structure
            formData: req.body,      // Submitted data with errors
            isEditing: true,
            vehicleTypes: Vehicle.VEHICLE_TYPES, fuelTypes: Vehicle.FUEL_TYPES,
            error: errorMessage, layout: './layouts/dashboard_layout'
        });
    }
});

// DELETE /vehicles/:id - Soft delete (mark as inactive)
router.delete('/:id', async (req, res) => {
    const vehicleId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;

    try {
        const vehicleToManage = await Vehicle.findById(vehicleId);
        if (!vehicleToManage) {
            return res.redirect('/vehicles?error=Vehicle+not+found');
        }

        if (loggedInUser.role === 'warehouse_owner' && vehicleToManage.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
            return res.redirect(`/vehicles?error=Access+Denied`);
        }
        
        // Toggle isActive status instead of just deactivating
        vehicleToManage.isActive = !vehicleToManage.isActive; 
        if (!vehicleToManage.isActive) { // If deactivating
            vehicleToManage.assignedDriverId = null; // Unassign driver
        }
        vehicleToManage.lastUpdated = new Date();
        await vehicleToManage.save();

        const statusMsg = vehicleToManage.isActive ? 'reactivated' : 'deactivated';
        console.log(`Vehicle ${vehicleToManage.vehicleNumber} ${statusMsg}.`);
        res.redirect(`/vehicles?success=Vehicle+${statusMsg}+successfully`);

    } catch (err) {
        console.error("Error managing vehicle active status:", err);
        res.redirect(`/vehicles?error=Failed+to+update+vehicle+status:+${err.message}`);
    }
});

module.exports = router;