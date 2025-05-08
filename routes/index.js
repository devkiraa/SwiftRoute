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
const Vehicle = require('../models/Vehicle');
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

// GET /register - Render the registration form
router.get('/register', (req, res) => {
    // No specific data needed for initial render unless showing plans dynamically
    res.render('register', { title: 'Register', layout: false }); // Use register view
});

// POST /register - Handle Company and User creation
router.post('/register', async (req, res) => {
    console.log("Registration data received:", req.body);
    // Destructure all form fields including address components
    const {
        companyName, contactEmail, mobileNumber, gstin, subscriptionPlan,
        address_street, address_city, address_state, address_pincode, address_country,
        sameAsMain, // Checkbox value
        billing_street, billing_city, billing_state, billing_pincode, billing_country,
        username, password
    } = req.body;

    // Basic Server-Side Validation (Add more robust validation as needed)
    const requiredCompanyFields = [companyName, contactEmail, address_street, address_city, address_state, address_pincode, address_country];
    const requiredUserFields = [username, password];
    let missingFields = [];

    if (requiredCompanyFields.some(field => !field || !field.trim())) {
        missingFields.push("Required company/address fields");
    }
    if (requiredUserFields.some(field => !field || !field.trim())) {
         missingFields.push("Username and Password");
    }
    if (password && password.length < 6) {
        missingFields.push("Password (min 6 chars)");
    }
    // If billing address is different, validate its fields too
    if (!sameAsMain) {
         const requiredBillingFields = [billing_street, billing_city, billing_state, billing_pincode, billing_country];
         if (requiredBillingFields.some(field => !field || !field.trim())) {
              missingFields.push("Required billing address fields");
         }
    }

    if (missingFields.length > 0) {
         console.error("Registration validation failed:", missingFields);
         // Re-render form with error and existing data
         return res.status(400).render('register', {
             title: 'Register',
             error: `Missing required fields: ${missingFields.join(', ')}. Please check the form.`,
             formData: req.body, // Send back submitted data to repopulate
             layout: false
         });
    }


    try {
        // Check if Company Name or Email already exists
        const existingCompany = await Company.findOne({ $or: [{ companyName }, { contactEmail }] });
        if (existingCompany) {
            throw new Error('Company name or contact email already registered.');
        }
        // Check if Username or User Email already exists
        const existingUser = await User.findOne({ $or: [{ username }, { email: contactEmail }] });
        if (existingUser) {
            throw new Error('Username or email already taken for the owner account.');
        }

        // Construct Address Objects
        const mainAddress = {
            street: address_street,
            city: address_city,
            state: address_state,
            pincode: address_pincode,
            country: address_country || 'India'
        };
        const billingAddr = sameAsMain ? mainAddress : { // Use main if checked, otherwise construct new
             street: billing_street,
             city: billing_city,
             state: billing_state,
             pincode: billing_pincode,
             country: billing_country || 'India'
        };

        // Create Company
        const newCompany = new Company({
            companyName,
            contactEmail,
            mobileNumber,
            gstin: gstin?.toUpperCase(), // Store GSTIN uppercase
            subscriptionPlan,
            address: mainAddress,
            billingAddress: billingAddr
        });
        const savedCompany = await newCompany.save();
        console.log("Company created:", savedCompany.companyName);

        // Hash User Password
        const salt = await bcrypt.genSalt(saltRounds);
        const hashedPassword = await bcrypt.hash(password, salt);

        // Create Warehouse Owner User
        const newUser = new User({
            username,
            email: contactEmail, // Use company email for owner initially? Or ask for separate user email? Using contactEmail for now.
            password: hashedPassword,
            role: 'warehouse_owner', // Default role for registration
            companyId: savedCompany._id // Link user to the new company
        });
        const savedUser = await newUser.save();
        console.log("Warehouse owner user created:", savedUser.username);

        // Log the user in by setting the session
        req.session.userId = savedUser._id;
        console.log(`User ${savedUser._id} registered and logged in.`);

        // Redirect to add the first warehouse instead of dashboard
        res.redirect('/warehouses/new?registration=success'); // Add query param for welcome message

    } catch (err) {
        console.error("Error during registration:", err);
        // If company was created but user failed, potentially delete company? Or handle differently.
        res.status(500).render('register', {
            title: 'Register',
            error: `Registration failed: ${err.message}`,
            formData: req.body, // Send back submitted data
            layout: false
        });
    }
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
    let vehicleData = { currentVehicle: null, availableVehicles: [] }; // For delivery partner


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
                canCreateOrder = false; 

                if (loggedInUser.currentVehicleId) {
                    vehicleData.currentVehicle = await Vehicle.findById(loggedInUser.currentVehicleId).select('vehicleNumber modelName type').lean();
                } else if (companyId) {
                    vehicleData.availableVehicles = await Vehicle.find({ companyId: companyId, isActive: true, assignedDriverId: null }).select('vehicleNumber modelName type').sort({ vehicleNumber: 1 }).lean();
                }

                const startOfDay = new Date(); startOfDay.setHours(0, 0, 0, 0);
                const [pickupCount, inProgressCount, deliveredTodayCount] = await Promise.all([
                     Order.countDocuments({ assignedDeliveryPartnerId: loggedInUser._id, orderStatus: 'confirmed' }),
                     Order.countDocuments({ assignedDeliveryPartnerId: loggedInUser._id, orderStatus: 'shipped' }),
                     Order.countDocuments({ assignedDeliveryPartnerId: loggedInUser._id, orderStatus: 'delivered', updatedDate: { $gte: startOfDay } })
                ]);
                 dashboardData.stats = { 'Ready for Pickup': pickupCount, 'In Progress': inProgressCount, 'Completed Today': deliveredTodayCount };

                 dashboardData.recentActivity = await Order.find({ assignedDeliveryPartnerId: loggedInUser._id, orderStatus: { $in: ['confirmed', 'shipped'] } })
                     .sort({ placedDate: 1 }).limit(5).populate('storeId', 'storeName address').lean();
                 dashboardData.activityTitle = "Upcoming Stops";
                break;

            default:
                viewTitle = 'Dashboard';
                dashboardData.stats = { Info: "No specific stats for your role." };
        }

        res.render('dashboard', { 
            title: viewTitle,
            stats: dashboardData.stats, 
            recentActivity: dashboardData.recentActivity, 
            activityTitle: dashboardData.activityTitle,
            canCreateOrder: canCreateOrder, 
            vehicleData: vehicleData, 
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