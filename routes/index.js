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
// --- Dashboard Route ---
router.get('/dashboard', ensureAuthenticated, async (req, res) => {
    const loggedInUser = res.locals.loggedInUser; // Get user from global middleware
    const companyId = loggedInUser.companyId?._id || loggedInUser.companyId; // Handle populated or just ID
    const storeId = loggedInUser.storeId;

    let dashboardData = { stats: {}, recentOrders: [] }; // Initialize data object
    let canCreateOrder = false; // Default
    let viewTitle = 'Dashboard';

    try {
        console.log(`Loading dashboard for role: ${loggedInUser.role}`);

        switch (loggedInUser.role) {
            case 'warehouse_owner':
            case 'admin':
                canCreateOrder = true; // Owners/Admins can create manual orders
                viewTitle = loggedInUser.role === 'admin' ? 'Platform Dashboard' : 'Company Dashboard';
                const companyQuery = loggedInUser.role === 'admin' ? {} : { companyId: companyId };
                const storeIdsForCompany = (await Store.find(companyQuery).select('_id').lean()).map(s => s._id);

                // Fetch company-wide stats
                 const [pendingCount, confirmedCount, shippedCount, storeCount, warehouseCount, itemCount, driverCount] = await Promise.all([
                    Order.countDocuments({ storeId: { $in: storeIdsForCompany }, orderStatus: 'pending' }),
                    Order.countDocuments({ storeId: { $in: storeIdsForCompany }, orderStatus: 'confirmed' }),
                    Order.countDocuments({ storeId: { $in: storeIdsForCompany }, orderStatus: 'shipped' }),
                    Store.countDocuments(companyQuery),
                    Warehouse.countDocuments(companyQuery),
                    Item.countDocuments({ companyId: companyId }), // Assumes Item has companyId
                    User.countDocuments({ companyId: companyId, role: 'delivery_partner' })
                 ]);

                 dashboardData.stats = {
                     'Pending Orders': pendingCount,
                     'Confirmed Orders': confirmedCount,
                     'Shipped Orders': shippedCount,
                     'Stores': storeCount,
                     'Warehouses': warehouseCount,
                     'Inventory Items': itemCount,
                     'Delivery Partners': driverCount,
                 };
                // Fetch recent orders
                 dashboardData.recentOrders = await Order.find({ storeId: { $in: storeIdsForCompany }})
                    .sort({ placedDate: -1 })
                    .limit(5)
                    .populate('storeId', 'storeName')
                    .lean();
                break;

            case 'store_owner':
            case 'employee':
                canCreateOrder = true; // Store users can create manual orders
                viewTitle = 'Store Dashboard';
                if (!storeId) throw new Error("User not assigned to a store.");

                // Fetch store-specific stats
                const [storePending, storeConfirmed, storeShipped, storeDelivered] = await Promise.all([
                    Order.countDocuments({ storeId: storeId, orderStatus: 'pending' }),
                    Order.countDocuments({ storeId: storeId, orderStatus: 'confirmed' }),
                    Order.countDocuments({ storeId: storeId, orderStatus: 'shipped' }),
                    Order.countDocuments({ storeId: storeId, orderStatus: 'delivered' })
                ]);
                dashboardData.stats = {
                    'Pending Orders': storePending,
                    'Confirmed Orders': storeConfirmed,
                    'Shipped Orders': storeShipped,
                    'Delivered Orders': storeDelivered,
                };
                 // Fetch recent orders for this store
                 dashboardData.recentOrders = await Order.find({ storeId: storeId })
                     .sort({ placedDate: -1 })
                     .limit(5)
                     .populate('storeId', 'storeName') // Still useful maybe
                     .lean();
                break;

            case 'delivery_partner':
                viewTitle = 'My Deliveries Dashboard';
                canCreateOrder = false; // Drivers don't create orders
                // Fetch delivery-specific stats
                const [pickupCount, outForDeliveryCount] = await Promise.all([
                     Order.countDocuments({ assignedDeliveryPartnerId: loggedInUser._id, orderStatus: 'confirmed' }),
                     Order.countDocuments({ assignedDeliveryPartnerId: loggedInUser._id, orderStatus: 'shipped' })
                 ]);
                 dashboardData.stats = {
                     'Orders Ready for Pickup': pickupCount,
                     'Orders Out for Delivery': outForDeliveryCount,
                 };
                 // Fetch current deliveries
                 dashboardData.recentOrders = await Order.find({ assignedDeliveryPartnerId: loggedInUser._id, orderStatus: { $in: ['confirmed', 'shipped'] } })
                     .sort({ placedDate: 1 }) // Sort oldest first for delivery sequence?
                     .limit(5)
                     .populate('storeId', 'storeName')
                     .lean();
                break;

            default:
                // Handle unexpected roles
                viewTitle = 'Dashboard';
                dashboardData.stats = { Info: "No specific stats for your role." };
        }

        res.render('dashboard', { // Renders views/dashboard.ejs
            title: viewTitle,
            stats: dashboardData.stats, // Pass the specific stats
            recentOrders: dashboardData.recentOrders, // Pass recent orders
            canCreateOrder: canCreateOrder, // Pass flag for button visibility
            // loggedInUser, companyDetails, storeDetails are available via res.locals from global middleware
            layout: './layouts/dashboard_layout'
        });

    } catch (err) {
        console.error("Error loading dashboard:", err);
        res.status(500).render('error_page', { title: "Error", message: `Failed to load dashboard: ${err.message}`, layout: false });
    }
});

// --- Logout Route ---
router.post('/logout', (req, res, next) => {
    // Destroy the session
    req.session.destroy((err) => {
        if (err) {
            // Handle error, perhaps log it and redirect anyway or show error page
            console.error("Error destroying session:", err);
            // Optionally pass an error message to the login page
            return res.redirect('/?error=logout_failed');
        }
        // Clear the cookie associated with the session (optional but good practice)
        // The cookie name often defaults to 'connect.sid' but check your session config
        res.clearCookie('connect.sid'); // Replace 'connect.sid' if you used a different name

        console.log("User logged out successfully.");
        // Redirect to the login page after session is destroyed
        res.redirect('/'); // Redirect to home/login page
    });
});

module.exports = router;