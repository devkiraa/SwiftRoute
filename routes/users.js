// routes/users.js
const express = require('express');
const User = require('../models/User'); // Assuming models are in ../models/
// Removed: const { ensureAuthenticated } = require('../middleware/auth');

const router = express.Router();

// --- Local Auth Middleware for this Router ---

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
router.get('/new', ensureAuthenticated, ensureAdminOrOwner, (req, res) => {
    res.render('user_form', { // Assumes views/user_form.ejs exists
         title: 'Add New User',
         userToEdit: null, // Indicate this is for creating, not editing
         csrfToken: req.csrfToken ? req.csrfToken() : null // Example if using CSRF protection
    });
});

// POST /users - Create a new user
router.post('/', ensureAuthenticated, ensureAdminOrOwner, async (req, res) => {
    // TODO: Implement user creation logic
    // 1. Get data from req.body (username, email, password, role, storeId?)
    // 2. Validate data
    // 3. Check if email/username already exists
    // 4. Hash password using bcrypt
    // 5. Create new User({ ... , companyId: res.locals.loggedInUser.companyId }) // Assign company
    // 6. Save user
    // 7. Redirect to /users or show success/error
    res.send("POST /users - Create user (Not Implemented Yet)");
});

// GET /users/:id/edit - Show form to edit a user
router.get('/:id/edit', ensureAuthenticated, ensureAdminOrOwner, async (req, res) => {
     try {
        const userToEdit = await User.findById(req.params.id).lean();
        if (!userToEdit) return res.status(404).send('User not found');

        // Authorization: Ensure warehouse owner can only edit users in their own company
        if (res.locals.loggedInUser.role === 'warehouse_owner' && userToEdit.companyId?.toString() !== res.locals.loggedInUser.companyId?.toString()) {
            return res.status(403).send("Access Denied: Cannot edit users outside your company.");
        }

        res.render('user_form', { // Assumes views/user_form.ejs exists
            title: 'Edit User',
            userToEdit: userToEdit
        });
     } catch (err) {
         console.error("Error fetching user for edit:", err);
         res.status(500).send("Error loading edit user page.");
     }
});

// PUT /users/:id - Update a user (requires method-override middleware usually)
router.put('/:id', ensureAuthenticated, ensureAdminOrOwner, async (req, res) => {
     // TODO: Implement user update logic
     // 1. Find user by req.params.id
     // 2. Authorize (check company match if warehouse owner)
     // 3. Get updated data from req.body
     // 4. Handle password update separately (hash if changed)
     // 5. Update user document
     // 6. Save changes
     // 7. Redirect to /users or /users/:id/edit
     res.send(`PUT /users/${req.params.id} - Update user (Not Implemented Yet)`);
});

// DELETE /users/:id - Delete a user (requires method-override middleware usually)
router.delete('/:id', ensureAuthenticated, ensureAdminOrOwner, async (req, res) => {
    // TODO: Implement user deletion logic
    // 1. Find user by req.params.id
    // 2. Authorize (check company match if warehouse owner)
    // 3. Delete user document
    // 4. Redirect to /users
     res.send(`DELETE /users/${req.params.id} - Delete user (Not Implemented Yet)`);
});


module.exports = router;