// routes/index.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');

// Render the Landing/Home page
router.get('/', (req, res) => {
  res.render('index', { title: 'SwiftRoute' });
});

// Render the Registration page
router.get('/register', (req, res) => {
  res.render('register', { title: 'Register' });
});

// Process Registration form: Create Company and User (Warehouse Owner)
router.post('/register', async (req, res) => {
  // Require models
  const Company = require('../models/Company');
  const User = require('../models/User');
  
  // Destructure form fields
  const { companyName, contactEmail, subscriptionPlan, username, password } = req.body;
  
  try {
    // Create new Company document
    let newCompany = new Company({ companyName, contactEmail, subscriptionPlan });
    newCompany = await newCompany.save();
    
    // Hash the user's password
    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(password, salt);
    
    // Create new User document for the warehouse owner
    const newUser = new User({
      username,
      email: contactEmail,
      password: hashedPassword,
      role: 'warehouse_owner',  // Set the role as warehouse_owner
      companyId: newCompany._id
    });
    
    await newUser.save();
    
    // Redirect to login after successful registration
    res.redirect('/login');
  } catch (error) {
    console.error('Error during registration:', error);
    res.status(500).send('Registration failed');
  }
});

// Render the Login page
router.get('/login', (req, res) => {
  res.render('login', { title: 'Login' });
});

// Dummy Login Process route (Replace with actual authentication)
router.post('/login', (req, res) => {
  // authentication logic here
  res.redirect('/dashboard');
});

// Render the Dashboard for authenticated users (dummy example)
router.get('/dashboard', (req, res) => {
  res.render('dashboard', { title: 'Dashboard' });
});

module.exports = router;
