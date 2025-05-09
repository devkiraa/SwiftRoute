// routes/warehouses.js
const express = require('express');
const mongoose = require('mongoose');
const Warehouse = require('../models/Warehouse');
const Item = require('../models/Item'); // Needed for delete check
const Order = require('../models/Order'); // Needed for delete check
const Company = require('../models/Company'); // Needed for Admin to select company if adding
const User = require('../models/User'); // For auth checks

const router = express.Router();

// --- Middleware (Ensure Authentication and Admin/Owner Role) ---
function ensureAuthenticated(req, res, next) {
    if (res.locals.loggedInUser) return next();
    console.log("User not authenticated (warehouses route), redirecting to login.");
    res.redirect('/login');
}

async function ensureAdminOrOwner(req, res, next) {
    const loggedInUser = res.locals.loggedInUser;
    if (!loggedInUser) {
        console.log("Authentication required for warehouse management.");
        return res.status(401).send("Authentication required.");
    }
    if (loggedInUser.role === 'admin' || loggedInUser.role === 'warehouse_owner') {
         if (loggedInUser.role === 'warehouse_owner' && !loggedInUser.companyId) {
             console.log("Warehouse owner not associated with a company.");
             return res.status(403).render('error_page', { title: "Access Denied", message: "You are not associated with a company to manage warehouses.", layout: './layouts/dashboard_layout' });
         }
        return next();
    }
    console.log(`Access Denied: Role ${loggedInUser.role} cannot manage warehouses.`);
    res.status(403).render('error_page', { title: "Access Denied", message: "You do not have permission to manage warehouses.", layout: './layouts/dashboard_layout' });
}

router.use(ensureAuthenticated, ensureAdminOrOwner);
// --- End Middleware ---
// GET /warehouses - List warehouses
router.get('/', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        let query = {};
        if (loggedInUser.role === 'warehouse_owner') {
            query.companyId = loggedInUser.companyId._id || loggedInUser.companyId;
        }
        const warehouses = await Warehouse.find(query)
            .populate('companyId', 'companyName') // Useful for admin view
            .sort({ name: 1 })
            .lean(); // .lean() is good for rendering read-only data

        // Optional: You could aggregate item counts here if desired, but be mindful of performance
        // For now, we'll keep it simple and focus on the view redesign.

        res.render('warehouses/index', {
            title: 'Manage Warehouses',
            warehouses: warehouses,
            success_msg: req.query.success,
            error_msg: req.query.error,
            layout: './layouts/dashboard_layout'
        });
    } catch (err) {
        console.error("Error fetching warehouses:", err);
        res.status(500).render('error_page', { title: "Error", message: "Failed to load warehouses.", layout: './layouts/dashboard_layout' });
    }
});

// GET /warehouses/new - Show add form
router.get('/new', async (req, res) => {
    let companies = [];
    if (res.locals.loggedInUser && res.locals.loggedInUser.role === 'admin') {
        try {
            companies = await Company.find().select('companyName _id').sort({ companyName: 1 }).lean();
        } catch (err) {
            console.error("Error fetching companies for admin:", err);
        }
    }
    res.render('warehouses/form', {
        title: 'Add New Warehouse',
        warehouse: {},
        formData: {},
        isEditing: false,
        companies,
        layout: './layouts/dashboard_layout'
    });
});

// POST /warehouses - Create new warehouse
router.post('/', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    const companyId = (loggedInUser.role === 'admin' && req.body.companyId) 
                      ? req.body.companyId 
                      : (loggedInUser.companyId?._id || loggedInUser.companyId);

    if (!companyId) {
        let companies = []; if (loggedInUser.role === 'admin') { companies = await Company.find().select('companyName _id').lean(); }
        return res.status(400).render('warehouses/form', { title: 'Add New Warehouse', warehouse: {}, formData: req.body, isEditing: false, companies, error: 'Company ID is required.', layout: './layouts/dashboard_layout' });
    }

    const { name, phone, email, address_street, address_city, address_state, address_pincode, address_country, coordinates_lat, coordinates_lng } = req.body;
    
    try {
        const address = { street: address_street, city: address_city, state: address_state, pincode: address_pincode, country: address_country || 'India' };
        let location = null;
        if (coordinates_lat && coordinates_lng && !isNaN(parseFloat(coordinates_lat)) && !isNaN(parseFloat(coordinates_lng))) {
            location = { type: 'Point', coordinates: [parseFloat(coordinates_lng), parseFloat(coordinates_lat)] };
        }

        const newWarehouse = new Warehouse({ companyId, name, phone, email, address, location });
        await newWarehouse.save();
        res.redirect('/warehouses?success=Warehouse+added+successfully');
    } catch (err) {
        console.error("Error creating warehouse:", err);
        let errorMessage = "Failed to add warehouse.";
        if (err.name === 'ValidationError') { errorMessage = Object.values(err.errors).map(val => val.message).join(', '); }
        else if (err.message) { errorMessage = err.message; }
        let companies = []; if (loggedInUser.role === 'admin') { companies = await Company.find().select('companyName _id').lean(); }
        res.status(400).render('warehouses/form', {
            title: 'Add New Warehouse', warehouse: {}, formData: req.body, isEditing: false, companies, error: errorMessage, layout: './layouts/dashboard_layout'
        });
    }
});

// routes/warehouses.js (GET /:id/edit excerpt)
router.get('/:id/edit', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        // Fetch the warehouse. If it has populated companyId, it will be an object.
        const warehouse = await Warehouse.findById(req.params.id)
                                        .populate('companyId', 'companyName') // Populate company for display
                                        .lean();

        if (!warehouse) {
            return res.status(404).render('error_page', { title: "Not Found", message: "Warehouse not found.", layout: './layouts/dashboard_layout' });
        }

        // Authorization
        if (loggedInUser.role === 'warehouse_owner' && 
            (!warehouse.companyId || // Check if companyId is populated
             (warehouse.companyId._id || warehouse.companyId).toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString())) {
            return res.status(403).render('error_page', { title: "Access Denied", message: "You do not have permission to edit this warehouse.", layout: './layouts/dashboard_layout' });
        }
        
        let companies = []; 
        if (loggedInUser.role === 'admin') {
            // Only needed if admin can change company, which is generally not advised on edit.
            // companies = await Company.find().select('companyName _id').sort({ companyName: 1 }).lean();
        }

        res.render('warehouses/form', {
            title: 'Edit Warehouse',
            warehouse: warehouse, // Pass the fetched warehouse object
            formData: warehouse,  // Pre-fill formData with existing data for the form
            isEditing: true,
            companies, 
            layout: './layouts/dashboard_layout'
        });
    } catch (err) {
        console.error("Error fetching warehouse for edit:", err);
        res.status(500).render('error_page', { title: "Server Error", message: "Failed to load warehouse for editing.", layout: './layouts/dashboard_layout' });
    }
});

// PUT /warehouses/:id - Update warehouse details
router.put('/:id', async (req, res) => {
    const warehouseId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;
    const { name, phone, email, address_street, address_city, address_state, address_pincode, address_country, coordinates_lat, coordinates_lng } = req.body;

    try {
        const warehouseToUpdate = await Warehouse.findById(warehouseId);
        if (!warehouseToUpdate) {
            return res.redirect('/warehouses?error=Warehouse+not+found');
        }

        if (loggedInUser.role === 'warehouse_owner' && warehouseToUpdate.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
            return res.redirect('/warehouses?error=Access+Denied.+Cannot+update+this+warehouse.');
        }
        
        const address = { street: address_street, city: address_city, state: address_state, pincode: address_pincode, country: address_country || 'India' };
        let location = warehouseToUpdate.location;
        if (coordinates_lat && coordinates_lng && !isNaN(parseFloat(coordinates_lat)) && !isNaN(parseFloat(coordinates_lng))) {
            location = { type: 'Point', coordinates: [parseFloat(coordinates_lng), parseFloat(coordinates_lat)] };
        } else if (req.body.clear_location === 'true') { // Allow clearing location
            location = undefined; 
        }


        warehouseToUpdate.name = name;
        warehouseToUpdate.phone = phone;
        warehouseToUpdate.email = email;
        warehouseToUpdate.address = address;
        warehouseToUpdate.location = location;
        warehouseToUpdate.lastUpdated = new Date();

        await warehouseToUpdate.save();
        res.redirect('/warehouses?success=Warehouse+updated+successfully');

    } catch (err) {
        console.error(`Error updating warehouse ${warehouseId}:`, err);
        let errorMessage = "Failed to update warehouse.";
        if (err.name === 'ValidationError') { errorMessage = Object.values(err.errors).map(val => val.message).join(', '); }
        else if (err.message) { errorMessage = err.message; }
        
        const warehouseDataForForm = await Warehouse.findById(warehouseId).populate('companyId', 'companyName').lean() || { _id: warehouseId };
        res.status(400).render('warehouses/form', {
            title: 'Edit Warehouse',
            warehouse: warehouseDataForForm,
            formData: req.body, 
            isEditing: true,
            companies: [], // Not changing company on edit usually
            error: errorMessage,
            layout: './layouts/dashboard_layout'
        });
    }
});

// DELETE /warehouses/:id - Delete a warehouse
router.delete('/:id', async (req, res) => {
    const warehouseId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;

    try {
        const warehouseToDelete = await Warehouse.findById(warehouseId);
        if (!warehouseToDelete) {
            return res.redirect('/warehouses?error=Warehouse+not+found');
        }

        if (loggedInUser.role === 'warehouse_owner' && warehouseToDelete.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
            return res.redirect('/warehouses?error=Access+Denied.');
        }

        const relatedItemsCount = await Item.countDocuments({ warehouseId: warehouseId });
        if (relatedItemsCount > 0) {
            return res.redirect(`/warehouses?error=${encodeURIComponent(`Cannot delete: ${relatedItemsCount} item(s) associated with this warehouse.`)}`);
        }
        
        const relatedOrdersCount = await Order.countDocuments({ warehouseId: warehouseId });
         if (relatedOrdersCount > 0) {
             return res.redirect(`/warehouses?error=${encodeURIComponent(`Cannot delete: ${relatedOrdersCount} order(s) associated with this warehouse.`)}`);
         }
         
        await Warehouse.findByIdAndDelete(warehouseId);
        res.redirect('/warehouses?success=Warehouse+deleted+successfully');

    } catch (err) {
        console.error(`Error deleting warehouse ${warehouseId}:`, err);
        res.redirect(`/warehouses?error=${encodeURIComponent(`Failed to delete warehouse: ${err.message}`)}`);
    }
});

module.exports = router;