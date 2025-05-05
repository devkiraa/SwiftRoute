// routes/orders.js
const express = require('express');
const mongoose = require('mongoose');

// --- Import ALL necessary models ---
const Order = require('../models/Order');
const Store = require('../models/Store');
const User = require('../models/User');
const Item = require('../models/Item');
const Warehouse = require('../models/Warehouse'); // Ensure this is present
const Company = require('../models/Company');
// --- End Model Imports ---

// Google Maps Client (Keep available for potential future use)
const { Client } = require("@googlemaps/google-maps-services-js");
const googleMapsClient = new Client({});
// Ensure this variable name matches the one in your .env file
const Maps_API_KEY_CONFIG = { key: process.env.Maps_API_KEY };

const router = express.Router();

// --- Local Auth Middleware ---
function ensureAuthenticated(req, res, next) {
    if (res.locals.loggedInUser) return next();
    console.log("User not authenticated (orders route check), redirecting to login.");
    res.redirect('/login');
}

function ensureCanCreateOrder(req, res, next) {
    const loggedInUser = res.locals.loggedInUser;
     if (loggedInUser && ['admin', 'warehouse_owner', 'store_owner', 'employee'].includes(loggedInUser.role)) {
        if (loggedInUser.role !== 'admin' && !loggedInUser.companyId) {
             console.log("Create Order Denied: User not associated with a company.");
             return res.status(400).send("User not associated with a company");
         }
        if (['store_owner', 'employee'].includes(loggedInUser.role) && !loggedInUser.storeId) {
             console.log("Create Order Denied: User not associated with a store.");
             return res.status(400).send("User not associated with a store");
         }
        return next();
    }
     console.log(`Create Order Denied: Role ${loggedInUser?.role} not permitted.`);
    res.status(403).send("Access Denied: You do not have permission to create orders.");
}

async function canAccessStoreData(user, storeId) {
     if (!user || !storeId) return false;
     if (user.role === 'admin') return true;
     if (user.role === 'warehouse_owner') {
         // Ensure companyId exists before querying
         if (!user.companyId) return false;
         const store = await Store.findOne({ _id: storeId, companyId: user.companyId }).lean();
         return !!store;
     }
     if (['store_owner', 'employee'].includes(user.role)) {
         return user.storeId?.toString() === storeId.toString();
     }
     return false;
}

async function ensureCanManageOrder(req, res, next) {
    const loggedInUser = res.locals.loggedInUser;
    const orderId = req.params.id;

    if (!loggedInUser){ return res.status(401).send("Authentication required."); } // Should be caught by ensureAuthenticated

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
        return res.status(400).send("Invalid Order ID format.");
    }

    try {
        const order = await Order.findById(orderId).select('storeId assignedDeliveryPartnerId').lean();
        if (!order) {
            return res.status(404).send("Order not found.");
        }

        const hasStoreAccess = await canAccessStoreData(loggedInUser, order.storeId);

        if (['admin', 'warehouse_owner', 'store_owner'].includes(loggedInUser.role) && hasStoreAccess) {
            req.order = order; // Attach order for handler use (optional)
            return next();
        }

        // Check if assigned delivery partner (add more checks if they can update status etc.)
        // if (loggedInUser.role === 'delivery_partner' && order.assignedDeliveryPartnerId?.toString() === loggedInUser._id.toString()) {
        //     req.order = order;
        //     return next();
        // }

        console.log(`Access Denied: User ${loggedInUser._id} role ${loggedInUser.role} cannot manage order ${orderId}`);
        res.status(403).render('error_page', {
             title: "Access Denied",
             message: "You do not have permission to manage this order.",
             layout: './layouts/dashboard_layout' // Show error within layout
         });

    } catch (err) {
        console.error("Error checking order management permissions:", err);
        res.status(500).send("Server error checking order permissions.");
    }
}
// --- End Local Auth Middleware ---

// Apply basic authentication to all routes in this file
router.use(ensureAuthenticated);

// --- ORDER LIST & DETAILS ---

// GET /orders - List orders based on role
router.get('/', async (req, res) => {
    console.log(`--- Accessing GET /orders ---`);
    const loggedInUser = res.locals.loggedInUser;
    if (!loggedInUser) return res.redirect('/login'); // Should be caught by middleware, but safe check

    console.log(`User Role: ${loggedInUser.role}`);
    let query = {};
    let viewTitle = 'Orders';
    let canCreateOrder = false;

    try {
        let companyStoreIds = [];

        switch (loggedInUser.role) {
            case 'warehouse_owner':
            case 'admin':
                console.log("Fetching stores for warehouse_owner/admin...");
                const companyQuery = loggedInUser.role === 'admin' ? {} : { companyId: loggedInUser.companyId };
                if (!companyQuery.companyId && loggedInUser.role === 'warehouse_owner') throw new Error("Warehouse owner missing company ID");

                const companyStores = await Store.find(companyQuery).select('_id').lean();
                companyStoreIds = companyStores.map(s => s._id);
                console.log(`Found ${companyStoreIds.length} store IDs.`);
                query = { storeId: { $in: companyStoreIds } };
                viewTitle = loggedInUser.role === 'admin' ? 'All Orders' : 'Company Orders';
                canCreateOrder = true; // Allow admin/owner to create orders
                break;

            case 'store_owner':
            case 'employee':
                console.log("Fetching orders for store_owner/employee...");
                if (!loggedInUser.storeId) {
                    console.error(`User ${loggedInUser._id} role ${loggedInUser.role} missing storeId.`);
                    return res.status(400).render('error_page', { title: "Error", message: "You are not assigned to a store.", layout: './layouts/dashboard_layout' });
                }
                query = { storeId: loggedInUser.storeId };
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

        // Handle case where no stores are found for non-admins
        if (loggedInUser.role !== 'admin' && companyStoreIds.length === 0 && !query.storeId) {
            console.log(`No stores found for user ${loggedInUser._id} to query orders.`);
             return res.render('orders/index', {
                 title: viewTitle, orders: [], canCreateOrder: canCreateOrder, layout: './layouts/dashboard_layout'
             });
        }

        console.log("Fetching orders with query:", JSON.stringify(query));
        const orders = await Order.find(query)
            .populate('storeId', 'storeName')
            .populate('customerId', 'username email')
            .sort({ placedDate: -1 })
            .limit(50) // Implement pagination later
            .lean();
        console.log(`Found ${orders.length} orders.`);

        console.log("Rendering orders/index view...");
        res.render('orders/index', {
            title: viewTitle,
            orders: orders,
            canCreateOrder: canCreateOrder,
            layout: './layouts/dashboard_layout'
        });
        console.log("Finished rendering orders/index view.");

    } catch (err) {
        console.error(`Error fetching orders for role ${loggedInUser?.role}:`, err);
        res.status(500).render('error_page', { title: "Error", message: "Failed to load orders.", layout: false });
    }
});


// --- Correct Route Order: '/new' before '/:id' ---

// GET /orders/new - Show form to manually create an order
router.get('/new', ensureCanCreateOrder, async (req, res) => {
    console.log("--- Accessing GET /orders/new ---");
    try {
        const loggedInUser = res.locals.loggedInUser;
        if (!loggedInUser) throw new Error("User not found in session.");

        let storeQuery = {}, warehouseQuery = {}, itemQuery = {};
        console.log(`Workspaceing form data for user role: ${loggedInUser.role}`);

        // Scope data based on role
        if (['warehouse_owner', 'store_owner', 'employee'].includes(loggedInUser.role)) {
            if (!loggedInUser.companyId) throw new Error("User missing company association.");
            storeQuery.companyId = loggedInUser.companyId;
            warehouseQuery.companyId = loggedInUser.companyId;
            const companyWarehouses = await Warehouse.find(warehouseQuery).select('_id').lean();
            console.log(`Found ${companyWarehouses.length} warehouses.`);
            // Only find items from those warehouses
            itemQuery.warehouseId = { $in: companyWarehouses.map(w => w._id) };
        } // Admin gets all

        console.log("Executing DB queries for stores, warehouses, items...");
        const [stores, warehouses, items] = await Promise.all([
            Store.find(storeQuery).select('storeName _id').lean(),
            Warehouse.find(warehouseQuery).select('name _id').lean(),
            Item.find(itemQuery).select('name sku price _id quantity warehouseId').populate('warehouseId', 'name').lean()
        ]);
        console.log(`Workspaceed: ${stores.length} stores, ${warehouses.length} warehouses, ${items.length} items.`);

        if ((loggedInUser.role === 'warehouse_owner' || loggedInUser.role === 'store_owner' || loggedInUser.role === 'employee') && warehouses.length === 0) {
             console.log(`User ${loggedInUser._id} has no warehouses to add items from.`);
             // Consider sending a message with the redirect
             return res.redirect(`/${loggedInUser.role === 'warehouse_owner' ? 'warehouses' : 'dashboard'}?message=No warehouses available to create order items.`);
        }

        console.log("Rendering orders/form view...");
        res.render('orders/form', {
            title: 'Create Manual Order',
            order: {}, stores, warehouses, items,
            // API key removed - not needed by view
            layout: './layouts/dashboard_layout'
        });
        console.log("Finished rendering orders/form view.");

    } catch (err) {
        console.error("Error loading new order form:", err);
        res.status(500).render('error_page', { title: "Error", message: `Failed to load new order form: ${err.message}`, layout: false });
    }
});


// --- ORDER DETAILS ---
router.get('/:id', async (req, res) => {
    console.log(`--- Accessing GET /orders/${req.params.id} ---`);
    const loggedInUser = res.locals.loggedInUser;
    const orderId = req.params.id;

    if (!loggedInUser) return res.redirect('/login');
    if (!mongoose.Types.ObjectId.isValid(orderId)) { /* ... invalid ID handling ... */ }

    try {
        console.log(`Workspaceing order ${orderId}...`);
        const order = await Order.findById(orderId)
            .populate('storeId', 'storeName address phone companyId') // Ensure companyId is populated
            .populate('customerId', 'username email phone')
            .populate({ path: 'orderItems.itemId', model: 'Item', select: 'name sku price' })
            .populate('assignedDeliveryPartnerId', 'username')
            .lean();

        if (!order) { /* ... not found handling ... */ }
        console.log(`Order ${orderId} fetched. Store ID: ${order.storeId?._id}, Store Company ID: ${order.storeId?.companyId}`); // Log fetched IDs

        console.log("Checking access permissions...");
        const hasAccess = await canAccessStoreData(loggedInUser, order.storeId?._id);
        const isAssignedDelivery = loggedInUser.role === 'delivery_partner' && order.assignedDeliveryPartnerId?._id?.toString() === loggedInUser._id.toString();
        if (!hasAccess && !isAssignedDelivery) { /* ... access denied handling ... */ }

        // Determine allowed actions
        console.log("Determining allowed actions...");
        let allowedActions = { canUpdateStatus: false, canAssignDelivery: false };
        let availableDrivers = [];
        const canManage = ['admin', 'warehouse_owner', 'store_owner'].includes(loggedInUser.role) && hasAccess;

        if (canManage && ['pending', 'confirmed', 'shipped'].includes(order.orderStatus)) { allowedActions.canUpdateStatus = true; }
        if (canManage && ['confirmed', 'shipped'].includes(order.orderStatus)) {
            allowedActions.canAssignDelivery = true;
            const orderCompanyId = order.storeId?.companyId; // Get companyId from populated store

            // *** ADD Explicit Log for Company ID used in Driver Query ***
            console.log(`Order's Store Company ID for driver search: ${orderCompanyId}`);

            if (orderCompanyId) {
                 console.log(`Workspaceing available drivers for Company ID: ${orderCompanyId}...`);
                 availableDrivers = await User.find({
                     companyId: orderCompanyId,         // Filter by the order's store's company
                     role: 'delivery_partner',     // Filter by role
                 }).select('username _id').lean();
                 console.log(`Found ${availableDrivers.length} drivers.`);
            } else {
                 console.warn(`Could not determine companyId for order ${orderId} to fetch drivers.`);
            }
        }
        console.log("Allowed Actions:", allowedActions);

        console.log("Rendering orders/details view...");
        res.render('orders/details', {
            title: `Order Details - ${order._id.toString().slice(-8)}`,
            order: order,
            allowedActions: allowedActions,
            availableDrivers: availableDrivers,
            hasAccess: hasAccess, // Ensure this is passed for Edit button logic
            layout: './layouts/dashboard_layout'
        });
        console.log("Finished rendering orders/details view.");

    } catch (err) {
        console.error(`Error fetching order details for ID ${req.params.id}:`, err);
        res.status(500).render('error_page', { title: "Error", message: "Failed to load order details.", layout: false });
    }
});


// POST /orders - Create a new manual order
router.post('/', ensureCanCreateOrder, async (req, res) => {
    console.log("Received POST /orders request body:", JSON.stringify(req.body, null, 2));
    const loggedInUser = res.locals.loggedInUser;
    let stores = [], warehouses = [], items = []; // For use in catch block

    try {
        const { storeId, warehouseId, customerName, customerPhone, itemIds, quantities } = req.body;

        // --- Validation ---
        if (!storeId || !warehouseId || !customerName || !itemIds || !quantities) throw new Error("Missing required fields...");
        if (!mongoose.Types.ObjectId.isValid(storeId) || !mongoose.Types.ObjectId.isValid(warehouseId)) throw new Error("Invalid Store/Warehouse ID.");
        if (!Array.isArray(itemIds) || !Array.isArray(quantities) || itemIds.length !== quantities.length) throw new Error("Item data arrays mismatch.");
        const validItemIds = itemIds.filter(id => id && mongoose.Types.ObjectId.isValid(id));
        const validQuantities = quantities.filter((qty, index) => itemIds[index] && mongoose.Types.ObjectId.isValid(itemIds[index]) && !isNaN(parseInt(qty)) && parseInt(qty) > 0).map(qty => parseInt(qty));
        if (validItemIds.length !== validQuantities.length || validItemIds.length === 0) throw new Error("Invalid item/quantity pairs submitted.");

        // --- Fetch Store/Warehouse & Auth Check ---
        console.log(`Workspaceing Store ${storeId} and Warehouse ${warehouseId}`);
        const selectedStore = await Store.findById(storeId).lean();
        const selectedWarehouse = await Warehouse.findById(warehouseId).lean();
        if (!selectedStore || !selectedWarehouse) throw new Error("Selected Store or Warehouse not found.");
        // *** Check if Store has an address ***
        if (!selectedStore.address) {
             console.error(`Validation Error: Store ${storeId} is missing the required address field.`);
             throw new Error(`Selected Store (${selectedStore.storeName}) is missing its address in the database.`);
        }
        // *** Check if Store has location coordinates *** (Optional, but needed for the field)
        if (!selectedStore.location || !selectedStore.location.coordinates || selectedStore.location.coordinates.length !== 2) {
             console.warn(`Validation Warning: Store ${storeId} is missing location coordinates. Order shippingLocation will be null.`);
             // You might allow creation but log a warning, or throw an error if coordinates are essential
             // throw new Error(`Selected Store (${selectedStore.storeName}) is missing location coordinates in the database.`);
        }

        if (loggedInUser.role !== 'admin') { /* ... Check company match using _id ... */ }


        // --- Prepare Order Items & Calculate Total ---
        console.log("Preparing order items...");
        let totalAmount = 0;
        const orderItemsData = [];
        const itemFetchPromises = validItemIds.map(id => Item.findById(id).lean());
        const fetchedItems = await Promise.all(itemFetchPromises);
        if(fetchedItems.some(item => !item)){
            throw new Error("One or more selected items could not be found.");
        }
        for (let i = 0; i < validItemIds.length; i++) {
            const item = fetchedItems[i];
            const quantity = validQuantities[i];
            // TODO: STOCK CHECK LOGIC HERE!
            orderItemsData.push({ itemId: item._id, quantity: quantity, priceAtOrder: item.price });
            totalAmount += quantity * item.price;
        }
        console.log(`Prepared ${orderItemsData.length} items. Calculated Total: ${totalAmount}`);
        if (isNaN(totalAmount)) { // Add check for NaN totalAmount
            throw new Error("Failed to calculate a valid total amount for the order.");
        }


        // --- Create Order Document ---
        const orderDataToSave = {
            storeId, warehouseId, customerName, customerPhone, customerId: null,
            shippingAddress: selectedStore.address, // Use validated store address
            shippingLocation: selectedStore.location, // Use store location (might be null if store is missing it)
            orderItems: orderItemsData,
            totalAmount: totalAmount, // Use calculated total
            orderStatus: 'confirmed',
            createdBy: loggedInUser._id,
            placedDate: new Date(), updatedDate: new Date(),
            assignedDeliveryPartnerId: null
        };

        // *** LOG DATA BEFORE SAVING ***
        console.log("Data being saved to new Order:", JSON.stringify(orderDataToSave, null, 2));

        const newOrder = new Order(orderDataToSave);
        await newOrder.save(); // Validation happens here
        console.log("Manual order saved:", newOrder._id);

        // --- TODO: Deduct Stock ---
        console.log("TODO: Implement stock deduction!");

        res.redirect(`/orders/${newOrder._id}`);

    } catch (err) {
        console.error("Error creating manual order:", err); // Log the full error
        // Fetch supporting data again for form re-render
        try {
            let storeQuery = {}, warehouseQuery = {}, itemQuery = {};
            if (loggedInUser && loggedInUser.role !== 'admin') { /* ... set queries ... */ }
            [stores, warehouses, items] = await Promise.all([ /* ... fetch dropdown data ... */ ]);
            res.status(400).render('orders/form', {
                title: 'Create Manual Order', order: req.body, stores, warehouses, items,
                // ** Correct API key variable **
                error: `Failed to create order: ${err.message}`,
                layout: './layouts/dashboard_layout'
            });
        } catch (renderErr) { /* ... render error page ... */ }
    }
});


// POST /orders/:id/assign-driver - Assign driver
router.post('/:id/assign-driver', ensureCanManageOrder, async (req, res) => {
     // ... (Keep assign driver logic from response #38) ...
     // Remember to use findByIdAndUpdate or fetch full doc then save()
     const orderId = req.params.id;
     const { driverId } = req.body;
     const loggedInUser = res.locals.loggedInUser;
     try {
         const driver = driverId ? await User.findById(driverId).lean() : null; // Fetch only if ID provided
         if (driverId && (!driver || driver.role !== 'delivery_partner')) { throw new Error("Invalid Driver selected."); }

         const order = await Order.findById(orderId).populate('storeId', 'companyId');
         if (!order) throw new Error("Order not found.");

         // Authorization Check: Driver company vs Order company
         const orderCompanyId = order.storeId?.companyId;
         if (!orderCompanyId) throw new Error("Could not determine company for the order.");
         if (driver && loggedInUser.role !== 'admin' && driver.companyId?.toString() !== orderCompanyId.toString()) {
             throw new Error("Selected driver does not belong to the correct company.");
         }

         order.assignedDeliveryPartnerId = driver ? driver._id : null; // Assign or unassign (if driverId is empty)
         order.updatedDate = new Date();
         await order.save();

         console.log(`Order ${orderId} ${driver ? 'assigned to' : 'unassigned from'} driver ${driver?.username || ''} by ${loggedInUser.username}`);
         res.redirect(`/orders/${orderId}`);
     } catch (err) {
          console.error(`Error assigning/unassigning driver to order ${orderId}:`, err);
          res.redirect(`/orders/<span class="math-inline">\{orderId\}?error\=</span>{encodeURIComponent(err.message)}`);
     }
});
// GET /orders/:id/edit - Show form to edit order items
router.get('/:id/edit', ensureCanManageOrder, async (req, res) => {
    const orderId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;
    console.log(`--- Accessing GET /orders/${orderId}/edit ---`);

    try {
        // Fetch the full order with populated items to edit
        const orderToEdit = await Order.findById(orderId)
            .populate({
                path: 'orderItems.itemId',
                model: 'Item',
                select: 'name sku price quantity warehouseId' // Need quantity for stock check info
            })
            .populate('storeId', 'storeName companyId') // Need company for item filtering
            .populate('warehouseId', 'name') // Need fulfilling warehouse name
            .lean(); // Use lean for easier manipulation

        if (!orderToEdit) {
            throw new Error("Order not found.");
        }

        // **Authorization**: Double-check management permission (redundant if ensureCanManageOrder is solid)
        // const hasAccess = await canAccessStoreData(loggedInUser, orderToEdit.storeId?._id);
        // if(!hasAccess && loggedInUser.role !== 'admin') { throw new Error("Permission denied."); }

        // **Status Check**: Prevent editing shipped/delivered/cancelled orders
        if (!['pending', 'confirmed'].includes(orderToEdit.orderStatus)) {
             console.log(`Order ${orderId} has status ${orderToEdit.orderStatus}, editing not allowed.`);
             // Redirect back with a message using flash or query param
             return res.redirect(`/orders/${orderId}?error=Cannot+edit+order+with+status:+${orderToEdit.orderStatus}`);
        }

        // Fetch available items for dropdowns - SCOPED TO THE ORDER'S COMPANY
        let itemQuery = {};
        const orderCompanyId = orderToEdit.storeId?.companyId;
        if(orderCompanyId){
             const companyWarehouses = await Warehouse.find({ companyId: orderCompanyId }).select('_id').lean();
             itemQuery.warehouseId = { $in: companyWarehouses.map(w => w._id) };
        } else if (loggedInUser.role !== 'admin') {
             throw new Error("Cannot determine company to fetch items for.");
        }
        // Fetch all items the user *could* add
        const availableItems = await Item.find(itemQuery)
            .select('name sku price _id quantity warehouseId')
            .populate('warehouseId', 'name')
            .lean();


        res.render('orders/edit_form', { // Render views/orders/edit_form.ejs
            title: `Edit Order - ${orderId.toString().slice(-8)}`,
            order: orderToEdit,
            items: availableItems, // Pass available items for adding new ones
            layout: './layouts/dashboard_layout'
        });
        console.log("Rendered order edit form.");

    } catch (err) {
        console.error(`Error loading order edit form for ID ${orderId}:`, err);
        res.status(500).render('error_page', { title: "Error", message: `Failed to load order edit form: ${err.message}`, layout: false });
    }
});

// --- TODO: Add route for updating status (PUT /orders/:id/status) ---

module.exports = router;