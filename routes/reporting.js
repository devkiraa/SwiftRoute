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


// GET /reporting - Display reporting dashboard
router.get('/', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    let reportData = { type: loggedInUser.role, salesSummary: {}, pnlSummary: {} }; // Initialize
    let viewTitle = 'Reports';
    console.log(`--- Accessing GET /reporting for role: ${loggedInUser.role} ---`);

    try {
        const companyId = loggedInUser.companyId?._id || loggedInUser.companyId;
        const storeIdForUser = loggedInUser.storeId?._id || loggedInUser.storeId;

        // --- Date Range (Placeholder for now - implement with date pickers later) ---
        // Example: const startDate = new Date(new Date().getFullYear(), 0, 1); // Start of year
        // const endDate = new Date(); // Today
        // Add { placedDate: { $gte: startDate, $lte: endDate } } to $match stages

        switch (loggedInUser.role) {
            case 'warehouse_owner':
            case 'admin':
                const companyScopeQuery = loggedInUser.role === 'admin' ? {} : { companyId: companyId };
                const relevantStoreIds = (await Store.find(companyScopeQuery).select('_id').lean()).map(s => s._id);
                const relevantWarehouseIds = (await Warehouse.find(companyScopeQuery).select('_id').lean()).map(w => w._id);

                if (relevantStoreIds.length === 0 && loggedInUser.role === 'warehouse_owner') {
                    console.warn("Warehouse owner has no stores associated with their company.");
                }

                // 1. Order Status Counts
                reportData.orderStatusCounts = await Order.aggregate([
                    { $match: { storeId: { $in: relevantStoreIds } } }, // Filter by company's stores
                    { $group: { _id: '$orderStatus', count: { $sum: 1 } } },
                    { $sort: { _id: 1 } }
                ]);

                // 2. Total Revenue (from delivered orders)
                const totalSalesResult = await Order.aggregate([
                    { $match: { storeId: { $in: relevantStoreIds }, orderStatus: 'delivered' } },
                    { $group: { _id: null, totalRevenue: { $sum: '$totalAmount' } } }
                ]);
                reportData.salesSummary.totalRevenue = totalSalesResult[0]?.totalRevenue || 0;

                // 3. Cost of Goods Sold (COGS) for P&L
                const cogsResult = await Order.aggregate([
                    { $match: { storeId: { $in: relevantStoreIds }, orderStatus: 'delivered' } },
                    { $unwind: '$orderItems' },
                    { $lookup: { // Get unitPrice from Item model
                        from: Item.collection.name,
                        localField: 'orderItems.itemId',
                        foreignField: '_id',
                        as: 'itemDetails'
                    }},
                    { $unwind: { path: '$itemDetails', preserveNullAndEmptyArrays: true } }, // Handle if item was deleted
                    { $group: {
                        _id: null,
                        totalCOGS: { $sum: { $multiply: ['$orderItems.quantity', { $ifNull: ['$itemDetails.unitPrice', 0] }] } } // Use 0 if unitPrice missing
                    }}
                ]);
                reportData.pnlSummary.totalCOGS = cogsResult[0]?.totalCOGS || 0;
                reportData.pnlSummary.grossProfit = reportData.salesSummary.totalRevenue - reportData.pnlSummary.totalCOGS;


                // 4. Inventory Summary (Value based on Unit Cost)
                const inventoryData = await Item.aggregate([
                    { $match: { warehouseId: { $in: relevantWarehouseIds } } }, // Items in company's warehouses
                    { $group: {
                        _id: null,
                        totalItems: { $sum: '$quantity' },
                        distinctSKUs: { $addToSet: '$sku'},
                        totalCostValue: { $sum: { $multiply: ['$quantity', '$unitPrice'] } }
                    }},
                    { $project: { _id: 0, totalItems: 1, distinctSKUs: { $size: '$distinctSKUs' }, totalCostValue: 1 }}
                ]);
                reportData.inventorySummary = inventoryData[0] || { totalItems: 0, distinctSKUs: 0, totalCostValue: 0 };

                viewTitle = loggedInUser.role === 'admin' ? 'Platform Reports' : 'Company Reports';
                break;

            // --- Cases for 'store_owner', 'employee', 'delivery_partner' (Keep similar logic as before) ---
            case 'store_owner':
            case 'employee':
                // ... (Fetch store-specific data: totalRevenue, orderStatusCounts, customerCount) ...
                break;
            case 'delivery_partner':
                // ... (Fetch deliveryStatusCounts) ...
                break;
            default:
                throw new Error('User role does not have access to reports.');
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