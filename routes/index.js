// routes/index.js
const express = require('express');
// No longer need session or bcrypt here if handled globally/elsewhere
const mongoose = require('mongoose');

// Import models needed specifically for routes in THIS file
const Company = require('../models/Company');
const User = require('../models/User');
const Order = require('../models/Order');
const Store = require('../models/Store');
const Warehouse = require('../models/Warehouse');
const Item = require('../models/Item');
const bcrypt = require('bcrypt'); // Still needed for register/login

const router = express.Router();

// --- Auth Middleware (Example - can be moved to a separate file) ---
function ensureAuthenticated(req, res, next) {
    if (res.locals.loggedInUser) { // Check res.locals set by global middleware
        return next();
    }
    console.log("User not authenticated (ensureAuthenticated check), redirecting to login.");
    res.redirect('/login');
}
// --- End Auth Middleware ---



// Landing page route
router.get('/', (req, res) => {
  if (res.locals.loggedInUser) {
      // User is logged in, redirect them to their dashboard
      res.redirect('/dashboard');
  } else {
      // User is NOT logged in, render the public index/landing page
      // Make sure you have a views/index.ejs file
      res.render('index', { // <-- Change 'login' to 'index'
          title: 'Welcome to SwiftRoute', // <-- Set an appropriate title
          layout: false // <-- Keep layout: false so it doesn't use the dashboard layout
      });
  }
});

// Registration form & POST (Keep as is)
router.get('/register', (req, res) => { res.render('register', { title: 'Register', layout: false }); });
router.post('/register', async (req, res) => { /* ... keep registration logic ... */
    try {
        const { companyName, contactEmail, subscriptionPlan, username, password } = req.body;
        // TODO: Add validation
        const company = await new Company({ companyName, contactEmail, subscriptionPlan }).save();
        const salt = await bcrypt.genSalt(10);
        const hash = await bcrypt.hash(password, salt);
        const user = await new User({ username, email: contactEmail, password: hash, role: 'warehouse_owner', companyId: company._id }).save();
        req.session.userId = user._id; // Set session
        res.redirect('/dashboard');
     } catch (err) { /* ... error handling ... */ }
});

// Login form & POST (Keep as is, including session regeneration)
router.get('/login', (req, res) => {
    // Pass error message from query param if present
    res.render('login', { title: 'Login', error: req.query.error,layout: false});
});
router.post('/login', async (req, res) => { /* ... keep login logic ... */
    try {
        const { email, password } = req.body;
        const user = await User.findOne({ email });
        if (!user) return res.redirect('/login?error=invalid');
        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.redirect('/login?error=invalid');

        req.session.regenerate(err => {
            if (err) return res.redirect('/login?error=server');
            req.session.userId = user._id;
            console.log(`User ${user.username} logged in. Role: ${user.role}`);
            res.redirect('/dashboard');
        });
     } catch (err) { /* ... error handling ... */ }
});


// --- Dynamic Dashboard Route ---
// Renders the appropriate 'home' view content within the layout
router.get('/dashboard', ensureAuthenticated, async (req, res) => {
  try {
    const loggedInUser = res.locals.loggedInUser; // From global middleware
    let viewData = {
        title: 'Dashboard - SwiftRoute',
        stats: {},
        // No table data needed for the generic dashboard home usually
        // companyDetails and storeDetails might be needed if displaying them prominently
        companyDetails: res.locals.companyDetails, // Get from global middleware
        storeDetails: null // Fetch if needed based on role, or rely on global middleware if added
    };

    // --- Fetch stats based on ROLE ---
    // (This logic is duplicated from previous step, ensure it's accurate)
    switch (loggedInUser.role) {
        case 'warehouse_owner':
            if (!loggedInUser.companyId) throw new Error('Warehouse owner missing company association.');
            const [ stores, warehouses ] = await Promise.all([
                Store.find({ companyId: loggedInUser.companyId }).lean(),
                Warehouse.find({ companyId: loggedInUser.companyId }).lean()
            ]);
            const whIds = warehouses.map(wh => wh._id);
            const stIds = stores.map(s => s._id);
            const [ itemsResult, pendingOrders ] = await Promise.all([
                 Item.aggregate([ { $match: { warehouseId: { $in: whIds } } }, { $group: { _id: null, totalQuantity: { $sum: "$quantity" } } } ]),
                 Order.countDocuments({ storeId: { $in: stIds }, orderStatus: { $in: ['pending', 'confirmed'] } })
            ]);
            viewData.stats = { totalStores: stores.length, totalWarehouses: warehouses.length, totalItemCount: itemsResult[0]?.totalQuantity || 0, pendingOrdersCompanyWide: pendingOrders };
            viewData.title = `Dashboard - ${res.locals.companyDetails?.companyName || 'Company'}`;
            break;
        case 'store_owner':
             if (!loggedInUser.storeId) throw new Error('Store owner missing store association.');
             // Fetch store details if not already done by global middleware
             viewData.storeDetails = await Store.findById(loggedInUser.storeId).lean();
             if (!viewData.storeDetails) throw new Error('Store not found.');
             viewData.title = `Store Dashboard - ${viewData.storeDetails.storeName}`;
             const [ custCount, storeOrderCount, empCount ] = await Promise.all([
                 User.countDocuments({ storeId: loggedInUser.storeId, role: 'customer' }),
                 Order.countDocuments({ storeId: loggedInUser.storeId, orderStatus: { $in: ['pending', 'confirmed'] } }),
                 User.countDocuments({ storeId: loggedInUser.storeId, role: 'employee' })
             ]);
             viewData.stats = { totalCustomers: custCount, pendingOrdersStore: storeOrderCount, totalEmployees: empCount };
            break;
        case 'employee':
            if (!loggedInUser.storeId) throw new Error('Employee missing store association.');
            viewData.storeDetails = await Store.findById(loggedInUser.storeId).lean();
            if (!viewData.storeDetails) throw new Error('Store not found.');
            viewData.title = `Employee Dashboard - ${viewData.storeDetails.storeName}`;
            // Fetch stats relevant to employee? Maybe pending tasks/orders?
             const pendingStoreOrdersEmp = await Order.countDocuments({ storeId: loggedInUser.storeId, orderStatus: { $in: ['pending', 'confirmed'] } });
             viewData.stats = { pendingStoreOrders: pendingStoreOrdersEmp };
            break;
        case 'delivery_partner':
             viewData.title = `Delivery Dashboard`;
             const assignedOrdersCount = await Order.countDocuments({ assignedDeliveryPartnerId: loggedInUser._id, orderStatus: { $in: ['shipped', 'confirmed'] } });
             viewData.stats = { pendingDeliveries: assignedOrdersCount };
            break;
        case 'admin':
             viewData.title = `Admin Dashboard`;
             const [ compCount, userCount ] = await Promise.all([ Company.countDocuments(), User.countDocuments() ]);
             viewData.stats = { totalCompanies: compCount, totalUsers: userCount };
            break;
        default:
            throw new Error('Access Denied: Unknown user role.');
    }

    // Render the 'home' specific view using the layout
    res.render('dashboard_home', viewData); // Render views/dashboard_home.ejs

  } catch (err) {
    console.error(`Dashboard loading error for user ${req.session?.userId || 'UNKNOWN'}:`, err);
    res.status(err.message.includes('not found') ? 404 : 500).send(`Could not load dashboard: ${err.message}`);
  }
});

// POST route for logout (keep as is)
router.post('/logout', (req, res, next) => { /* ... keep logout logic ... */ });

module.exports = router;