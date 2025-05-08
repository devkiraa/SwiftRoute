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
const puppeteer = require('puppeteer'); // <-- ADDED: For PDF generation
const ejs = require('ejs');             // <-- ADDED: To render EJS to string
const path = require('path');  
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


// POST /orders - Create Manual Order (WITH TRANSACTION)
router.post('/', ensureCanCreateOrder, async (req, res) => {
    console.log("Received POST /orders request body:", JSON.stringify(req.body, null, 2));
    const loggedInUser = res.locals.loggedInUser;
    let storesForForm = [], warehousesForForm = [], itemsForForm = [];
    const { storeId, warehouseId, customerName, customerPhone, itemIds, quantities } = req.body;

    const session = await mongoose.startSession(); // Start a session

    try {
        let newOrderId = null; // To store the ID of the newly created order

        await session.withTransaction(async () => { // Start transaction
            // --- Validation --- (Keep your existing validation)
            if (!storeId || !warehouseId || !customerName || !itemIds || !quantities) throw new Error("Missing fields.");
            const validItemIds = Array.isArray(itemIds) ? itemIds.filter(id => id && mongoose.Types.ObjectId.isValid(id)) : [];
            const validQuantities = Array.isArray(quantities) ? quantities.filter((qty, i) => itemIds[i] && !isNaN(parseInt(qty)) && parseInt(qty) > 0).map(qty => parseInt(qty)) : [];
            if (validItemIds.length === 0 || validItemIds.length !== validQuantities.length) throw new Error("No valid items or item/quantity mismatch.");

            const selectedStore = await Store.findById(storeId).session(session).lean();
            if (!selectedStore) throw new Error(`Store ${storeId} not found.`);
            if (!selectedStore.address) throw new Error(`Store ${selectedStore.storeName} missing address.`);

            // --- Prepare Order Items, Check Stock, Calculate Total (within transaction) ---
            let totalAmount = 0;
            const orderItemsData = []; // For saving to order
            const populatedOrderItemsForStock = []; // For passing to stock helper

            for (let i = 0; i < validItemIds.length; i++) {
                const currentItemId = validItemIds[i];
                const currentQuantity = validQuantities[i];
                const item = await Item.findOne({ _id: currentItemId, warehouseId: warehouseId })
                                     .select('name sku sellingPrice quantity') // Need quantity for stock check
                                     .session(session).lean(); // Use session
                if (!item) throw new Error(`Item ID ${currentItemId} not found in Warehouse or missing data.`);
                if (typeof item.sellingPrice !== 'number') throw new Error(`Selling price missing for ${item.name}.`);

                // STOCK CHECK (already part of updateStockForOrderItems, but good for early fail)
                if (item.quantity < currentQuantity) {
                    throw new Error(`Insufficient stock for ${item.name} (SKU: ${item.sku}). Available: ${item.quantity}, Requested: ${currentQuantity}.`);
                }

                orderItemsData.push({ itemId: item._id, quantity: currentQuantity, priceAtOrder: item.sellingPrice });
                // For stock helper, we need the populated item (or at least its ID and name/sku for logging)
                populatedOrderItemsForStock.push({ itemId: item, quantity: currentQuantity });
                totalAmount += currentQuantity * item.sellingPrice;
            }
            if (isNaN(totalAmount)) throw new Error("Total amount calculation failed.");

            // --- Create Order Document ---
            const newOrder = new Order({
                storeId, warehouseId, customerName, customerPhone, customerId: null,
                shippingAddress: selectedStore.address, shippingLocation: selectedStore.location,
                orderItems: orderItemsData, totalAmount, orderStatus: 'confirmed',
                createdBy: loggedInUser._id, placedDate: new Date(), updatedDate: new Date(),
            });
            const savedOrder = await newOrder.save({ session }); // Pass session
            newOrderId = savedOrder._id; // Store the ID
            console.log("Manual order saved within transaction:", savedOrder._id);

            // --- STOCK DEDUCTION (using helper function) ---
            await updateStockForOrderItems(populatedOrderItemsForStock, warehouseId, 'deduct', session);
            console.log("Stock deduction complete for new order within transaction.");
        }); // Transaction commits here if all successful

        res.redirect(`/orders/${newOrderId}?success=Order+created+successfully`);

    } catch (err) {
        console.error("Error creating manual order (transaction may have aborted):", err);
        // Fetch supporting data again for form re-render
        try {
            // ... (your logic to fetch storesForForm, warehousesForForm, itemsForForm)
            res.status(400).render('orders/form', {
                title: 'Create Manual Order', order: req.body, 
                stores: storesForForm, warehouses: warehousesForForm, items: itemsForForm,
                error: `Failed to create order: ${err.message}`,
                layout: './layouts/dashboard_layout'
            });
        } catch (renderErr) {
            console.error("Error re-rendering order form after transaction error:", renderErr);
            res.status(500).render('error_page', { title: "Error", message: "Error processing order creation.", layout: false });
        }
    } finally {
        await session.endSession(); // Always end session
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

// PUT /orders/:id - Update Order Details & Items (WITH STOCK LOGIC & TRANSACTION)
router.put('/:id', ensureCanManageOrder, async (req, res) => {
    const orderId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;
    console.log(`--- Attempting UPDATE for order ${orderId} ---`);
    console.log("Received PUT /orders/:id request body:", JSON.stringify(req.body, null, 2));

    const { customerName, customerPhone, itemIds, quantities } = req.body;
    // Note: storeId and warehouseId are generally not changed after creation
    
    const session = await mongoose.startSession(); // Start session for transaction

    try {
        let updatedOrderData = {}; // To hold final update values

        await session.withTransaction(async () => { // Start transaction
            
            // 1. Fetch the original order within the transaction
            const originalOrder = await Order.findById(orderId)
                                        .populate('orderItems.itemId', 'name sku sellingPrice unitPrice') // Need unitPrice for COGS in potential stock restoration? Maybe not needed here directly. SellingPrice definitely needed.
                                        .session(session); 
            if (!originalOrder) throw new Error("Order not found.");
            if (!['pending', 'confirmed'].includes(originalOrder.orderStatus)) {
                 throw new Error(`Cannot edit order with status: ${originalOrder.orderStatus}`);
            }
            const warehouseId = originalOrder.warehouseId; // Use the original warehouse for all stock ops

            // --- Basic Validation ---
            if (!customerName || !itemIds || !quantities) throw new Error("Missing required fields (customer name, items, or quantities).");
            const validNewItemIds = Array.isArray(itemIds) ? itemIds.filter(id => id && mongoose.Types.ObjectId.isValid(id)) : [];
            const validNewQuantities = Array.isArray(quantities) ? quantities.filter((qty, i) => itemIds[i] && !isNaN(parseInt(qty)) && parseInt(qty) > 0).map(qty => parseInt(qty)) : [];
            if (validNewItemIds.length === 0 || validNewItemIds.length !== validNewQuantities.length) throw new Error("No valid items or item/quantity mismatch.");

            // --- Process Item Changes & Stock Adjustments ---
            const originalItemsMap = new Map(originalOrder.orderItems.map(item => [item.itemId._id.toString(), item.quantity]));
            const newItemsMap = new Map();
            validNewItemIds.forEach((id, index) => {
                newItemsMap.set(id, (newItemsMap.get(id) || 0) + validNewQuantities[index]); // Sum quantities if same item added multiple times
            });

            const stockAdjustments = []; // Array of promises for stock updates
            const itemsToRecheckStock = []; // Items added or quantity increased

            // --- Calculate stock restoration (Items removed or quantity decreased) ---
            for (const [itemIdStr, originalQty] of originalItemsMap.entries()) {
                const newQty = newItemsMap.get(itemIdStr) || 0; // Get new quantity from submitted form data
                if (newQty < originalQty) {
                    const qtyToRestore = originalQty - newQty;
                    console.log(`[Order Edit] Restoring stock for item ${itemIdStr}: ${qtyToRestore}`);
                    stockAdjustments.push(
                        Item.updateOne({ _id: itemIdStr, warehouseId: warehouseId }, { $inc: { quantity: qtyToRestore }, $set: { lastUpdated: new Date() } }, { session })
                    );
                }
            }

            // --- Calculate stock deduction needed (Items added or quantity increased) ---
            for (const [itemIdStr, newQty] of newItemsMap.entries()) {
                const originalQty = originalItemsMap.get(itemIdStr) || 0;
                if (newQty > originalQty) {
                    const qtyToDeduct = newQty - originalQty;
                    console.log(`[Order Edit] Need to check/deduct stock for item ${itemIdStr}: ${qtyToDeduct}`);
                    itemsToRecheckStock.push({ itemId: itemIdStr, quantity: qtyToDeduct });
                }
            }

            // --- Perform Stock Check for items needing deduction ---
             if (itemsToRecheckStock.length > 0) {
                console.log("[Order Edit] Checking stock for added/increased items...");
                const itemIdsToCheck = itemsToRecheckStock.map(item => item.itemId);
                const currentStockLevels = await Item.find({ _id: { $in: itemIdsToCheck }, warehouseId: warehouseId })
                                                    .select('_id quantity name sku')
                                                    .session(session).lean();
                const stockMap = new Map(currentStockLevels.map(i => [i._id.toString(), i]));

                for (const itemToCheck of itemsToRecheckStock) {
                    const stockInfo = stockMap.get(itemToCheck.itemId);
                    if (!stockInfo) throw new Error(`Item (${itemToCheck.itemId}) not found in warehouse ${warehouseId} during stock check.`);
                    if (stockInfo.quantity < itemToCheck.quantity) {
                        throw new Error(`Insufficient stock for item ${stockInfo.name} (SKU: ${stockInfo.sku}). Available: ${stockInfo.quantity}, Additional Needed: ${itemToCheck.quantity}.`);
                    }
                    // Add deduction to promises
                    console.log(`[Order Edit] Deducting stock for item ${itemToCheck.itemId}: ${itemToCheck.quantity}`);
                    stockAdjustments.push(
                         Item.updateOne({ _id: itemToCheck.itemId, warehouseId: warehouseId }, { $inc: { quantity: -itemToCheck.quantity }, $set: { lastUpdated: new Date() } }, { session })
                    );
                }
                console.log("[Order Edit] Stock checks passed for added/increased items.");
            }

            // --- Execute all stock adjustments together ---
            if (stockAdjustments.length > 0) {
                console.log(`[Order Edit] Executing ${stockAdjustments.length} stock adjustments...`);
                await Promise.all(stockAdjustments);
                console.log("[Order Edit] Stock adjustments completed.");
            } else {
                console.log("[Order Edit] No stock quantity changes detected.");
            }


            // --- Prepare final updated orderItems array & Recalculate Total ---
            let finalTotalAmount = 0;
            const finalOrderItems = [];
            const finalItemDetails = await Item.find({ _id: { $in: Array.from(newItemsMap.keys()) } })
                                            .select('sellingPrice')
                                            .session(session).lean();
            const finalPriceMap = new Map(finalItemDetails.map(i => [i._id.toString(), i.sellingPrice]));

            for (const [itemIdStr, finalQty] of newItemsMap.entries()) {
                 const price = finalPriceMap.get(itemIdStr);
                 if (typeof price !== 'number') {
                     throw new Error(`Could not retrieve selling price for item ${itemIdStr} while finalizing order.`);
                 }
                 finalOrderItems.push({ itemId: itemIdStr, quantity: finalQty, priceAtOrder: price });
                 finalTotalAmount += finalQty * price;
            }
            if (isNaN(finalTotalAmount)) throw new Error("Failed to recalculate final total amount.");

            // --- Update Order Document ---
            originalOrder.customerName = customerName;
            originalOrder.customerPhone = customerPhone;
            originalOrder.orderItems = finalOrderItems;
            originalOrder.totalAmount = finalTotalAmount;
            originalOrder.updatedDate = new Date();
            originalOrder.lastUpdatedBy = loggedInUser._id;

            updatedOrderData = await originalOrder.save({ session }); // Save within transaction
            console.log(`Order ${orderId} updated successfully within transaction.`);

        }); // Transaction commits here if all successful

        res.redirect(`/orders/${orderId}?success=Order+updated+successfully`);

    } catch (err) {
        console.error(`Error updating order ${orderId}:`, err);
        // Re-fetch data needed to render edit form again
        try {
             const orderForForm = await Order.findById(orderId).populate('orderItems.itemId').populate('storeId').populate('warehouseId').lean();
             const itemsForForm = await Item.find({ companyId: orderForForm.storeId?.companyId }).populate('warehouseId').lean(); // Re-fetch available items
             res.status(400).render('orders/edit_form', {
                title: `Edit Order - ${orderId.toString().slice(-8)}`, 
                order: orderForForm || { _id: orderId }, // Pass original order data
                formData: req.body,                      // Pass submitted data back
                items: itemsForForm,
                isEditing: true,
                error: `Update failed: ${err.message}`,
                layout: './layouts/dashboard_layout'
            });
        } catch (renderErr) {
             console.error(`Error re-rendering edit form for order ${orderId}:`, renderErr);
              res.redirect(`/orders/${orderId}?error=Update+failed+and+form+could+not+be+reloaded.`);
        }
    } finally {
        await session.endSession();
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

// Helper function for stock operations (modified to always use session)
async function updateStockForOrderItems(orderItems, warehouseId, operation, session) {
    console.log(`[StockHelper] Starting stock operation: ${operation} for warehouse ${warehouseId}`);
    const stockUpdates = [];
    for (const orderItem of orderItems) {
        // Ensure itemDoc is the actual item document or just its ID to be fetched.
        // If orderItem.itemId is just an ID, you might need to fetch the item's current stock first.
        // For deduction, a pre-check is good, but the update itself needs to be atomic.
        
        let itemIdToUpdate;
        let itemNameToLog = 'Unknown Item';
        let itemSkuToLog = 'N/A';

        if (orderItem.itemId && orderItem.itemId._id) { // If itemId is a populated object
            itemIdToUpdate = orderItem.itemId._id;
            itemNameToLog = orderItem.itemId.name;
            itemSkuToLog = orderItem.itemId.sku;
        } else if (mongoose.Types.ObjectId.isValid(orderItem.itemId)) { // If itemId is just an ID
            itemIdToUpdate = orderItem.itemId;
            // Fetch item details for logging and potentially for the pre-check inside transaction
            const tempItem = await Item.findById(itemIdToUpdate).select('name sku').lean().session(session); // Use session if fetching inside transaction
            if(tempItem) {
                itemNameToLog = tempItem.name;
                itemSkuToLog = tempItem.sku;
            }
        } else {
            throw new Error(`Invalid item data in order for stock adjustment. Item ID: ${orderItem.itemId}`);
        }

        const quantityToAdjust = orderItem.quantity;
        let stockChange;

        if (operation === 'deduct') {
            stockChange = -quantityToAdjust;
            // Check current stock *within the transaction* just before update for maximum safety
            const currentItemInDB = await Item.findOne({ _id: itemIdToUpdate, warehouseId: warehouseId }).session(session);
            if (!currentItemInDB) {
                 throw new Error(`Item ${itemNameToLog} (SKU: ${itemSkuToLog}, ID: ${itemIdToUpdate}) not found in warehouse ${warehouseId} for stock deduction.`);
            }
            if (currentItemInDB.quantity < quantityToAdjust) {
                throw new Error(`Insufficient stock for item ${itemNameToLog} (SKU: ${itemSkuToLog}) during final deduction. Available: ${currentItemInDB.quantity}, Needed: ${quantityToAdjust}.`);
            }
        } else if (operation === 'restore') {
            stockChange = +quantityToAdjust;
        } else {
            throw new Error("Invalid stock operation type specified.");
        }

        console.log(`[StockHelper] Preparing to adjust stock for Item ${itemIdToUpdate} (SKU: ${itemSkuToLog}) in Warehouse ${warehouseId} by ${stockChange}`);
        stockUpdates.push(
            Item.updateOne(
                { _id: itemIdToUpdate, warehouseId: warehouseId },
                { $inc: { quantity: stockChange }, $set: { lastUpdated: new Date() } },
                { session } // Pass session here
            )
        );
    }
    await Promise.all(stockUpdates); // Execute all updates
    console.log(`[StockHelper] Stock adjustments (${operation}) successful for order items.`);
}


// PUT /orders/:id/status - Update Order Status (WITH TRANSACTION)
router.put('/:id/status', ensureCanManageOrder, async (req, res) => {
    const orderId = req.params.id;
    const { newStatus } = req.body;
    const loggedInUser = res.locals.loggedInUser;
    console.log(`--- User ${loggedInUser._id} attempting status update for order ${orderId} to '${newStatus}' ---`);

    if (!Order.schema.path('orderStatus').enumValues.includes(newStatus)) {
        return res.redirect(`/orders/${orderId}?error=Invalid+status+value`);
    }

    const session = await mongoose.startSession(); // Start session

    try {
        await session.withTransaction(async () => { // Start transaction
            const order = await Order.findById(orderId)
                .populate({ path: 'orderItems.itemId', model: 'Item', select: 'name sku quantity' }) // Select fields needed by stock helper
                .populate('warehouseId', '_id name')
                .session(session); // Use session

            if (!order) throw new Error("Order not found.");
            if (!order.warehouseId?._id) throw new Error("Order is missing warehouse information for stock operations.");

            const currentStatus = order.orderStatus;
            const warehouseIdForStock = order.warehouseId._id;
            console.log(`Current status: ${currentStatus}, Target status: ${newStatus}, Warehouse: ${warehouseIdForStock}`);

            const validTransitions = {
                pending: ['confirmed', 'cancelled'],
                confirmed: ['shipped', 'cancelled'],
                shipped: ['delivered', 'cancelled'], // Allow cancelling shipped? Or a 'return' process?
                delivered: [], // No transitions out of delivered for now
                cancelled: []  // No transitions out of cancelled
            };
            if (!validTransitions[currentStatus] || !validTransitions[currentStatus].includes(newStatus)) {
                throw new Error(`Invalid status transition from '${currentStatus}' to '${newStatus}'.`);
            }

            // --- Stock Check & Adjustments ---
            if (newStatus === 'shipped' && currentStatus === 'confirmed') {
                console.log("Preparing stock deduction for order:", orderId);
                await updateStockForOrderItems(order.orderItems, warehouseIdForStock, 'deduct', session);
            } else if (newStatus === 'cancelled' && ['confirmed', 'shipped'].includes(currentStatus)) {
                // Only restore stock if it was confirmed (potentially allocated) or shipped (deducted)
                console.log("Preparing stock restoration for cancelled order:", orderId);
                await updateStockForOrderItems(order.orderItems, warehouseIdForStock, 'restore', session);
            }

            order.orderStatus = newStatus;
            order.updatedDate = new Date();
            order.lastUpdatedBy = loggedInUser._id;
            await order.save({ session }); // Save order update within transaction
        }); // Transaction commits here if all successful

        console.log(`Order ${orderId} status updated to '${newStatus}' successfully.`);
        res.redirect(`/orders/${orderId}?success=Order+status+updated+to+${newStatus}`);

    } catch (err) {
        console.error(`Error updating order ${orderId} status (transaction may have aborted):`, err);
        res.redirect(`/orders/${orderId}?error=${encodeURIComponent(`Status update failed: ${err.message}`)}`);
    } finally {
        await session.endSession(); // Always end the session
    }
});

// Helper to convert number to words (Indian numbering system) - Basic version
function numberToWordsINR(num) {
    // This is a placeholder - use a robust library for production
    if (num === null || num === undefined) return 'N/A';
    const a = ['','one ','two ','three ','four ', 'five ','six ','seven ','eight ','nine ','ten ','eleven ','twelve ','thirteen ','fourteen ','fifteen ','sixteen ','seventeen ','eighteen ','nineteen '];
    const b = ['', '', 'twenty','thirty','forty','fifty', 'sixty','seventy','eighty','ninety'];
    const convert = function (n) {
        if (n < 20) return a[n];
        let digit = n%10;
        if (n < 100) return b[Math.floor(n/100)%10] + (digit!=0 ? ' ' : '') + a[digit]; // Incorrect logic here
        // Corrected and simplified - needs full library for proper conversion
        return num.toString(); // Fallback to digits
    };
    // This is a VERY basic placeholder. Use a proper library for full conversion
    const numStr = num.toFixed(0); // Get integer part
    // More complex logic needed for lakhs, crores etc.
    // For now, let's use a simple placeholder
    return `RUPEES ${numStr} ONLY`; // Replace with actual word conversion
}


// GET /orders/:id/invoice/pdf - Generate PDF invoice
router.get('/:id/invoice/pdf', ensureAuthenticated, async (req, res) => { // ensureCanManageOrder could also be applied here
    try {
        const orderId = req.params.id;
        if (!mongoose.Types.ObjectId.isValid(orderId)) {
            return res.status(400).send("Invalid Order ID");
        }
        console.log(`Generating invoice for order: ${orderId}`);

        // Fetch all necessary populated data
        const order = await Order.findById(orderId)
            .populate({ path: 'storeId', model: 'Store', select: 'storeName address gstin stateCode phone companyId' }) // Get necessary store fields
            .populate({
                path: 'warehouseId',
                model: 'Warehouse',
                select: 'name address companyId', // Get necessary warehouse fields
                populate: { path: 'companyId', model: 'Company' } // Populate seller company details from warehouse
            })
            .populate({
                path: 'orderItems.itemId',
                model: 'Item',
                select: 'name sku hsnCode uom gstRate' // Get necessary item fields
            })
            .populate('createdBy', 'username') // For Salesman name if needed
            .lean();

        if (!order) {
            return res.status(404).send("Order not found");
        }

        // Seller details from the company associated with the order's warehouse
        const sellerCompany = order.warehouseId?.companyId;
        if (!sellerCompany) {
            return res.status(500).send("Seller company details not found for this order's warehouse.");
        }

        // Receiver (Billed to / Shipped to) details from the order's store
        const receiverStore = order.storeId;
        if (!receiverStore) {
             return res.status(500).send("Receiver (Store) details not found for this order.");
        }
        // You might need to populate company details of the receiver store if it's different from seller
        // For now, assuming receiverStore has all needed fields like gstin, address, etc.

        // GST Calculation Logic (keep as is from response #65 or refine)
        let totalTaxableValue = 0;
        let totalGSTAmount = 0;
        const gstSummary = {}; // e.g., { "18": { taxable: 1000, gst: 180 }}
        order.orderItems.forEach(entry => {
            const item = entry.itemId;
            if (!item) { console.warn(`Skipping item in invoice due to missing details: ${entry.itemId}`); return; }
            const taxableValue = entry.quantity * entry.priceAtOrder;
            const gstRate = item.gstRate || 0;
            const gstAmount = (taxableValue * gstRate) / 100;
            totalTaxableValue += taxableValue;
            totalGSTAmount += gstAmount;
            if (gstRate > 0) {
                if (!gstSummary[gstRate]) gstSummary[gstRate] = { taxable: 0, gst: 0 };
                gstSummary[gstRate].taxable += taxableValue;
                gstSummary[gstRate].gst += gstAmount;
            }
        });
        // Use order.totalAmount if it's guaranteed to be the final correct amount including tax
        // Or use the calculated grandTotal. Ensure consistency.
        const grandTotalForInvoice = order.totalAmount; // Or: totalTaxableValue + totalGSTAmount;

        const invoiceData = {
            order: {
                ...order,
                invoiceNumber: `INV-${order._id.toString().slice(-6).toUpperCase()}`,
                salesmanName: order.createdBy?.username,
                grandTotal: grandTotalForInvoice, // Pass the confirmed grand total
                amountInWords: numberToWordsINR(grandTotalForInvoice)
            },
            seller: sellerCompany, // Full populated Company object
            receiver: receiverStore, // Full populated Store object
            consignee: receiverStore, // Assuming consignee is same as receiver
            gstSummary: gstSummary,
            currentDate: new Date()
        };

        const templatePath = path.join(__dirname, '../views/invoices/invoice_template.ejs');
        console.log("Rendering EJS template from:", templatePath);
        const htmlContent = await ejs.renderFile(templatePath, invoiceData);
        console.log("EJS template rendered to HTML successfully.");

        const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
        const page = await browser.newPage();
        console.log("Puppeteer page created. Setting content...");
        await page.setContent(htmlContent, { waitUntil: 'networkidle0' }); // Wait for all resources
        console.log("HTML content set. Generating PDF...");
        const pdfBuffer = await page.pdf({
            format: 'A4',
            printBackground: true,
            margin: { top: '20mm', right: '12mm', bottom: '20mm', left: '12mm' } // Adjusted margins slightly
        });
        await browser.close();
        console.log("PDF generated and browser closed.");

        res.set({
            'Content-Type': 'application/pdf',
            'Content-Length': pdfBuffer.length,
            'Content-Disposition': `inline; filename=invoice-${order._id}.pdf` // Use 'inline' to display in browser
        });
        res.send(pdfBuffer);

    } catch (err) {
        console.error("Error generating PDF invoice:", err);
        res.status(500).send(`Error generating invoice: ${err.message}`);
    }
});


// --- TODO: Add route for updating status (PUT /orders/:id/status) ---

module.exports = router;