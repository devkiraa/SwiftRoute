// routes/reporting.js
const express = require('express');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const Store = require('../models/Store');
const Warehouse = require('../models/Warehouse');
const Item = require('../models/Item');
const User = require('../models/User');
const Company = require('../models/Company');
const TripLog = require('../models/TripLog'); // <-- Add TripLog
const FuelLog = require('../models/FuelLog'); // <-- Add FuelLog

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
    // Initialize with more detailed structure
    let reportData = { 
        type: loggedInUser.role, 
        salesSummary: {}, 
        pnlSummary: {}, 
        orderStatusCounts: [],
        inventorySummary: {},
        deliveryStatusCounts: [], // For delivery partner
        customerCount: 0, // For store owner
        tripSummary: {}, // <-- NEW: For trip stats
        fuelSummary: {}  // <-- NEW: For fuel stats
    }; 
    let viewTitle = 'Reports';
    console.log(`--- Accessing GET /reporting for role: ${loggedInUser.role} ---`);

    try {
        const companyId = loggedInUser.companyId?._id || loggedInUser.companyId;
        const storeIdForUser = loggedInUser.storeId?._id || loggedInUser.storeId;

        // --- Date Range (Placeholder) ---
        // Define startDate, endDate for filtering if needed

        switch (loggedInUser.role) {
            case 'warehouse_owner':
            case 'admin':
                const companyQuery = loggedInUser.role === 'admin' ? {} : { companyId: companyId };
                // Determine relevant IDs for filtering sub-collections if needed
                const relevantStoreIds = loggedInUser.role === 'admin' ? null : (await Store.find({ companyId: companyId }).select('_id').lean()).map(s => s._id);
                const relevantWarehouseIds = loggedInUser.role === 'admin' ? null : (await Warehouse.find({ companyId: companyId }).select('_id').lean()).map(w => w._id);
                const relevantDriverIds = loggedInUser.role === 'admin' ? null : (await User.find({ companyId: companyId, role: 'delivery_partner' }).select('_id').lean()).map(u => u._id);

                // --- Aggregations (Keep existing + Add New) ---
                const matchCompanyOrders = loggedInUser.role === 'admin' ? {} : { storeId: { $in: relevantStoreIds }};
                const matchCompanyItems = loggedInUser.role === 'admin' ? {} : { warehouseId: { $in: relevantWarehouseIds }};
                const matchCompanyTrips = loggedInUser.role === 'admin' ? {} : { companyId: companyId }; // TripLog has companyId
                const matchCompanyFuel = loggedInUser.role === 'admin' ? {} : { companyId: companyId }; // FuelLog has companyId

                // Existing Aggregations (Order Status, Sales, P&L, Inventory)
                // ... (Keep these pipelines, ensure they use correct filters if needed) ...
                 reportData.orderStatusCounts = await Order.aggregate([ { $match: matchCompanyOrders }, { $group: { _id: '$orderStatus', count: { $sum: 1 } } }, { $sort: { _id: 1 } } ]);
                 const totalSalesResult = await Order.aggregate([ { $match: { ...matchCompanyOrders, orderStatus: 'delivered' } }, { $group: { _id: null, totalRevenue: { $sum: '$totalAmount' } } } ]);
                 reportData.salesSummary.totalRevenue = totalSalesResult[0]?.totalRevenue || 0;
                 const cogsResult = await Order.aggregate([ { $match: { ...matchCompanyOrders, orderStatus: 'delivered' } }, { $unwind: '$orderItems' }, { $lookup: { from: Item.collection.name, localField: 'orderItems.itemId', foreignField: '_id', as: 'itemDetails' }}, { $unwind: { path: '$itemDetails', preserveNullAndEmptyArrays: true } }, { $group: { _id: null, totalCOGS: { $sum: { $multiply: ['$orderItems.quantity', { $ifNull: ['$itemDetails.unitPrice', 0] }] } } }} ]);
                 reportData.pnlSummary.totalCOGS = cogsResult[0]?.totalCOGS || 0;
                 reportData.pnlSummary.grossProfit = reportData.salesSummary.totalRevenue - reportData.pnlSummary.totalCOGS;
                 const inventoryData = await Item.aggregate([ { $match: matchCompanyItems }, { $group: { _id: null, totalItems: { $sum: '$quantity' }, distinctSKUs: { $addToSet: '$sku'}, totalCostValue: { $sum: { $multiply: ['$quantity', '$unitPrice'] } } }}, { $project: { _id: 0, totalItems: 1, distinctSKUs: { $size: '$distinctSKUs' }, totalCostValue: 1 }} ]);
                 reportData.inventorySummary = inventoryData[0] || { totalItems: 0, distinctSKUs: 0, totalCostValue: 0 };

                // --- NEW: Trip Summary Aggregation ---
                const tripStats = await TripLog.aggregate([
                    { $match: { ...matchCompanyTrips, status: 'completed', startOdometer: { $ne: null }, endOdometer: { $ne: null } } }, // Only completed trips with odo readings
                    { $project: {
                        distance: { $subtract: ["$endOdometer", "$startOdometer"] } 
                    }},
                    { $match: { distance: { $gte: 0 } } }, // Ensure distance is non-negative
                    { $group: {
                        _id: null,
                        totalTrips: { $sum: 1 },
                        totalDistanceKm: { $sum: "$distance" }
                    }}
                ]);
                 reportData.tripSummary = {
                     totalCompletedTrips: tripStats[0]?.totalTrips || 0,
                     totalDistanceKm: tripStats[0]?.totalDistanceKm?.toFixed(1) || 0,
                 };
                 if (reportData.tripSummary.totalCompletedTrips > 0) {
                    reportData.tripSummary.averageDistanceKm = (reportData.tripSummary.totalDistanceKm / reportData.tripSummary.totalCompletedTrips).toFixed(1);
                 } else {
                    reportData.tripSummary.averageDistanceKm = 0;
                 }
                console.log("Trip Summary:", reportData.tripSummary);


                // --- NEW: Fuel Log Summary Aggregation ---
                 const fuelStats = await FuelLog.aggregate([
                     { $match: matchCompanyFuel }, // Filter by company
                     { $group: {
                         _id: null,
                         totalFuelLiters: { $sum: "$fuelQuantityLiters" },
                         totalFuelCost: { $sum: "$fuelCostTotalINR" },
                         logCount: { $sum: 1 }
                     }}
                 ]);
                 reportData.fuelSummary = {
                     totalFuelLiters: fuelStats[0]?.totalFuelLiters?.toFixed(2) || 0,
                     totalFuelCost: fuelStats[0]?.totalFuelCost?.toFixed(2) || 0,
                     logCount: fuelStats[0]?.logCount || 0
                 };
                 if (reportData.fuelSummary.totalFuelLiters > 0) {
                     reportData.fuelSummary.averageCostPerLiter = (reportData.fuelSummary.totalFuelCost / reportData.fuelSummary.totalFuelLiters).toFixed(2);
                 } else {
                      reportData.fuelSummary.averageCostPerLiter = 0;
                 }
                console.log("Fuel Summary:", reportData.fuelSummary);

                viewTitle = loggedInUser.role === 'admin' ? 'Platform Reports' : 'Company Reports';
                break;

            // --- Cases for 'store_owner', 'employee', 'delivery_partner' (Keep as is or enhance later) ---
            case 'store_owner':
            case 'employee': /* ... fetch store specific data ... */ break;
            case 'delivery_partner': /* ... fetch driver specific data ... */ break;
            default: throw new Error('User role does not have access to reports.');
        }

        res.render('reporting/index', { title: viewTitle, reportData, layout: './layouts/dashboard_layout' });

    } catch (err) {
        console.error(`Error fetching reports for role ${loggedInUser?.role}:`, err);
        reportData.error = `Failed to load some report data: ${err.message}`; // Pass error to view
        res.status(500).render('reporting/index', { title: "Reports Error", reportData, layout: './layouts/dashboard_layout' });
    }
});


// --- DOWNLOAD ROUTES ---
// GET /reporting/sales-summary/csv - Download Sales Summary as CSV
router.get('/sales-summary/csv', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    console.log(`--- CSV Download: Sales Summary for role ${loggedInUser.role} ---`);

    try {
        let salesDataForCsv = [];
        const companyId = loggedInUser.companyId?._id || loggedInUser.companyId;
        let relevantStoreIds = [];

        if (['admin', 'warehouse_owner'].includes(loggedInUser.role)) {
            const companyQuery = loggedInUser.role === 'admin' ? {} : { companyId: companyId };
            relevantStoreIds = (await Store.find(companyQuery).select('_id').lean()).map(s => s._id);
        } else if (['store_owner', 'employee'].includes(loggedInUser.role) && loggedInUser.storeId) {
            relevantStoreIds = [loggedInUser.storeId?._id || loggedInUser.storeId];
        } else {
            throw new Error("User role not permitted for this report.");
        }

        if (relevantStoreIds.length === 0 && loggedInUser.role !== 'admin') {
             throw new Error("No stores found to generate sales summary.");
        }

        // Fetch delivered orders to create a sales list
        const deliveredOrders = await Order.find({
            storeId: { $in: relevantStoreIds },
            orderStatus: 'delivered'
        })
        .populate('storeId', 'storeName')
        .populate('orderItems.itemId', 'name sku unitPrice') // Get unit price for COGS
        .sort({ placedDate: -1 })
        .lean();

        if (deliveredOrders.length === 0) {
            // Send an empty CSV or a message? For now, empty.
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', 'attachment; filename=sales_summary_empty.csv');
            return res.status(200).send("No sales data to export.");
        }

        // Transform data for CSV
        deliveredOrders.forEach(order => {
            order.orderItems.forEach(item => {
                const revenue = item.quantity * item.priceAtOrder;
                const cogs = item.quantity * (item.itemId?.unitPrice || 0); // COGS for this line item
                salesDataForCsv.push({
                    'Order ID': order._id.toString(),
                    'Order Date': new Date(order.placedDate).toLocaleDateString('en-IN'),
                    'Store Name': order.storeId?.storeName || 'N/A',
                    'Customer Name': order.customerName || 'N/A',
                    'Item Name': item.itemId?.name || 'Unknown Item',
                    'Item SKU': item.itemId?.sku || 'N/A',
                    'Quantity Sold': item.quantity,
                    'Price at Order (₹)': item.priceAtOrder.toFixed(2),
                    'Line Item Revenue (₹)': revenue.toFixed(2),
                    'Line Item COGS (₹)': cogs.toFixed(2),
                    'Line Item Gross Profit (₹)': (revenue - cogs).toFixed(2),
                    'Order Status': order.orderStatus
                });
            });
        });

        const fields = ['Order ID', 'Order Date', 'Store Name', 'Customer Name', 'Item Name', 'Item SKU', 'Quantity Sold', 'Price at Order (₹)', 'Line Item Revenue (₹)', 'Line Item COGS (₹)', 'Line Item Gross Profit (₹)', 'Order Status'];
        const json2csvParser = new Parser({ fields, header: true });
        const csv = json2csvParser.parse(salesDataForCsv);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', 'attachment; filename=sales_summary.csv');
        res.status(200).send(csv);

    } catch (err) {
        console.error("Error generating Sales Summary CSV:", err);
        res.status(500).send(`Could not generate CSV: ${err.message}`);
    }
});

module.exports = router;