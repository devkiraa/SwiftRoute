// routes/reporting.js
const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Store = require('../models/Store');
const Warehouse = require('../models/Warehouse');
const Item = require('../models/Item');
const User = require('../models/User');
const Company = require('../models/Company');

const router = express.Router();

// --- Local Auth Middleware ---
function ensureAuthenticated(req, res, next) {
    if (res.locals.loggedInUser) return next();
    res.redirect('/login');
}
// Apply authentication to all reporting routes
router.use(ensureAuthenticated);


// GET /reporting - Display reporting dashboard based on role
router.get('/', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    let reportData = { type: loggedInUser.role }; // Include role type for the view
    let viewTitle = 'Reports';

    try {
        const companyId = loggedInUser.companyId;
        const storeId = loggedInUser.storeId;

        // --- Fetch data based on ROLE ---
        switch (loggedInUser.role) {
            case 'warehouse_owner':
            case 'admin':
                if (loggedInUser.role === 'warehouse_owner' && !companyId) {
                    throw new Error('User not associated with a company.');
                }
                const companyQuery = loggedInUser.role === 'admin' ? {} : { companyId: companyId };

                // Find stores & warehouses for the company/platform
                const relevantStores = await Store.find(companyQuery).select('_id').lean();
                const relevantStoreIds = relevantStores.map(s => s._id);
                const relevantWarehouses = await Warehouse.find(companyQuery).select('_id').lean();
                const relevantWarehouseIds = relevantWarehouses.map(w => w._id);

                // --- Aggregations ---
                // 1. Order Status Counts
                const orderStatusCounts = await Order.aggregate([
                    { $match: { storeId: { $in: relevantStoreIds } } },
                    { $group: { _id: '$orderStatus', count: { $sum: 1 } } },
                    { $sort: { _id: 1 } } // Sort by status name
                ]);

                // 2. Total Sales Value (from delivered orders)
                const totalSalesResult = await Order.aggregate([
                    { $match: { storeId: { $in: relevantStoreIds }, orderStatus: 'delivered' } },
                    { $group: { _id: null, totalRevenue: { $sum: '$totalAmount' } } }
                ]);

                // 3. Inventory Summary
                const inventorySummary = await Item.aggregate([
                     { $match: { warehouseId: { $in: relevantWarehouseIds } } },
                     {
                         $group: {
                             _id: null,
                             totalItems: { $sum: '$quantity' },
                             distinctSKUs: { $addToSet: '$sku'}, // Count distinct items
                             totalValue: { $sum: { $multiply: ['$quantity', '$price'] } } // Calculate value
                         }
                     },
                     {
                          $project: { // Reshape the output
                              _id: 0, // Exclude the default _id field
                              totalItems: 1,
                              distinctSKUs: { $size: '$distinctSKUs' }, // Get the count from the set
                              totalValue: 1
                          }
                     }
                ]);

                // Assign data to report object
                reportData.orderStatusCounts = orderStatusCounts; // Array: [{ _id: 'pending', count: 5 }, ...]
                reportData.totalRevenue = totalSalesResult[0]?.totalRevenue || 0;
                reportData.inventorySummary = inventorySummary[0] || { totalItems: 0, distinctSKUs: 0, totalValue: 0 }; // Handle empty result

                viewTitle = loggedInUser.role === 'admin' ? 'Platform Reports' : 'Company Reports';
                break;

            case 'store_owner':
            case 'employee':
                 if (!storeId) throw new Error('User not associated with a store.');

                 viewTitle = 'Store Reports';

                 // 1. Order Status Counts for THIS Store
                 const storeOrderStatusCounts = await Order.aggregate([
                    { $match: { storeId: storeId } },
                    { $group: { _id: '$orderStatus', count: { $sum: 1 } } },
                    { $sort: { _id: 1 } }
                 ]);

                 // 2. Total Sales for THIS Store
                 const storeTotalSalesResult = await Order.aggregate([
                    { $match: { storeId: storeId, orderStatus: 'delivered' } },
                    { $group: { _id: null, totalRevenue: { $sum: '$totalAmount' } } }
                 ]);

                 // 3. Customer Count for THIS Store
                 const customerCount = await User.countDocuments({ storeId: storeId, role: 'customer'});

                 reportData.orderStatusCounts = storeOrderStatusCounts;
                 reportData.totalRevenue = storeTotalSalesResult[0]?.totalRevenue || 0;
                 reportData.customerCount = customerCount;
                break;

            case 'delivery_partner':
                 viewTitle = 'My Delivery Report';
                 // 1. Count deliveries by status for THIS partner
                 const deliveryStatusCounts = await Order.aggregate([
                    { $match: { assignedDeliveryPartnerId: loggedInUser._id } }, // Assumes field exists
                    { $group: { _id: '$orderStatus', count: { $sum: 1 } } },
                    { $match: { _id: { $in: ['shipped', 'delivered', 'cancelled'] } } }, // Filter relevant statuses
                    { $sort: { _id: 1 } }
                 ]);
                 reportData.deliveryStatusCounts = deliveryStatusCounts;
                break;

            default:
                throw new Error('User role does not have access to reports.');
        }

        res.render('reporting/index', { // Render views/reporting/index.ejs
            title: viewTitle,
            reportData: reportData,
            layout: './layouts/dashboard_layout'
        });

    } catch (err) {
        console.error(`Error fetching reports for role ${loggedInUser?.role}:`, err);
        res.status(500).render('error_page', { title: "Error", message: "Failed to load reports.", layout: false });
    }
});


module.exports = router;