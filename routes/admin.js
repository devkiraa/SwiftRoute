// routes/admin.js
const express = require('express');
const Company = require('../models/Company');
const User = require('../models/User');
const mongoose = require('mongoose');

const router = express.Router();

// --- Local Auth Middleware for Admin Routes ---
function ensureAuthenticated(req, res, next) {
    // Use user data potentially set by global middleware in server.js
    if (res.locals.loggedInUser) {
        return next();
    }
    res.redirect('/login');
}

function ensureAdmin(req, res, next) {
    const loggedInUser = res.locals.loggedInUser;
    if (loggedInUser && loggedInUser.role === 'admin') {
        return next(); // User is admin, allow access
    }
    // User is not an admin or not logged in
    console.log(`Access Denied: User ${loggedInUser?._id || 'UNKNOWN'} with role ${loggedInUser?.role || 'NONE'} attempted to access admin route.`);
    res.status(403).render('error_page', {
        title: "Access Denied",
        message: "You do not have permission to access this administrative area.",
        layout: './layouts/dashboard_layout' // Use dashboard layout for consistency in error for logged-in users
    });
}

// Apply authentication and admin role check to ALL routes defined in this file
router.use(ensureAuthenticated, ensureAdmin);

// --- Admin Routes ---

// GET /admin/companies - List all companies on the platform
router.get('/companies', async (req, res) => {
    try {
        // Fetch all companies, perhaps sort by name or date
        // Add pagination later
        const companies = await Company.find()
            .sort({ companyName: 1 })
            .limit(50) // Example limit
            .lean();

        res.render('admin/companies', { // Render views/admin/companies.ejs
            title: 'Manage Companies',
            companies: companies,
            layout: './layouts/dashboard_layout' // Use dashboard layout
        });
    } catch (err) {
        console.error("Admin error fetching companies:", err);
        res.status(500).render('error_page', { title: "Server Error", message: "Failed to load companies.", layout: false });
    }
});

// GET /admin/users - List all users on the platform
router.get('/users', async (req, res) => {
     try {
        // Fetch all users, populate company name
        // Add pagination later
        const users = await User.find() // No company filter for admin
            .populate('companyId', 'companyName') // Populate company name
            .populate('storeId', 'storeName') // Optionally populate store name too
            .limit(50) // Example limit
            .sort({ createdDate: -1 })
            .lean();

         const tableData = users.map(user => ({
             _id: user._id,
             username: user.username,
             email: user.email,
             role: user.role,
             avatarUrl: user.avatarUrl,
             company: user.companyId, // Populated company object or null
             store: user.storeId    // Populated store object or null
         }));

         const pagination = { currentPage: 1, totalPages: 1 }; // Replace with real pagination

         res.render('admin/users', { // Render views/admin/users.ejs
             title: 'Manage All Users',
             tableTitle: 'All Platform Users',
             tableData: tableData,
             pagination: pagination,
             layout: './layouts/dashboard_layout' // Use dashboard layout
         });

     } catch (err) {
        console.error("Admin error fetching users:", err);
        res.status(500).render('error_page', { title: "Server Error", message: "Failed to load users.", layout: false });
     }
});


// --- TODO: Add routes for Admin actions ---
// GET /admin/companies/new - Form to add company
// POST /admin/companies - Create company
// GET /admin/companies/:id/edit - Form to edit company
// PUT /admin/companies/:id - Update company
// DELETE /admin/companies/:id - Delete company

// GET /admin/users/:id/edit - Form to edit any user (change role, company, etc.)
// PUT /admin/users/:id - Update any user
// DELETE /admin/users/:id - Delete any user

// GET /admin/settings - Platform settings page


module.exports = router;