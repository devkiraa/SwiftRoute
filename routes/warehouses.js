// routes/warehouses.js
const express = require('express');
const mongoose = require('mongoose');
const Warehouse = require('../models/Warehouse');
const User = require('../models/User');

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
// --- End Local Auth Middleware ---

router.use(ensureAuthenticated, ensureAdminOrOwner);

// GET /warehouses - List all warehouses
router.get('/', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        let query = {};
        if (loggedInUser.role === 'warehouse_owner') {
            query.companyId = loggedInUser.companyId;
        }
        const warehouses = await Warehouse.find(query).sort({ name: 1 }).lean();
        res.render('warehouses/index', {
            title: 'Manage Warehouses',
            warehouses: warehouses,
            layout: './layouts/dashboard_layout'
        });
    } catch (err) {
         console.error("Error fetching warehouses:", err);
         res.status(500).render('error_page', { title: "Error", message: "Failed to load warehouses.", layout: false });
    }
});

// GET /warehouses/new - Show form
router.get('/new', (req, res) => {
    res.render('warehouses/form', {
        title: 'Add New Warehouse',
        warehouse: {},
        // *** CORRECTED API KEY VARIABLE NAME ***
        googleMapsApiKey: process.env.Maps_API_KEY,
        layout: './layouts/dashboard_layout'
    });
});

// POST /warehouses - Create warehouse
router.post('/', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        const { name, capacity, latitude, longitude, companyId: companyIdFromForm } = req.body;

        if (!name || !latitude || !longitude) {
            throw new Error("Name and location are required.");
        }

        let targetCompanyId;
        if (loggedInUser.role === 'admin') {
             if (!companyIdFromForm || !mongoose.Types.ObjectId.isValid(companyIdFromForm)) { throw new Error("Admin must specify a valid Company ID."); }
             targetCompanyId = companyIdFromForm;
        } else { // Warehouse owner
             targetCompanyId = loggedInUser.companyId;
        }

        const newWarehouse = new Warehouse({
            name,
            capacity: capacity ? parseInt(capacity, 10) : 0,
            location: { type: 'Point', coordinates: [parseFloat(longitude), parseFloat(latitude)] },
            companyId: targetCompanyId
        });
        await newWarehouse.save();
        res.redirect('/warehouses');

    } catch (err) {
        console.error("Error creating warehouse:", err);
        res.status(400).render('warehouses/form', {
            title: 'Add New Warehouse',
            warehouse: req.body,
             // *** CORRECTED API KEY VARIABLE NAME ***
            googleMapsApiKey: process.env.Maps_API_KEY,
            error: `Failed to add warehouse: ${err.message}`,
            layout: './layouts/dashboard_layout'
        });
    }
});

// --- Placeholder routes ---
router.get('/:id/edit', (req, res) => res.send(`GET Edit Warehouse ${req.params.id} Form - NIY`));
router.put('/:id', (req, res) => res.send(`PUT Update Warehouse ${req.params.id} - NIY`));
router.delete('/:id', (req, res) => res.send(`DELETE Warehouse ${req.params.id} - NIY`));

module.exports = router;