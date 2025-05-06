// routes/items.js
const express = require('express');
const Item = require('../models/Item');         // Adjust path if needed
const Warehouse = require('../models/Warehouse'); // To select warehouse
const User = require('../models/User');         // For role checks
const { default: mongoose } = require('mongoose');

const router = express.Router();

const UOM_ENUM = ['pcs', 'kg', 'g', 'ltr', 'ml', 'box', 'pack', 'set', 'mtr', 'other'];

// --- Local Auth Middleware for this Router ---
function ensureAuthenticated(req, res, next) {
    if (res.locals.loggedInUser) return next();
    res.redirect('/login');
}

function ensureAdminOrOwner(req, res, next) {
    const loggedInUser = res.locals.loggedInUser;
    if (loggedInUser && ['warehouse_owner', 'admin'].includes(loggedInUser.role)) {
        if (loggedInUser.role === 'warehouse_owner' && !loggedInUser.companyId) {
             return res.status(400).send("User not associated with a company");
        }
        return next();
    }
    res.status(403).send("Access Denied: Admin or Warehouse Owner role required.");
}
// --- End Local Auth Middleware ---

// Apply auth checks to all item routes
router.use(ensureAuthenticated, ensureAdminOrOwner);

// GET /items - List all items with Search and Pagination
router.get('/', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        const page = parseInt(req.query.page) || 1; // Current page, default 1
        const limit = 10; // Items per page
        const skip = (page - 1) * limit;
        const searchTerm = req.query.search || ''; // Get search term

        let query = {};
        let warehouseQuery = {};

        // Scope warehouses to the company unless admin
        if (loggedInUser.role === 'warehouse_owner') {
            if (!loggedInUser.companyId) {
                // Handle case where warehouse_owner has no companyId (should not happen if data is consistent)
                return res.status(400).render('error_page', { title: "Error", message: "User not associated with a company.", layout: false });
            }
            warehouseQuery.companyId = loggedInUser.companyId._id || loggedInUser.companyId; // Handle populated or just ID
        } // Admin sees items from all warehouses initially

        const companyWarehouses = await Warehouse.find(warehouseQuery).select('_id').lean();
        const companyWarehouseIds = companyWarehouses.map(w => w._id);

        // Base query for items within the user's accessible warehouses
        query.warehouseId = { $in: companyWarehouseIds };

        // Add search functionality
        if (searchTerm) {
            const regex = new RegExp(searchTerm.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&'), 'i'); // Case-insensitive search
            query.$or = [
                { name: regex },
                { sku: regex },
                { description: regex } // Optional: search description too
            ];
        }

        // Fetch items with pagination
        const items = await Item.find(query)
            .populate('warehouseId', 'name')
            .sort({ name: 1 })
            .skip(skip)
            .limit(limit)
            .lean();

        // Get total count for pagination
        const totalItems = await Item.countDocuments(query);
        const totalPages = Math.ceil(totalItems / limit);

        res.render('items/index', {
            title: 'Inventory Items',
            items: items,
            currentPage: page,
            totalPages: totalPages,
            totalItems: totalItems,
            searchTerm: searchTerm, // Pass search term back to pre-fill input
            limit: limit,
            layout: './layouts/dashboard_layout'
        });
    } catch (err) {
        console.error("Error fetching items:", err);
        res.status(500).render('error_page', { title: "Error", message: "Failed to load inventory items.", layout: false });
    }
});


// GET /items/new - Show form
router.get('/new', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        let warehouseQuery = {};
        if (loggedInUser.role === 'warehouse_owner' && loggedInUser.companyId) { warehouseQuery.companyId = loggedInUser.companyId._id; }
        const availableWarehouses = await Warehouse.find(warehouseQuery, 'id name').lean();
        if (loggedInUser.role !== 'admin' && availableWarehouses.length === 0) { return res.redirect('/warehouses/new?message=Please add a warehouse first.'); }

        res.render('items/form', {
            title: 'Add New Item', item: {}, formData: {}, availableWarehouses, isEditing: false,
            uomOptions: UOM_ENUM, // Pass UOM options
            layout: './layouts/dashboard_layout'
        });
    } catch(err) { /* ... error handling ... */ }
});


// POST /items - Create a new item
router.post('/', async (req, res) => {
    let availableWarehouses = [];
    const loggedInUser = res.locals.loggedInUser;
    console.log("Received POST /items request body:", JSON.stringify(req.body));

    try {
        // Add new fields to destructuring
        const { name, quantity, unitPrice, sellingPrice, mrp, hsnCode, uom, description, perishable, expiryDate, warehouseId } = req.body;

        // Validation (add checks for new fields)
        if (!name || !quantity || unitPrice === undefined || sellingPrice === undefined || !warehouseId || !uom) {
            throw new Error("Name, Quantity, Unit Price, Selling Price, UOM, and Warehouse are required.");
        }
         if (!UOM_ENUM.includes(uom)) { throw new Error("Invalid Unit of Measure selected."); }
         const parsedMrp = mrp ? parseFloat(mrp) : null; // MRP is optional
         const parsedSellingPrice = parseFloat(sellingPrice);
         if (parsedMrp !== null && (isNaN(parsedMrp) || parsedMrp < 0)) { throw new Error("Invalid MRP provided."); }
         if (parsedMrp !== null && parsedSellingPrice > parsedMrp) { throw new Error("Selling Price cannot be greater than MRP."); }
        // ... (keep other validations) ...

        // Authorization & Get Company ID (Keep as is)
        const selectedWarehouse = await Warehouse.findById(warehouseId).lean();
        if (!selectedWarehouse) throw new Error("Selected warehouse not found.");
        let targetCompanyId; // ... determine targetCompanyId ...
        if (!targetCompanyId) throw new Error("Could not determine Company ID.");

        // Create Item Data (add new fields)
        const newItemData = {
            name: name.trim(), companyId: targetCompanyId, warehouseId,
            quantity: parseInt(quantity, 10), unitPrice: parseFloat(unitPrice), sellingPrice: parsedSellingPrice,
            mrp: parsedMrp, hsnCode: hsnCode?.trim() || null, uom, // Add new fields
            description: description?.trim() || '',
            perishable: perishable === 'on' || perishable === true,
            expiryDate: (perishable === 'on' || perishable === true) && expiryDate ? new Date(expiryDate) : null
        };
        console.log("Prepared newItemData:", newItemData);

        const newItem = new Item(newItemData);
        await newItem.save(); // Pre-save hook generates SKU
        console.log("Item created:", newItem.name, "SKU:", newItem.sku);
        res.redirect('/items');

    } catch (err) {
        console.error("Error creating item:", err);
        // Fetch warehouses again for form re-render
         try { /* ... fetch availableWarehouses ... */ } catch (fetchErr) { /* ... */ }
        res.status(400).render('items/form', {
            title: 'Add New Item', item: {}, formData: req.body, availableWarehouses, isEditing: false,
            uomOptions: UOM_ENUM, // Pass UOM options back on error
            error: `Failed to add item: ${err.message}`, layout: './layouts/dashboard_layout'
        });
    }
});

// GET /items/:id/edit - Show form to edit item
router.get('/:id/edit', async (req, res) => {
    // ... (Keep fetch and auth logic) ...
    try {
        const item = await Item.findById(req.params.id).lean();
        if (!item) throw new Error("Item not found.");
        // ... Auth check ...
        const availableWarehouses = await Warehouse.find({ companyId: item.companyId }).select('id name').lean();

         res.render('items/form', {
            title: 'Edit Item', item: item, isEditing: true,
            availableWarehouses,
            uomOptions: UOM_ENUM, // Pass UOM options
            formData: item, // Pass item data as formData too
            layout: './layouts/dashboard_layout'
         });
    } catch (err) {
        console.error(`Error loading edit form for item ${itemId}:`, err);
        res.status(500).render('error_page', { title: "Error", message: `Failed to load edit item form: ${err.message}`, layout: false });
    }
});

// DELETE /items/:id - Delete an item
router.delete('/:id', ensureAdminOrOwner, async (req, res) => {
    const itemId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;
    console.log(`--- User ${loggedInUser._id} attempting to DELETE item ${itemId} ---`);

    if (!mongoose.Types.ObjectId.isValid(itemId)) return res.status(400).send("Invalid Item ID");

    try {
        const itemToDelete = await Item.findById(itemId);
        if (!itemToDelete) throw new Error("Item not found.");

        // Authorization: Ensure item belongs to user's company (if not admin)
        if (loggedInUser.role === 'warehouse_owner' && itemToDelete.companyId?.toString() !== loggedInUser.companyId?._id?.toString()) {
             throw new Error("You do not have permission to delete this item.");
        }

        // TODO: Add check - Prevent deletion if item exists in non-delivered/non-cancelled orders?

        await Item.findByIdAndDelete(itemId);

        console.log(`Item ${itemId} deleted successfully.`);
        // Add flash message
        res.redirect('/items?success=Item+deleted+successfully');

    } catch (err) {
         console.error(`Error deleting item ${itemId}:`, err);
         res.redirect(`/items?error=${encodeURIComponent(err.message)}`);
    }
});

// PUT /items/:id - Update an item
router.put('/:id', async (req, res) => {
    const itemId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;
    // Add new fields to destructuring
    const { name, unitPrice, sellingPrice, mrp, hsnCode, uom, description, perishable, expiryDate } = req.body;
    // Excluded: quantity, sku, warehouseId, companyId

    if (!mongoose.Types.ObjectId.isValid(itemId)) { /* ... */ }
    let availableWarehouses = [];

    try {
        const itemToUpdate = await Item.findById(itemId);
        if (!itemToUpdate) throw new Error("Item not found.");
        // Authorization check (keep as is)

        // Validation (add checks for new fields)
        if (!name || unitPrice === undefined || sellingPrice === undefined || !uom) { throw new Error("Name, Unit Price, Selling Price, and UOM are required."); }
         if (!UOM_ENUM.includes(uom)) { throw new Error("Invalid Unit of Measure selected."); }
         const parsedMrp = mrp ? parseFloat(mrp) : null;
         const parsedUnitPrice = parseFloat(unitPrice);
         const parsedSellingPrice = parseFloat(sellingPrice);
         if (isNaN(parsedUnitPrice) || parsedUnitPrice < 0) { throw new Error("Invalid Unit Price."); }
         if (isNaN(parsedSellingPrice) || parsedSellingPrice < 0) { throw new Error("Invalid Selling Price."); }
         if (parsedMrp !== null && (isNaN(parsedMrp) || parsedMrp < 0)) { throw new Error("Invalid MRP."); }
         if (parsedMrp !== null && parsedSellingPrice > parsedMrp) { throw new Error("Selling Price cannot be greater than MRP."); }

        // Update fields
        itemToUpdate.name = name.trim();
        itemToUpdate.unitPrice = parsedUnitPrice;
        itemToUpdate.sellingPrice = parsedSellingPrice;
        itemToUpdate.mrp = parsedMrp; // Update MRP
        itemToUpdate.hsnCode = hsnCode?.trim() || null; // Update HSN
        itemToUpdate.uom = uom; // Update UOM
        itemToUpdate.description = description?.trim() || '';
        itemToUpdate.perishable = perishable === 'on' || perishable === true;
        itemToUpdate.expiryDate = itemToUpdate.perishable && expiryDate ? new Date(expiryDate) : null;
        itemToUpdate.lastUpdated = new Date();

        await itemToUpdate.save();
        console.log(`Item ${itemId} updated successfully.`);
        res.redirect('/items');

    } catch (err) {
         console.error(`Error updating item ${itemId}:`, err);
         // Fetch data needed to re-render edit form
         try {
            // Re-fetch potentially needed data if re-rendering
            const item = await Item.findById(itemId).lean(); // Get potentially updated data
            const companyIdForLookup = loggedInUser.role === 'admin' ? item?.companyId : loggedInUser.companyId?._id;
            if (companyIdForLookup) {
                 availableWarehouses = await Warehouse.find({ companyId: companyIdForLookup }).select('id name').lean();
            }
            res.status(400).render('items/form', {
                title: 'Edit Item',
                item: req.body, // Pass attempted data back via 'item' (or use formData)
                isEditing: true,
                availableWarehouses: availableWarehouses,
                error: `Failed to update item: ${err.message}`, // Show specific error
                layout: './layouts/dashboard_layout'
            });
         } catch (renderErr) {
            console.error("Error re-rendering item edit form:", renderErr);
            res.status(500).render('error_page', { title: "Error", message: "Failed to update item and could not reload form.", layout: false });
         }
    }
});


// --- Add routes for viewing details, editing, updating stock, deleting later ---
// GET /items/:id
// GET /items/:id/edit
// PUT /items/:id (or POST with method override)
// POST /items/:id/adjust (for stock adjustments)
// DELETE /items/:id (or POST with method override)


module.exports = router;