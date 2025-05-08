// routes/company.js
const express = require('express');
const mongoose = require('mongoose');
const Company = require('../models/Company'); // Adjust path if needed

const router = express.Router();

// --- Middleware ---
function ensureAuthenticated(req, res, next) {
    if (res.locals.loggedInUser) return next();
    res.redirect('/login');
}

// Only Admins or Warehouse Owners can manage company settings
async function ensureAdminOrOwner(req, res, next) {
    const loggedInUser = res.locals.loggedInUser;
    if (!loggedInUser) return res.status(401).send("Authentication required.");

    if (loggedInUser.role === 'admin') return next(); // Admin can manage any company (potentially)

    if (loggedInUser.role === 'warehouse_owner') {
        if (!loggedInUser.companyId) {
             return res.status(403).render('error_page', { title: "Access Denied", message: "You are not associated with a company.", layout: './layouts/dashboard_layout' });
        }
        // Warehouse owner can only manage their own company settings
        return next();
    }
    res.status(403).render('error_page', { title: "Access Denied", message: "You do not have permission to manage company settings.", layout: './layouts/dashboard_layout' });
}

router.use(ensureAuthenticated, ensureAdminOrOwner);
// --- End Middleware ---


// GET /company/settings - Display form to edit company settings
router.get('/settings', async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        let companyToEdit = null;
        const companyId = loggedInUser.companyId?._id || loggedInUser.companyId; 

        if (!companyId && loggedInUser.role !== 'admin') { // Owners must have a company
             return res.status(403).render('error_page', {title:"Error", message: "User not associated with a company.", layout: './layouts/dashboard_layout'});
        }
        
        if (companyId) { // Fetch if owner has company ID or if admin has one associated
            companyToEdit = await Company.findById(companyId).lean();
        } 
        // Handle Admin case without associated company - maybe redirect to company selection?
        // For now, assume admin MUST be associated or selects via different mechanism

        if (!companyToEdit) {
             return res.status(404).render('error_page', { title: "Not Found", message: "Company details not found.", layout: './layouts/dashboard_layout' });
        }

        res.render('company/settings', {
            title: 'Company Settings',
            company: companyToEdit,
            formData: companyToEdit, // Pre-fill form with current data
            layout: './layouts/dashboard_layout'
        });

    } catch (err) {
        console.error("Error fetching company settings:", err);
        res.status(500).render('error_page', { title: "Server Error", message: "Failed to load company settings.", layout: './layouts/dashboard_layout' });
    }
});

// PUT /company/settings - Update company settings
router.put('/settings', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    const companyId = loggedInUser.companyId?._id || loggedInUser.companyId; 

    if (!companyId) {
        return res.redirect('/dashboard?error=Cannot+identify+company+to+update.');
    }

    // Destructure ALL expected fields from the form
    const { 
        contactEmail, mobileNumber, upiId, 
        gstin, fssaiLicenseNo,
        address_street, address_city, address_state, address_pincode, address_country,
        sameAsMain, // Checkbox value for billing address
        billing_street, billing_city, billing_state, billing_pincode, billing_country,
        bank_accountName, bank_accountNumber, bank_bankName, bank_ifscCode
    } = req.body;

    try {
        const companyToUpdate = await Company.findById(companyId);
        if (!companyToUpdate) throw new Error("Company not found for update.");

        // Authorization (optional, middleware should cover owner)
        if (loggedInUser.role === 'warehouse_owner' && companyToUpdate._id.toString() !== companyId.toString()) {
             throw new Error("Authorization failed.");
        }

        // Construct Address Objects
        const mainAddress = {
            street: address_street, city: address_city, state: address_state, 
            pincode: address_pincode, country: address_country || 'India'
        };
        // Use submitted billing address ONLY if 'sameAsMain' checkbox is NOT checked
        const useSameBilling = sameAsMain === 'on' || sameAsMain === true;
        const billingAddr = useSameBilling ? mainAddress : {
            street: billing_street, city: billing_city, state: billing_state, 
            pincode: billing_pincode, country: billing_country || 'India'
        };

        // Construct Bank Details Object
        const bankDetails = {
            accountName: bank_accountName,
            accountNumber: bank_accountNumber,
            bankName: bank_bankName,
            ifscCode: bank_ifscCode
        };

        // Update fields
        companyToUpdate.contactEmail = contactEmail?.trim();
        companyToUpdate.mobileNumber = mobileNumber?.trim();
        companyToUpdate.upiId = upiId?.trim();
        companyToUpdate.gstin = gstin?.toUpperCase().trim();
        companyToUpdate.fssaiLicenseNo = fssaiLicenseNo?.trim();
        companyToUpdate.address = mainAddress;
        companyToUpdate.billingAddress = billingAddr;
        companyToUpdate.bankDetails = bankDetails;
        companyToUpdate.lastUpdated = new Date();

        await companyToUpdate.save();
        console.log(`Company settings updated for ${companyId}`);
        res.redirect('/company/settings?success=Settings+updated+successfully');

    } catch (err) {
         console.error("Error updating company settings:", err);
         let errorMessage = "Failed to update settings.";
         if (err.name === 'ValidationError') { errorMessage = Object.values(err.errors).map(val => val.message).join(', '); }
         else if (err.message) { errorMessage = err.message; }
         
         // Re-render form with error
         try {
             const companyDataForForm = await Company.findById(companyId).lean();
             res.status(400).render('company/settings', {
                 title: 'Company Settings',
                 company: companyDataForForm || { _id: companyId }, 
                 formData: req.body, // Submitted data with error
                 error: errorMessage,
                 layout: './layouts/dashboard_layout'
             });
         } catch (fetchErr) {
              res.redirect('/dashboard?error=Update+failed,+could+not+reload+settings+page.');
         }
    }
});


module.exports = router;