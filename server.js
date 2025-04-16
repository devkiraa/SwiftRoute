// server.js
require('dotenv').config(); // Load environment variables from .env file
const express = require('express');
const path = require('path');
const mongoose = require('mongoose');
const bodyParser = require('body-parser');

// Initialize Express app
const app = express();

// --- Database connection ---
mongoose.connect(process.env.MONGO_URI)
.then(() => console.log('MongoDB connected'))
.catch((err) => console.error('MongoDB connection error:', err));

// --- Middlewares ---
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Set view engine to EJS and set the views directory
app.set('views', path.join(__dirname, 'views'));
app.set('view engine', 'ejs');

// --- Static Files ---
// For serving static files (CSS, images, etc.) uncomment and use:
// app.use(express.static(path.join(__dirname, 'public')));

// --- Routes ---
const indexRoutes = require('./routes/index');
app.use('/', indexRoutes);

// --- Server Listening ---
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
