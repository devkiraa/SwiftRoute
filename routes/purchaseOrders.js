// routes/purchaseOrders.js
const express = require('express');
const mongoose = require('mongoose');
const PurchaseOrder = require('../models/PurchaseOrder');
const Supplier = require('../models/Supplier');
const Warehouse = require('../models/Warehouse');
const Item = require('../models/Item'); 
const User = require('../models/User');

const router = express.Router();

// --- Middleware ---
function ensureAuthenticated(req, res, next) {
    if (res.locals.loggedInUser) return next();
    res.redirect('/login');
}
// Only Admins or Warehouse Owners can manage stores
async function ensureAdminOrOwner(req, res, next) {
    const loggedInUser = res.locals.loggedInUser;
    if (!loggedInUser) return res.status(401).send("Authentication required.");

    if (loggedInUser.role === 'admin') return next(); 

    if (loggedInUser.role === 'warehouse_owner') {
        if (!loggedInUser.companyId) {
             return res.status(403).render('error_page', { title: "Access Denied", message: "You are not associated with a company.", layout: './layouts/dashboard_layout' });
        }
        // Further checks in specific routes to ensure store belongs to user's company
        return next();
    }
    res.status(403).render('error_page', { title: "Access Denied", message: "You do not have permission to manage stores.", layout: './layouts/dashboard_layout' });
}
router.use(ensureAuthenticated, ensureAdminOrOwner);

// GET /purchase-orders - List POs
router.get('/', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        let query = {};
        if (loggedInUser.role === 'warehouse_owner') {
            query.companyId = loggedInUser.companyId._id || loggedInUser.companyId;
        }
        const purchaseOrders = await PurchaseOrder.find(query)
            .populate('supplierId', 'supplierName')
            .populate('warehouseId', 'name')
            .sort({ orderDate: -1, poNumber: -1 })
            .lean();
        
        res.render('purchase-orders/index', {
            title: 'Purchase Orders', purchaseOrders,
            success_msg: req.query.success, error_msg: req.query.error,
            layout: './layouts/dashboard_layout'
        });
    } catch (err) {
        console.error("Error fetching purchase orders:", err);
        res.status(500).render('error_page', { title: "Error", message: "Failed to load purchase orders.", layout: './layouts/dashboard_layout' });
    }
});

// GET /purchase-orders/new - Show form to create a new PO
router.get('/new', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        const companyId = loggedInUser.companyId?._id || loggedInUser.companyId;
        if (!companyId && loggedInUser.role !== 'admin') { // Admins might select company later
             throw new Error("User must be associated with a company.");
        }
        const companyQuery = loggedInUser.role === 'admin' ? {} : { companyId: companyId };
        
        // Fetch data needed for dropdowns, scoped by company
        const [suppliers, warehouses, items] = await Promise.all([
            Supplier.find(companyQuery).select('supplierName _id').sort({supplierName: 1}).lean(),
            Warehouse.find(companyQuery).select('name _id').sort({name: 1}).lean(),
            // Fetch items potentially across all company warehouses, or filter later based on selected warehouse?
            // Let's get all company items for now, user selects warehouse first.
            Item.find(companyQuery).select('name sku unitCost _id warehouseId').populate('warehouseId', 'name').sort({name: 1}).lean() 
        ]);

        res.render('purchase-orders/form', {
            title: 'Create Purchase Order',
            po: {}, formData: {}, isEditing: false,
            suppliers, warehouses, items, // Pass data for dropdowns
            layout: './layouts/dashboard_layout'
        });
    } catch (err) {
        console.error("Error loading new PO form:", err);
         res.status(500).render('error_page', { title: "Error", message: `Failed to load form: ${err.message}`, layout: './layouts/dashboard_layout' });
    }
});

// POST /purchase-orders - Create a new PO
router.post('/', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    const companyId = loggedInUser.companyId?._id || loggedInUser.companyId;
    const { warehouseId, supplierId, expectedDeliveryDate, notes, itemIds, orderedQuantities, unitCosts } = req.body;

    // Basic validation
    if (!warehouseId || !supplierId || !itemIds || !orderedQuantities || !unitCosts) {
         // Re-render form with error - need to re-fetch suppliers, warehouses, items
         // Simplified error handling for now:
         return res.redirect('/purchase-orders/new?error=Missing+required+fields.'); 
    }

    try {
        const validItemIds = Array.isArray(itemIds) ? itemIds.filter(id => id && mongoose.Types.ObjectId.isValid(id)) : [itemIds].filter(id => id && mongoose.Types.ObjectId.isValid(id));
        const validQuantities = Array.isArray(orderedQuantities) ? orderedQuantities.map(q => parseInt(q, 10)).filter((q, i) => itemIds[i] && q > 0) : [parseInt(orderedQuantities, 10)].filter(q => itemIds[0] && q > 0);
        const validUnitCosts = Array.isArray(unitCosts) ? unitCosts.map(c => parseFloat(c)).filter((c, i) => itemIds[i] && c >= 0) : [parseFloat(unitCosts)].filter(c => itemIds[0] && c >= 0);

        if (validItemIds.length === 0 || validItemIds.length !== validQuantities.length || validItemIds.length !== validUnitCosts.length) {
             throw new Error("Invalid item data: Ensure each item has a valid quantity and unit cost.");
        }

        const poItems = validItemIds.map((id, index) => ({
            itemId: id,
            orderedQuantity: validQuantities[index],
            receivedQuantity: 0, // Starts at 0
            unitCost: validUnitCosts[index]
        }));

        const newPO = new PurchaseOrder({
            companyId,
            warehouseId,
            supplierId,
            orderDate: new Date(),
            expectedDeliveryDate: expectedDeliveryDate || undefined,
            status: 'ordered', // Set initial status
            items: poItems,
            notes,
            createdBy: loggedInUser._id
            // totalValue will be calculated by pre-save hook
        });

        await newPO.save(); // This will trigger pre-save hook and auto-increment
        console.log(`Purchase Order ${newPO.poNumber} created.`);
        res.redirect('/purchase-orders?success=Purchase+Order+created+successfully');

    } catch (err) {
        console.error("Error creating purchase order:", err);
        // Re-render form with error - need to re-fetch suppliers, warehouses, items
         try {
             const companyQuery = loggedInUser.role === 'admin' ? {} : { companyId: companyId };
             const [suppliers, warehouses, items] = await Promise.all([ /* ... re-fetch dropdown data ... */ ]);
             res.status(400).render('purchase-orders/form', {
                 title: 'Create Purchase Order', po: {}, formData: req.body, isEditing: false,
                 suppliers, warehouses, items, 
                 error: `Failed to create PO: ${err.message}`, 
                 layout: './layouts/dashboard_layout'
             });
         } catch(renderErr) {
              res.redirect('/purchase-orders/new?error=Failed+to+create+PO,+error+loading+form.');
         }
    }
});

// --- NEW STOCK RECEIVING ROUTES ---

// GET /purchase-orders/:id/receive - Show form to receive stock
router.get('/:id/receive', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        const poId = req.params.id;
        if (!mongoose.Types.ObjectId.isValid(poId)) throw new Error("Invalid Purchase Order ID");

        const po = await PurchaseOrder.findById(poId)
            .populate('supplierId', 'supplierName')
            .populate('warehouseId', 'name address')
            .populate({ path: 'items.itemId', model: 'Item', select: 'name sku quantity' }) // Populate item details within items array
            .lean(); // Use lean for rendering

        if (!po) throw new Error("Purchase Order not found.");

        // Authorization Check (Example: Ensure PO belongs to user's company if not admin)
        if (loggedInUser.role === 'warehouse_owner' && po.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
             throw new Error("Access Denied: PO does not belong to your company.");
        }

        // Check if PO status allows receiving
        if (!['ordered', 'partially_received'].includes(po.status)) {
            return res.redirect(`/purchase-orders/${poId}?error=Cannot+receive+stock+for+PO+with+status+'${po.status}'.`);
        }

        res.render('purchase-orders/receive_form', {
            title: `Receive Stock for PO #${po.poNumber}`,
            po: po,
            formData: {}, // Empty formData for initial load
            layout: './layouts/dashboard_layout'
        });

    } catch (err) {
        console.error("Error loading receive stock form:", err);
        res.redirect(`/purchase-orders?error=${encodeURIComponent(err.message)}`);
    }
});

// POST /purchase-orders/:id/receive - Process received stock
router.post('/:id/receive', async (req, res) => {
    const poId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;
    // Data comes as arrays: itemIds[index], receivedNowQuantities[index]
    const { itemIds, receivedNowQuantities, notes } = req.body;
    console.log("Received Stock Data:", req.body);

    const session = await mongoose.startSession();
    let poDataForForm = null; // To hold data for re-rendering on error

    try {
        await session.withTransaction(async () => {
            const po = await PurchaseOrder.findById(poId).session(session); // Need full document to save
            if (!po) throw new Error("Purchase Order not found.");
            
            // Authorization Check
             if (loggedInUser.role === 'warehouse_owner' && po.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
                 throw new Error("Access Denied.");
             }

            // Check status
            if (!['ordered', 'partially_received'].includes(po.status)) {
                 throw new Error(`Cannot receive stock for PO with status: ${po.status}`);
            }
            
            const warehouseIdForStockUpdate = po.warehouseId; // Get warehouse ID from PO
            const stockUpdatePromises = []; // Promises for Item.updateOne

            // Process received items
            let totalItemsReceivedInThisSubmission = 0;
            for (let i = 0; i < itemIds.length; i++) {
                const itemId = itemIds[i];
                const receivedNowQty = parseInt(receivedNowQuantities[i] || '0', 10);

                if (!mongoose.Types.ObjectId.isValid(itemId) || isNaN(receivedNowQty)) {
                    console.warn(`Skipping invalid item data at index ${i}: ID ${itemId}, Qty ${receivedNowQuantities[i]}`);
                    continue; // Skip invalid entries silently or throw? Maybe throw.
                    // throw new Error(`Invalid item data submitted at index ${i}.`);
                }
                
                if (receivedNowQty < 0) {
                     throw new Error(`Received quantity cannot be negative for item ${itemId}.`);
                }
                if (receivedNowQty === 0) {
                    continue; // Skip if 0 quantity received for this item
                }

                // Find the specific item within the PO's items array
                const poItem = po.items.find(item => item.itemId.toString() === itemId);
                if (!poItem) {
                    throw new Error(`Item ${itemId} not found on this Purchase Order.`);
                }

                const remainingQty = poItem.orderedQuantity - poItem.receivedQuantity;
                if (receivedNowQty > remainingQty) {
                     throw new Error(`Received quantity (${receivedNowQty}) for item ${itemId} exceeds remaining quantity (${remainingQty}).`);
                }

                // Update PO Item's receivedQuantity
                poItem.receivedQuantity += receivedNowQty;
                totalItemsReceivedInThisSubmission += receivedNowQty;

                // Prepare stock update promise
                console.log(`Increasing stock for item ${itemId} in warehouse ${warehouseIdForStockUpdate} by ${receivedNowQty}`);
                stockUpdatePromises.push(
                    Item.updateOne(
                        { _id: itemId, warehouseId: warehouseIdForStockUpdate },
                        { $inc: { quantity: receivedNowQty }, $set: { lastUpdated: new Date() } },
                        { session }
                    )
                );
            }

            if (totalItemsReceivedInThisSubmission === 0) {
                throw new Error("No quantities were entered to receive.");
            }
            
            // Execute all stock updates
            await Promise.all(stockUpdatePromises);
            console.log("Item stock levels updated.");

            // Update PO status and details
            po.updateStatusBasedOnReceived(); // Use method defined in model
            po.notes = notes?.trim() ? `${po.notes || ''}\nReceived on ${new Date().toLocaleDateString()}: ${notes.trim()}` : po.notes;
            po.lastUpdated = new Date();
            po.lastUpdatedBy = loggedInUser._id; // Track who received it
            
            await po.save({ session });
            console.log(`Purchase Order ${poId} status updated to ${po.status}.`);

        }); // Transaction commits

        res.redirect(`/purchase-orders/${poId}?success=Stock+received+successfully`);

    } catch (err) {
        console.error(`Error receiving stock for PO ${poId}:`, err);
        // Re-render form with error message and previously submitted data
        try {
            poDataForForm = await PurchaseOrder.findById(poId)
                .populate('supplierId', 'supplierName')
                .populate('warehouseId', 'name address')
                .populate({ path: 'items.itemId', model: 'Item', select: 'name sku quantity' })
                .lean();
        } catch(fetchErr) { console.error("Error fetching PO data for error re-render:", fetchErr); }
        
        res.status(400).render('purchase-orders/receive_form', {
            title: `Receive Stock for PO #${poDataForForm?.poNumber || poId.slice(-6)}`,
            po: poDataForForm || { _id: poId, items: [] }, // Pass PO data back
            formData: req.body, // Pass submitted data with error
            error: `Failed to receive stock: ${err.message}`,
            layout: './layouts/dashboard_layout'
        });
    } finally {
        await session.endSession();
    }
});

// --- NEW ROUTE: View PO Details ---
router.get('/:id', async (req, res) => {
    const poId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;
    console.log(`--- Accessing GET /purchase-orders/${poId} ---`);

    if (!mongoose.Types.ObjectId.isValid(poId)) {
        return res.status(400).render('error_page', { title: "Invalid ID", message: "Purchase Order ID format is invalid.", layout: './layouts/dashboard_layout' });
    }

    try {
        const po = await PurchaseOrder.findById(poId)
            .populate('supplierId', 'supplierName contactPerson email phone')
            .populate('warehouseId', 'name address')
            .populate({ 
                path: 'items.itemId', 
                model: 'Item', 
                select: 'name sku' // Select fields needed for display
            })
            .populate('createdBy', 'username') // Show who created it
            .lean(); // Use lean for rendering

        if (!po) {
             return res.status(404).render('error_page', { title: "Not Found", message: "Purchase Order not found.", layout: './layouts/dashboard_layout' });
        }

        // Authorization: Ensure user's company matches the PO's company
        if (loggedInUser.role === 'warehouse_owner' && po.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
            return res.status(403).render('error_page', { title: "Access Denied", message: "You do not have permission to view this Purchase Order.", layout: './layouts/dashboard_layout' });
        }
        
        // Calculate line totals and check if fully received for display logic
        let isFullyReceived = true;
        po.items.forEach(item => {
            item.lineTotal = item.orderedQuantity * item.unitCost;
            if (item.receivedQuantity < item.orderedQuantity) {
                isFullyReceived = false;
            }
        });

        res.render('purchase-orders/details', {
            title: `Purchase Order PO-${po.poNumber}`,
            po: po,
            isFullyReceived: isFullyReceived, // Pass flag to view
            success_msg: req.query.success, // Show success message from redirect
            error_msg: req.query.error,     // Show error message from redirect (if any)
            layout: './layouts/dashboard_layout'
        });

    } catch (err) {
        console.error(`Error fetching PO details for ID ${poId}:`, err);
        res.status(500).render('error_page', { title: "Server Error", message: `Failed to load Purchase Order details: ${err.message}`, layout: './layouts/dashboard_layout' });
    }
});

// TODO:
// GET /purchase-orders/:id - View PO Details
// GET /purchase-orders/:id/edit - Edit PO (potentially limited fields/statuses)
// PUT /purchase-orders/:id - Update PO
// GET /purchase-orders/:id/receive - Show Receive Stock form
// POST /purchase-orders/:id/receive - Process Received Stock

module.exports = router;