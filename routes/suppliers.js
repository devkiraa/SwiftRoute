// routes/suppliers.js
const express = require('express');
const mongoose = require('mongoose');
const Supplier = require('../models/Supplier');
const PurchaseOrder = require('../models/PurchaseOrder'); // For future delete check
const Company = require('../models/Company'); // For admin view
const User = require('../models/User'); // For auth

const router = express.Router();

// --- Middleware ---
function ensureAuthenticated(req, res, next) {
    if (res.locals.loggedInUser) return next();
    res.redirect('/login');
}
async function ensureAdminOrOwner(req, res, next) {
    const loggedInUser = res.locals.loggedInUser;
    if (!loggedInUser) return res.status(401).send("Authentication required.");
    if (loggedInUser.role === 'admin' || loggedInUser.role === 'warehouse_owner') {
         if (loggedInUser.role === 'warehouse_owner' && !loggedInUser.companyId) {
             return res.status(403).render('error_page', { title: "Access Denied", message: "You are not associated with a company.", layout: './layouts/dashboard_layout' });
         }
        return next();
    }
    res.status(403).render('error_page', { title: "Access Denied", message: "You do not have permission to manage suppliers.", layout: './layouts/dashboard_layout' });
}
router.use(ensureAuthenticated, ensureAdminOrOwner);
// --- End Middleware ---

// GET /suppliers - List suppliers
router.get('/', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        let query = {};
        if (loggedInUser.role === 'warehouse_owner') {
            query.companyId = loggedInUser.companyId._id || loggedInUser.companyId;
        }
        const suppliers = await Supplier.find(query)
            .populate('companyId', 'companyName') // For Admin view
            .sort({ supplierName: 1 }).lean();
        res.render('suppliers/index', {
            title: 'Manage Suppliers', suppliers,
            success_msg: req.query.success, error_msg: req.query.error,
            layout: './layouts/dashboard_layout'
        });
    } catch (err) {
        console.error("Error fetching suppliers:", err);
        res.status(500).render('error_page', { title: "Error", message: "Failed to load suppliers.", layout: './layouts/dashboard_layout' });
    }
});

// GET /suppliers/new - Show add form (Corrected res.locals)
router.get('/new', async (req, res) => {
    let companies = [];
    // Correctly use res.locals
    if (res.locals.loggedInUser && res.locals.loggedInUser.role === 'admin') { 
        try {
            companies = await Company.find().select('companyName _id').sort({ companyName: 1 }).lean();
        } catch(err) {
            console.error("Error fetching companies for admin in GET /suppliers/new:", err);
        }
    }
    res.render('suppliers/form', {
        title: 'Add New Supplier',
        supplier: {}, 
        formData: {}, 
        isEditing: false, 
        companies, // Pass fetched companies (or empty array)
        layout: './layouts/dashboard_layout'
    });
});

// POST /suppliers - Create new supplier (Keep as is from response #77)
router.post('/', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    const companyId = loggedInUser.role === 'admin' ? req.body.companyId : (loggedInUser.companyId?._id || loggedInUser.companyId);
     if (!companyId) {
         let companies = []; if (loggedInUser.role === 'admin') { companies = await Company.find().select('companyName _id').lean(); }
         return res.status(400).render('suppliers/form', { title: 'Add New Supplier', supplier: {}, formData: req.body, isEditing: false, companies, error: 'Company ID is required.', layout: './layouts/dashboard_layout' });
     }
    const { supplierName, contactPerson, email, phone, gstin, notes, address_street, address_city, address_state, address_pincode, address_country } = req.body;
    try {
        const existing = await Supplier.findOne({ companyId, supplierName });
        if(existing) {
             throw new mongoose.Error.ValidationError(null).addError('supplierName', new mongoose.Error.ValidatorError({ message: `Supplier name '${supplierName}' already exists for this company.` }));
        }
        const address = { street: address_street, city: address_city, state: address_state, pincode: address_pincode, country: address_country || 'India' };
        const newSupplier = new Supplier({ companyId, supplierName, contactPerson, email, phone, gstin: gstin?.toUpperCase(), notes, address });
        await newSupplier.save();
        res.redirect('/suppliers?success=Supplier+added+successfully');
    } catch (err) {
        console.error("Error creating supplier:", err);
        let errorMessage = "Failed to add supplier.";
        if (err.name === 'ValidationError') { errorMessage = Object.values(err.errors).map(val => val.message).join(', '); }
        else if (err.message) { errorMessage = err.message; }
        let companies = []; if (loggedInUser.role === 'admin') { companies = await Company.find().select('companyName _id').lean(); }
        res.status(400).render('suppliers/form', {
            title: 'Add New Supplier', supplier: {}, formData: req.body, isEditing: false, companies, error: errorMessage, layout: './layouts/dashboard_layout'
        });
    }
});

// GET /suppliers/:id/edit - Show edit form (Keep as is from response #77)
router.get('/:id/edit', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        const supplier = await Supplier.findById(req.params.id).lean();
        if (!supplier) throw new Error("Supplier not found.");
        if (loggedInUser.role === 'warehouse_owner' && supplier.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
            throw new Error("Access Denied.");
        }
        let companies = []; // Admin doesn't change company of existing supplier
        res.render('suppliers/form', {
            title: 'Edit Supplier', supplier: supplier, formData: supplier, isEditing: true,
            companies, layout: './layouts/dashboard_layout'
        });
    } catch (err) {
        console.error("Error fetching supplier for edit:", err);
        res.redirect(`/suppliers?error=${encodeURIComponent(err.message)}`);
    }
});


// PUT /suppliers/:id - Update supplier
router.put('/:id', async (req, res) => {
    const supplierId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;
    const { supplierName, contactPerson, email, phone, gstin, notes, address_street, address_city, address_state, address_pincode, address_country } = req.body;

    try {
        const supplierToUpdate = await Supplier.findById(supplierId);
        if (!supplierToUpdate) throw new Error("Supplier not found.");

        // Authorization
        if (loggedInUser.role === 'warehouse_owner' && supplierToUpdate.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
            throw new Error("Access Denied.");
        }
        
        // Check for duplicate name within company (excluding self)
        if (supplierName !== supplierToUpdate.supplierName) {
            const existing = await Supplier.findOne({ companyId: supplierToUpdate.companyId, supplierName, _id: { $ne: supplierId } });
             if (existing) {
                throw new mongoose.Error.ValidationError(null).addError('supplierName', new mongoose.Error.ValidatorError({ message: `Supplier name '${supplierName}' already exists.` }));
            }
        }

        const address = { street: address_street, city: address_city, state: address_state, pincode: address_pincode, country: address_country || 'India' };

        // Update fields
        supplierToUpdate.supplierName = supplierName;
        supplierToUpdate.contactPerson = contactPerson;
        supplierToUpdate.email = email;
        supplierToUpdate.phone = phone;
        supplierToUpdate.gstin = gstin?.toUpperCase();
        supplierToUpdate.notes = notes;
        supplierToUpdate.address = address;
        supplierToUpdate.lastUpdated = new Date();

        await supplierToUpdate.save();
        res.redirect('/suppliers?success=Supplier+updated+successfully');

    } catch (err) {
        console.error(`Error updating supplier ${supplierId}:`, err);
        let errorMessage = "Failed to update supplier.";
        if (err.name === 'ValidationError') { errorMessage = Object.values(err.errors).map(val => val.message).join(', '); }
        else if (err.message) { errorMessage = err.message; }

        // Re-render form with error
        const supplierDataForForm = await Supplier.findById(supplierId).lean() || { _id: supplierId };
        res.status(400).render('suppliers/form', {
            title: 'Edit Supplier', supplier: supplierDataForForm, formData: req.body, isEditing: true,
            error: errorMessage, layout: './layouts/dashboard_layout'
        });
    }
});

// DELETE /suppliers/:id - Delete a supplier
router.delete('/:id', async (req, res) => {
     const supplierId = req.params.id;
     const loggedInUser = res.locals.loggedInUser;
    try {
        const supplierToDelete = await Supplier.findById(supplierId);
        if (!supplierToDelete) throw new Error("Supplier not found.");

        // Authorization
        if (loggedInUser.role === 'warehouse_owner' && supplierToDelete.companyId.toString() !== (loggedInUser.companyId._id || loggedInUser.companyId).toString()) {
             throw new Error("Access Denied.");
        }
        
        // ** TODO: Check for dependencies (Purchase Orders) before deleting **
        // const relatedPOs = await PurchaseOrder.countDocuments({ supplierId: supplierId });
        // if (relatedPOs > 0) {
        //     throw new Error(`Cannot delete supplier with ${relatedPOs} associated purchase orders.`);
        // }

        await Supplier.findByIdAndDelete(supplierId);
        res.redirect('/suppliers?success=Supplier+deleted+successfully');

    } catch (err) {
        console.error(`Error deleting supplier ${supplierId}:`, err);
         res.redirect(`/suppliers?error=${encodeURIComponent(`Failed to delete supplier: ${err.message}`)}`);
    }
});

module.exports = router;