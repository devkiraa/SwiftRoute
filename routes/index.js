// routes/index.js
const express = require('express');
const session = require('express-session');
const bcrypt = require('bcrypt');
const Company = require('../models/Company');
const User = require('../models/User');
const Order = require('../models/Order');

const router = express.Router();

// Session middleware (you can instead put this in server.js for the whole app)
router.use(session({
  secret: process.env.SESSION_SECRET || 'change_this_secret',
  resave: false,
  saveUninitialized: false
}));

// Landing page
router.get('/', (req, res) => {
  res.render('index', { title: 'SwiftRoute' });
});

// Registration form
router.get('/register', (req, res) => {
  res.render('register', { title: 'Register' });
});

// Process registration: create Company + warehouse_owner User
router.post('/register', async (req, res) => {
  try {
    const { companyName, contactEmail, subscriptionPlan, username, password } = req.body;

    // Create company
    const company = await new Company({ companyName, contactEmail, subscriptionPlan }).save();

    // Hash password
    const salt = await bcrypt.genSalt(10);
    const hash = await bcrypt.hash(password, salt);

    // Create warehouse_owner user
    const user = await new User({
      username,
      email: contactEmail,
      password: hash,
      role: 'warehouse_owner',
      companyId: company._id
    }).save();

    // Set session and redirect
    req.session.userId = user._id;
    res.redirect('/dashboard');

  } catch (err) {
    console.error('Registration error:', err);
    res.status(500).send('Registration failed');
  }
});

// Login form
router.get('/login', (req, res) => {
  res.render('login', { title: 'Login' });
});

// Process login
router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const user = await User.findOne({ email });
    if (!user) return res.redirect('/login');

    const match = await bcrypt.compare(password, user.password);
    if (!match) return res.redirect('/login');

    req.session.userId = user._id;
    res.redirect('/dashboard');

  } catch (err) {
    console.error('Login error:', err);
    res.redirect('/login');
  }
});

// Dashboard route
router.get('/dashboard', async (req, res) => {
  // Guard against no session
  if (!req.session || !req.session.userId) {
    return res.redirect('/login');
  }

  try {
    // Fetch logged-in user
    const storeUser = await User.findById(req.session.userId)
      .populate('storeId')
      .lean();

    const storeId = storeUser.storeId?._id;

    // Compute stats
    const totalCustomers = await User.countDocuments({ storeId, role: 'customer' });
    const members = await User.countDocuments({
      storeId,
      role: { $in: ['store_owner', 'employee', 'delivery_partner'] }
    });
    const activeNow = await Order.countDocuments({
      storeId,
      placedDate: { $gt: new Date(Date.now() - 24 * 60 * 60 * 1000) }
    });

    const stats = {
      totalCustomers,
      totalCustomersChange: 0,
      members,
      membersChange: 0,
      activeNow,
      activeNowChange: 0
    };

    // Fetch first 10 customers
    const customersRaw = await User.find({ storeId, role: 'customer' })
      .limit(10)
      .lean();

    const customers = customersRaw.map(cust => ({
      name: cust.username,
      website: cust.email,
      iconUrl: cust.avatarUrl || 'https://static-00.iconduck.com/assets.00/profile-icon-2048x2048-yj5zf8da.png',
      type: 'Customer',
      licenseUsers: []
    }));

    // Pagination stub
    const pagination = { currentPage: 1, totalPages: 1 };

    // Render
    res.render('dashboard', { storeUser, stats, customers, pagination });

  } catch (err) {
    console.error('Dashboard error:', err);
    res.status(500).send('Could not load dashboard');
  }
});

module.exports = router;
