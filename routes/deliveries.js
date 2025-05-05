// routes/deliveries.js
const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Store = require('../models/Store');
const Item = require('../models/Item');
const Warehouse = require('../models/Warehouse');

// Import Google Maps Client
const { Client, Status } = require("@googlemaps/google-maps-services-js");
const googleMapsClient = new Client({});
// *** CORRECTED CONFIG VARIABLE NAME ***
const Maps_API_KEY_CONFIG = { key: process.env.Maps_API_KEY }; // Use Maps_API_KEY

const router = express.Router();

// --- Local Auth Middleware ---
function ensureAuthenticated(req, res, next) {
    if (res.locals.loggedInUser) return next();
    res.redirect('/login');
}
function ensureDeliveryPartner(req, res, next) {
    const loggedInUser = res.locals.loggedInUser;
    if (loggedInUser?.role === 'delivery_partner') return next();
    res.status(403).render('error_page', { title: "Access Denied", message: "Delivery Partner role required.", layout: './layouts/dashboard_layout'});
}
// --- End Local Auth Middleware ---

router.use(ensureAuthenticated, ensureDeliveryPartner);

// GET /deliveries/my - Show Aggregated Loading List and Individual Orders
router.get('/my', async (req, res) => {
    console.log("--- Accessing GET /deliveries/my ---");
    const loggedInUser = res.locals.loggedInUser;
    let originWarehouse = null;
    let aggregatedItems = [];
    let ordersForPickup = [];
    let ordersInProgress = [];
    let showPickupButton = false;

    try {
        // 1. Find orders
        const allAssignedOrders = await Order.find({
            assignedDeliveryPartnerId: loggedInUser._id,
            orderStatus: { $in: ['confirmed', 'shipped'] }
        })
        .populate('warehouseId', 'name location address _id') // Ensure _id is selected if using lean() with populate
        .populate('storeId', 'storeName')
        .sort({ placedDate: 1 }).lean();
        console.log(`Found ${allAssignedOrders.length} total active assigned orders.`);

        if (allAssignedOrders.length > 0) {
            // 2. Determine Origin & Check consistency
            originWarehouse = allAssignedOrders[0].warehouseId;
            // Check if warehouse was populated and has an ID
            if (!originWarehouse?._id) {
                 console.error("Error: First order lacks a valid populated warehouseId.", allAssignedOrders[0]);
                 throw new Error("Cannot determine origin warehouse for deliveries. Check order data.");
            }
            const originWarehouseId = originWarehouse._id; // Now we know this exists

            // Verify all orders come from the same warehouse
            const allFromSameWarehouse = allAssignedOrders.every(order => {
                // *** SAFER CHECK ***
                // Check if warehouseId exists and has an _id before comparing
                const currentWarehouseId = order.warehouseId?._id;
                if (!currentWarehouseId) {
                     console.warn(`Order ${order._id} is missing a valid populated warehouseId.`);
                     return false; // Treat orders missing warehouse as not matching
                 }
                return currentWarehouseId.toString() === originWarehouseId.toString();
            });

            if (!allFromSameWarehouse) {
                 console.error(`Driver ${loggedInUser._id} has orders assigned from multiple warehouses or orders with missing warehouse data.`);
                 throw new Error("Deliveries are assigned from different warehouses or lack warehouse info. Please contact dispatch.");
            }
            console.log(`All orders originate from warehouse: ${originWarehouse.name} (${originWarehouseId})`);

            // Separate orders
            ordersForPickup = allAssignedOrders.filter(o => o.orderStatus === 'confirmed');
            ordersInProgress = allAssignedOrders.filter(o => o.orderStatus === 'shipped');
            showPickupButton = ordersForPickup.length > 0;

            // 3. Aggregate Items
            if (showPickupButton) {
                 console.log("Aggregating items for pickup list...");
                 try {
                    aggregatedItems = await Order.aggregate([ /* ... pipeline with safer unwind ... */ ]);
                    console.log(`Aggregation complete. Found ${aggregatedItems.length} unique items.`);
                 } catch (aggError) { /* ... handle aggregation error ... */ }
            }
        }

        console.log("Rendering deliveries/my_deliveries view...");
        res.render('deliveries/my_deliveries', {
            title: 'My Deliveries & Loading List', originWarehouse, aggregatedItems,
            ordersForPickup, ordersInProgress, showPickupButton,
            error: req.query.error, success_msg: req.query.success, layout: './layouts/dashboard_layout'
        });
        console.log("Finished rendering deliveries/my_deliveries view.");

    } catch (err) {
        console.error(`Error in GET /deliveries/my for driver ${loggedInUser?._id}:`, err);
        res.status(500).render('error_page', { title: "Error", message: `Failed to load deliveries: ${err.message}`, layout: false });
    }
});

// GET /deliveries/map - Show UNOPTIMIZED delivery locations
router.get('/map', async (req, res) => {
    console.log("--- Accessing GET /deliveries/map (Simplified) ---");
    const loggedInUser = res.locals.loggedInUser;
    let assignedOrders = [];
    let originWarehouse = null;
    let errorMsg = null;
    // *** USE CORRECT ENV VARIABLE NAME from your .env ***
    const googleApiKeyForView = process.env.Maps_API_KEY; // Using the name you confirmed

    if (!googleApiKeyForView) {
        console.error("FATAL: Maps_API_KEY is missing!"); // Use correct name in error msg
        errorMsg = "Mapping service API key not configured.";
        return res.render('deliveries/route_map', { title: 'Delivery Locations', orders: [], originWarehouse: null, googleMapsApiKey: null, errorMsg: errorMsg, layout: './layouts/dashboard_layout' });
    }

    try {
        // 1. Fetch orders
        assignedOrders = await Order.find({
            assignedDeliveryPartnerId: loggedInUser._id,
            orderStatus: { $in: ['confirmed', 'shipped'] }
        })
        .populate('storeId', 'storeName address location')
        .populate('warehouseId', 'name location address')
        .sort({ placedDate: 1 }) // Sort by date or maybe proximity later?
        .limit(100) // Keep limit reasonable
        .lean();
        console.log(`Found ${assignedOrders.length} assigned orders.`);

        // Filter orders with valid locations
        const ordersWithLocation = assignedOrders.filter(order => {
             const deliveryLocation = order.shippingLocation?.coordinates?.length === 2 ? order.shippingLocation : order.storeId?.location;
             const warehouseLocation = order.warehouseId?.location?.coordinates?.length === 2;
             if (!warehouseLocation) console.warn(`Order ${order._id} excluded: Missing warehouse location.`);
             if (!deliveryLocation?.coordinates || deliveryLocation.coordinates.length !== 2) { console.warn(`Order ${order._id} excluded: Missing delivery coordinates.`); return false; }
             return warehouseLocation;
        });
        console.log(`Displaying ${ordersWithLocation.length} orders with valid locations.`);

        // 2. Determine Origin (if any orders are valid)
        if (ordersWithLocation.length > 0) {
            originWarehouse = ordersWithLocation[0].warehouseId;
             console.log("Route Origin:", originWarehouse.name);
        } else {
             console.log("No valid orders to determine origin or display stops.");
             if(assignedOrders.length > 0) { // Orders exist but lack coords
                errorMsg = "Some assigned deliveries are missing valid location data.";
             }
        }

        // 3. Render the view (pass the filtered, unoptimized list)
        res.render('deliveries/route_map', {
            title: 'Delivery Locations Map', // Update title
            orders: ordersWithLocation,       // Pass the filtered list
            originWarehouse: originWarehouse,
            routePolyline: null,            // No polyline anymore
            googleMapsApiKey: googleApiKeyForView,
            errorMsg: errorMsg,
            layout: './layouts/dashboard_layout'
        });

     } catch (err) {
         console.error(`Error loading delivery map page for driver ${loggedInUser?._id}:`, err);
         res.status(500).render('deliveries/route_map', {
             title: 'Error Loading Map', orders: [], originWarehouse: null, routePolyline: null,
             googleMapsApiKey: googleApiKeyForView, errorMsg: `Server Error: ${err.message}`, layout: './layouts/dashboard_layout'
         });
     }
});

// --- Status Update Routes ---

// POST /deliveries/batch-pickup - Mark ALL confirmed orders for the warehouse as shipped
router.post('/batch-pickup', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    // We need the warehouse ID from which the pickup is happening.
    // Since we assume all active orders are from one warehouse, we can get it from any assigned order.
    // Or potentially pass it in the form if needed later.
    console.log(`--- Driver ${loggedInUser._id} attempting BATCH pickup ---`);

    let originWarehouseId = null;

    try {
        // Find one 'confirmed' order to determine the warehouse ID
        const oneOrder = await Order.findOne({
             assignedDeliveryPartnerId: loggedInUser._id,
             orderStatus: 'confirmed'
        }).select('warehouseId').lean();

        if (!oneOrder) {
             throw new Error("No confirmed orders found ready for pickup.");
        }
        originWarehouseId = oneOrder.warehouseId;
        if (!originWarehouseId) {
             throw new Error("Could not determine origin warehouse for pickup.");
        }

        console.log(`Attempting batch pickup from warehouse ${originWarehouseId} for driver ${loggedInUser._id}`);

        // TODO: Implement Robust Stock Deduction Here!
        // 1. Aggregate needed items/quantities for *all confirmed orders* for this driver/warehouse.
        // 2. Fetch current stock for those items.
        // 3. Verify ALL items have sufficient stock. If not, throw error.
        // 4. If stock is sufficient, perform the updateMany and THEN decrement stock using $inc. Use transactions if possible.
        console.log("TODO: Implement stock check and deduction before updating status!");

        // Update all 'confirmed' orders for this driver FROM THIS WAREHOUSE to 'shipped'
        const updateResult = await Order.updateMany(
            {
                assignedDeliveryPartnerId: loggedInUser._id,
                warehouseId: originWarehouseId, // Ensure we only update orders from this warehouse
                orderStatus: 'confirmed'
            },
            {
                $set: {
                    orderStatus: 'shipped',
                    updatedDate: new Date()
                    // Optionally set pickupTimestamp: new Date()
                }
            }
        );

        if (updateResult.matchedCount === 0) {
             console.warn(`Batch pickup attempted, but no 'confirmed' orders found for driver ${loggedInUser._id} and warehouse ${originWarehouseId}.`);
             // Maybe redirect with info message?
        }

        console.log(`Batch pickup complete: ${updateResult.modifiedCount} orders marked as 'shipped' from warehouse ${originWarehouseId}.`);
        // req.flash('success_msg', `${updateResult.modifiedCount} orders marked as picked up.`);
        res.redirect('/deliveries/map?success=Orders+picked+up.+Route+ready.'); // Redirect to map view

    } catch (err) {
        console.error(`Error during batch pickup from warehouse ${originWarehouseId}:`, err);
        // req.flash('error_msg', `Pickup failed: ${err.message}`);
        res.redirect(`/deliveries/my?error=${encodeURIComponent(`Pickup failed: ${err.message}`)}`);
    }
});

// POST /deliveries/:orderId/delivered - Mark order as delivered
router.post('/:orderId/delivered', async (req, res) => {
     const orderId = req.params.orderId;
     const loggedInUser = res.locals.loggedInUser;
     console.log(`--- Driver ${loggedInUser._id} attempting delivery for order ${orderId} ---`);

     if (!mongoose.Types.ObjectId.isValid(orderId)) {
        // req.flash('error_msg', 'Invalid Order ID.');
        return res.redirect('/deliveries/my?error=Invalid+Order+ID');
     }

     try {
        // Fetch full Mongoose document
        const order = await Order.findById(orderId);
        if (!order) {
            throw new Error("Order not found.");
        }

        // Authorization: Is this driver assigned?
        if (order.assignedDeliveryPartnerId?.toString() !== loggedInUser._id.toString()) {
            throw new Error("You are not assigned to this delivery.");
        }

        // Validation: Can only deliver 'shipped' orders
        if (order.orderStatus !== 'shipped') {
            throw new Error(`Order status is currently '${order.orderStatus}', cannot mark as delivered (requires 'shipped').`);
        }

        // *** TODO: Handle proof of delivery if needed (e.g., signature image upload) ***

        // Update Status
        order.orderStatus = 'delivered';
        order.updatedDate = new Date();
        // Optionally record delivery timestamp
        // order.deliveryTimestamp = new Date();

        await order.save();
        console.log(`Order ${orderId} marked as 'delivered' by driver ${loggedInUser._id}`);

        // *** TODO: Trigger Notifications? ***

        // Add flash message for success
        // req.flash('success_msg', 'Order marked as delivered.');
        res.redirect('/deliveries/my?success=Order+marked+as+delivered'); // Redirect back to list

     } catch (err) {
         console.error(`Error marking order ${orderId} as delivered:`, err);
         // Add flash message for error
         // req.flash('error_msg', `Error: ${err.message}`);
         res.redirect(`/deliveries/my?error=${encodeURIComponent(err.message)}`); // Redirect back with error
     }
});


module.exports = router;