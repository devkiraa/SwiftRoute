// routes/orders.js
const express = require('express');
const mongoose = require('mongoose');

// --- Import ALL necessary models ---
const Order = require('../models/Order');
const Store = require('../models/Store');
const User = require('../models/User');
const Item = require('../models/Item');
const Warehouse = require('../models/Warehouse');
const Company = require('../models/Company');
// --- End Model Imports ---

// Google Maps Client (Only needed if you add geocoding back later or use other services)
// const { Client } = require("@googlemaps/google-maps-services-js");
// const googleMapsClient = new Client({});
// Ensure this variable name matches the one in your .env file
// const Maps_API_KEY_CONFIG = { key: process.env.Maps_API_KEY };

const router = express.Router();

// --- Local Auth Middleware ---
function ensureAuthenticated(req, res, next) {
    if (res.locals.loggedInUser) return next();
    res.redirect('/login');
}
function ensureCanCreateOrder(req, res, next) {
    // ... (keep implementation as before) ...
     const loggedInUser = res.locals.loggedInUser;
     if (loggedInUser && ['admin', 'warehouse_owner', 'store_owner', 'employee'].includes(loggedInUser.role)) {
        if (loggedInUser.role !== 'admin' && !loggedInUser.companyId) return res.status(400).send("User not associated with a company");
        if (['store_owner', 'employee'].includes(loggedInUser.role) && !loggedInUser.storeId) return res.status(400).send("User not associated with a store");
        return next();
    }
    res.status(403).send("Access Denied: You do not have permission to create orders.");
}
async function canAccessStoreData(user, storeId) {
    // ... (keep implementation as before) ...
     if (!user || !storeId) return false;
     if (user.role === 'admin') return true; // Admin has access to all
     if (user.role === 'warehouse_owner') {
         const store = await Store.findOne({ _id: storeId, companyId: user.companyId }).lean();
         return !!store;
     }
     if (['store_owner', 'employee'].includes(user.role)) {
         return user.storeId?.toString() === storeId.toString();
     }
     return false;
}
// Middleware to check if user can manage a specific order (e.g., assign driver, update status)
// Often requires admin, warehouse owner, or store owner of the associated store
async function ensureCanManageOrder(req, res, next) {
    const loggedInUser = res.locals.loggedInUser;
    const orderId = req.params.id;

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
        return res.status(400).send("Invalid Order ID format.");
    }

    try {
        const order = await Order.findById(orderId).select('storeId assignedDeliveryPartnerId').lean();
        if (!order) {
            return res.status(404).send("Order not found.");
        }

        // Check if user is admin or associated with the order's store's company
        const hasStoreAccess = await canAccessStoreData(loggedInUser, order.storeId);

        if (loggedInUser && ['admin', 'warehouse_owner', 'store_owner'].includes(loggedInUser.role) && hasStoreAccess) {
            req.order = order; // Attach order (or needed fields) to request for handler
            return next();
        }

        // Allow delivery partner to update status if assigned (add more specific logic later)
        // if (loggedInUser.role === 'delivery_partner' && order.assignedDeliveryPartnerId?.toString() === loggedInUser._id.toString()) {
        //     req.order = order;
        //     return next();
        // }

        console.log(`Access Denied: User ${loggedInUser?._id} role ${loggedInUser?.role} cannot manage order ${orderId}`);
        res.status(403).send("Access Denied: You do not have permission to manage this order.");

    } catch (err) {
        console.error("Error checking order management permissions:", err);
        res.status(500).send("Server error checking order permissions.");
    }
}
// --- End Local Auth Middleware ---

router.use(ensureAuthenticated); // Apply basic authentication to all routes

// --- ORDER LIST & DETAILS ---
// GET /orders - List orders based on role
router.get('/', async (req, res) => {
    console.log(`--- Accessing GET /orders ---`); // Log: Route entry
    const loggedInUser = res.locals.loggedInUser;
    if (!loggedInUser) { // Double check user exists
        console.error("Error: loggedInUser not found in res.locals for GET /orders");
        return res.redirect('/login');
    }

    console.log(`User Role: ${loggedInUser.role}`); // Log: Role
    let query = {};
    let viewTitle = 'Orders';
    let canCreateOrder = false;

    try {
        let companyStoreIds = []; // Initialize

        switch (loggedInUser.role) {
            case 'warehouse_owner':
            case 'admin':
                console.log("Fetching stores for warehouse_owner/admin...");
                const companyQuery = loggedInUser.role === 'admin' ? {} : { companyId: loggedInUser.companyId };
                if (!companyQuery.companyId && loggedInUser.role !== 'admin') throw new Error("Warehouse owner missing company ID");

                const companyStores = await Store.find(companyQuery).select('_id').lean();
                companyStoreIds = companyStores.map(s => s._id);
                console.log(`Found ${companyStoreIds.length} store IDs for query.`);
                query = { storeId: { $in: companyStoreIds } };
                viewTitle = loggedInUser.role === 'admin' ? 'All Orders' : 'Company Orders';
                 // Allow warehouse owner & admin to create manual orders too
                 canCreateOrder = true;
                break;

            case 'store_owner':
            case 'employee':
                console.log("Fetching orders for store_owner/employee...");
                if (!loggedInUser.storeId) {
                     console.error(`User ${loggedInUser._id} role ${loggedInUser.role} missing storeId.`);
                    return res.status(400).render('error_page', { title: "Error", message: "You are not assigned to a store.", layout: './layouts/dashboard_layout' });
                }
                query = { storeId: loggedInUser.storeId };
                companyStoreIds = [loggedInUser.storeId]; // Needed for consistency if used below
                viewTitle = 'Store Orders';
                canCreateOrder = true;
                break;

            case 'delivery_partner':
                 console.log("Redirecting delivery_partner from /orders");
                return res.status(403).render('error_page', { title: "Access Denied", message: "Please view your assigned deliveries page.", layout: './layouts/dashboard_layout' });

            default:
                 console.error(`Invalid role "${loggedInUser.role}" accessing /orders`);
                return res.status(403).send("Access Denied: Role cannot view orders.");
        }

        // Ensure query has storeIds before proceeding (important for empty companies)
        if (!query.storeId || (query.storeId.$in && query.storeId.$in.length === 0)) {
             if (loggedInUser.role === 'warehouse_owner' || loggedInUser.role === 'store_owner') {
                 console.log(`No stores found for user ${loggedInUser._id} to query orders.`);
             }
             // Render the page with an empty order list if no stores are found
             return res.render('orders/index', {
                 title: viewTitle,
                 orders: [], // Empty array
                 canCreateOrder: canCreateOrder,
                 layout: './layouts/dashboard_layout'
             });
        }

        console.log("Fetching orders with query:", JSON.stringify(query)); // Log: DB Query
        const orders = await Order.find(query)
            .populate('storeId', 'storeName')
            .populate('customerId', 'username email')
            .sort({ placedDate: -1 })
            .limit(50) // Add proper pagination later
            .lean();
        console.log(`Found ${orders.length} orders.`); // Log: Query Result

        console.log("Rendering orders/index view..."); // Log: Rendering step
        res.render('orders/index', {
            title: viewTitle,
            orders: orders,
            canCreateOrder: canCreateOrder,
            layout: './layouts/dashboard_layout'
        });

    } catch (err) {
        // Log the specific error encountered
        console.error(`Error fetching orders for role ${loggedInUser?.role}:`, err);
        res.status(500).render('error_page', { title: "Error", message: "Failed to load orders.", layout: false });
    }
});

router.get('/:id', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        const orderId = req.params.id;

        if (!mongoose.Types.ObjectId.isValid(orderId)) { /* ... invalid ID handling ... */ }

        const order = await Order.findById(orderId)
            .populate('storeId', 'storeName address phone companyId') // <-- Added companyId populate
            .populate('customerId', 'username email phone')
            .populate({ path: 'orderItems.itemId', model: 'Item', select: 'name sku price' })
            .populate('assignedDeliveryPartnerId', 'username') // <-- Populate assigned driver's name
            .lean();

        if (!order) { /* ... not found handling ... */ }

        const hasAccess = await canAccessStoreData(loggedInUser, order.storeId?._id);
        const isAssignedDelivery = loggedInUser.role === 'delivery_partner' && order.assignedDeliveryPartnerId?._id?.toString() === loggedInUser._id.toString();

        if (!hasAccess && !isAssignedDelivery) { /* ... access denied handling ... */ }

        // Determine allowed actions
        let allowedActions = { canUpdateStatus: false, canAssignDelivery: false };
        let availableDrivers = []; // Initialize driver list

        const canManage = ['admin', 'warehouse_owner', 'store_owner'].includes(loggedInUser.role) && hasAccess;

        if (canManage && ['pending', 'confirmed', 'shipped'].includes(order.orderStatus)) {
            allowedActions.canUpdateStatus = true;
        }
        // Allow assigning if confirmed/shipped and user can manage
        if (canManage && ['confirmed', 'shipped'].includes(order.orderStatus)) {
            allowedActions.canAssignDelivery = true;
            // Fetch available drivers from the SAME company as the order's store
            if (order.storeId?.companyId) {
                 availableDrivers = await User.find({
                     companyId: order.storeId.companyId, // Find drivers in the order's company
                     role: 'delivery_partner',
                     // isAvailable: true // Optional: Add availability flag later
                 }).select('username _id').lean();
            }
        }

        res.render('orders/details', {
            title: `Order Details - ${order._id.toString().slice(-8)}`,
            order: order,
            allowedActions: allowedActions,
            availableDrivers: availableDrivers, // Pass drivers to the view
            layout: './layouts/dashboard_layout'
        });

    } catch (err) { /* ... error handling ... */ }
});

// GET /orders/new - Show form
router.get('/new', ensureCanCreateOrder, async (req, res) => {
    console.log("--- Accessing GET /orders/new ---"); // Log entry
    try {
        const loggedInUser = res.locals.loggedInUser;
        if (!loggedInUser) throw new Error("User not found in session."); // Added check

        let storeQuery = {}, warehouseQuery = {}, itemQuery = {};
        console.log(`Workspaceing form data for user role: ${loggedInUser.role}`);

        if (['warehouse_owner', 'store_owner', 'employee'].includes(loggedInUser.role)) {
            if (!loggedInUser.companyId) throw new Error("User missing company association.");
            storeQuery.companyId = loggedInUser.companyId;
            warehouseQuery.companyId = loggedInUser.companyId;
            const companyWarehouses = await Warehouse.find(warehouseQuery).select('_id').lean();
            console.log(`Found ${companyWarehouses.length} warehouses.`);
            itemQuery.warehouseId = { $in: companyWarehouses.map(w => w._id) };
        } // Admin gets all

        console.log("Executing DB queries for stores, warehouses, items...");
        const [stores, warehouses, items] = await Promise.all([
            Store.find(storeQuery).select('storeName _id').lean(),
            Warehouse.find(warehouseQuery).select('name _id').lean(),
            Item.find(itemQuery).select('name sku price _id quantity warehouseId').populate('warehouseId', 'name').lean()
        ]);
        console.log(`Workspaceed: ${stores.length} stores, ${warehouses.length} warehouses, ${items.length} items.`);

        // Redirect if owner has no warehouses (prevent empty dropdowns later)
        if (loggedInUser.role === 'warehouse_owner' && warehouses.length === 0) {
             console.log("Warehouse owner has no warehouses, redirecting...");
             return res.redirect('/warehouses/new?message=Please add a warehouse first.');
        }

        console.log("Rendering orders/form view...");
        res.render('orders/form', {
            title: 'Create Manual Order',
            order: {}, stores, warehouses, items,
            // ** REMOVED googleMapsApiKey - View doesn't need it **
            layout: './layouts/dashboard_layout'
        });
        console.log("Finished rendering orders/form view."); // Add log after render attempt

    } catch (err) {
        console.error("Error loading new order form:", err);
        res.status(500).render('error_page', { title: "Error", message: `Failed to load new order form: ${err.message}`, layout: false });
    }
});


// POST /orders - Create a new manual order
router.post('/', ensureCanCreateOrder, async (req, res) => {
    console.log("Received POST /orders request body:", JSON.stringify(req.body, null, 2));
    const loggedInUser = res.locals.loggedInUser;
    let stores = [], warehouses = [], items = [];

    try {
        const { storeId, warehouseId, customerName, customerPhone, itemIds, quantities } = req.body;

        // --- Validation ---
        // ... (keep validation logic as before, checking required fields, IDs, arrays) ...
        if (!storeId || !warehouseId || !customerName || !itemIds || !quantities) { throw new Error("Missing required fields..."); }
        if (!mongoose.Types.ObjectId.isValid(storeId) || !mongoose.Types.ObjectId.isValid(warehouseId)) { throw new Error("Invalid Store/Warehouse ID."); }
        if (!Array.isArray(itemIds) || !Array.isArray(quantities) || itemIds.length !== quantities.length) { throw new Error("Item data arrays mismatch."); }

        const validItemIds = itemIds.filter(id => id && mongoose.Types.ObjectId.isValid(id));
        const validQuantities = quantities.filter((qty, index) => itemIds[index] && mongoose.Types.ObjectId.isValid(itemIds[index]) && !isNaN(parseInt(qty)) && parseInt(qty) > 0).map(qty => parseInt(qty));
        if (validItemIds.length !== validQuantities.length || validItemIds.length === 0) { throw new Error("Invalid item/quantity pairs submitted."); }


        // --- Fetch Store/Warehouse & Auth Check --- (Keep as is)
        const selectedStore = await Store.findById(storeId).lean();
        const selectedWarehouse = await Warehouse.findById(warehouseId).lean();
        if (!selectedStore || !selectedWarehouse) throw new Error("Selected Store or Warehouse not found.");
        if (loggedInUser.role !== 'admin') { /* ... Check company match ... */ }

        // --- Prepare Order Items & Calculate Total (Including Stock Check TODO) ---
        // ... (Keep logic as before) ...
         let totalAmount = 0;
         const orderItemsData = [];
         const itemFetchPromises = validItemIds.map(id => Item.findById(id).lean());
         const fetchedItems = await Promise.all(itemFetchPromises);
         for (let i = 0; i < validItemIds.length; i++) { /* ... STOCK CHECK (TODO), push to orderItemsData, add to totalAmount ... */ }


        // --- Create Order Document ---
        const newOrder = new Order({ /* ... Set fields using selectedStore.address/location ... */ });
        await newOrder.save();

        // --- TODO: Deduct Stock ---

        console.log("Manual order created:", newOrder._id);
        res.redirect(`/orders/${newOrder._id}`);

    } catch (err) {
        console.error("Error creating manual order:", err);
        // Fetch supporting data again for form re-render
        try {
            // ... (Fetch stores, warehouses, items again as before) ...
            res.status(400).render('orders/form', {
                title: 'Create Manual Order',
                order: req.body, stores, warehouses, items,
                // ** REMOVED googleMapsApiKey **
                error: `Failed to create order: ${err.message}`,
                layout: './layouts/dashboard_layout'
            });
        } catch (renderErr) { /* ... render error page ... */ }
    }
});

// --- ORDER ACTIONS ---

// POST /orders/:id/assign-driver - Assign a delivery partner
router.post('/:id/assign-driver', ensureAuthenticated, ensureCanManageOrder, async (req, res) => {
    const orderId = req.params.id;
    const { driverId } = req.body; // Get driver ID from form submission
    const loggedInUser = res.locals.loggedInUser;

    try {
        if (!driverId || !mongoose.Types.ObjectId.isValid(driverId)) {
            throw new Error("Invalid or missing Driver ID.");
        }

        // Fetch the order again (or use req.order if passed from middleware)
        const order = await Order.findById(orderId).populate('storeId', 'companyId'); // Need companyId
        if (!order) throw new Error("Order not found.");

        // Fetch the selected driver to verify role and company
        const driver = await User.findById(driverId).lean();
        if (!driver || driver.role !== 'delivery_partner') {
            throw new Error("Selected user is not a valid delivery partner.");
        }

        // Authorization: Ensure driver belongs to the same company as the order's store
        const orderCompanyId = order.storeId?.companyId;
        if (!orderCompanyId) throw new Error("Could not determine company for the order."); // Should not happen if store is populated

        if (loggedInUser.role !== 'admin' && driver.companyId?.toString() !== orderCompanyId.toString()) {
             throw new Error("Selected driver does not belong to the correct company.");
        }

        // Update the order
        order.assignedDeliveryPartnerId = driver._id;
        order.updatedDate = new Date();
        // Optionally update status, e.g., if it was 'confirmed', maybe move to 'shipped' or 'ready_for_delivery'?
        // if (order.orderStatus === 'confirmed') {
        //    order.orderStatus = 'shipped'; // Example status change
        // }

        await order.save(); // Use save() if you fetched the full Mongoose document, or findByIdAndUpdate

        console.log(`Order ${orderId} assigned to driver ${driver.username} (${driverId}) by user ${loggedInUser.username}`);
        // Add success flash message
        res.redirect(`/orders/${orderId}`);

    } catch(err) {
        console.error(`Error assigning driver to order ${orderId}:`, err);
        // Add error flash message
        res.redirect(`/orders/${orderId}?error=${encodeURIComponent(err.message)}`); // Redirect back with error query
    }
});


// --- TODO: Add route for updating status (PUT /orders/:id/status) ---


module.exports = router;