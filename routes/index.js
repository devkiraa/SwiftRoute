// routes/index.js
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const mongoose = require('mongoose'); // Ensure mongoose is required

// Import all necessary models
const Company = require('../models/Company');
const User = require('../models/User');
const Order = require('../models/Order');
const Store = require('../models/Store');
const Warehouse = require('../models/Warehouse');
const Item = require('../models/Item');

const router = express.Router();

// Session middleware (Make sure SESSION_SECRET is defined in .env and loaded first in server.js)
// Consider moving session middleware setup to server.js to apply globally if needed by other route files
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
    console.error("FATAL ERROR: SESSION_SECRET environment variable is not set.");
    process.exit(1); // Exit if secret is not set
}
router.use(session({
  secret: sessionSecret,
  resave: false, // Recommended settings
  saveUninitialized: false, // Recommended settings
  cookie: { secure: process.env.NODE_ENV === 'production' } // Use secure cookies in production (requires HTTPS)
}));

// --- Auth Middleware (Example - Implement or use your own) ---
function ensureAuthenticated(req, res, next) {
    if (req.session && req.session.userId) {
        return next();
    }
    console.log("User not authenticated, redirecting to login.");
    res.redirect('/login');
}

async function ensureWarehouseOwner(req, res, next) {
     if (!req.session || !req.session.userId) {
         // Should be caught by ensureAuthenticated, but double-check
         return res.redirect('/login');
     }
     try {
         const user = await User.findById(req.session.userId).lean();
         if (user && user.role === 'warehouse_owner') {
            req.user = user; // Attach user to request object for use in the main route
             return next();
         } else {
             console.log(`Access Denied: User ${req.session.userId} role is not warehouse_owner.`);
             // Redirect or send forbidden if not warehouse owner
             res.status(403).send('Access Denied: Warehouse Owner role required.');
         }
     } catch(err) {
         console.error("Auth check error:", err);
         res.redirect('/login');
     }
}
// --- End Auth Middleware ---
// Landing page
router.get('/', (req, res) => {
  res.render('index', { title: 'SwiftRoute' });
});

// Registration form
router.get('/register', (req, res) => {
  res.render('register', { title: 'Register' });
});

// Process registration: create Company + warehouse_owner User
router.post('/register', async (req, res) => {
  try {
    const { companyName, contactEmail, subscriptionPlan, username, password } = req.body;

    // Create company
    const company = await new Company({ companyName, contactEmail, subscriptionPlan }).save();

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    // Create warehouse_owner user
    const user = await new User({
      username,
      email: contactEmail,
      password: hash,
      role: 'warehouse_owner',
      companyId: company._id
    }).save();

    // Set session and redirect
    req.session.userId = user._id;
    res.redirect('/dashboard');

  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).send('Registration failed');
  }
});

// Login form
router.get('/login', (req, res) => {
  res.render('login', { title: 'Login' });
});

// Process login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.redirect('/login');

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.redirect('/login');

    req.session.userId = user._id;
    res.redirect('/dashboard');

  } catch (err) {
    console.error('Login error:', err);
    res.redirect('/login');
  }
});

// --- Dashboard Route for Warehouse Owner ---
// Apply authentication middleware
router.get('/dashboard', ensureAuthenticated, ensureWarehouseOwner, async (req, res) => {
  try {
    // User object is attached to req.user by the ensureWarehouseOwner middleware
    const loggedInUser = req.user;
    const companyId = loggedInUser.companyId;

    if (!companyId) {
        console.error(`User ${loggedInUser._id} is not associated with a company.`);
        return res.status(400).send('User is not associated with a company.'); // Use return
    }

    // --- Fetch Company Details ---
    const companyDetails = await Company.findById(companyId).lean();
    if (!companyDetails) {
         console.error(`Company not found for ID: ${companyId}`);
        return res.status(404).send('Company associated with your account not found.'); // Use return
    }

    // --- Calculate Stats for the Company ---
    // Use Promise.all for concurrent fetching
    const [
        companyStores,
        companyWarehouses,
        pendingOrdersCompanyWide // Count pending orders directly
    ] = await Promise.all([
        Store.find({ companyId: companyId }).lean(),
        Warehouse.find({ companyId: companyId }).lean(),
        Order.countDocuments({ // Count orders related to the company's stores
            storeId: { $in: (await Store.find({ companyId: companyId }).select('_id')).map(s => s._id) }, // Get store IDs first
            orderStatus: { $in: ['pending', 'confirmed'] }
        })
    ]);

    const companyStoreIds = companyStores.map(store => store._id);
    const companyWarehouseIds = companyWarehouses.map(wh => wh._id);

    const totalStores = companyStores.length;
    const totalWarehouses = companyWarehouses.length;

    // Calculate total item count across company warehouses
    // Using estimatedDocumentCount can be faster if exact count isn't critical, or aggregate
    const totalItemCountResult = await Item.aggregate([
        { $match: { warehouseId: { $in: companyWarehouseIds } } },
        { $group: { _id: null, totalQuantity: { $sum: "$quantity" } } }
    ]);
    const totalItemCount = totalItemCountResult[0]?.totalQuantity || 0;


    const stats = {
      totalStores,
      totalWarehouses,
      totalItemCount,
      pendingOrdersCompanyWide
      // Add % change calculations later if needed
    };

    // --- Fetch Data for Main Table (Company Users) ---
    // Fetch users belonging to the company
    // Populate their assigned store name if applicable
    const companyUsersRaw = await User.find({ companyId: companyId })
        .populate({
            path: 'storeId',
            select: 'storeName -_id' // Select only storeName, exclude _id from populated doc
        })
        .limit(20) // Example limit, implement pagination properly later
        .sort({ createdDate: -1 }) // Example sort
        .lean();

    // Format data for the view, ensuring 'store' is accessed correctly
    const tableData = companyUsersRaw.map(user => ({
        _id: user._id,
        username: user.username,
        email: user.email,
        role: user.role,
        avatarUrl: user.avatarUrl,
        // Access the populated store object directly (it might be null if not assigned)
        store: user.storeId
    }));

    // --- Pagination Stub (Replace with actual logic) ---
    // Example: Calculate total pages based on total users for the company
    // const totalUsers = await User.countDocuments({ companyId: companyId });
    // const itemsPerPage = 20;
    // const totalPages = Math.ceil(totalUsers / itemsPerPage);
    const pagination = { currentPage: 1, totalPages: 1 }; // Replace with actual calculation

    // --- Render the Dashboard View ---
    res.render('dashboard', {
        title: `Dashboard - ${companyDetails.companyName}`, // Pass title if needed elsewhere
        loggedInUser,   // Pass the logged-in user object
        companyDetails, // Pass company details
        stats,          // Pass calculated stats
        tableData,      // Pass the formatted user list for the table
        pagination      // Pass pagination info
    });

  } catch (err) {
    console.error('Dashboard loading error for user:', req.session.userId, err);
    // Render a user-friendly error page or message
    res.status(500).send(`Could not load dashboard. Please try again later.`);
  }
});

// POST route for logout
router.post('/logout', (req, res, next) => { // Add next for error handling
    req.session.destroy(err => {
        if (err) {
            console.error("Logout error:", err);
            // Optionally pass error to an error handler
            return next(err); // Or redirect cautiously
        }
        res.clearCookie('connect.sid'); // Default session cookie name
        console.log("User logged out, redirecting to login.");
        res.redirect('/login');
    });
});

module.exports = router;
