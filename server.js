// server.js
require('dotenv').config(); // Load environment variables FIRST

const express = require('express');
const session = require('express-session');
const MongoStore = require('connect-mongo'); // For storing sessions in MongoDB
const path = require('path');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const expressLayouts = require('express-ejs-layouts');
const passport = require('passport'); // <-- Added Passport
require('./config/passport-setup'); // <-- Added: This will run your Passport configuration
const methodOverride = require('method-override');

// --- Session Configuration Check ---
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
    console.error("\nFATAL ERROR: SESSION_SECRET environment variable is not set.");
    // ... (your existing error message and process.exit)
    process.exit(1); 
}
const dbUri = process.env.MONGO_URI; // For session store
if (!dbUri) {
    console.error("\nFATAL ERROR: MONGO_URI environment variable is not set for session store.");
    process.exit(1);
}


// --- Import Models (Needed for Global Middleware User Population) ---
const User = require('./models/User'); // Assuming User model path
const Company = require('./models/Company'); // Assuming Company model path
// Add other models if they are directly used in global middleware, though usually User and Company are primary

// --- Import Routes ---
const indexRoutes = require('./routes/index');
const storeRoutes = require('./routes/stores');
const userRoutes = require('./routes/users'); // You have this, good for future user management
const warehouseRoutes = require('./routes/warehouses');
const itemRoutes = require('./routes/items'); 
const supplierRoutes = require('./routes/suppliers');
const companyRoutes = require('./routes/company');
const vehicleRoutes = require('./routes/vehicles');
const orderRoutes = require('./routes/orders');
const reportingRoutes = require('./routes/reporting');
const adminRoutes = require('./routes/admin'); 
const deliveryRoutes = require('./routes/deliveries');
const purchaseOrderRoutes = require('./routes/purchaseOrders');
const apiRoutes = require('./routes/api'); // For your geocoding proxy

const app = express();

// --- Database Connection ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB connected successfully.'))
    .catch((err) => { /* ... your existing error handling ... */ process.exit(1); });

// --- View Engine Setup ---
app.use(expressLayouts); 
app.set('layout', './layouts/dashboard_layout'); 
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// --- Static Files ---
app.use(express.static(path.join(__dirname, 'public')));

// --- Core Middlewares ---
app.use(bodyParser.urlencoded({ extended: true })); 
app.use(bodyParser.json()); 
app.use(methodOverride('_method')); // Should be before routes that use it

// --- Session Middleware (Global) ---
app.use(session({
    secret: sessionSecret, 
    resave: false,              
    saveUninitialized: false,   
    store: MongoStore.create({ mongoUrl: dbUri }), // Using MongoStore
    cookie: {
        secure: process.env.NODE_ENV === 'production', 
        httpOnly: true, 
        maxAge: 1000 * 60 * 60 * 24 // 1 day
    }
}));

// --- Passport Middleware (Initialize AFTER session middleware) ---
app.use(passport.initialize());
app.use(passport.session()); // Allow persistent login sessions
// --- End Passport Middleware ---


// --- Global Middleware for User/Company/Path and Messages ---
app.use(async (req, res, next) => {
    // User object from Passport's deserializeUser is in req.user
    res.locals.loggedInUser = req.user || null; 
    
    res.locals.companyDetails = null;
    res.locals.storeDetails = null;

    if (req.user && req.user.companyId) {
        // If companyId on user is just an ID, populate it.
        // If passport's deserializeUser already populates it, this might be redundant but safe.
        if (typeof req.user.companyId === 'string' || req.user.companyId instanceof mongoose.Types.ObjectId) {
            try {
                const company = await Company.findById(req.user.companyId).lean();
                res.locals.companyDetails = company;
            } catch (err) {
                console.error("Error populating company details for locals:", err);
            }
        } else if (typeof req.user.companyId === 'object') { // Already populated
            res.locals.companyDetails = req.user.companyId;
        }
    }

    if (req.user && req.user.storeId) {
        if (typeof req.user.storeId === 'string' || req.user.storeId instanceof mongoose.Types.ObjectId) {
            try {
                 const store = await Store.findById(req.user.storeId).select('storeName').lean(); // Select only needed fields
                 res.locals.storeDetails = store;
            } catch (err) {
                console.error("Error populating store details for locals:", err);
            }
        } else if (typeof req.user.storeId === 'object') {
            res.locals.storeDetails = req.user.storeId;
        }
    }
    
    // Message Handling (Using Query Params - as per your choice to defer flash)
    res.locals.success_msg = req.query.success ? decodeURIComponent(req.query.success.replace(/\+/g, ' ')) : null;
    res.locals.error_msg = req.query.error ? decodeURIComponent(req.query.error.replace(/\+/g, ' ')) : null;
    // If Passport authentication fails with failureMessage: true, message is in req.session.messages
    if (req.session && req.session.messages && req.session.messages.length > 0) {
        res.locals.error_msg = (res.locals.error_msg ? res.locals.error_msg + " " : "") + req.session.messages.join(', ');
        req.session.messages = []; // Clear messages after displaying
    }

    res.locals.currentPath = req.path; 
    next();
});
// --- End Global Middleware ---

// --- Route Mounting ---
app.use('/', indexRoutes);          // Handles /, /dashboard, /login, /logout, /register, AND NOW /auth/google routes
app.use('/stores', storeRoutes); 
app.use('/users', userRoutes);   
app.use('/warehouses', warehouseRoutes);
app.use('/vehicles', vehicleRoutes); 
app.use('/deliveries', deliveryRoutes); 
app.use('/items', itemRoutes);
app.use('/orders', orderRoutes);
app.use('/reporting', reportingRoutes);
app.use('/admin', adminRoutes);
app.use('/company', companyRoutes); 
app.use('/suppliers', supplierRoutes);
app.use('/purchase-orders', purchaseOrderRoutes);
app.use('/api', apiRoutes); // Your API routes (e.g., for geocoding)

// --- Basic 404 Handler ---
// Catch requests that don't match any routes above
app.use((req, res, next) => {
  res.status(404).render('error_page', { // Assumes you have views/error_page.ejs
       layout: false, // Don't use dashboard layout for 404
       title: "Page Not Found",
       message: "Sorry, the page you were looking for could not be found."
    });
});

// --- Basic Error Handler ---
// Catches errors passed via next(err)
app.use((err, req, res, next) => {
  console.error("Global Error Handler caught:", err.stack);
  res.status(err.status || 500).render('error_page', { // Assumes views/error_page.ejs
        layout: false, // Don't use dashboard layout for errors
        title: "Server Error",
        message: process.env.NODE_ENV === 'production' ? "Sorry, something went wrong." : err.message // Show more detail in dev
    });
});


// --- Server Listening ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Access: http://localhost:${PORT}`); // Add local access URL
});