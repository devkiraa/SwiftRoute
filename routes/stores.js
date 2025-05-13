// routes/stores.js
const express = require('express');
const mongoose = require('mongoose');
const Store = require('../models/Store');
const Company = require('../models/Company'); // Might be needed for admin view/checks
const Order = require('../models/Order');   // Needed to check before delete
const User = require('../models/User');     // For auth checks

const router = express.Router();

// --- Middleware ---
function ensureAuthenticated(req, res, next) {
    if (res.locals.loggedInUser) return next();
    res.redirect('/login');
}

// Only Admins or Warehouse Owners can manage stores
async function ensureAdminOrOwner(req, res, next) {
    const loggedInUser = res.locals.loggedInUser;
    if (!loggedInUser) return res.status(401).send("Authentication required.");

    if (loggedInUser.role === 'admin') return next(); 

    if (loggedInUser.role === 'warehouse_owner') {
        if (!loggedInUser.companyId) {
             return res.status(403).render('error_page', { title: "Access Denied", message: "You are not associated with a company.", layout: './layouts/dashboard_layout' });
        }
        // Further checks in specific routes to ensure store belongs to user's company
        return next();
    }
    res.status(403).render('error_page', { title: "Access Denied", message: "You do not have permission to manage stores.", layout: './layouts/dashboard_layout' });
}

router.use(ensureAuthenticated, ensureAdminOrOwner);
// --- End Middleware ---


// GET /stores - List all stores for the company
router.get('/', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        let query = {};
        if (loggedInUser.role === 'warehouse_owner') {
            query.companyId = loggedInUser.companyId._id || loggedInUser.companyId;
        } // Admin sees all

        const stores = await Store.find(query).populate('companyId', 'companyName').sort({ storeName: 1 }).lean();
        
        res.render('stores/index', {
            title: 'Manage Stores',
            stores: stores,
            success_msg: req.query.success,
            error_msg: req.query.error,
            layout: './layouts/dashboard_layout'
        });
    } catch (err) {
        console.error("Error fetching stores:", err);
        res.status(500).render('error_page', { title: "Server Error", message: "Failed to load stores.", layout: './layouts/dashboard_layout' });
    }
});

// routes/stores.js (GET /new excerpt - corrected)
router.get('/new', async (req, res) => {
    let companies = [];
    // CORRECTED: Use res.locals
    if (res.locals.loggedInUser && res.locals.loggedInUser.role === 'admin') {
        try {
            companies = await Company.find().select('companyName _id').sort({ companyName: 1 }).lean();
        } catch (err) {
            console.error("Error fetching companies for admin (new store form):", err);
        }
    }
    res.render('stores/form', {
        title: 'Add New Store',
        store: {}, formData: {}, isEditing: false, companies,
        googleMapsApiKey: process.env.Maps_API_KEY_FRONTEND, // Pass API key for map
        layout: './layouts/dashboard_layout'
    });
});

// POST /stores - Create a new store
router.post('/', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    // Determine companyId: Admin selects, Owner uses their own
    const companyId = loggedInUser.role === 'admin' ? req.body.companyId : (loggedInUser.companyId?._id || loggedInUser.companyId);
     if (!companyId) {
          // Re-render form with error if company ID is missing (esp. for Admin)
           let companies = []; if (loggedInUser.role === 'admin') { companies = await Company.find().select('companyName _id').lean(); }
           return res.status(400).render('stores/form', { title: 'Add New Store', store: {}, formData: req.body, isEditing: false, companies, error: 'Company ID is required.', layout: './layouts/dashboard_layout' });
     }

    const { storeName, phone, email, gstin, stateCode, address_street, address_city, address_state, address_pincode, address_country, coordinates_lat, coordinates_lng } = req.body;

    try {
        // Construct address and location objects
        const address = { street: address_street, city: address_city, state: address_state, pincode: address_pincode, country: address_country || 'India' };
        let location = null;
        if (coordinates_lat && coordinates_lng && !isNaN(parseFloat(coordinates_lat)) && !isNaN(parseFloat(coordinates_lng))) {
            location = { type: 'Point', coordinates: [parseFloat(coordinates_lng), parseFloat(coordinates_lat)] };
        }

        const newStore = new Store({
            companyId, storeName, phone, email, gstin: gstin?.toUpperCase(), stateCode, address, location
        });
        await newStore.save();
        res.redirect('/stores?success=Store+added+successfully');

    } catch (err) {
        console.error("Error creating store:", err);
        let errorMessage = "Failed to add store.";
        if (err.name === 'ValidationError') { errorMessage = Object.values(err.errors).map(val => val.message).join(', '); }
        let companies = []; if (loggedInUser.role === 'admin') { companies = await Company.find().select('companyName _id').lean(); }
        res.status(400).render('stores/form', {
            title: 'Add New Store', store: {}, formData: req.body, isEditing: false, companies, error: errorMessage, layout: './layouts/dashboard_layout'
        });
    }
});

// --- EDIT / UPDATE / DELETE ---

// GET /stores/:id/edit - Show edit form
router.get('/:id/edit', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        const store = await Store.findById(req.params.id).lean();

        if (!store) {
            return res.status(404).render('error_page', { title: "Not Found", message: "Store not found.", layout: './layouts/dashboard_layout' });
        }

        // Authorization: Check if owner owns this store's company
        if (loggedInUser.role === 'warehouse_owner' && store.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
            return res.status(403).render('error_page', { title: "Access Denied", message: "You do not have permission to edit this store.", layout: './layouts/dashboard_layout' });
        }
        
        let companies = [];
        if (loggedInUser.role === 'admin') {
            companies = await Company.find().select('companyName _id').lean();
        }

        res.render('stores/form', {
            title: 'Edit Store',
            store: store, // Pass the store data to pre-fill
            formData: store, // Pre-fill formData too
            isEditing: true,
            companies, // Pass companies for admin if needed (though company shouldn't change)
            googleMapsApiKey: process.env.Maps_API_KEY_FRONTEND,
            layout: './layouts/dashboard_layout'
        });
    } catch (err) {
        console.error("Error fetching store for edit:", err);
        res.status(500).render('error_page', { title: "Server Error", message: "Failed to load store for editing.", layout: './layouts/dashboard_layout' });
    }
});

// PUT /stores/:id - Update store details
router.put('/:id', async (req, res) => {
    const storeId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;
    const { storeName, phone, email, gstin, stateCode, address_street, address_city, address_state, address_pincode, address_country, coordinates_lat, coordinates_lng } = req.body;
    // Note: companyId is typically not changed

    try {
        const storeToUpdate = await Store.findById(storeId);
        if (!storeToUpdate) {
            return res.redirect('/stores?error=Store+not+found');
        }

        // Authorization
        if (loggedInUser.role === 'warehouse_owner' && storeToUpdate.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
             return res.redirect('/stores?error=Access+Denied');
        }
        
        // Construct address and location objects
        const address = { street: address_street, city: address_city, state: address_state, pincode: address_pincode, country: address_country || 'India' };
        let location = storeToUpdate.location; // Keep old location unless new coords provided
        if (coordinates_lat && coordinates_lng && !isNaN(parseFloat(coordinates_lat)) && !isNaN(parseFloat(coordinates_lng))) {
            location = { type: 'Point', coordinates: [parseFloat(coordinates_lng), parseFloat(coordinates_lat)] };
        }

        // Update fields
        storeToUpdate.storeName = storeName;
        storeToUpdate.phone = phone;
        storeToUpdate.email = email;
        storeToUpdate.gstin = gstin?.toUpperCase();
        storeToUpdate.stateCode = stateCode;
        storeToUpdate.address = address;
        storeToUpdate.location = location;
        storeToUpdate.lastUpdated = new Date(); // Assuming you add this field to the model

        await storeToUpdate.save();
        res.redirect('/stores?success=Store+updated+successfully');

    } catch (err) {
        console.error(`Error updating store ${storeId}:`, err);
        let errorMessage = "Failed to update store.";
        if (err.name === 'ValidationError') { errorMessage = Object.values(err.errors).map(val => val.message).join(', '); }
        
        // Re-render edit form with error
        const storeDataForForm = await Store.findById(storeId).lean() || { _id: storeId };
        let companies = []; if (loggedInUser.role === 'admin') { companies = await Company.find().select('companyName _id').lean(); }
        res.status(400).render('stores/form', {
            title: 'Edit Store',
            store: storeDataForForm, // Original data
            formData: req.body, // Submitted data with error
            isEditing: true,
            companies,
            error: errorMessage,
            layout: './layouts/dashboard_layout'
        });
    }
});

// DELETE /stores/:id - Delete a store
router.delete('/:id', async (req, res) => {
    const storeId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;

    try {
        const storeToDelete = await Store.findById(storeId);
        if (!storeToDelete) {
            return res.redirect('/stores?error=Store+not+found');
        }

        // Authorization
        if (loggedInUser.role === 'warehouse_owner' && storeToDelete.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
            return res.redirect('/stores?error=Access+Denied');
        }

        // ** Check for dependencies **
        const relatedOrders = await Order.countDocuments({ storeId: storeId });
        if (relatedOrders > 0) {
            console.log(`Attempt to delete store ${storeId} failed: Store has ${relatedOrders} associated orders.`);
            return res.redirect(`/stores?error=Cannot+delete+store+as+it+has+${relatedOrders}+associated+orders.`);
            // Alternatively, implement soft delete (e.g., add an 'isActive' flag to Store model)
        }

        // If no dependencies, proceed with hard delete (use soft delete in production!)
        await Store.findByIdAndDelete(storeId);
        console.log(`Store ${storeId} deleted by user ${loggedInUser._id}`);
        res.redirect('/stores?success=Store+deleted+successfully');

    } catch (err) {
        console.error(`Error deleting store ${storeId}:`, err);
        res.redirect(`/stores?error=Failed+to+delete+store:+${err.message}`);
    }
});


module.exports = router;