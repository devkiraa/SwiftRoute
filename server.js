// server.js
require('dotenv').config(); // Load environment variables FIRST

const express = require('express');
const session = require('express-session');
const path = require('path');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const expressLayouts = require('express-ejs-layouts');

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
const supplierRoutes = require('./routes/suppliers');
const companyRoutes = require('./routes/company');
const vehicleRoutes = require('./routes/vehicles');
const orderRoutes = require('./routes/orders');
const reportingRoutes = require('./routes/reporting');
const adminRoutes = require('./routes/admin'); // If you separate admin routes
const deliveryRoutes = require('./routes/deliveries');
const purchaseOrderRoutes = require('./routes/purchaseOrders');
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
 app.use(express.static(path.join(__dirname, 'public')));

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

// --- Global Middleware for User/Company/Path ---
// --- Global Middleware (Make user and other locals available to views) ---
app.use(async (req, res, next) => {
  res.locals.loggedInUser = null; // Initialize defaults
  res.locals.companyDetails = null;
  res.locals.storeDetails = null;

  if (req.session && req.session.userId) {
      try {
          // Populate the FULL company document or select specific fields needed globally
          const user = await mongoose.model('User').findById(req.session.userId)
              // OPTION 1: Populate fully (simpler if you need more company fields later)
              .populate('companyId') 
              // OPTION 2: Select specific fields needed globally
              // .populate('companyId', 'companyName upiId mobileNumber contactEmail') // Select name AND upiId etc.
              .populate('storeId', 'storeName') // Keep this as is if only name needed
              .lean(); 
              
          res.locals.loggedInUser = user;
          if (user) {
              // Now user.companyId (and thus locals.companyDetails) will have the upiId field
              res.locals.companyDetails = user.companyId; 
              res.locals.storeDetails = user.storeId;   
          }
      } catch (error) { 
          console.error('Error fetching user/company for session:', error);
      }
  } 

  // --- Message Handling (Using Query Params - Keep from Response #75) ---
  // Note: If you ever switch to flash, this part changes.
  res.locals.success_msg = req.query.success ? decodeURIComponent(req.query.success.replace(/\+/g, ' ')) : null;
  res.locals.error_msg = req.query.error ? decodeURIComponent(req.query.error.replace(/\+/g, ' ')) : null;
  // --- End Message Handling ---

  res.locals.currentPath = req.path; 
  next();
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
app.use('/company', companyRoutes); 
app.use('/suppliers', supplierRoutes);
app.use('/purchase-orders', purchaseOrderRoutes);

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