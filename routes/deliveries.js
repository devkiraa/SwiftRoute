// routes/deliveries.js
const express = require('express');
const axios = require('axios');
const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Store = require('../models/Store');
const Item = require('../models/Item');
const Warehouse = require('../models/Warehouse');
const { RouteOptimizationClient } = require('@googlemaps/routeoptimization');

// Import Google Maps Client
const { Client, Status } = require("@googlemaps/google-maps-services-js");
const googleMapsClient = new Client({});
// *** USE ENV VARIABLE NAME FROM YOUR .env FILE ***
const Maps_API_KEY_CONFIG = { key: process.env.Maps_API_KEY }; // Use Maps_API_KEY here

const router = express.Router();
const routingClient = new RouteOptimizationClient();

// --- Local Auth Middleware ---
function ensureAuthenticated(req, res, next) {
    if (res.locals.loggedInUser) return next();
    res.redirect('/login');
}
function ensureDeliveryPartner(req, res, next) {
    const loggedInUser = res.locals.loggedInUser;
    if (loggedInUser?.role === 'delivery_partner') return next();
    res.status(403).render('error_page', { title: "Access Denied", message: "Delivery Partner role required.", layout: './layouts/dashboard_layout'});
}
// --- End Local Auth Middleware ---

router.use(ensureAuthenticated, ensureDeliveryPartner);

// GET /deliveries/my - Show Aggregated Loading List and Individual Orders
router.get('/my', async (req, res) => {
    console.log("--- Accessing GET /deliveries/my ---");
    const loggedInUser = res.locals.loggedInUser;
    let originWarehouse = null;
    let aggregatedItems = [];
    let ordersForPickup = [];
    let ordersInProgress = [];
    let showPickupButton = false;

    try {
        // 1. Find all active orders assigned to driver
        const allAssignedOrders = await Order.find({
            assignedDeliveryPartnerId: loggedInUser._id,
            orderStatus: { $in: ['confirmed', 'shipped'] }
        })
        .populate('warehouseId', 'name location address _id')
        .populate('storeId', 'storeName')
        .sort({ placedDate: 1 }).lean();
        console.log(`Found ${allAssignedOrders.length} total active assigned orders.`);

        if (allAssignedOrders.length > 0) {
            // 2. Determine Origin & Check consistency
            originWarehouse = allAssignedOrders[0].warehouseId;
            if (!originWarehouse?._id) { throw new Error("Cannot determine origin warehouse."); }
            const originWarehouseId = originWarehouse._id;
            const allFromSameWarehouse = allAssignedOrders.every(order => {
                const currentWarehouseId = order.warehouseId?._id;
                if (!currentWarehouseId) { console.warn(`Order ${order._id} missing warehouseId.`); return false; }
                return currentWarehouseId.toString() === originWarehouseId.toString();
            });
            if (!allFromSameWarehouse) { throw new Error("Deliveries assigned from multiple warehouses."); }
            console.log(`All orders originate from warehouse: ${originWarehouse.name} (${originWarehouseId})`);

            // Separate orders
            ordersForPickup = allAssignedOrders.filter(o => o.orderStatus === 'confirmed');
            ordersInProgress = allAssignedOrders.filter(o => o.orderStatus === 'shipped');
            showPickupButton = ordersForPickup.length > 0;
            console.log(`Orders for pickup: ${ordersForPickup.length}, Orders in progress: ${ordersInProgress.length}`); // Log counts

             // *** Log the orders being aggregated ***
             if (showPickupButton) {
                 console.log("Orders used for aggregation:", JSON.stringify(ordersForPickup.map(o => ({_id: o._id, items: o.orderItems})), null, 2));
             }

            // 3. Aggregate Items
            if (showPickupButton) {
                console.log("Aggregating items for pickup list...");
                try {
                    aggregatedItems = await Order.aggregate([
                        { $match: { _id: { $in: ordersForPickup.map(o => o._id) } }}, // Match specific confirmed order IDs
                        { $unwind: "$orderItems" },
                        { $group: { _id: "$orderItems.itemId", totalQuantity: { $sum: "$orderItems.quantity" } } },
                        { $lookup: { from: Item.collection.name, localField: "_id", foreignField: "_id", as: "itemDetails" }},
                        { $unwind: { path: "$itemDetails", preserveNullAndEmptyArrays: true } },
                        { $project: { _id: 0, itemId: "$_id", name: { $ifNull: [ "$itemDetails.name", "Unknown Item" ] }, sku: { $ifNull: [ "$itemDetails.sku", "N/A" ] }, neededQuantity: "$totalQuantity" }},
                        { $sort: { name: 1 } }
                    ]);
                    console.log(`Aggregation complete. Found ${aggregatedItems.length} unique items.`);
                    // Log if lookup failed for any items
                    if (aggregatedItems.some(item => item.name === 'Unknown Item')) {
                        console.warn("Warning: Some items in confirmed orders could not be found in the Item collection (check itemIds).");
                    }
                } catch (aggError) {
                    console.error("Error during item aggregation:", aggError);
                    throw aggError; // Re-throw
                }
            } else {
                 console.log("No orders in 'confirmed' status, skipping item aggregation.");
            }
        }

        console.log("Rendering deliveries/my_deliveries view...");
        res.render('deliveries/my_deliveries', {
            title: 'My Deliveries & Loading List', originWarehouse, aggregatedItems,
            ordersForPickup, ordersInProgress, showPickupButton,
            error: req.query.error, success_msg: req.query.success, layout: './layouts/dashboard_layout'
        });
        console.log("Finished rendering deliveries/my_deliveries view.");

    } catch (err) {
        console.error(`Error in GET /deliveries/my for driver ${loggedInUser?._id}:`, err);
        res.status(500).render('error_page', { title: "Error", message: `Failed to load deliveries: ${err.message}`, layout: false });
    }
});

// GET /deliveries/map — OSRM + Nearest-Neighbor Optimization
router.get('/map', async (req, res) => {
    console.log('--- GET /deliveries/map (OSRM NN) ---');
    const driverId = res.locals.loggedInUser._id;
  
    try {
      const all = await Order.find({
        assignedDeliveryPartnerId: driverId,
        orderStatus: { $in: ['confirmed', 'shipped'] }
      })
        .populate('warehouseId', 'location')
        .populate('shippingLocation')
        .populate('storeId', 'location')
        .lean();
  
      const points = [];
      const uniqueCoords = [];
      all.forEach(o => {
        const wh = o.warehouseId?.location?.coordinates;
        const dl = (o.shippingLocation?.coordinates?.length === 2)
          ? o.shippingLocation.coordinates
          : o.storeId?.location?.coordinates;
        if (wh?.length === 2 && dl?.length === 2) {
          points.push(o);
          if (uniqueCoords.length === 0) uniqueCoords.push({ lat: wh[1], lng: wh[0] });
          uniqueCoords.push({ lat: dl[1], lng: dl[0] });
        }
      });
      if (!points.length) {
        return res.render('deliveries/route_map', {
          title: 'Optimized Delivery Route', orders: [], originWarehouse: null,
          routePolyline: null, legs: [], googleMapsApiKey: process.env.Maps_API_KEY,
          errorMsg: 'No valid delivery locations.', layout: './layouts/dashboard_layout'
        });
      }
  
      const coordList = uniqueCoords.map(c => `${c.lng},${c.lat}`).join(';');
      const tableUrl = `http://router.project-osrm.org/table/v1/driving/${coordList}?annotations=distance,duration`;
      const { distances, durations } = (await axios.get(tableUrl)).data;
  
      const N = distances.length;
      const visited = Array(N).fill(false);
      visited[0] = true;
      const visitOrder = [0];
      let current = 0;
      const alpha = 1.0, beta = 0.5;
      for (let i = 1; i < N; i++) {
        let best = { idx: -1, cost: Infinity };
        for (let j = 1; j < N; j++) {
          if (!visited[j]) {
            const cost = alpha * distances[current][j] + beta * durations[current][j];
            if (cost < best.cost) best = { idx: j, cost };
          }
        }
        visited[best.idx] = true;
        visitOrder.push(best.idx);
        current = best.idx;
      }
      visitOrder.push(0);
  
      // Build route legs for client: pairs of coordinates
      const legs = [];
      for (let i = 0; i < visitOrder.length - 1; i++) {
        const a = uniqueCoords[visitOrder[i]];
        const b = uniqueCoords[visitOrder[i+1]];
        legs.push([a, b]);
      }
  
      // Map back orders in optimized order
      const finalOrders = visitOrder.slice(1, -1).map(i => points[i-1]);
      const originWarehouse = points[0].warehouseId;
  
      res.render('deliveries/route_map', {
        title: 'Optimized Delivery Route', orders: finalOrders,
        originWarehouse, legs, googleMapsApiKey: process.env.Maps_API_KEY,
        errorMsg: null, layout: './layouts/dashboard_layout'
      });
    } catch (err) {
      console.error('Error in /deliveries/map:', err);
      res.status(500).render('deliveries/route_map', {
        title: 'Error Loading Route', orders: [], originWarehouse: null,
        legs: [], googleMapsApiKey: process.env.Maps_API_KEY,
        errorMsg: `Server error: ${err.message}`, layout: './layouts/dashboard_layout'
      });
    }
  });
  
    // --- Status Update Routes ---

// POST /deliveries/batch-pickup - Mark ALL confirmed orders for the warehouse as shipped
router.post('/batch-pickup', async (req, res) => {
  const loggedInUser = res.locals.loggedInUser;
  console.log(`--- Driver ${loggedInUser._id} attempting BATCH pickup ---`);
  let originWarehouseId = null;
  // const session = await mongoose.startSession(); // For transaction
  // session.startTransaction();

  try {
      // Find ALL 'confirmed' orders for this driver to get warehouse and aggregate items
      const ordersToPick = await Order.find({
          assignedDeliveryPartnerId: loggedInUser._id,
          orderStatus: 'confirmed'
      }).populate('orderItems.itemId', 'name sku quantity') // Populate items needed
        .select('warehouseId orderItems') // Select only needed fields initially
        .lean();

      if (ordersToPick.length === 0) throw new Error("No confirmed orders found ready for pickup.");

      // Determine and validate warehouse
      originWarehouseId = ordersToPick[0].warehouseId;
      if (!originWarehouseId) throw new Error("Could not determine origin warehouse from orders.");
      const allFromSameWarehouse = ordersToPick.every(o => o.warehouseId?.toString() === originWarehouseId.toString());
      if (!allFromSameWarehouse) throw new Error("Cannot batch pickup from multiple warehouses.");
      console.log(`Attempting batch pickup from warehouse ${originWarehouseId}`);

      // Aggregate ALL items needed for ALL these confirmed orders
      const itemsToAggregate = ordersToPick.flatMap(o => o.orderItems); // Get flat list of all order items
      const itemQuantitiesNeeded = itemsToAggregate.reduce((acc, current) => {
          const itemIdStr = current.itemId?._id?.toString();
          if (itemIdStr) {
              acc[itemIdStr] = (acc[itemIdStr] || 0) + current.quantity;
          }
          return acc;
      }, {}); // Result: { "itemId1": totalQty, "itemId2": totalQty, ... }
      const neededItemIds = Object.keys(itemQuantitiesNeeded);

      console.log("Aggregated items for stock check:", itemQuantitiesNeeded);

      // --- CRITICAL STOCK CHECK ---
      if (neededItemIds.length > 0) {
          console.log("Checking stock levels...");
          const stockItems = await Item.find({
              _id: { $in: neededItemIds },
              warehouseId: originWarehouseId // Check stock in the correct warehouse
          }).lean();
          const stockMap = new Map(stockItems.map(i => [i._id.toString(), i.quantity]));

          for (const itemId of neededItemIds) {
               const needed = itemQuantitiesNeeded[itemId];
               const available = stockMap.get(itemId) ?? -1; // Use ?? for safety if item missing
               if (available < needed) {
                   const failedItem = await Item.findById(itemId).select('name sku').lean(); // Get details for error msg
                   throw new Error(`Insufficient stock for ${failedItem?.name || 'Unknown Item'} (SKU: ${failedItem?.sku || 'N/A'}). Available: ${available < 0 ? 0 : available}, Needed: ${needed}`);
               }
               console.log(`Stock OK for item ${itemId}. Available: ${available}, Needed: ${needed}`);
          }
          console.log("Stock check passed for all items.");
      }


      // --- Perform Stock Deduction ---
      let stockUpdates = [];
      for (const itemId of neededItemIds) {
           stockUpdates.push(
               Item.findByIdAndUpdate(itemId, { $inc: { quantity: -itemQuantitiesNeeded[itemId] } } /*, { session }*/ )
           );
      }
      if (stockUpdates.length > 0) {
           console.log(`Executing ${stockUpdates.length} stock deductions...`);
           await Promise.all(stockUpdates); // Run updates
           console.log("Stock deductions successful.");
      }


      // --- Update Order Statuses ---
      const orderIdsToUpdate = ordersToPick.map(o => o._id);
      console.log(`Updating status to 'shipped' for ${orderIdsToUpdate.length} orders...`);
      const updateResult = await Order.updateMany(
          { _id: { $in: orderIdsToUpdate } },
          { $set: { orderStatus: 'shipped', updatedDate: new Date() } }
          // { session } // Add session if using transactions
      );
      console.log(`Batch pickup complete: ${updateResult.modifiedCount} orders marked as 'shipped'.`);

      // await session.commitTransaction(); // Commit transaction
      res.redirect('/deliveries/map?success=Orders+picked+up.+Route+ready.'); // Redirect to map

  } catch (err) {
      // await session.abortTransaction(); // Abort on error
      console.error(`Error during batch pickup from warehouse ${originWarehouseId}:`, err);
      res.redirect(`/deliveries/my?error=${encodeURIComponent(`Pickup failed: ${err.message}`)}`);
  } finally {
     // if (session) session.endSession(); // Always end session
  }
});

// POST /deliveries/:orderId/delivered - Mark order as delivered
router.post('/:orderId/delivered', async (req, res) => {
     const orderId = req.params.orderId;
     const loggedInUser = res.locals.loggedInUser;
     console.log(`--- Driver ${loggedInUser._id} attempting delivery for order ${orderId} ---`);

     if (!mongoose.Types.ObjectId.isValid(orderId)) {
        // req.flash('error_msg', 'Invalid Order ID.');
        return res.redirect('/deliveries/my?error=Invalid+Order+ID');
     }

     try {
        // Fetch full Mongoose document
        const order = await Order.findById(orderId);
        if (!order) {
            throw new Error("Order not found.");
        }

        // Authorization: Is this driver assigned?
        if (order.assignedDeliveryPartnerId?.toString() !== loggedInUser._id.toString()) {
            throw new Error("You are not assigned to this delivery.");
        }

        // Validation: Can only deliver 'shipped' orders
        if (order.orderStatus !== 'shipped') {
            throw new Error(`Order status is currently '${order.orderStatus}', cannot mark as delivered (requires 'shipped').`);
        }

        // *** TODO: Handle proof of delivery if needed (e.g., signature image upload) ***

        // Update Status
        order.orderStatus = 'delivered';
        order.updatedDate = new Date();
        // Optionally record delivery timestamp
        // order.deliveryTimestamp = new Date();

        await order.save();
        console.log(`Order ${orderId} marked as 'delivered' by driver ${loggedInUser._id}`);

        // *** TODO: Trigger Notifications? ***

        // Add flash message for success
        // req.flash('success_msg', 'Order marked as delivered.');
        res.redirect('/deliveries/my?success=Order+marked+as+delivered'); // Redirect back to list

     } catch (err) {
         console.error(`Error marking order ${orderId} as delivered:`, err);
         // Add flash message for error
         // req.flash('error_msg', `Error: ${err.message}`);
         res.redirect(`/deliveries/my?error=${encodeURIComponent(err.message)}`); // Redirect back with error
     }
});


module.exports = router;