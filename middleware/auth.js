// middleware/auth.js
module.exports = {
    ensureAuthenticated: function(req, res, next) {
        // Use res.locals set by global middleware in server.js
        if (res.locals.loggedInUser) {
            return next();
        }
        console.log("User not authenticated (ensureAuthenticated middleware), redirecting to login.");
        // Optional: Store intended URL
        // req.session.returnTo = req.originalUrl;
        res.redirect('/login');
    },

    // Example role check middleware
    ensureRole: function(roles) {
        return (req, res, next) => {
            const loggedInUser = res.locals.loggedInUser;
             // Ensure roles is an array
            if (!Array.isArray(roles)) {
                roles = [roles];
            }
            if (loggedInUser && roles.includes(loggedInUser.role)) {
                return next(); // User has one of the required roles
            }
            console.log(`Access Denied: User ${loggedInUser?._id || 'UNKNOWN'} role ${loggedInUser?.role || 'NONE'} not in required roles [${roles.join(', ')}].`);
            res.status(403).send(`Access Denied: Required role(s): ${roles.join(' or ')}.`);
        };
    }
};