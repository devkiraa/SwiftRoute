// routes/deliveries.js
const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Store = require('../models/Store'); // Needed for populating

const router = express.Router();

// --- Local Auth Middleware ---
function ensureAuthenticated(req, res, next) {
    if (res.locals.loggedInUser) return next();
    res.redirect('/login');
}

// Middleware to ensure the user is a delivery partner
function ensureDeliveryPartner(req, res, next) {
    const loggedInUser = res.locals.loggedInUser;
    if (loggedInUser && loggedInUser.role === 'delivery_partner') {
        return next();
    }
    res.status(403).send("Access Denied: Delivery Partner role required.");
}
// --- End Local Auth Middleware ---

// Apply authentication and role check to all delivery routes
router.use(ensureAuthenticated, ensureDeliveryPartner);

// GET /deliveries/my - List deliveries assigned to the logged-in partner
router.get('/my', async (req, res) => {
    console.log("--- Accessing GET /deliveries/my ---");
    const loggedInUser = res.locals.loggedInUser;

    try {
        // Find orders assigned to this driver, in statuses relevant for delivery
        // Example: 'confirmed' (ready for pickup) or 'shipped' (out for delivery)
        const assignedOrders = await Order.find({
            assignedDeliveryPartnerId: loggedInUser._id,
            orderStatus: { $in: ['confirmed', 'shipped'] } // Adjust statuses as needed
        })
        .populate('storeId', 'storeName address') // Get store info
        .sort({ placedDate: 1 }) // Maybe sort by oldest first, or optimize sequence later
        .limit(100) // Add pagination later if needed
        .lean();

        console.log(`Found ${assignedOrders.length} assigned orders for driver ${loggedInUser._id}`);

        res.render('deliveries/my_deliveries', { // Render views/deliveries/my_deliveries.ejs
            title: 'My Assigned Deliveries',
            orders: assignedOrders,
            layout: './layouts/dashboard_layout'
        });

    } catch (err) {
        console.error(`Error fetching deliveries for driver ${loggedInUser._id}:`, err);
        res.status(500).render('error_page', { title: "Error", message: "Failed to load assigned deliveries.", layout: false });
    }
});

// GET /deliveries/map - Placeholder for route map view
router.get('/map', async (req, res) => {
    console.log("--- Accessing GET /deliveries/map ---");
     const loggedInUser = res.locals.loggedInUser;
     // For now, just fetch the same orders as '/my' to display the list
     // Later, this route will fetch orders, potentially optimize, and pass data to map JS
     try {
         const assignedOrders = await Order.find({
            assignedDeliveryPartnerId: loggedInUser._id,
            orderStatus: { $in: ['confirmed', 'shipped'] }
        })
        .populate('storeId', 'storeName address location') // Need location for map later
        .sort({ placedDate: 1 })
        .limit(100)
        .lean();

         console.log(`Found ${assignedOrders.length} orders for map page.`);

         // TODO: Fetch warehouse origin based on orders (e.g., order[0].warehouseId)
         // TODO: Prepare waypoints (store locations / shipping locations)
         // TODO: Call Google Maps Directions API (via proxy) for optimized route
         // TODO: Pass optimized route and map API key to the view

         res.render('deliveries/route_map', { // Render views/deliveries/route_map.ejs
            title: 'Delivery Route Map',
            orders: assignedOrders, // Pass orders to display list for now
            googleMapsApiKey: process.env.Maps_API_KEY, // Map will need this
            layout: './layouts/dashboard_layout'
         });

     } catch (err) {
         console.error(`Error loading route map page for driver ${loggedInUser._id}:`, err);
         res.status(500).render('error_page', { title: "Error", message: "Failed to load route map page.", layout: false });
     }
});

// --- TODO: Add routes for delivery actions ---
// POST /deliveries/:orderId/pickup (or update status route)
// POST /deliveries/:orderId/delivered (or update status route)


module.exports = router;