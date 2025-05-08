// routes/warehouses.js
const express = require('express');
const mongoose = require('mongoose');
const Warehouse = require('../models/Warehouse');
const Item = require('../models/Item'); // Needed for delete check
const Order = require('../models/Order'); // Needed for delete check
const Company = require('../models/Company'); // Needed for Admin potentially
const User = require('../models/User'); // For auth checks

const router = express.Router();

// --- Middleware (Ensure Authentication and Admin/Owner Role) ---
function ensureAuthenticated(req, res, next) {
    if (res.locals.loggedInUser) return next();
    res.redirect('/login');
}

async function ensureAdminOrOwner(req, res, next) {
    const loggedInUser = res.locals.loggedInUser;
    if (!loggedInUser) return res.status(401).send("Authentication required.");
    if (loggedInUser.role === 'admin' || loggedInUser.role === 'warehouse_owner') {
         if (loggedInUser.role === 'warehouse_owner' && !loggedInUser.companyId) {
             return res.status(403).render('error_page', { title: "Access Denied", message: "You are not associated with a company.", layout: './layouts/dashboard_layout' });
         }
        return next();
    }
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
        const warehouses = await Warehouse.find(query).populate('companyId', 'companyName').sort({ name: 1 }).lean();
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
     if (req.locals?.loggedInUser?.role === 'admin') {
         companies = await Company.find().select('companyName _id').lean();
     }
    res.render('warehouses/form', {
        title: 'Add New Warehouse',
        warehouse: {}, formData: {}, isEditing: false, companies,
        layout: './layouts/dashboard_layout'
    });
});

// POST /warehouses - Create new warehouse
router.post('/', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    const companyId = loggedInUser.role === 'admin' ? req.body.companyId : (loggedInUser.companyId?._id || loggedInUser.companyId);
     if (!companyId) {
        // Handle missing company ID error, potentially re-rendering form
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
        let companies = []; if (loggedInUser.role === 'admin') { companies = await Company.find().select('companyName _id').lean(); }
        res.status(400).render('warehouses/form', {
            title: 'Add New Warehouse', warehouse: {}, formData: req.body, isEditing: false, companies, error: errorMessage, layout: './layouts/dashboard_layout'
        });
    }
});

// --- EDIT / UPDATE / DELETE ---

// GET /warehouses/:id/edit - Show edit form
router.get('/:id/edit', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        const warehouse = await Warehouse.findById(req.params.id).lean();

        if (!warehouse) {
             return res.status(404).render('error_page', { title: "Not Found", message: "Warehouse not found.", layout: './layouts/dashboard_layout' });
        }

        // Authorization
        if (loggedInUser.role === 'warehouse_owner' && warehouse.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
            return res.status(403).render('error_page', { title: "Access Denied", message: "You cannot edit this warehouse.", layout: './layouts/dashboard_layout' });
        }
        
        let companies = []; // Only needed if admin can change company, usually not allowed.
        // if (loggedInUser.role === 'admin') { companies = await Company.find().select('companyName _id').lean(); }

        res.render('warehouses/form', {
            title: 'Edit Warehouse',
            warehouse: warehouse,
            formData: warehouse, // Pre-fill form data with current warehouse data
            isEditing: true,
            companies, // Pass if admin can change company
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
    // companyId is usually not changed

    try {
        const warehouseToUpdate = await Warehouse.findById(warehouseId);
        if (!warehouseToUpdate) {
             return res.redirect('/warehouses?error=Warehouse+not+found');
        }

        // Authorization
        if (loggedInUser.role === 'warehouse_owner' && warehouseToUpdate.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
            return res.redirect('/warehouses?error=Access+Denied');
        }

        const address = { street: address_street, city: address_city, state: address_state, pincode: address_pincode, country: address_country || 'India' };
        let location = warehouseToUpdate.location;
        if (coordinates_lat && coordinates_lng && !isNaN(parseFloat(coordinates_lat)) && !isNaN(parseFloat(coordinates_lng))) {
            location = { type: 'Point', coordinates: [parseFloat(coordinates_lng), parseFloat(coordinates_lat)] };
        }

        warehouseToUpdate.name = name;
        warehouseToUpdate.phone = phone;
        warehouseToUpdate.email = email;
        warehouseToUpdate.address = address;
        warehouseToUpdate.location = location;
        warehouseToUpdate.lastUpdated = new Date(); // Assuming you add this field

        await warehouseToUpdate.save();
        res.redirect('/warehouses?success=Warehouse+updated+successfully');

    } catch (err) {
        console.error(`Error updating warehouse ${warehouseId}:`, err);
        let errorMessage = "Failed to update warehouse.";
        if (err.name === 'ValidationError') { errorMessage = Object.values(err.errors).map(val => val.message).join(', '); }
        
        const warehouseDataForForm = await Warehouse.findById(warehouseId).lean() || { _id: warehouseId };
        let companies = []; if (loggedInUser.role === 'admin') { companies = await Company.find().select('companyName _id').lean(); }
        res.status(400).render('warehouses/form', {
            title: 'Edit Warehouse',
            warehouse: warehouseDataForForm,
            formData: req.body, // Submitted data with errors
            isEditing: true,
            companies,
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

        // Authorization
        if (loggedInUser.role === 'warehouse_owner' && warehouseToDelete.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
             return res.redirect('/warehouses?error=Access+Denied');
        }

        // ** Check for dependencies (Items, Orders using this warehouse) **
        const relatedItemsCount = await Item.countDocuments({ warehouseId: warehouseId });
        if (relatedItemsCount > 0) {
            console.log(`Attempt to delete warehouse ${warehouseId} failed: Warehouse has ${relatedItemsCount} associated items.`);
            return res.redirect(`/warehouses?error=Cannot+delete+warehouse+as+it+has+${relatedItemsCount}+associated+items.`);
        }
        
        // Optionally check for Orders fulfilled by this warehouse too
        const relatedOrdersCount = await Order.countDocuments({ warehouseId: warehouseId });
         if (relatedOrdersCount > 0) {
             console.log(`Attempt to delete warehouse ${warehouseId} failed: Warehouse has ${relatedOrdersCount} associated orders.`);
             return res.redirect(`/warehouses?error=Cannot+delete+warehouse+as+it+has+${relatedOrdersCount}+associated+orders.`);
         }
         
        // If no dependencies, proceed with hard delete
        await Warehouse.findByIdAndDelete(warehouseId);
        console.log(`Warehouse ${warehouseId} deleted by user ${loggedInUser._id}`);
        res.redirect('/warehouses?success=Warehouse+deleted+successfully');

    } catch (err) {
        console.error(`Error deleting warehouse ${warehouseId}:`, err);
        res.redirect(`/warehouses?error=Failed+to+delete+warehouse:+${err.message}`);
    }
});


module.exports = router;