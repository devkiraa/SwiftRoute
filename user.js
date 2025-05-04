// seed_users.js
require('dotenv').config(); // Load .env variables like MONGO_URI
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const User = require('./models/User'); // Adjust path if needed
const Company = require('./models/Company'); // Needed to ensure company exists
const Store = require('./models/Store'); // Needed to ensure store exists

// --- Configuration ---
const plainPassword = '1'; // The password for all users
const saltRounds = 10; // Must match the salt rounds used in your login/registration logic
const companyNameForNewUsers = 'Sample Seed Company'; // Create/use this company
const storeNameForNewUsers = 'Sample Seed Store'; // Create/use this store

// --- Sample User Data (Structure) ---
// Define user data structure without password initially
const usersToSeed = [
  { username: 'platform_admin', email: 'admin@swiftroute.app', role: 'admin', companyId: null, storeId: null },
  { username: 'main_warehouse_owner', email: 'owner@company_seed.com', role: 'warehouse_owner', companyId: null, storeId: null }, // companyId filled later
  { username: 'main_store_mgr', email: 'store_mgr@company_seed.com', role: 'store_owner', companyId: null, storeId: null }, // IDs filled later
  { username: 'store_employee_1', email: 'employee1@company_seed.com', role: 'employee', companyId: null, storeId: null }, // IDs filled later
  { username: 'delivery_ravi', email: 'ravi.d@delivery.co', role: 'delivery_partner', companyId: null, storeId: null } // IDs filled later
];


// --- Main Seeding Function ---
async function seedDatabase() {
  try {
    // 1. Connect to MongoDB
    await mongoose.connect(process.env.MONGO_URI);
    console.log('MongoDB connected for seeding...');

    // 2. Hash the password
    console.log(`Hashing password: "${plainPassword}"...`);
    const hashedPassword = await bcrypt.hash(plainPassword, saltRounds);
    console.log('Password hashed.');

    // 3. Ensure Company exists (or create it)
    let company = await Company.findOne({ companyName: companyNameForNewUsers });
    if (!company) {
        console.log(`Company "${companyNameForNewUsers}" not found, creating...`);
        company = await new Company({
            companyName: companyNameForNewUsers,
            contactEmail: 'seed_contact@company_seed.com', // Example contact
            subscriptionPlan: 'basic'
        }).save();
        console.log(`Company created with ID: ${company._id}`);
    } else {
        console.log(`Using existing company: ${company.companyName} (ID: ${company._id})`);
    }
    const companyId = company._id;

    // 4. Ensure Store exists (or create it) linked to the company
    let store = await Store.findOne({ storeName: storeNameForNewUsers, companyId: companyId });
     if (!store) {
         console.log(`Store "${storeNameForNewUsers}" not found for company, creating...`);
         // Example coordinates (Bangalore) - Replace if needed
         const sampleCoords = [77.5946, 12.9716]; // Lng, Lat
         store = await new Store({
             storeName: storeNameForNewUsers,
             address: '123 Seed Street, Sample City',
             phone: '9876543210',
             location: { type: 'Point', coordinates: sampleCoords },
             companyId: companyId
         }).save();
         console.log(`Store created with ID: ${store._id}`);
     } else {
         console.log(`Using existing store: ${store.storeName} (ID: ${store._id})`);
     }
     const storeId = store._id;


    // 5. Prepare user data with hashed password and IDs
    const finalUsersData = usersToSeed.map(user => {
      // Assign Company and Store IDs based on role/logic
      let assignedCompanyId = null;
      let assignedStoreId = null;

      if (user.role === 'warehouse_owner' || user.role === 'store_owner' || user.role === 'employee' || user.role === 'delivery_partner') {
          assignedCompanyId = companyId; // Assign the created/found company
      }
      if (user.role === 'store_owner' || user.role === 'employee') {
          assignedStoreId = storeId; // Assign the created/found store
      }

      return {
        ...user,
        password: hashedPassword, // Add the hashed password
        companyId: assignedCompanyId,
        storeId: assignedStoreId,
        avatarUrl: user.avatarUrl || 'https://i.pinimg.com/736x/3f/94/70/3f9470b34a8e3f526dbdb022f9f19cf7.jpg' // Ensure default avatar
      };
    });

    // 6. Clear existing users (optional, use with caution!)
    // console.log('Clearing existing Users collection...');
    // await User.deleteMany({});

    // 7. Insert new users
    console.log('Inserting sample users...');
    const createdUsers = await User.insertMany(finalUsersData, { ordered: false }).catch(err => {
         // Ignore duplicate key errors if re-running, log others
         if (err.code === 11000) { // MongoDB duplicate key error code
             console.warn('Some users might already exist (duplicate key errors ignored).');
             // Query the successfully inserted ones if needed, err.insertedDocs might not be reliable on bulk errors
             return User.find({ email: { $in: finalUsersData.map(u => u.email) } });
         } else {
             throw err; // Re-throw other errors
         }
    });

    console.log(`Successfully seeded ${createdUsers.length} users.`);
    // console.log(createdUsers.map(u => ({ username: u.username, email: u.email, role: u.role, companyId: u.companyId, storeId: u.storeId })));


  } catch (error) {
    console.error('\nError during seeding process:');
    console.error(error);
  } finally {
    // 8. Disconnect from MongoDB
    await mongoose.disconnect();
    console.log('MongoDB disconnected.');
  }
}

// Run the seeding function
seedDatabase();