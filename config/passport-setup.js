// config/passport-setup.js
const passport = require('passport');
const GoogleStrategy = require('passport-google-oauth20').Strategy;
const User = require('../models/User'); // Adjust path if needed
const Company = require('../models/Company'); // For new company registration

passport.use(
    new GoogleStrategy(
        {
            clientID: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
            callbackURL: `${process.env.APP_BASE_URL || 'http://localhost:3000'}/auth/google/callback`, // Make sure this matches GCP setup
            scope: ['profile', 'email'] // Ensure 'profile' is included for name and picture
        },
        async (accessToken, refreshToken, profile, done) => {
            try {
                // console.log('Google Profile:', JSON.stringify(profile, null, 2));

                // 1. Check if user already exists via Google ID
                let user = await User.findOne({ googleId: profile.id });
                if (user) {
                    console.log('User found by Google ID:', user.username);
                    user.lastLogin = new Date();
                    await user.save();
                    return done(null, user);
                }

                // 2. Check if user exists via email (and link account or handle conflict)
                user = await User.findOne({ email: profile.emails[0].value });
                if (user) {
                    console.log('User found by email, linking Google ID:', user.username);
                    user.googleId = profile.id;
                    user.avatarUrl = profile.photos && profile.photos.length > 0 ? profile.photos[0].value : user.avatarUrl;
                    user.lastLogin = new Date();
                    // If username wasn't set by Google, ensure it's there
                    if (!user.username && profile.displayName) {
                        user.username = profile.displayName.replace(/\s+/g, '').toLowerCase() + Math.floor(Math.random()*1000); // Simple unique username
                    }
                    await user.save();
                    return done(null, user);
                }

                // 3. If no user exists, create a new one
                // For this application, new users via Google are assumed to be registering a new company
                // and becoming a 'warehouse_owner'. Adapt this logic if needed.
                console.log('Creating new user via Google:', profile.displayName);

                // Create a placeholder company for the new user
                // Ideally, company creation would be part of a separate onboarding step after Google signup
                // For now, create a basic company.
                const newCompanyName = `${profile.displayName}'s Company`;
                let company = await Company.findOne({ companyName: newCompanyName });
                if (!company) {
                    company = new Company({
                        companyName: newCompanyName,
                        contactEmail: profile.emails[0].value,
                        // Add default address or prompt later
                        address: { street: "Default Street", city: "Default City", state: "Default State", pincode: "000000", country: "India" },
                        subscriptionPlan: 'free' // Default plan
                    });
                    await company.save();
                    console.log("New company created for Google user:", company.companyName);
                }


                const newUser = new User({
                    googleId: profile.id,
                    username: profile.displayName.replace(/\s+/g, '').toLowerCase() + Math.floor(Math.random()*1000), // Create a simple unique username
                    email: profile.emails[0].value,
                    avatarUrl: profile.photos && profile.photos.length > 0 ? profile.photos[0].value : undefined,
                    role: 'warehouse_owner', // Default role for Google signup in this app context
                    companyId: company._id, // Link to the newly created or found company
                    isActive: true,
                    lastLogin: new Date()
                    // Password field is omitted as they are using Google Auth
                });
                await newUser.save();
                console.log('New user created and saved:', newUser.username);
                return done(null, newUser);

            } catch (err) {
                console.error('Error in Google OAuth Strategy:', err);
                return done(err, null);
            }
        }
    )
);

passport.serializeUser((user, done) => {
    done(null, user.id); // Store user.id in session
});

passport.deserializeUser(async (id, done) => {
    try {
        const user = await User.findById(id);
        done(null, user); // Makes user object available in req.user
    } catch (err) {
        done(err, null);
    }
});