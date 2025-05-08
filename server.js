// server.js
require('dotenv').config(); // Load environment variables FIRST

const express = require('express');
const session = require('express-session');
const path = require('path');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const expressLayouts = require('express-ejs-layouts');
const flash = require('connect-flash');

// --- Session Configuration Check ---
const sessionSecret = process.env.SESSION_SECRET;
if (!sessionSecret) {
    console.error("\nFATAL ERROR: SESSION_SECRET environment variable is not set.");
    console.error("Please create a .env file in the project root with a line like:");
    console.error("SESSION_SECRET=your_very_strong_random_secret_string\n");
    process.exit(1); // Stop the server if the secret is missing
}

// --- Import Routes ---
// Ensure these files exist in the './routes/' directory
const indexRoutes = require('./routes/index');
const storeRoutes = require('./routes/stores');
const userRoutes = require('./routes/users');
const warehouseRoutes = require('./routes/warehouses');
const itemRoutes = require('./routes/items'); 
// Require other routes as you create them:
// const warehouseRoutes = require('./routes/warehouses');
const vehicleRoutes = require('./routes/vehicles');
const orderRoutes = require('./routes/orders');
const reportingRoutes = require('./routes/reporting');
const adminRoutes = require('./routes/admin'); // If you separate admin routes
const deliveryRoutes = require('./routes/deliveries');
const methodOverride = require('method-override');

const app = express();

// --- Database Connection ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB connected successfully.'))
    .catch((err) => {
        console.error('\nMongoDB Connection Error:');
        console.error(err.message);
        console.error("Please ensure MongoDB is running and MONGO_URI in .env is correct.\n");
        process.exit(1); // Exit if DB connection fails
    });

// --- View Engine Setup ---
app.use(expressLayouts); // Use express-ejs-layouts
app.set('layout', './layouts/dashboard_layout'); // Set default layout file
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// --- Static Files ---
// Uncomment if you have a 'public' directory for CSS, client-side JS, images
// app.use(express.static(path.join(__dirname, 'public')));

// --- Core Middlewares ---
app.use(bodyParser.urlencoded({ extended: true })); // Parse URL-encoded bodies
app.use(bodyParser.json()); // Parse JSON bodies

// --- Session Middleware (Global) ---
app.use(session({
  secret: sessionSecret, // Use the variable checked above
  resave: false,                  // Explicitly set to recommended false
  saveUninitialized: false,       // Explicitly set to recommended false
  cookie: {
      secure: process.env.NODE_ENV === 'production', // Use secure cookies only in production (HTTPS)
      httpOnly: true, // Prevent client-side JS access (good practice)
      maxAge: 1000 * 60 * 60 * 24 // Example: 1 day expiry
    }
}));

app.use(flash());
// --- Global Middleware (Make user and flash messages available to views) ---
app.use(async (req, res, next) => {
  // Make user available
  if (req.session && req.session.userId) {
      try {
          // Use lean() for read-only user data in views
          const user = await mongoose.model('User').findById(req.session.userId)
              .populate('companyId', 'companyName')
              .populate('storeId', 'storeName')
              .lean(); 
          res.locals.loggedInUser = user;
          if (user) {
              res.locals.companyDetails = user.companyId; // Already lean
              res.locals.storeDetails = user.storeId;   // Already lean
          }
      } catch (error) {
          console.error('Error fetching user for session:', error);
           res.locals.loggedInUser = null; // Ensure it's null on error
           res.locals.companyDetails = null;
           res.locals.storeDetails = null;
      }
  } else {
      // Ensure these are explicitly null if no user session
      res.locals.loggedInUser = null; 
      res.locals.companyDetails = null;
      res.locals.storeDetails = null;
  }

  // --- Make Flash Messages available to ALL templates ---
  res.locals.success_msg = req.flash('success_msg'); // Gets success messages
  res.locals.error_msg = req.flash('error_msg');     // Gets error messages
  res.locals.error = req.flash('error');             // Gets error messages from Passport (if used) or general error
  // You only need one error key, let's consolidate to 'error_msg' or 'error'
  // Let's use 'error_msg' for consistency with 'success_msg' and keep 'error' for potential passport compatibility
  res.locals.error_msg = res.locals.error_msg.length ? res.locals.error_msg : req.flash('error'); 
  // --- End Flash Message Middleware ---

  res.locals.currentPath = req.path; // For active sidebar links
  next();
});

// --- Global Middleware for User/Company/Path ---
// Makes loggedInUser, companyDetails, and currentPath available in all templates (via res.locals)
app.use(async (req, res, next) => {
  res.locals.currentPath = req.path; // For active sidebar links
  // Initialize locals to null
  res.locals.loggedInUser = null;
  res.locals.companyDetails = null;
  res.locals.storeDetails = null; // <-- Initialize storeDetails

  if (req.session && req.session.userId) {
    try {
      const user = await mongoose.model('User').findById(req.session.userId)
        .populate('companyId', 'companyName') // Populate company name
        .lean();

      if (user) {
        res.locals.loggedInUser = user;
        res.locals.companyDetails = user.companyId; // Populated company or null

        // --- Attempt to fetch store details if user has storeId ---
        if (user.storeId) {
          try {
             // Fetch store details if the user is associated with one
             res.locals.storeDetails = await mongoose.model('Store')
                                              .findById(user.storeId)
                                              .select('storeName address') // Select fields needed globally
                                              .lean();
          } catch (storeErr) {
               console.error(`Error fetching store details for storeId ${user.storeId}:`, storeErr);
               // Proceed without storeDetails if store fetch fails
               res.locals.storeDetails = null;
          }
        }
        // --- End store details fetch ---

      } else {
         console.warn(`Session has userId ${req.session.userId}, but user not found. Clearing session.`);
         req.session.destroy(); // Logged out
      }
    } catch (err) {
      console.error("Error fetching user/company in global middleware:", err);
      // Ensure locals are null on error
      res.locals.loggedInUser = null;
      res.locals.companyDetails = null;
      res.locals.storeDetails = null;
    }
  }
  next(); // Proceed to the next middleware/route
});
// --- End Global Middleware ---
app.use(methodOverride('_method'));
// --- Route Mounting ---
app.use('/', indexRoutes);       // Handles /, /dashboard, /login, /logout, /register
app.use('/stores', storeRoutes); // Handles /stores, /stores/new etc.
app.use('/users', userRoutes);   // Handles /users, /users/new etc.
app.use('/warehouses', warehouseRoutes);
app.use('/vehicles', vehicleRoutes); 
app.use('/deliveries', deliveryRoutes); 
app.use('/items', itemRoutes);
app.use('/orders', orderRoutes);
app.use('/reporting', reportingRoutes);
app.use('/admin', adminRoutes);

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