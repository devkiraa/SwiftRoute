// routes/users.js
const express = require('express');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt'); // Needed for hashing passwords
const User = require('../models/User');
const Store = require('../models/Store'); // Needed for dropdowns/validation
const Company = require('../models/Company'); // Needed for admin dropdowns

const router = express.Router();
const saltRounds = 10; // Use consistent salt rounds

// Checks if user is logged in (using res.locals set by global middleware)
function ensureAuthenticated(req, res, next) {
    if (res.locals.loggedInUser) {
        return next();
    }
    console.log("User not authenticated (users route check), redirecting to login.");
    res.redirect('/login');
}

// Checks if user has required role(s)
function ensureAdminOrOwner(req, res, next) {
    const loggedInUser = res.locals.loggedInUser; // Get user from global middleware
    // Ensure user exists before checking role
    if (loggedInUser && ['warehouse_owner', 'admin'].includes(loggedInUser.role)) {
        return next(); // Allow access
    }
    // Deny access if user doesn't exist or doesn't have the right role
    console.log(`Access Denied for user ${loggedInUser?._id || 'UNKNOWN'} with role ${loggedInUser?.role || 'NONE'} to user management.`);
    res.status(403).send("Access Denied: Admin or Warehouse Owner role required.");
}
// --- End Local Auth Middleware ---


// GET /users - List users for the company (or all for admin)
// Apply the locally defined middleware
router.get('/', ensureAuthenticated, ensureAdminOrOwner, async (req, res) => {
    try {
        const { loggedInUser, companyDetails } = res.locals; // Get data from global middleware

        // Fetch users based on role
        const query = {};
        if (loggedInUser.role === 'warehouse_owner') {
            if (!loggedInUser.companyId) return res.status(400).send("User not associated with a company");
            query.companyId = loggedInUser.companyId;
        }
        // Admin query remains empty (fetches all) - add filters if needed

        const users = await User.find(query)
            .populate('storeId', 'storeName')
            .limit(20) // Add pagination later
            .sort({ createdDate: -1 })
            .lean();

        const tableData = users.map(user => ({
            _id: user._id,
            username: user.username,
            email: user.email,
            role: user.role,
            avatarUrl: user.avatarUrl,
            store: user.storeId
         }));

        const pagination = { currentPage: 1, totalPages: 1 }; // Replace with real pagination

        res.render('users', { // Renders views/users.ejs
            title: 'Manage Users',
            tableTitle: loggedInUser.role === 'admin' ? 'All Users' : 'Company Users',
            tableData: tableData,
            pagination: pagination
            // loggedInUser and companyDetails are available via res.locals
        });

    } catch (err) {
         console.error("Error fetching users:", err);
         res.status(500).render('error_page', { title: "Error", message: "Error loading user management page." }); // Assumes you have an error_page.ejs
    }
});

// GET /users/new - Show form to add a new user
router.get('/new', ensureAdminOrOwner, async (req, res) => {
    try {
        const loggedInUser = res.locals.loggedInUser;
        let companyStores = null;
        let allCompanies = null;

        // Warehouse owner needs stores from their company to assign store roles
        if (loggedInUser.role === 'warehouse_owner' && loggedInUser.companyId) {
            companyStores = await Store.find({ companyId: loggedInUser.companyId }).select('storeName _id').lean();
        }
        // Admin needs all companies to assign users
        if (loggedInUser.role === 'admin') {
             allCompanies = await Company.find({}).select('companyName _id').lean();
             // Admin might also need all stores if they can assign store roles directly? Decide logic.
             // For now, let's assume admin assigns company, then maybe edits user later to assign store if needed.
        }

        res.render('user_form', {
            title: 'Add New User',
            userToEdit: null, // Indicate 'add' mode
            companyStores: companyStores, // For store dropdown (if owner)
            allCompanies: allCompanies, // For company dropdown (if admin)
            layout: './layouts/dashboard_layout'
        });
    } catch(err) {
         console.error("Error loading new user form:", err);
         res.status(500).render('error_page', { title: "Error", message: "Failed to load add user form.", layout: false });
    }
});
// POST /users - Create a new user
router.post('/', ensureAdminOrOwner, async (req, res) => {
    const { username, email, password, role, storeId, companyId: companyIdFromForm } = req.body;
    const loggedInUser = res.locals.loggedInUser;
    let companyStores = null; // For re-rendering form on error
    let allCompanies = null;  // For re-rendering form on error

    try {
        // --- Basic Validation ---
        if (!username || !email || !password || !role) {
            throw new Error("Username, Email, Password, and Role are required.");
        }
        if (password.length < 6) { // Example complexity
            throw new Error("Password must be at least 6 characters long.");
        }
        // Validate role against schema enum (Mongoose will also do this on save)
        if (!User.schema.path('role').enumValues.includes(role)) {
             throw new Error("Invalid role selected.");
        }
         // Prevent non-admins from creating admins
        if (role === 'admin' && loggedInUser.role !== 'admin') {
             throw new Error("You do not have permission to create admin users.");
        }


        // --- Determine Company and Store IDs ---
        let targetCompanyId = null;
        let targetStoreId = storeId && mongoose.Types.ObjectId.isValid(storeId) ? storeId : null; // Use provided storeId if valid

        if (loggedInUser.role === 'admin') {
             // Admin MUST assign a company unless creating another admin
             if (role !== 'admin' && (!companyIdFromForm || !mongoose.Types.ObjectId.isValid(companyIdFromForm))) {
                 throw new Error("Admin must assign a valid company to non-admin users.");
             }
             if (role !== 'admin') {
                targetCompanyId = companyIdFromForm;
                // Optional: Verify companyIdFromForm exists
                // Optional: If role needs store, verify storeId belongs to companyIdFromForm
             }
         } else { // Warehouse owner creating user
             targetCompanyId = loggedInUser.companyId;
             // Verify storeId belongs to the owner's company if provided
             if (targetStoreId) {
                 const store = await Store.findOne({ _id: targetStoreId, companyId: targetCompanyId }).lean();
                 if (!store) {
                     throw new Error("Selected store does not belong to your company.");
                 }
             }
         }

         // Validate if role requires a store and if one was provided/valid
         if (['store_owner', 'employee'].includes(role) && !targetStoreId) {
             throw new Error(`Role '${role}' requires assignment to a valid store.`);
         }
         // Clear storeId if role doesn't need it
         if (!['store_owner', 'employee'].includes(role)) {
             targetStoreId = null;
         }


        // --- Check for existing user ---
        const existingUser = await User.findOne({ $or: [{ email: email }, { username: username }] }).lean();
        if (existingUser) {
            throw new Error(`User with email ${email} or username ${username} already exists.`);
        }

        // --- Hash password ---
        const hashedPassword = await bcrypt.hash(password, saltRounds);

        // --- Create and save new user ---
        const newUser = new User({
            username,
            email,
            password: hashedPassword,
            role,
            companyId: targetCompanyId,
            storeId: targetStoreId,
            // avatarUrl uses default from schema
        });
        await newUser.save();

        console.log(`User created: ${username} (Role: ${role})`);
        // Add flash message for success
        res.redirect('/users');

    } catch (err) {
        console.error("Error creating user:", err);
        // Fetch data needed to re-render form
         try {
            if (loggedInUser.role === 'warehouse_owner' && loggedInUser.companyId) {
                companyStores = await Store.find({ companyId: loggedInUser.companyId }).select('storeName _id').lean();
            }
            if (loggedInUser.role === 'admin') {
                 allCompanies = await Company.find({}).select('companyName _id').lean();
            }
             res.status(400).render('user_form', {
                title: 'Add New User',
                userToEdit: null, // Still in 'add' mode
                formData: req.body, // Pass back submitted data (excluding password)
                companyStores: companyStores,
                allCompanies: allCompanies,
                error: `Failed to add user: ${err.message}`,
                layout: './layouts/dashboard_layout'
            });
         } catch(renderErr) {
              console.error("Error re-rendering user form:", renderErr);
              res.status(500).render('error_page', { title: "Error", message: "Failed to process user creation.", layout: false });
         }
    }
});

// GET /users/:id/edit - Show form to edit a user
router.get('/:id/edit', ensureAdminOrOwner, async (req, res) => {
    const userId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;

    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).send("Invalid User ID");

    try {
       const userToEdit = await User.findById(userId).lean();
       if (!userToEdit) return res.status(404).render('error_page', { title: "Not Found", message: "User not found.", layout: false });

        // Authorization check
        if (loggedInUser.role === 'warehouse_owner' && userToEdit.companyId?.toString() !== loggedInUser.companyId?._id?.toString()) {
            // This line is triggered because the IDs don't match
            return res.status(403).send("Access Denied: Cannot edit users outside your company.");
        }
        
       // Fetch stores/companies needed for dropdowns, scoped appropriately
       let companyStores = null;
       let allCompanies = null;

       if (loggedInUser.role === 'admin') {
            allCompanies = await Company.find({}).select('companyName _id').lean();
            // Admin might need stores for the specific company the user belongs to
            if (userToEdit.companyId) {
                companyStores = await Store.find({ companyId: userToEdit.companyId }).select('storeName _id').lean();
            }
       } else { // Warehouse Owner
            companyStores = await Store.find({ companyId: loggedInUser.companyId }).select('storeName _id').lean();
       }

       res.render('user_form', {
           title: 'Edit User',
           userToEdit: userToEdit, // Pass user data to pre-fill form
           companyStores: companyStores,
           allCompanies: allCompanies,
           layout: './layouts/dashboard_layout'
       });
    } catch (err) {
        console.error(`Error fetching user ${userId} for edit:`, err);
        res.status(500).render('error_page', { title: "Error", message: "Error loading edit user page.", layout: false });
    }
});

// PUT /users/:id - Update a user (requires method-override)
router.put('/:id', ensureAdminOrOwner, async (req, res) => {
    const userId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;
    const { username, email, password, role, storeId, companyId: companyIdFromForm } = req.body;
    let companyStores = null; // For re-rendering form on error
    let allCompanies = null;  // For re-rendering form on error

     if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).send("Invalid User ID");

    try {
        const userToUpdate = await User.findById(userId); // Fetch full Mongoose document to update/save
        if (!userToUpdate) throw new Error("User not found.");

        // Authorization: Warehouse owner can only edit users in their own company
        if (loggedInUser.role === 'warehouse_owner' && userToUpdate.companyId?.toString() !== loggedInUser.companyId?.toString()) {
            throw new Error("Cannot edit users outside your company.");
        }
        // Prevent non-admins from promoting to or editing admins
        if (userToUpdate.role === 'admin' && loggedInUser.role !== 'admin') {
            throw new Error("You cannot edit an admin user.");
        }
         if (role === 'admin' && loggedInUser.role !== 'admin') {
             throw new Error("You cannot promote a user to admin.");
         }


        // --- Basic Validation ---
        if (!username || !email || !role) { throw new Error("Username, Email, and Role are required."); }
        if (password && password.length < 6) { throw new Error("New password must be at least 6 characters long."); }
        if (!User.schema.path('role').enumValues.includes(role)) { throw new Error("Invalid role selected."); }


        // --- Determine Company and Store IDs ---
        let targetCompanyId = userToUpdate.companyId; // Keep original unless admin changes it
        let targetStoreId = storeId && mongoose.Types.ObjectId.isValid(storeId) ? storeId : null;

        if (loggedInUser.role === 'admin') {
             // Admin can change company association (unless target is admin role)
             if (role !== 'admin') {
                  if (!companyIdFromForm || !mongoose.Types.ObjectId.isValid(companyIdFromForm)) { throw new Error("Admin must assign a valid company to non-admin users."); }
                  targetCompanyId = companyIdFromForm;
             } else {
                  targetCompanyId = null; // Admins have null company
             }
        } else { // Warehouse owner cannot change company ID
            targetCompanyId = loggedInUser.companyId;
        }

        // Verify store ID if required by role and provided
        if (targetStoreId && targetCompanyId) { // Check if store belongs to target company
             const store = await Store.findOne({ _id: targetStoreId, companyId: targetCompanyId }).lean();
             if (!store) { throw new Error("Selected store does not belong to the target company."); }
        }

        // Validate store assignment based on role
        if (['store_owner', 'employee'].includes(role) && !targetStoreId) { throw new Error(`Role '${role}' requires assignment to a valid store.`); }
        if (!['store_owner', 'employee'].includes(role)) { targetStoreId = null; } // Clear store if role doesn't need it


        // --- Check for username/email conflicts (only if changed) ---
        if (email !== userToUpdate.email) {
            const existingEmail = await User.findOne({ email: email, _id: { $ne: userId } }); // Check other users
            if (existingEmail) throw new Error(`Email ${email} is already in use.`);
        }
        if (username !== userToUpdate.username) {
             const existingUsername = await User.findOne({ username: username, _id: { $ne: userId } });
             if (existingUsername) throw new Error(`Username ${username} is already taken.`);
        }

        // --- Update fields ---
        userToUpdate.username = username;
        userToUpdate.email = email;
        userToUpdate.role = role;
        userToUpdate.companyId = targetCompanyId;
        userToUpdate.storeId = targetStoreId;
        userToUpdate.updatedDate = new Date(); // Assuming you add this field

        // --- Update password only if a new one is provided ---
        if (password) {
            userToUpdate.password = await bcrypt.hash(password, saltRounds);
            console.log(`Password updated for user ${userId}`);
        }

        await userToUpdate.save();
        console.log(`User ${userId} updated successfully.`);
        // Add flash message
        res.redirect('/users');

    } catch (err) {
        console.error(`Error updating user ${userId}:`, err);
        // Fetch data needed to re-render edit form
        try {
           // Refetch user data in case partial updates happened before error
           const userToEdit = await User.findById(userId).lean();
            if (loggedInUser.role === 'admin') { /* Fetch allCompanies */ }
            if (userToEdit?.companyId || loggedInUser.companyId) { /* Fetch companyStores */ }

            res.status(400).render('user_form', {
                title: 'Edit User',
                userToEdit: userToEdit || { _id: userId }, // Pass existing or minimal data back
                formData: req.body, // Pass submitted data back
                companyStores: companyStores,
                allCompanies: allCompanies,
                error: `Failed to update user: ${err.message}`,
                layout: './layouts/dashboard_layout'
            });
        } catch (renderErr) { /* render error page */ }
    }
});


// DELETE /users/:id - Delete a user (requires method-override)
router.delete('/:id', ensureAdminOrOwner, async (req, res) => {
    const userId = req.params.id;
    const loggedInUser = res.locals.loggedInUser;

    if (!mongoose.Types.ObjectId.isValid(userId)) return res.status(400).send("Invalid User ID");

    try {
        const userToDelete = await User.findById(userId);
        if (!userToDelete) throw new Error("User not found.");

        // Authorization
        if (loggedInUser.role === 'warehouse_owner' && userToDelete.companyId?.toString() !== loggedInUser.companyId?.toString()) {
            throw new Error("Cannot delete users outside your company.");
        }
        // Prevent deleting self
        if (userToDelete._id.toString() === loggedInUser._id.toString()) {
             throw new Error("You cannot delete your own account.");
        }
        // Optional: Prevent deleting the last admin? Requires more logic.

        await User.findByIdAndDelete(userId);

        console.log(`User ${userId} deleted by ${loggedInUser._id}`);
        // Add flash message
        res.redirect('/users');

    } catch (err) {
         console.error(`Error deleting user ${userId}:`, err);
          // Add flash message
         res.redirect('/users?error=' + encodeURIComponent(err.message)); // Redirect back to list with error
    }
});

module.exports = router;