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
const Vehicle = require('../models/Vehicle');

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

// GET /reporting - Display reporting dashboard based on role
router.get('/', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    let reportData = { 
        type: loggedInUser.role, 
        salesSummary: {}, pnlSummary: {}, orderStatusCounts: [], inventorySummary: {},
        deliveryStatusCounts: [], customerCount: 0, 
        tripSummary: {}, fuelSummary: {}, vehiclePerformance: {},
        perVehicleFuelStats: [], 
        perVehicleTripStats: [],  
        perDriverTripStats: []   
    }; 
    let viewTitle = 'Reports';
    console.log(`--- Accessing GET /reporting for role: ${loggedInUser.role} ---`);

    try {
        const companyId = loggedInUser.companyId?._id || loggedInUser.companyId;
        const storeIdForUser = loggedInUser.storeId?._id || loggedInUser.storeId;

        let startDate = parseDateFilter(req.query.startDate);
        let endDate = parseDateFilter(req.query.endDate, true); 

        if (!startDate || !endDate || startDate > endDate) {
            const now = new Date();
            startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)); 
            endDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0, 23, 59, 59, 999));
        }
        
        const currentFilters = {
            startDate: startDate.toISOString().split('T')[0],
            endDate: endDate.toISOString().split('T')[0]
        };
        console.log("Effective Date Range (UTC):", startDate.toISOString(), "to", endDate.toISOString());

        const dateFilterOrders = { placedDate: { $gte: startDate, $lte: endDate } }; 
        const dateFilterDeliveredOrders = { updatedDate: { $gte: startDate, $lte: endDate } }; 
        const dateFilterTrips = { tripStartDate: { $gte: startDate, $lte: endDate } }; 
        const dateFilterFuel = { logDate: { $gte: startDate, $lte: endDate } }; 

        switch (loggedInUser.role) {
            case 'warehouse_owner':
            case 'admin':
                const companyQuery = loggedInUser.role === 'admin' ? {} : { companyId: companyId };
                const relevantStoreIds = loggedInUser.role === 'admin' ? null : (await Store.find({ companyId: companyId }).select('_id').lean()).map(s => s._id);
                const relevantWarehouseIds = loggedInUser.role === 'admin' ? null : (await Warehouse.find({ companyId: companyId }).select('_id').lean()).map(w => w._id);

                const matchCompanyOrders = loggedInUser.role === 'admin' ? {} : { storeId: { $in: relevantStoreIds || [] }}; // Handle empty relevantStoreIds
                const matchCompanyItems = loggedInUser.role === 'admin' ? {} : { warehouseId: { $in: relevantWarehouseIds || [] }};
                const matchCompanyTrips = loggedInUser.role === 'admin' ? {} : { companyId: companyId }; 
                const matchCompanyFuel = loggedInUser.role === 'admin' ? {} : { companyId: companyId }; 

                // Order Status Counts
                reportData.orderStatusCounts = await Order.aggregate([ 
                    { $match: { ...matchCompanyOrders, ...dateFilterOrders } }, 
                    { $group: { _id: '$orderStatus', count: { $sum: 1 } } }, { $sort: { _id: 1 } } 
                ]);
                
                // Revenue
                const totalSalesResult = await Order.aggregate([ 
                    { $match: { ...matchCompanyOrders, orderStatus: 'delivered', ...dateFilterDeliveredOrders } }, 
                    { $group: { _id: null, totalRevenue: { $sum: '$totalAmount' } } } 
                ]);
                reportData.salesSummary.totalRevenue = totalSalesResult[0]?.totalRevenue || 0;
                
                // COGS
                const cogsResult = await Order.aggregate([ 
                    { $match: { ...matchCompanyOrders, orderStatus: 'delivered', ...dateFilterDeliveredOrders } }, 
                    { $unwind: '$orderItems' }, 
                    { $lookup: { from: Item.collection.name, localField: 'orderItems.itemId', foreignField: '_id', as: 'itemDetails' }}, 
                    { $unwind: { path: '$itemDetails', preserveNullAndEmptyArrays: true } }, 
                    { $group: { _id: null, totalCOGS: { $sum: { $multiply: ['$orderItems.quantity', { $ifNull: ['$itemDetails.unitPrice', 0] }] } } }} 
                ]);
                reportData.pnlSummary.totalCOGS = cogsResult[0]?.totalCOGS || 0;
                reportData.pnlSummary.grossProfit = reportData.salesSummary.totalRevenue - reportData.pnlSummary.totalCOGS;
                
                // Inventory Summary
                const inventoryData = await Item.aggregate([ { $match: matchCompanyItems }, { $group: { _id: null, totalItems: { $sum: '$quantity' }, distinctSKUs: { $addToSet: '$sku'}, totalCostValue: { $sum: { $multiply: ['$quantity', '$unitPrice'] } } }}, { $project: { _id: 0, totalItems: 1, distinctSKUs: { $size: '$distinctSKUs' }, totalCostValue: 1 }} ]);
                reportData.inventorySummary = inventoryData[0] || { totalItems: 0, distinctSKUs: 0, totalCostValue: 0 };

                // Overall Trip Summary
                const tripStats = await TripLog.aggregate([
                    { $match: { ...matchCompanyTrips, status: 'completed', startOdometer: { $ne: null }, endOdometer: { $ne: null }, ...dateFilterTrips } }, 
                    { $project: { distance: { $subtract: ["$endOdometer", "$startOdometer"] } }},
                    { $match: { distance: { $gte: 0 } } }, 
                    { $group: { _id: null, totalTrips: { $sum: 1 }, totalDistanceKm: { $sum: "$distance" } }}
                ]);
                 reportData.tripSummary = {
                     totalCompletedTrips: tripStats[0]?.totalTrips || 0,
                     totalDistanceKm: parseFloat((tripStats[0]?.totalDistanceKm || 0).toFixed(1)),
                     averageDistanceKm: (tripStats[0]?.totalTrips > 0) ? parseFloat(((tripStats[0]?.totalDistanceKm || 0) / tripStats[0]?.totalTrips).toFixed(1)) : 0,
                 };

                // Overall Fuel Log Summary
                 const fuelStats = await FuelLog.aggregate([
                     { $match: { ...matchCompanyFuel, ...dateFilterFuel } }, 
                     { $group: { _id: null, totalFuelLiters: { $sum: "$fuelQuantityLiters" }, totalFuelCost: { $sum: "$fuelCostTotalINR" }, logCount: { $sum: 1 } }}
                 ]);
                 reportData.fuelSummary = {
                     totalFuelLiters: parseFloat((fuelStats[0]?.totalFuelLiters || 0).toFixed(2)),
                     totalFuelCost: parseFloat((fuelStats[0]?.totalFuelCost || 0).toFixed(2)),
                     logCount: fuelStats[0]?.logCount || 0,
                     averageCostPerLiter: (fuelStats[0]?.totalFuelLiters > 0) ? parseFloat(((fuelStats[0]?.totalFuelCost || 0) / fuelStats[0]?.totalFuelLiters).toFixed(2)) : 0,
                 };
                 
                // Overall Vehicle Performance
                reportData.vehiclePerformance = {
                    fuelEfficiencyKmL: (reportData.tripSummary.totalDistanceKm > 0 && reportData.fuelSummary.totalFuelLiters > 0) ? (reportData.tripSummary.totalDistanceKm / reportData.fuelSummary.totalFuelLiters).toFixed(2) : 'N/A',
                    costPerKm: (reportData.tripSummary.totalDistanceKm > 0 && reportData.fuelSummary.totalFuelCost > 0) ? (reportData.fuelSummary.totalFuelCost / reportData.tripSummary.totalDistanceKm).toFixed(2) : 'N/A'
                };

                // Per-Vehicle Fuel Stats
                reportData.perVehicleFuelStats = await FuelLog.aggregate([
                    { $match: { ...matchCompanyFuel, ...dateFilterFuel } },
                    { $group: { _id: "$vehicleId", totalLiters: { $sum: "$fuelQuantityLiters" }, totalCost: { $sum: "$fuelCostTotalINR" }, logCount: { $sum: 1 } }},
                    { $lookup: { from: Vehicle.collection.name, localField: "_id", foreignField: "_id", as: "vehicleDetails" }},
                    { $unwind: { path: "$vehicleDetails", preserveNullAndEmptyArrays: true } },
                    { $project: { _id: 0, vehicleId: "$_id", vehicleNumber: { $ifNull: [ "$vehicleDetails.vehicleNumber", "Unknown" ] }, modelName: { $ifNull: [ "$vehicleDetails.modelName", "" ] }, totalLiters: { $round: ["$totalLiters", 2] }, totalCost: { $round: ["$totalCost", 2] }, logCount: 1, avgCostPerLiter: { $cond: { if: { $gt: ["$totalLiters", 0] }, then: { $round: [{ $divide: ["$totalCost", "$totalLiters"] }, 2] }, else: 0 } } }},
                    { $sort: { vehicleNumber: 1 } }
                ]);

                // Per-Vehicle Trip Stats
                reportData.perVehicleTripStats = await TripLog.aggregate([
                    { $match: { ...matchCompanyTrips, status: 'completed', startOdometer: { $ne: null }, endOdometer: { $ne: null }, ...dateFilterTrips } },
                    { $project: { vehicleId: 1, distance: { $subtract: ["$endOdometer", "$startOdometer"] } }},
                    { $match: { distance: { $gte: 0 } } },
                    { $group: { _id: "$vehicleId", totalTrips: { $sum: 1 }, totalDistanceKm: { $sum: "$distance" } }},
                    { $lookup: { from: Vehicle.collection.name, localField: "_id", foreignField: "_id", as: "vehicleDetails" }},
                    { $unwind: { path: "$vehicleDetails", preserveNullAndEmptyArrays: true } },
                    { $project: { _id: 0, vehicleId: "$_id", vehicleNumber: { $ifNull: [ "$vehicleDetails.vehicleNumber", "Unknown" ] }, modelName: { $ifNull: [ "$vehicleDetails.modelName", "" ] }, totalTrips: 1, totalDistanceKm: { $round: ["$totalDistanceKm", 1] }, avgDistancePerTrip: { $cond: { if: { $gt: ["$totalTrips", 0] }, then: { $round: [{ $divide: ["$totalDistanceKm", "$totalTrips"] }, 1] }, else: 0 } } }},
                    { $sort: { vehicleNumber: 1 } }
                ]);

                // Per-Driver Trip Stats
                reportData.perDriverTripStats = await TripLog.aggregate([
                    { $match: { ...matchCompanyTrips, status: 'completed', startOdometer: { $ne: null }, endOdometer: { $ne: null }, ...dateFilterTrips } },
                    { $project: { driverId: 1, distance: { $subtract: ["$endOdometer", "$startOdometer"] } }},
                    { $match: { distance: { $gte: 0 } } },
                    { $group: { _id: "$driverId", totalTrips: { $sum: 1 }, totalDistanceKm: { $sum: "$distance" } }},
                    { $lookup: { from: User.collection.name, localField: "_id", foreignField: "_id", as: "driverDetails" }},
                    { $unwind: { path: "$driverDetails", preserveNullAndEmptyArrays: true } },
                    { $project: { _id: 0, driverId: "$_id", driverName: { $ifNull: [ "$driverDetails.username", "Unknown" ] }, totalTrips: 1, totalDistanceKm: { $round: ["$totalDistanceKm", 1] }, avgDistancePerTrip: { $cond: { if: { $gt: ["$totalTrips", 0] }, then: { $round: [{ $divide: ["$totalDistanceKm", "$totalTrips"] }, 1] }, else: 0 } } }},
                    { $sort: { driverName: 1 } }
                ]);
                
                viewTitle = loggedInUser.role === 'admin' ? 'Platform Reports' : 'Company Reports';
                break;

            case 'store_owner':
            case 'employee':
                 if (!storeIdForUser) throw new Error("User not assigned to a store.");
                 viewTitle = 'Store Reports';
                 const storeMatch = { storeId: storeIdForUser };
                 reportData.orderStatusCounts = await Order.aggregate([ { $match: { ...storeMatch, ...dateFilterOrders } }, { $group: { _id: '$orderStatus', count: { $sum: 1 } } }, { $sort: { _id: 1 } } ]);
                 const storeSalesResult = await Order.aggregate([ { $match: { ...storeMatch, orderStatus: 'delivered', ...dateFilterDeliveredOrders } }, { $group: { _id: null, totalRevenue: { $sum: '$totalAmount' } } } ]);
                 reportData.salesSummary.totalRevenue = storeSalesResult[0]?.totalRevenue || 0;
                 reportData.customerCount = await User.countDocuments({ storeId: storeIdForUser, role: 'customer'}); 
                break;

            case 'delivery_partner':
                viewTitle = 'My Delivery Report';
                const driverMatch = { assignedDeliveryPartnerId: loggedInUser._id };
                reportData.deliveryStatusCounts = await Order.aggregate([
                     { $match: { ...driverMatch, orderStatus: { $in: ['shipped', 'delivered', 'cancelled'] }, ...dateFilterDeliveredOrders } },
                     { $group: { _id: '$orderStatus', count: { $sum: 1 } } }, { $sort: { _id: 1 } }
                ]);
                // TODO: Add driver-specific trip/fuel stats, filtered by driverId and date
                break;

            default:
                reportData.error = 'No report data available for your role.';
        }

        res.render('reporting/index', { 
            title: viewTitle,
            reportData, 
            currentFilters, 
            layout: './layouts/dashboard_layout' 
        });

    } catch (err) {
         console.error(`Error fetching reports for role ${loggedInUser?.role}:`, err);
         res.status(500).render('reporting/index', { 
            title: "Reports Error", 
            reportData: { type: loggedInUser.role, error: `Failed to load report data: ${err.message}` },
            currentFilters: { 
                 startDate: req.query.startDate || new Date(new Date().setDate(new Date().getDate() - 30)).toISOString().split('T')[0],
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


// --- NEW: GET /reporting/trips - List Trip Logs ---
router.get('/trips', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    const page = parseInt(req.query.page) || 1;
    const limit = 20; // Trips per page
    const skip = (page - 1) * limit;
    let errorMsg = null;

    // Authorization: Only Admin or Warehouse Owner for now
    if (!['admin', 'warehouse_owner'].includes(loggedInUser.role)) {
        return res.status(403).render('error_page', { title: "Access Denied", message: "You do not have permission to view trip logs.", layout: './layouts/dashboard_layout' });
    }

    try {
        const companyId = loggedInUser.companyId?._id || loggedInUser.companyId;

        // --- Date Filters ---
        let startDate = parseDateFilter(req.query.startDate);
        let endDate = parseDateFilter(req.query.endDate, true);
        
        // Build query
        let query = {};
        if (loggedInUser.role === 'warehouse_owner') {
            if (!companyId) throw new Error("User not associated with a company.");
            query.companyId = companyId;
        }
        // Apply date filters if both are valid
        if (startDate && endDate && startDate <= endDate) {
            query.tripStartDate = { $gte: startDate, $lte: endDate };
        }

        const [tripLogs, totalTrips] = await Promise.all([
            TripLog.find(query)
                .populate('driverId', 'username') // Populate driver's username
                .populate('vehicleId', 'vehicleNumber modelName') // Populate vehicle details
                .sort({ tripStartDate: -1 }) // Newest trips first
                .skip(skip)
                .limit(limit)
                .lean(),
            TripLog.countDocuments(query)
        ]);

        tripLogs.forEach(trip => {
            if (trip.startOdometer != null && trip.endOdometer != null) {
                trip.distanceKm = trip.endOdometer - trip.startOdometer;
            } else {
                trip.distanceKm = 'N/A';
            }
        });
        
        const totalPages = Math.ceil(totalTrips / limit);

        // Format dates for input fields to retain values
        const currentFilters = {
            startDate: startDate ? startDate.toISOString().split('T')[0] : '',
            endDate: endDate ? endDate.toISOString().split('T')[0] : ''
        };

        res.render('reporting/trip_log', {
            title: 'Trip Logs',
            tripLogs,
            totalPages,
            currentPage: page,
            limit,
            totalTrips,
            currentFilters, // Pass current filters back to the view
            error_msg: req.query.error || errorMsg, // From redirects or internal
            success_msg: req.query.success,
            layout: './layouts/dashboard_layout'
        });

    } catch (err) {
        console.error("Error fetching trip logs:", err);
        res.status(500).render('error_page', { 
            title: "Error", 
            message: `Failed to load trip logs: ${err.message}`, 
            layout: './layouts/dashboard_layout' 
        });
    }
});

// --- NEW: GET /reporting/fuel-logs - List Fuel Log Entries ---
router.get('/fuel-logs', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    const page = parseInt(req.query.page) || 1;
    const limit = 20; // Fuel logs per page
    const skip = (page - 1) * limit;
    let errorMsg = null;

    // Authorization: Only Admin or Warehouse Owner for now
    if (!['admin', 'warehouse_owner'].includes(loggedInUser.role)) {
        return res.status(403).render('error_page', { title: "Access Denied", message: "You do not have permission to view fuel logs.", layout: './layouts/dashboard_layout' });
    }

    try {
        const companyId = loggedInUser.companyId?._id || loggedInUser.companyId;

        // --- Date Filters ---
        let startDate = parseDateFilter(req.query.startDate);
        let endDate = parseDateFilter(req.query.endDate, true); 
        
        // Build query
        let query = {};
        if (loggedInUser.role === 'warehouse_owner') {
            if (!companyId) throw new Error("User not associated with a company.");
            query.companyId = companyId;
        }
        // Apply date filters if both are valid
        if (startDate && endDate && startDate <= endDate) {
            query.logDate = { $gte: startDate, $lte: endDate }; // Filter by logDate
        }

        const [fuelLogs, totalLogs] = await Promise.all([
            FuelLog.find(query)
                .populate('driverId', 'username') 
                .populate('vehicleId', 'vehicleNumber modelName type') 
                .sort({ logDate: -1 }) // Newest logs first
                .skip(skip)
                .limit(limit)
                .lean(),
            FuelLog.countDocuments(query)
        ]);

        // Calculate cost per liter for each log (if not already stored)
        fuelLogs.forEach(log => {
            if (log.fuelQuantityLiters > 0 && log.fuelCostTotalINR >= 0) {
                log.costPerLiter = (log.fuelCostTotalINR / log.fuelQuantityLiters).toFixed(2);
            } else {
                log.costPerLiter = 'N/A';
            }
        });
        
        const totalPages = Math.ceil(totalLogs / limit);

        const currentFilters = {
            startDate: startDate ? startDate.toISOString().split('T')[0] : '',
            endDate: endDate ? endDate.toISOString().split('T')[0] : ''
        };

        res.render('reporting/fuel_log', { // New EJS view
            title: 'Fuel Logs',
            fuelLogs,
            totalPages,
            currentPage: page,
            limit,
            totalLogs,
            currentFilters,
            error_msg: req.query.error || errorMsg,
            success_msg: req.query.success,
            layout: './layouts/dashboard_layout'
        });

    } catch (err) {
        console.error("Error fetching fuel logs:", err);
        res.status(500).render('error_page', { 
            title: "Error", 
            message: `Failed to load fuel logs: ${err.message}`, 
            layout: './layouts/dashboard_layout' 
        });
    }
});

module.exports = router;