// routes/vehicles.js
const express = require('express');
const mongoose = require('mongoose');
const Vehicle = require('../models/Vehicle');
const Company = require('../models/Company'); // If needed for any checks
const User = require('../models/User');       // For populating driver names

const router = express.Router();

// Middleware: Ensure user is authenticated
function ensureAuthenticated(req, res, next) {
    if (res.locals.loggedInUser) return next();
    res.redirect('/login');
}

// Middleware: Ensure user is admin or warehouse owner of the relevant company
async function ensureAdminOrOwner(req, res, next) {
    const loggedInUser = res.locals.loggedInUser;
    if (!loggedInUser) return res.status(401).send("Authentication required.");

    if (loggedInUser.role === 'admin') return next(); // Admin has universal access

    if (loggedInUser.role === 'warehouse_owner') {
        if (!loggedInUser.companyId) {
            return res.status(403).send("Warehouse owner not associated with a company.");
        }
        // For operations on specific vehicles, further checks might be needed
        // to ensure the vehicle belongs to this owner's company.
        return next();
    }
    res.status(403).send("Access Denied: Admin or Warehouse Owner role required.");
}

router.use(ensureAuthenticated, ensureAdminOrOwner);

// GET /vehicles - List all vehicles for the company
router.get('/', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        let query = {};
        if (loggedInUser.role === 'warehouse_owner') {
            query.companyId = loggedInUser.companyId._id || loggedInUser.companyId;
        } // Admin sees all if not scoped, or implement company filter for admin

        const vehicles = await Vehicle.find(query)
            .populate('assignedDriverId', 'username') // Show assigned driver's name
            .sort({ vehicleNumber: 1 })
            .lean();

        res.render('vehicles/index', {
            title: 'Manage Vehicles',
            vehicles: vehicles,
            layout: './layouts/dashboard_layout'
        });
    } catch (err) {
        console.error("Error fetching vehicles:", err);
        res.status(500).render('error_page', { title: "Error", message: "Failed to load vehicles.", layout: false });
    }
});

// GET /vehicles/new - Show form to add a new vehicle
router.get('/new', (req, res) => {
    res.render('vehicles/form', {
        title: 'Add New Vehicle',
        vehicle: {},        // New vehicle, empty data
        formData: {},       // Always pass formData, even if empty for initial load
        isEditing: false,
        vehicleTypes: Vehicle.VEHICLE_TYPES,
        fuelTypes: Vehicle.FUEL_TYPES,
        layout: './layouts/dashboard_layout'
    });
});

// POST /vehicles - Create a new vehicle
router.post('/', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    // Ensure companyId is correctly determined based on user role
    const companyId = (loggedInUser.role === 'admin' && req.body.companyId) // Admin might select company
                    ? req.body.companyId 
                    : (loggedInUser.companyId?._id || loggedInUser.companyId);

    if (!companyId) {
        return res.status(400).render('vehicles/form', {
            title: 'Add New Vehicle', vehicle: {}, formData: req.body, isEditing: false,
            vehicleTypes: Vehicle.VEHICLE_TYPES, fuelTypes: Vehicle.FUEL_TYPES,
            error: 'Company ID is missing for vehicle creation.', layout: './layouts/dashboard_layout'
        });
    }
    
    const { vehicleNumber, type, modelName, fuelType, capacityVolume, capacityWeight, initialOdometer, notes } = req.body;

    try {
        const existingVehicle = await Vehicle.findOne({ companyId, vehicleNumber: vehicleNumber.toUpperCase() });
        if (existingVehicle) {
            return res.status(400).render('vehicles/form', {
                title: 'Add New Vehicle', vehicle: {}, formData: req.body, isEditing: false,
                vehicleTypes: Vehicle.VEHICLE_TYPES, fuelTypes: Vehicle.FUEL_TYPES,
                error: `Vehicle number '${vehicleNumber}' already exists.`, layout: './layouts/dashboard_layout'
            });
        }

        const newVehicleData = {
            companyId, vehicleNumber: vehicleNumber.toUpperCase(), type, modelName, fuelType,
            capacityVolume: capacityVolume ? Number(capacityVolume) : undefined,
            capacityWeight: capacityWeight ? Number(capacityWeight) : undefined,
            initialOdometer: initialOdometer ? Number(initialOdometer) : 0,
            currentOdometer: initialOdometer ? Number(initialOdometer) : 0,
            notes
        };
        const newVehicle = new Vehicle(newVehicleData);
        await newVehicle.save();
        res.redirect('/vehicles?success=Vehicle+added');
    } catch (err) {
        let errorMessage = "Failed to add vehicle.";
        if (err.name === 'ValidationError') {errorMessage = Object.values(err.errors).map(val => val.message).join(', ');}
        console.error("Error creating vehicle:", err);
        res.status(400).render('vehicles/form', {
            title: 'Add New Vehicle', vehicle: {}, formData: req.body, isEditing: false,
            vehicleTypes: Vehicle.VEHICLE_TYPES, fuelTypes: Vehicle.FUEL_TYPES,
            error: errorMessage, layout: './layouts/dashboard_layout'
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

        // Authorization: Admin can edit any. Warehouse owner can only edit their company's vehicles.
        if (loggedInUser.role === 'warehouse_owner' && vehicle.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
            return res.status(403).render('error_page', { title: "Access Denied", message: "You do not have permission to edit this vehicle.", layout: './layouts/dashboard_layout' });
        }

        res.render('vehicles/form', {
            title: 'Edit Vehicle',
            vehicle: vehicle,
            isEditing: true,
            vehicleTypes: Vehicle.VEHICLE_TYPES,
            fuelTypes: Vehicle.FUEL_TYPES,
            layout: './layouts/dashboard_layout'
        });
    } catch (err) {
        console.error("Error fetching vehicle for edit:", err);
        res.status(500).render('error_page', { title: "Server Error", message: "Failed to load vehicle for editing.", layout: false });
    }
});

// PUT /vehicles/:id - Update an existing vehicle
router.put('/:id', async (req, res) => {
    const vehicleId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;
    const { vehicleNumber, type, modelName, fuelType, capacityVolume, capacityWeight, notes, isActive } = req.body;
    // initialOdometer is not updatable after creation
    // currentOdometer is updated via specific logs (fuel, trip start/end)

    try {
        const vehicleToUpdate = await Vehicle.findById(vehicleId);
        if (!vehicleToUpdate) {
            return res.status(404).render('error_page', { title: "Not Found", message: "Vehicle not found for update."});
        }

        // Authorization
        if (loggedInUser.role === 'warehouse_owner' && vehicleToUpdate.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
            return res.status(403).render('error_page', { title: "Access Denied", message: "You do not have permission to update this vehicle."});
        }

        // Check for duplicate vehicleNumber within the same company (excluding itself)
        if (vehicleNumber.toUpperCase() !== vehicleToUpdate.vehicleNumber) {
            const existingVehicle = await Vehicle.findOne({
                companyId: vehicleToUpdate.companyId,
                vehicleNumber: vehicleNumber.toUpperCase(),
                _id: { $ne: vehicleId } // Exclude the current vehicle from the check
            });
            if (existingVehicle) {
                return res.status(400).render('vehicles/form', {
                    title: 'Edit Vehicle', vehicle: { ...req.body, _id: vehicleId }, isEditing: true,
                    vehicleTypes: Vehicle.VEHICLE_TYPES, fuelTypes: Vehicle.FUEL_TYPES,
                    error: `Vehicle number '${vehicleNumber}' already exists for this company.`,
                    layout: './layouts/dashboard_layout'
                });
            }
        }

        vehicleToUpdate.vehicleNumber = vehicleNumber.toUpperCase();
        vehicleToUpdate.type = type;
        vehicleToUpdate.modelName = modelName;
        vehicleToUpdate.fuelType = fuelType;
        vehicleToUpdate.capacityVolume = capacityVolume ? Number(capacityVolume) : undefined;
        vehicleToUpdate.capacityWeight = capacityWeight ? Number(capacityWeight) : undefined;
        vehicleToUpdate.notes = notes;
        vehicleToUpdate.isActive = isActive === 'on' || isActive === true; // Handle checkbox
        // currentOdometer should not be updated here directly, only initialOdometer on creation
        vehicleToUpdate.lastUpdated = new Date();

        await vehicleToUpdate.save();
        console.log(`Vehicle ${vehicleToUpdate.vehicleNumber} updated.`);
        res.redirect('/vehicles?success=Vehicle+updated+successfully');

    } catch (err) {
        console.error("Error updating vehicle:", err);
        let errorMessage = "Failed to update vehicle.";
        if (err.name === 'ValidationError') {
            errorMessage = Object.values(err.errors).map(val => val.message).join(', ');
        }
        res.status(400).render('vehicles/form', {
            title: 'Edit Vehicle', vehicle: { ...req.body, _id: vehicleId }, isEditing: true,
            vehicleTypes: Vehicle.VEHICLE_TYPES, fuelTypes: Vehicle.FUEL_TYPES,
            error: errorMessage, layout: './layouts/dashboard_layout'
        });
    }
});

// DELETE /vehicles/:id - Soft delete a vehicle (mark as inactive)
router.delete('/:id', async (req, res) => {
    const vehicleId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;

    try {
        const vehicleToDeactivate = await Vehicle.findById(vehicleId);
        if (!vehicleToDeactivate) {
            return res.redirect('/vehicles?error=Vehicle+not+found');
        }

        // Authorization
        if (loggedInUser.role === 'warehouse_owner' && vehicleToDeactivate.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
            return res.redirect(`/vehicles?error=Access+Denied`);
        }
        
        // Soft delete: Mark as inactive and unassign driver
        vehicleToDeactivate.isActive = false;
        vehicleToDeactivate.assignedDriverId = null; // Unassign driver if vehicle is made inactive
        vehicleToDeactivate.lastUpdated = new Date();
        await vehicleToDeactivate.save();

        console.log(`Vehicle ${vehicleToDeactivate.vehicleNumber} marked as inactive.`);
        res.redirect('/vehicles?success=Vehicle+marked+as+inactive');

    } catch (err) {
        console.error("Error deactivating vehicle:", err);
        res.redirect(`/vehicles?error=Failed+to+deactivate+vehicle:+${err.message}`);
    }
});

module.exports = router;