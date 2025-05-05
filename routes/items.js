// routes/items.js
const express = require('express');
const Item = require('../models/Item');         // Adjust path if needed
const Warehouse = require('../models/Warehouse'); // To select warehouse
const User = require('../models/User');         // For role checks
const { default: mongoose } = require('mongoose');

const router = express.Router();

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

// GET /items - List all items for the company's warehouses
router.get('/', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        let warehouseQuery = {};
        // Scope warehouses to the company unless admin
        if (loggedInUser.role === 'warehouse_owner') {
            warehouseQuery.companyId = loggedInUser.companyId;
        } // Admin sees items from all warehouses (or add company filter later)

        // Find warehouses first to filter items
        const companyWarehouses = await Warehouse.find(warehouseQuery).select('_id').lean();
        const companyWarehouseIds = companyWarehouses.map(w => w._id);

        // Fetch items belonging to those warehouses, populating warehouse name
        const items = await Item.find({ warehouseId: { $in: companyWarehouseIds } })
            .populate('warehouseId', 'name') // Populate warehouse name
            .sort({ name: 1 }) // Sort alphabetically by item name
            .lean();

        res.render('items/index', { // Render views/items/index.ejs
            title: 'Inventory Items',
            items: items,
            layout: './layouts/dashboard_layout'
        });
    } catch (err) {
        console.error("Error fetching items:", err);
        res.status(500).render('error_page', { title: "Error", message: "Failed to load inventory items.", layout: false });
    }
});

// GET /items/new - Show form to add a new item
router.get('/new', async (req, res) => {
    try {
         const loggedInUser = res.locals.loggedInUser;
         let warehouseQuery = {};
         if (loggedInUser.role === 'warehouse_owner' && loggedInUser.companyId) {
            warehouseQuery.companyId = loggedInUser.companyId._id; // Use ._id
         } // Admins see all warehouses

         const availableWarehouses = await Warehouse.find(warehouseQuery, 'id name').lean();

         if (loggedInUser.role !== 'admin' && availableWarehouses.length === 0) {
             return res.redirect('/warehouses/new?message=Please add a warehouse first.');
         }

         res.render('items/form', {
            title: 'Add New Item',
            item: {}, // Represents the item being added/edited
            formData: {}, // <-- ADD EMPTY formData OBJECT HERE for initial load
            availableWarehouses: availableWarehouses,
            isEditing: false, // Explicitly set for clarity
            layout: './layouts/dashboard_layout'
         });
    } catch(err) { /* ... error handling ... */ }
});


// POST /items - Create a new item
router.post('/', async (req, res) => {
    let availableWarehouses = [];
    const loggedInUser = res.locals.loggedInUser;
    console.log("Received POST /items request body:", JSON.stringify(req.body)); // Log received data

    try {
        const { name, quantity, unitPrice, sellingPrice, description, perishable, expiryDate, warehouseId } = req.body;

        // --- Validation ---
        if (!name || !quantity || unitPrice === undefined || sellingPrice === undefined || !warehouseId) { // Check price existence too
            throw new Error("Name, Quantity, Unit Price, Selling Price, and Warehouse are required.");
        }
        if (!mongoose.Types.ObjectId.isValid(warehouseId)) { throw new Error("Invalid Warehouse selected."); }
        if (isNaN(parseInt(quantity)) || parseInt(quantity) < 0) { throw new Error("Invalid Quantity provided."); }
        if (isNaN(parseFloat(unitPrice)) || parseFloat(unitPrice) < 0) { throw new Error("Invalid Unit Price provided."); }
        if (isNaN(parseFloat(sellingPrice)) || parseFloat(sellingPrice) < 0) { throw new Error("Invalid Selling Price provided."); }

        // --- Authorization & Get Company ID ---
        const selectedWarehouse = await Warehouse.findById(warehouseId).lean();
        if (!selectedWarehouse) throw new Error("Selected warehouse not found.");

        let targetCompanyId;
        if (loggedInUser.role === 'admin') {
            targetCompanyId = selectedWarehouse.companyId;
        } else { // Warehouse owner
            if (selectedWarehouse.companyId?.toString() !== loggedInUser.companyId?._id?.toString()) {
                 throw new Error("Selected warehouse does not belong to your company.");
             }
            targetCompanyId = loggedInUser.companyId._id;
        }
        if (!targetCompanyId) throw new Error("Could not determine Company ID for the item.");


        // --- *** RESTORED newItemData DEFINITION *** ---
        const newItemData = {
            name: name.trim(), // Trim whitespace
            companyId: targetCompanyId,
            warehouseId: warehouseId,
            quantity: parseInt(quantity, 10),
            unitPrice: parseFloat(unitPrice),
            sellingPrice: parseFloat(sellingPrice),
            description: description?.trim() || '', // Handle potentially undefined description
            perishable: perishable === 'on' || perishable === true,
            expiryDate: (perishable === 'on' || perishable === true) && expiryDate ? new Date(expiryDate) : null
            // SKU is generated by pre-save hook, DO NOT set it here
        };
        console.log("Prepared newItemData:", newItemData);
        // --- *** END OF RESTORED BLOCK *** ---

        const newItem = new Item(newItemData);
        console.log("Attempting to save new item...");
        await newItem.save(); // Pre-save hook generates unique SKU within company
        console.log("Item created successfully:", newItem.name, "SKU:", newItem.sku);

        // TODO: Consider flash message for success
        res.redirect('/items');

    } catch (err) {
        console.error("Error creating item:", err);
        // Fetch warehouses again for form re-render
         try {
            let warehouseQuery = {};
             if (loggedInUser?.role === 'warehouse_owner' && loggedInUser?.companyId?._id) {
                 warehouseQuery.companyId = loggedInUser.companyId._id;
             } // Admin might need different logic or fetch all if they add items
             availableWarehouses = await Warehouse.find(warehouseQuery, 'id name').lean();
         } catch (fetchErr) { console.error("Error refetching warehouses for error re-render:", fetchErr); }

        res.status(400).render('items/form', {
            title: 'Add New Item',
            item: {}, // Still 'add' mode
            formData: req.body, // Pass back submitted data
            availableWarehouses,
            isEditing: false,
            error: `Failed to add item: ${err.message}`, // Display specific error
            layout: './layouts/dashboard_layout'
            // No API key needed
        });
    }
});

// GET /items/:id/edit - Show form to edit item
router.get('/:id/edit', ensureAdminOrOwner, async (req, res) => { // ensureAdminOrOwner restricts access
    const itemId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;
    if (!mongoose.Types.ObjectId.isValid(itemId)) return res.status(400).send("Invalid Item ID");

    try {
        const itemToEdit = await Item.findById(itemId).lean(); // Use itemToEdit consistently
        if (!itemToEdit) throw new Error("Item not found.");

        // Authorization: Ensure item belongs to user's company (if not admin)
        if (loggedInUser.role === 'warehouse_owner') {
            if (!itemToEdit.companyId) { throw new Error("Item is missing company information."); } // Safety check
            if (itemToEdit.companyId.toString() !== loggedInUser.companyId?._id?.toString()) {
                throw new Error("You do not have permission to edit this item.");
            }
        }

        // Fetch warehouses for context (warehouse field is disabled, but good practice)
        const companyIdForLookup = loggedInUser.role === 'admin' ? itemToEdit.companyId : loggedInUser.companyId?._id;
        let availableWarehouses = [];
        if (companyIdForLookup) {
            availableWarehouses = await Warehouse.find({ companyId: companyIdForLookup }).select('id name').lean();
        }

         res.render('items/form', { // Render items/form.ejs
            title: 'Edit Item',
            item: itemToEdit, // Pass existing item data as 'item'
            isEditing: true, // Set flag for the view
            availableWarehouses: availableWarehouses,
            formData: itemToEdit, // Pre-fill formData too for consistency if desired
            // No need to pass allCompanies unless admin can change company here
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

// PUT /items/:id - Update an item (requires method-override)
router.put('/:id', ensureAdminOrOwner, async (req, res) => { // ensureAdminOrOwner restricts access
    const itemId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;
    // Get editable fields from body. Exclude quantity, sku, warehouseId, companyId.
    const { name, unitPrice, sellingPrice, description, perishable, expiryDate } = req.body;

    if (!mongoose.Types.ObjectId.isValid(itemId)) return res.status(400).send("Invalid Item ID");

    let availableWarehouses = []; // For re-rendering form on error

    try {
        // Fetch full Mongoose document to use validation and save()
        const itemToUpdate = await Item.findById(itemId);
        if (!itemToUpdate) throw new Error("Item not found.");

        // Authorization: Check again if user owns this item's company (if not admin)
        if (loggedInUser.role === 'warehouse_owner') {
            if (!itemToUpdate.companyId) { throw new Error("Item is missing company information."); }
            if (itemToUpdate.companyId.toString() !== loggedInUser.companyId?._id?.toString()) {
               throw new Error("You do not have permission to edit this item.");
           }
        }

        // Validation for submitted fields
        if (!name || unitPrice === undefined || sellingPrice === undefined) {
            throw new Error("Name, Unit Price, and Selling Price are required.");
        }
        const parsedUnitPrice = parseFloat(unitPrice);
        const parsedSellingPrice = parseFloat(sellingPrice);
        if (isNaN(parsedUnitPrice) || parsedUnitPrice < 0) { throw new Error("Invalid Unit Price."); }
        if (isNaN(parsedSellingPrice) || parsedSellingPrice < 0) { throw new Error("Invalid Selling Price."); }


        // Update fields (DO NOT update quantity here)
        itemToUpdate.name = name.trim();
        itemToUpdate.unitPrice = parsedUnitPrice;
        itemToUpdate.sellingPrice = parsedSellingPrice;
        itemToUpdate.description = description?.trim() || '';
        itemToUpdate.perishable = perishable === 'on' || perishable === true; // Handle checkbox
        // Only update expiryDate if perishable is checked AND a valid date was provided
        itemToUpdate.expiryDate = (itemToUpdate.perishable && expiryDate) ? new Date(expiryDate) : null;
        itemToUpdate.lastUpdated = new Date();

        // Pre-save hook will run again, but won't change SKU as item is not new

        await itemToUpdate.save(); // Validate and save changes
        console.log(`Item ${itemId} updated successfully.`);
        // TODO: Add flash message for success
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