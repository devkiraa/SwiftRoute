// routes/stores.js
const express = require('express');
const Store = require('../models/Store');
const User = require('../models/User');
const Company = require('../models/Company');
const { default: mongoose } = require('mongoose');

const router = express.Router();

// --- Local Auth Middleware ---
function ensureAuthenticated(req, res, next) {
    if (res.locals.loggedInUser) return next();
    res.redirect('/login');
}

function ensureAdminOrOwner(req, res, next) {
    const loggedInUser = res.locals.loggedInUser;
    if (loggedInUser && ['warehouse_owner', 'admin'].includes(loggedInUser.role)) {
        if (loggedInUser.role === 'warehouse_owner' && !loggedInUser.companyId) {
             return res.status(400).send("User not associated with a company");
        }
        return next();
    }
    res.status(403).send("Access Denied: Admin or Warehouse Owner role required.");
}

function ensureCanViewStores(req, res, next) {
    const loggedInUser = res.locals.loggedInUser;
    if (loggedInUser && ['warehouse_owner', 'admin'].includes(loggedInUser.role)) {
        return next();
    }
    res.status(403).send("Access Denied: You do not have permission to view the store list.");
}
// --- End Local Auth Middleware ---


// GET /stores - List stores
router.get('/', ensureAuthenticated, ensureCanViewStores, async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        let query = {};
        let allCompanies = null;

        if (loggedInUser.role === 'warehouse_owner') {
            query.companyId = loggedInUser.companyId;
        } else if (loggedInUser.role === 'admin') {
            allCompanies = await Company.find().lean();
        }

        const stores = await Store.find(query)
            .populate('companyId', 'companyName')
            .sort({ storeName: 1 }) // Sort by name
            .lean();

        res.render('stores/index', {
            title: 'Manage Stores',
            stores: stores,
            allCompanies: allCompanies,
            layout: './layouts/dashboard_layout'
        });
    } catch (err) { /* ... error handling ... */ }
});

// GET /stores/new - Show form
// Apply specific middleware
router.get('/new', ensureAuthenticated, ensureAdminOrOwner, async (req, res) => {
     let companies = null;
     if (res.locals.loggedInUser.role === 'admin') {
         try {
             companies = await Company.find({}, 'id companyName').lean();
         } catch(err) { /* ... error handling ... */ }
     }
    res.render('stores/form', {
        title: 'Add New Store',
        store: {},
        companies: companies,
        // *** CORRECTED API KEY VARIABLE NAME ***
        googleMapsApiKey: process.env.Maps_API_KEY,
        layout: './layouts/dashboard_layout'
    });
});

// POST /stores - Create store
// Apply specific middleware
router.post('/', ensureAuthenticated, ensureAdminOrOwner, async (req, res) => {
    let companies = null; // Define for use in catch block
    try {
        const loggedInUser = res.locals.loggedInUser;
        const { storeName, address, phone, email, deliveryWindow, latitude, longitude, companyId: companyIdFromForm } = req.body;

        if (!storeName || !address || !latitude || !longitude) {
            throw new Error("Store Name, Address, and Location are required.");
        }

        let targetCompanyId;
        if (loggedInUser.role === 'admin') {
            if (!companyIdFromForm || !mongoose.Types.ObjectId.isValid(companyIdFromForm)) { throw new Error("Admin must select a valid Company."); }
            targetCompanyId = companyIdFromForm;
        } else { // warehouse_owner
             if (!loggedInUser.companyId) { throw new Error("Warehouse owner is not associated with a company."); }
            targetCompanyId = loggedInUser.companyId;
        }

        const newStore = new Store({
            storeName, address, phone, email, deliveryWindow,
            location: { type: 'Point', coordinates: [parseFloat(longitude), parseFloat(latitude)] },
            companyId: targetCompanyId
        });

        await newStore.save();
        res.redirect('/stores');

    } catch (err) {
        console.error("Error creating store:", err);
         if (res.locals.loggedInUser.role === 'admin') { // Fetch companies again for error re-render if admin
             try { companies = await Company.find({}, 'id companyName').lean(); } catch(e) { console.error(e); }
         }
        res.status(400).render('stores/form', {
            title: 'Add New Store',
            store: req.body,
            companies: companies,
            // *** CORRECTED API KEY VARIABLE NAME ***
            googleMapsApiKey: process.env.Maps_API_KEY,
            error: `Failed to add store: ${err.message}`,
            layout: './layouts/dashboard_layout'
        });
    }
});

// --- Add routes for viewing details, editing, updating, deleting later ---
// GET /stores/:id
// GET /stores/:id/edit
// PUT /stores/:id (or POST with method override)
// DELETE /stores/:id (or POST with method override)

module.exports = router;