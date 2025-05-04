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
         if (loggedInUser.role === 'warehouse_owner') {
            warehouseQuery.companyId = loggedInUser.companyId;
         } // Admins might need to filter warehouses differently or select company first

         // Fetch warehouses the user can add items to
         const availableWarehouses = await Warehouse.find(warehouseQuery, 'id name').lean();

         if (loggedInUser.role !== 'admin' && availableWarehouses.length === 0) {
             // Redirect or show message if no warehouses exist for the owner yet
             // Consider adding a flash message here
             console.warn(`User ${loggedInUser._id} tried to add item but has no warehouses.`);
             return res.redirect('/warehouses/new?message=Please add a warehouse first.'); // Redirect to add warehouse page
         }

         res.render('items/form', { // Render views/items/form.ejs
            title: 'Add New Item',
            item: {}, // Empty object for add form
            availableWarehouses: availableWarehouses, // Pass warehouses for dropdown
            layout: './layouts/dashboard_layout'
         });
    } catch (err) {
        console.error("Error loading new item form:", err);
        res.status(500).render('error_page', { title: "Error", message: "Failed to load new item form.", layout: false });
    }
});

// POST /items - Create a new item
router.post('/', async (req, res) => {
    let availableWarehouses = []; // Define outside try for use in catch
    const loggedInUser = res.locals.loggedInUser; // Available from global middleware

    try {
        const { name, sku, quantity, price, description, perishable, expiryDate, warehouseId } = req.body;

        // Validation
        if (!name || !sku || !quantity || !price || !warehouseId) {
            throw new Error("Name, SKU, Quantity, Price, and Warehouse are required.");
        }
        if (!mongoose.Types.ObjectId.isValid(warehouseId)) {
            throw new Error("Invalid Warehouse selected.");
        }

        // **Authorization**: Check if selected warehouse belongs to the user's company (if not admin)
         let targetCompanyId;
         if (loggedInUser.role === 'warehouse_owner') {
             const selectedWarehouse = await Warehouse.findOne({ _id: warehouseId, companyId: loggedInUser.companyId });
             if (!selectedWarehouse) {
                 throw new Error("Selected warehouse does not belong to your company.");
             }
             targetCompanyId = loggedInUser.companyId;
         } else if (loggedInUser.role === 'admin') {
             const selectedWarehouse = await Warehouse.findById(warehouseId).lean();
             if (!selectedWarehouse) throw new Error("Selected warehouse not found.");
             targetCompanyId = selectedWarehouse.companyId; // Associate item with warehouse's company
         } else {
              throw new Error("Unauthorized role for creating items.");
         }


        // **SKU Uniqueness**: Mongoose schema enforces global uniqueness.
        // For company-level uniqueness, schema/index needs modification.
        // Check manually for now if needed (less efficient):
        // const existingSku = await Item.findOne({ sku: sku, companyId: targetCompanyId }); // Needs companyId on Item model or complex lookup
        // if (existingSku) throw new Error(`SKU '${sku}' already exists.`);

        const newItemData = {
            name,
            sku,
            quantity: parseInt(quantity, 10) || 0,
            price: parseFloat(price) || 0,
            description,
            warehouseId,
            perishable: perishable === 'on' || perishable === true, // Handle checkbox value
            // Only set expiryDate if perishable is checked and date is provided
            expiryDate: (perishable === 'on' || perishable === true) && expiryDate ? new Date(expiryDate) : null
        };

        const newItem = new Item(newItemData);
        await newItem.save();
        console.log("Item created:", newItem.name, "SKU:", newItem.sku);
        res.redirect('/items'); // Redirect to the list view

    } catch (err) {
        console.error("Error creating item:", err);
        // Fetch warehouses again for the form re-render
         try {
             let warehouseQuery = {};
             if (loggedInUser.role === 'warehouse_owner') { warehouseQuery.companyId = loggedInUser.companyId; }
             availableWarehouses = await Warehouse.find(warehouseQuery, 'id name').lean();
         } catch (fetchErr) {
             console.error("Error fetching warehouses for error re-render:", fetchErr);
         }
        // Re-render form with error and submitted data
        res.status(400).render('items/form', {
            title: 'Add New Item',
            item: req.body, // Pass back submitted data
            availableWarehouses: availableWarehouses,
            error: `Failed to add item: ${err.message}`,
            layout: './layouts/dashboard_layout'
        });
    }
});

// --- Add routes for viewing details, editing, updating stock, deleting later ---
// GET /items/:id
// GET /items/:id/edit
// PUT /items/:id (or POST with method override)
// POST /items/:id/adjust (for stock adjustments)
// DELETE /items/:id (or POST with method override)


module.exports = router;