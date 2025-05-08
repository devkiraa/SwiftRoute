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


// Helper function to parse date strings into Date objects (start or end of day UTC)
function parseDateFilter(dateString, isEndDate = false) {
    if (!dateString || !/^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
        return null; 
    }
    try {
        // Create date assuming UTC to avoid local timezone shifts during parsing
        const date = new Date(dateString + 'T00:00:00.000Z'); 
        if (isNaN(date.getTime())) return null; 
        
        if (isEndDate) {
            // Set to the very end of the specified day in UTC
            date.setUTCHours(23, 59, 59, 999);
        }
        // If !isEndDate, it remains at the beginning of the day (00:00:00.000Z)
        return date;
    } catch (e) {
        return null;
    }
}

// GET /reporting - Display reporting dashboard based on role (with Date Filters)
router.get('/', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    let reportData = { 
        type: loggedInUser.role, 
        salesSummary: {}, pnlSummary: {}, orderStatusCounts: [], inventorySummary: {},
        deliveryStatusCounts: [], customerCount: 0, 
        tripSummary: {}, fuelSummary: {}, vehiclePerformance: {}
    }; 
    let viewTitle = 'Reports';
    console.log(`--- Accessing GET /reporting for role: ${loggedInUser.role} ---`);
    console.log("Query Params Received:", req.query);

    try {
        const companyId = loggedInUser.companyId?._id || loggedInUser.companyId;
        const storeIdForUser = loggedInUser.storeId?._id || loggedInUser.storeId;

        // --- Process Date Filters ---
        let startDate = parseDateFilter(req.query.startDate);
        let endDate = parseDateFilter(req.query.endDate, true); 

        // Default date range (e.g., current month) if none provided or invalid
        if (!startDate || !endDate || startDate > endDate) {
            console.log("Applying default date range (Current Month)");
            const now = new Date();
            startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); // Start of current month UTC
            endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999)); // End of current month UTC
            
            // If you prefer last 30 days:
            // endDate = new Date(); 
            // endDate.setUTCHours(23, 59, 59, 999); 
            // startDate = new Date(endDate);
            // startDate.setUTCDate(startDate.getUTCDate() - 30); 
            // startDate.setUTCHours(0, 0, 0, 0); 
        }
        
        // Format dates back to YYYY-MM-DD for sending to the view's input fields
        const currentFilters = {
            startDate: startDate.toISOString().split('T')[0],
            endDate: endDate.toISOString().split('T')[0]
        };
        console.log("Effective Date Range (UTC):", startDate.toISOString(), "to", endDate.toISOString());

        // --- Define Date Range Matchers ---
        // Use $match stages with these date objects
        const dateFilterOrders = { placedDate: { $gte: startDate, $lte: endDate } }; 
        const dateFilterDelivered = { updatedDate: { $gte: startDate, $lte: endDate } }; // For delivered revenue/cogs
        const dateFilterTrips = { tripStartDate: { $gte: startDate, $lte: endDate } }; // Filter trips based on start date
        const dateFilterFuel = { logDate: { $gte: startDate, $lte: endDate } }; 

        switch (loggedInUser.role) {
            case 'warehouse_owner':
            case 'admin':
                const companyQuery = loggedInUser.role === 'admin' ? {} : { companyId: companyId };
                const relevantStoreIds = loggedInUser.role === 'admin' ? null : (await Store.find({ companyId: companyId }).select('_id').lean()).map(s => s._id);
                const relevantWarehouseIds = loggedInUser.role === 'admin' ? null : (await Warehouse.find({ companyId: companyId }).select('_id').lean()).map(w => w._id);

                const matchCompanyOrders = loggedInUser.role === 'admin' ? {} : { storeId: { $in: relevantStoreIds }};
                const matchCompanyItems = loggedInUser.role === 'admin' ? {} : { warehouseId: { $in: relevantWarehouseIds }};
                const matchCompanyTrips = loggedInUser.role === 'admin' ? {} : { companyId: companyId }; 
                const matchCompanyFuel = loggedInUser.role === 'admin' ? {} : { companyId: companyId }; 

                // --- Run Aggregations with Date Filters ---
                
                // Order Status Counts (filter by placedDate)
                reportData.orderStatusCounts = await Order.aggregate([ 
                    { $match: { ...matchCompanyOrders, ...dateFilterOrders } }, 
                    { $group: { _id: '$orderStatus', count: { $sum: 1 } } }, 
                    { $sort: { _id: 1 } } 
                ]);
                
                // Revenue (filter by updatedDate when status became 'delivered')
                const totalSalesResult = await Order.aggregate([ 
                    { $match: { ...matchCompanyOrders, orderStatus: 'delivered', ...dateFilterDelivered } }, 
                    { $group: { _id: null, totalRevenue: { $sum: '$totalAmount' } } } 
                ]);
                reportData.salesSummary.totalRevenue = totalSalesResult[0]?.totalRevenue || 0;
                
                // COGS (match same orders as revenue)
                const cogsResult = await Order.aggregate([ 
                    { $match: { ...matchCompanyOrders, orderStatus: 'delivered', ...dateFilterDelivered } }, 
                    { $unwind: '$orderItems' }, 
                    { $lookup: { from: Item.collection.name, localField: 'orderItems.itemId', foreignField: '_id', as: 'itemDetails' }}, 
                    { $unwind: { path: '$itemDetails', preserveNullAndEmptyArrays: true } }, 
                    { $group: { _id: null, totalCOGS: { $sum: { $multiply: ['$orderItems.quantity', { $ifNull: ['$itemDetails.unitPrice', 0] }] } } }} 
                ]);
                reportData.pnlSummary.totalCOGS = cogsResult[0]?.totalCOGS || 0;
                reportData.pnlSummary.grossProfit = reportData.salesSummary.totalRevenue - reportData.pnlSummary.totalCOGS;
                
                // Inventory Summary (Point-in-time, no date filter usually applied)
                const inventoryData = await Item.aggregate([ { $match: matchCompanyItems }, { $group: { _id: null, totalItems: { $sum: '$quantity' }, distinctSKUs: { $addToSet: '$sku'}, totalCostValue: { $sum: { $multiply: ['$quantity', '$unitPrice'] } } }}, { $project: { _id: 0, totalItems: 1, distinctSKUs: { $size: '$distinctSKUs' }, totalCostValue: 1 }} ]);
                reportData.inventorySummary = inventoryData[0] || { totalItems: 0, distinctSKUs: 0, totalCostValue: 0 };

                // Trip Summary (Filter completed trips within date range by start date)
                const tripStats = await TripLog.aggregate([
                    { $match: { ...matchCompanyTrips, status: 'completed', startOdometer: { $ne: null }, endOdometer: { $ne: null }, ...dateFilterTrips } }, 
                    { $project: { distance: { $subtract: ["$endOdometer", "$startOdometer"] } }},
                    { $match: { distance: { $gte: 0 } } }, 
                    { $group: { _id: null, totalTrips: { $sum: 1 }, totalDistanceKm: { $sum: "$distance" } }}
                ]);
                 reportData.tripSummary = {
                     totalCompletedTrips: tripStats[0]?.totalTrips || 0,
                     totalDistanceKm: parseFloat((tripStats[0]?.totalDistanceKm || 0).toFixed(1)),
                 };
                 reportData.tripSummary.averageDistanceKm = (reportData.tripSummary.totalCompletedTrips > 0) 
                    ? parseFloat((reportData.tripSummary.totalDistanceKm / reportData.tripSummary.totalCompletedTrips).toFixed(1)) 
                    : 0;

                // Fuel Log Summary (Filter fuel logs by log date)
                 const fuelStats = await FuelLog.aggregate([
                     { $match: { ...matchCompanyFuel, ...dateFilterFuel } }, 
                     { $group: { _id: null, totalFuelLiters: { $sum: "$fuelQuantityLiters" }, totalFuelCost: { $sum: "$fuelCostTotalINR" }, logCount: { $sum: 1 } }}
                 ]);
                 reportData.fuelSummary = {
                     totalFuelLiters: parseFloat((fuelStats[0]?.totalFuelLiters || 0).toFixed(2)),
                     totalFuelCost: parseFloat((fuelStats[0]?.totalFuelCost || 0).toFixed(2)),
                     logCount: fuelStats[0]?.logCount || 0
                 };
                 reportData.fuelSummary.averageCostPerLiter = (reportData.fuelSummary.totalFuelLiters > 0) 
                    ? parseFloat((reportData.fuelSummary.totalFuelCost / reportData.fuelSummary.totalFuelLiters).toFixed(2)) 
                    : 0;
                 
                // Calculate Vehicle Performance based on filtered totals
                const totalDistance = reportData.tripSummary.totalDistanceKm;
                const totalFuel = reportData.fuelSummary.totalFuelLiters;
                const totalCost = reportData.fuelSummary.totalFuelCost;
                reportData.vehiclePerformance = {
                    fuelEfficiencyKmL: (totalDistance > 0 && totalFuel > 0) ? (totalDistance / totalFuel).toFixed(2) : 'N/A',
                    costPerKm: (totalDistance > 0 && totalCost > 0) ? (totalCost / totalDistance).toFixed(2) : 'N/A'
                };

                viewTitle = loggedInUser.role === 'admin' ? 'Platform Reports' : 'Company Reports';
                break;

            case 'store_owner':
            case 'employee':
                // Add date filters to store-specific aggregations
                 if (!storeIdForUser) throw new Error("User not assigned to a store.");
                 viewTitle = 'Store Reports';
                 const storeMatch = { storeId: storeIdForUser };

                 reportData.orderStatusCounts = await Order.aggregate([ { $match: { ...storeMatch, ...dateFilterOrders } }, { $group: { _id: '$orderStatus', count: { $sum: 1 } } }, { $sort: { _id: 1 } } ]);
                 const storeSalesResult = await Order.aggregate([ { $match: { ...storeMatch, orderStatus: 'delivered', ...dateFilterDeliveredOrders } }, { $group: { _id: null, totalRevenue: { $sum: '$totalAmount' } } } ]);
                 reportData.salesSummary.totalRevenue = storeSalesResult[0]?.totalRevenue || 0;
                 // Customer count isn't typically date-filtered unless you track first order date
                 reportData.customerCount = await User.countDocuments({ storeId: storeIdForUser, role: 'customer'}); 
                break;

            case 'delivery_partner':
                viewTitle = 'My Delivery Report';
                const driverMatch = { assignedDeliveryPartnerId: loggedInUser._id };
                // Filter driver's deliveries by completion date (updatedDate)
                reportData.deliveryStatusCounts = await Order.aggregate([
                     { $match: { ...driverMatch, orderStatus: { $in: ['shipped', 'delivered', 'cancelled'] }, ...dateFilterDeliveredOrders } }, // Filter relevant statuses within date range
                     { $group: { _id: '$orderStatus', count: { $sum: 1 } } },
                     { $sort: { _id: 1 } }
                ]);
                 // TODO: Add driver-specific trip/fuel stats if needed here, applying date filters
                break;

            default:
                throw new Error('User role does not have access to reports.');
        }

        res.render('reporting/index', { 
            title: viewTitle,
            reportData, 
            currentFilters, // Pass applied filters back to view
            layout: './layouts/dashboard_layout'
        });

    } catch (err) {
         console.error(`Error fetching reports for role ${loggedInUser?.role}:`, err);
         // Pass error message to the view
         res.status(500).render('reporting/index', { 
            title: "Reports Error", 
            reportData: { type: loggedInUser.role, error: `Failed to load report data: ${err.message}` }, // Pass error in reportData
            currentFilters: { // Pass potentially received filters or defaults back
                 startDate: req.query.startDate || new Date(new Date().setDate(new Date().getDate() - 30)).toISOString().split('T')[0], // Example default
                 endDate: req.query.endDate || new Date().toISOString().split('T')[0]
            }, 
            layout: './layouts/dashboard_layout' 
        });
    }
});

// --- DOWNLOAD ROUTES (Keep existing, Add date filter logic) ---
router.get('/sales-summary/csv', async (req, res) => { 
    const loggedInUser = res.locals.loggedInUser;
    console.log(`--- CSV Download: Sales Summary for role ${loggedInUser.role} ---`);
    console.log("Query Params for CSV:", req.query);

    try {
        // --- Process Date Filters ---
        let startDate = parseDateFilter(req.query.startDate);
        let endDate = parseDateFilter(req.query.endDate, true); 
        if (!startDate || !endDate || startDate > endDate) {
            // Use same default as main report or maybe all time? Let's use same default for consistency.
            endDate = new Date(); endDate.setUTCHours(23, 59, 59, 999); 
            startDate = new Date(endDate); startDate.setUTCDate(startDate.getUTCDate() - 30); startDate.setUTCHours(0, 0, 0, 0); 
        }
        const dateFilterDelivered = { updatedDate: { $gte: startDate, $lte: endDate } }; 

        // --- Determine Company/Store Scope ---
        let orderQuery = {};
        if (loggedInUser.role === 'warehouse_owner' && loggedInUser.companyId) {
             const storeIds = (await Store.find({ companyId: loggedInUser.companyId }).select('_id').lean()).map(s => s._id);
             orderQuery.storeId = { $in: storeIds };
        } else if ((loggedInUser.role === 'store_owner' || loggedInUser.role === 'employee') && loggedInUser.storeId) {
             orderQuery.storeId = loggedInUser.storeId;
        } // Admin gets all by default (empty orderQuery)

        // --- Fetch Filtered Delivered Orders ---
        const deliveredOrders = await Order.find({
            ...orderQuery, // Apply company/store filter
            orderStatus: 'delivered',
            ...dateFilterDelivered // Apply date filter
        })
        .populate('storeId', 'storeName')
        .populate('orderItems.itemId', 'name sku unitPrice')
        .sort({ updatedDate: -1 }) // Sort by delivery date
        .lean();

        if (deliveredOrders.length === 0) {
            res.setHeader('Content-Type', 'text/csv');
            res.setHeader('Content-Disposition', `attachment; filename=sales_summary_${startDate.toISOString().split('T')[0]}_to_${endDate.toISOString().split('T')[0]}.csv`);
            return res.status(200).send("Order ID,Order Date,Store Name,Customer Name,Item Name,Item SKU,Quantity Sold,Price at Order (₹),Line Item Revenue (₹),Line Item COGS (₹),Line Item Gross Profit (₹),Order Status\n(No data for selected period)");
        }

        // Transform data for CSV
        const salesDataForCsv = deliveredOrders.flatMap(order => 
             order.orderItems.map(item => {
                const revenue = item.quantity * item.priceAtOrder;
                const cogs = item.quantity * (item.itemId?.unitPrice || 0);
                return {
                    'Order ID': order._id.toString(),
                    'Delivery Date': new Date(order.updatedDate).toLocaleDateString('en-IN'), // Use delivery date
                    'Store Name': order.storeId?.storeName || 'N/A',
                    'Customer Name': order.customerName || 'N/A',
                    'Item Name': item.itemId?.name || 'Unknown Item',
                    'Item SKU': item.itemId?.sku || 'N/A',
                    'Quantity Sold': item.quantity,
                    'Price at Order (₹)': item.priceAtOrder.toFixed(2),
                    'Line Revenue (₹)': revenue.toFixed(2),
                    'Line COGS (₹)': cogs.toFixed(2),
                    'Line Profit (₹)': (revenue - cogs).toFixed(2)
                };
            })
        );

        const fields = ['Order ID', 'Delivery Date', 'Store Name', 'Customer Name', 'Item Name', 'Item SKU', 'Quantity Sold', 'Price at Order (₹)', 'Line Revenue (₹)', 'Line COGS (₹)', 'Line Profit (₹)'];
        const json2csvParser = new Parser({ fields, header: true });
        const csv = json2csvParser.parse(salesDataForCsv);

        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename=sales_summary_${startDate.toISOString().split('T')[0]}_to_${endDate.toISOString().split('T')[0]}.csv`);
        res.status(200).send(csv);

    } catch (err) {
        console.error("Error generating Sales Summary CSV:", err);
        res.status(500).send(`Could not generate CSV: ${err.message}`);
    }
});

module.exports = router;