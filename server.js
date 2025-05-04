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
// Require other routes as you create them:
// const warehouseRoutes = require('./routes/warehouses');
// const itemRoutes = require('./routes/items');
// const orderRoutes = require('./routes/orders');
// const adminRoutes = require('./routes/admin'); // If you separate admin routes

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
app.use(bodyParser.urlencoded({ extended: false })); // Parse URL-encoded bodies
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
// Makes loggedInUser, companyDetails, and currentPath available in all templates (via res.locals)
app.use(async (req, res, next) => {
  res.locals.currentPath = req.path; // For active sidebar links

  if (req.session && req.session.userId) {
    try {
      // Fetch user and populate company name in one go
      const user = await mongoose.model('User').findById(req.session.userId)
        .populate('companyId', 'companyName') // Select only companyName from Company
        .lean();

      if (user) {
        res.locals.loggedInUser = user;
        // companyDetails is the populated sub-document or null
        res.locals.companyDetails = user.companyId;
        // You could fetch storeDetails here too if needed globally often,
        // but usually better to fetch in specific routes needing it.
        // if (user.storeId) {
        //   res.locals.storeDetails = await mongoose.model('Store').findById(user.storeId).lean();
        // }
      } else {
         // Invalid userId in session, clear it
         console.warn(`Session contains userId ${req.session.userId}, but user not found in DB. Clearing session.`);
         req.session.destroy(); // Use callback if needed
         res.locals.loggedInUser = null;
         res.locals.companyDetails = null;
      }
    } catch (err) {
      console.error("Error fetching user/company details in global middleware:", err);
      res.locals.loggedInUser = null;
      res.locals.companyDetails = null;
    }
  } else {
    // No user in session
    res.locals.loggedInUser = null;
    res.locals.companyDetails = null;
  }
  next(); // Proceed to the next middleware/route
});
// --- End Global Middleware ---

// --- Route Mounting ---
app.use('/', indexRoutes);       // Handles /, /dashboard, /login, /logout, /register
app.use('/stores', storeRoutes); // Handles /stores, /stores/new etc.
app.use('/users', userRoutes);   // Handles /users, /users/new etc.
// Mount other routes as they are created:
// app.use('/warehouses', warehouseRoutes);
// app.use('/items', itemRoutes);
// app.use('/orders', orderRoutes);
// app.use('/admin', adminRoutes);

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