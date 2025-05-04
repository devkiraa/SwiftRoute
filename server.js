// server.js
require('dotenv').config(); // <-- VERY IMPORTANT: Make this the first line!

// Now require other modules
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');
const indexRoutes = require('./routes/index'); // This file uses process.env.SESSION_SECRET
const storeRoutes = require('./routes/stores');

// Initialize Express app
const app = express();

// --- Database connection ---
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('MongoDB connected'))
    .catch((err) => console.error('MongoDB connection error:', err));

// --- Middlewares ---
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Set view engine
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// --- Static Files ---
// app.use(express.static(path.join(__dirname, 'public'))); // Uncomment if you have a public folder

// --- Routes ---
// Session middleware is applied inside indexRoutes, which is okay if indexRoutes is mounted first for relevant paths
app.use('/', indexRoutes);
app.use('/stores', storeRoutes); // These routes might also need session access depending on your logic

// --- Server Listening ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});