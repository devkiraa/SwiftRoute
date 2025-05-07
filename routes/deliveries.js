// routes/deliveries.js
const express = require('express');
const axios = require('axios'); // For OSRM
const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Store = require('../models/Store');
const Item = require('../models/Item');
const Warehouse = require('../models/Warehouse');

const router = express.Router();

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
router.use(ensureAuthenticated, ensureDeliveryPartner);
// --- End Local Auth Middleware ---

// GET /deliveries/my
router.get('/my', async (req, res) => {
    // Using the version from your prompt #70 that was working
    console.log("--- Accessing GET /deliveries/my ---");
    const loggedInUser = res.locals.loggedInUser;
    let originWarehouse = null;
    let aggregatedItems = [];
    let ordersForPickup = [];
    let ordersInProgress = [];
    let showPickupButton = false;

    try {
        const allAssignedOrders = await Order.find({
            assignedDeliveryPartnerId: loggedInUser._id,
            orderStatus: { $in: ['confirmed', 'shipped'] }
        })
        .populate('warehouseId', 'name location address _id')
        .populate('storeId', 'storeName')
        .sort({ placedDate: 1 }).lean();
        
        if (allAssignedOrders.length > 0) {
            originWarehouse = allAssignedOrders[0].warehouseId;
            if (!originWarehouse?._id) { throw new Error("Cannot determine origin warehouse for deliveries."); }
            const originWarehouseId = originWarehouse._id;
            const allFromSameWarehouse = allAssignedOrders.every(order => {
                const currentWarehouseId = order.warehouseId?._id;
                if (!currentWarehouseId) { console.warn(`Order ${order._id} missing warehouseId.`); return false; }
                return currentWarehouseId.toString() === originWarehouseId.toString();
            });
            if (!allFromSameWarehouse) { throw new Error("Deliveries assigned from multiple warehouses."); }
            
            ordersForPickup = allAssignedOrders.filter(o => o.orderStatus === 'confirmed');
            ordersInProgress = allAssignedOrders.filter(o => o.orderStatus === 'shipped');
            showPickupButton = ordersForPickup.length > 0;

            if (showPickupButton) {
                aggregatedItems = await Order.aggregate([
                    { $match: { _id: { $in: ordersForPickup.map(o => o._id) } } },
                    { $unwind: "$orderItems" },
                    { $group: { _id: "$orderItems.itemId", totalQuantity: { $sum: "$orderItems.quantity" } } },
                    { $lookup: { from: "items", localField: "_id", foreignField: "_id", as: "itemDetails" }},
                    { $unwind: { path: "$itemDetails", preserveNullAndEmptyArrays: true } },
                    { $project: { _id: 0, itemId: "$_id", name: { $ifNull: [ "$itemDetails.name", "Unknown Item" ] }, sku: { $ifNull: [ "$itemDetails.sku", "N/A" ] }, neededQuantity: "$totalQuantity" }},
                    { $sort: { name: 1 } }
                ]);
            }
        }
        res.render('deliveries/my_deliveries', {
            title: 'My Deliveries & Loading List', originWarehouse, aggregatedItems,
            ordersForPickup, ordersInProgress, showPickupButton,
            error: req.query.error, success_msg: req.query.success, layout: './layouts/dashboard_layout'
        });
    } catch (err) {
        console.error(`Error in GET /deliveries/my for driver ${loggedInUser?._id}:`, err);
        res.status(500).render('error_page', { title: "Error", message: `Failed to load deliveries: ${err.message}`, layout: false });
    }
});

// GET /deliveries/map — OSRM + Nearest-Neighbor Optimization
router.get('/map', async (req, res) => {
    console.log('--- GET /deliveries/map (OSRM NN) ---');
    const loggedInUser = res.locals.loggedInUser;
    let errorMsg = null;
    const googleMapsApiKeyForView = process.env.Maps_API_KEY;
    if (!googleMapsApiKeyForView) {
      console.error("FATAL: Maps_API_KEY for frontend map display is missing!");
      errorMsg = "Mapping service API key not configured for map display.";
    }
  
    try {
      // 1) Fetch active orders
      const allAssignedOrders = await Order.find({
        assignedDeliveryPartnerId: loggedInUser._id,
        orderStatus: { $in: ['confirmed', 'shipped'] }
      })
      .populate('warehouseId', 'name location address')
      .populate('storeId', 'storeName address location')
      .lean();
      console.log(`Found ${allAssignedOrders.length} assigned orders.`);
  
      // 2) Build points arrays
      const originalOrdersWithCoords = [];
      const uniqueCoordsForOSRM = [];
      let originWarehouseForView = null;
  
      if (allAssignedOrders.length > 0) {
        const w = allAssignedOrders[0].warehouseId;
        if (w?.location?.coordinates?.length === 2) {
          uniqueCoordsForOSRM.push({
            lng: w.location.coordinates[0],
            lat: w.location.coordinates[1],
            type: 'warehouse',
            name: w.name,
            address: w.address
          });
          originWarehouseForView = w;
        } else {
          throw new Error("Valid origin warehouse location is missing.");
        }
  
        allAssignedOrders.forEach(order => {
          const coords = order.shippingLocation?.coordinates?.length === 2
            ? order.shippingLocation.coordinates
            : order.storeId?.location?.coordinates;
          if (coords?.length === 2) {
            originalOrdersWithCoords.push({ orderDoc: order, deliveryLng: coords[0], deliveryLat: coords[1] });
            uniqueCoordsForOSRM.push({
              lng: coords[0],
              lat: coords[1],
              type: 'delivery',
              orderId: order._id,
              name: order.customerName || order.storeId?.storeName,
              address: order.storeId?.address || order.shippingAddress
            });
          } else {
            console.warn(`Order ${order._id} skipped due to missing coords.`);
          }
        });
      }
  
      if (originalOrdersWithCoords.length === 0) {
        return res.render('deliveries/route_map', {
          title: 'Delivery Route', orders: [], originWarehouse: originWarehouseForView,
          routePolyline: null, routeLegs: [],
          googleMapsApiKey: googleMapsApiKeyForView,
          errorMsg, layout: './layouts/dashboard_layout'
        });
      }
  
      // 3) OSRM Table API
      const coordList = uniqueCoordsForOSRM.map(c => `${c.lng},${c.lat}`).join(';');
      const tableRes = await axios.get(`http://router.project-osrm.org/table/v1/driving/${coordList}?annotations=distance,duration`);
      if (tableRes.data.code !== 'Ok') throw new Error(tableRes.data.message || tableRes.data.code);
      const { distances, durations } = tableRes.data;
  
      // 4) Nearest-Neighbor TSP
      const N = uniqueCoordsForOSRM.length;
      const visited = Array(N).fill(false);
      const visitOrderIndices = [0]; visited[0] = true;
      let current = 0;
      for (let i = 0; i < originalOrdersWithCoords.length; i++) {
        let next = -1, best = Infinity;
        for (let j = 1; j < N; j++) {
          if (!visited[j]) {
            const cost = (distances[current][j] || Infinity) + (durations[current][j] || Infinity);
            if (cost < best) { best = cost; next = j; }
          }
        }
        if (next === -1) break;
        visited[next] = true;
        visitOrderIndices.push(next);
        current = next;
      }
      visitOrderIndices.push(0);
      console.log(`Visit sequence: ${visitOrderIndices}`);
  
      // 5) OSRM Route API for full polyline
      const routeCoords = visitOrderIndices.map(i => `${uniqueCoordsForOSRM[i].lng},${uniqueCoordsForOSRM[i].lat}`).join(';');
      const routeRes = await axios.get(`http://router.project-osrm.org/route/v1/driving/${routeCoords}?overview=full&geometries=polyline`);
      if (routeRes.data.code !== 'Ok') throw new Error(routeRes.data.message || routeRes.data.code);
      const fullPolyline = routeRes.data.routes[0].geometry;
  
      // 6) Build routeLegs
      const routeLegs = [];
      for (let k = 0; k < visitOrderIndices.length - 1; k++) {
        const fromIdx = visitOrderIndices[k], toIdx = visitOrderIndices[k + 1];
        const fromP = uniqueCoordsForOSRM[fromIdx], toP = uniqueCoordsForOSRM[toIdx];
        routeLegs.push({
          startName: fromP.name,
          startAddress: fromP.address,
          endName: toP.name,
          endAddress: toP.address,
          distance: distances[fromIdx][toIdx],
          duration: durations[fromIdx][toIdx],
          startCoords: { lat: fromP.lat, lng: fromP.lng },
          endCoords: { lat: toP.lat, lng: toP.lng },
          orderId: toP.type === 'delivery' ? toP.orderId : null
        });
      }
  
      // 7) Render view with legs
      res.render('deliveries/route_map', {
        title: 'Optimized Delivery Route (OSRM)',
        orders: originalOrdersWithCoords.map(o => o.orderDoc),
        originWarehouse: originWarehouseForView,
        routePolyline: fullPolyline,
        routeLegs,
        googleMapsApiKey: googleMapsApiKeyForView,
        errorMsg,
        layout: './layouts/dashboard_layout'
      });
  
    } catch (err) {
      console.error('Error in /deliveries/map:', err);
      res.status(500).render('deliveries/route_map', {
        title: 'Error Loading Route', orders: [], originWarehouse: null,
        routePolyline: null, routeLegs: [],
        googleMapsApiKey: process.env.Maps_API_KEY,
        errorMsg: `Server error: ${err.message}`,
        layout: './layouts/dashboard_layout'
      });
    }
  });

async function updateStockForOrderItems(orderItems, warehouseId, operation, session) {
      const stockUpdates = [];
      for (const orderItem of orderItems) {
          const itemDoc = orderItem.itemId;
          const quantityToAdjust = orderItem.quantity;
          if (!itemDoc || !itemDoc._id) throw new Error(`Invalid item data for stock adjustment.`);
  
          let stockChange;
          if (operation === 'deduct') {
              stockChange = -quantityToAdjust;
              const currentItemInDB = await Item.findOne({ _id: itemDoc._id, warehouseId: warehouseId }).session(session);
              if (!currentItemInDB || currentItemInDB.quantity < quantityToAdjust) {
                  throw new Error(`Insufficient stock for ${itemDoc.name} (SKU: ${itemDoc.sku}) during deduction. Have: ${currentItemInDB?.quantity || 0}, Need: ${quantityToAdjust}.`);
              }
          } else if (operation === 'restore') {
              stockChange = +quantityToAdjust;
          } else {
              throw new Error("Invalid stock operation.");
          }
          stockUpdates.push(
              Item.updateOne({ _id: itemDoc._id, warehouseId: warehouseId }, { $inc: { quantity: stockChange } }, { session })
          );
      }
      await Promise.all(stockUpdates);
      console.log(`Stock adjustments (${operation}) for involved items completed.`);
  }
  
  
  // POST /deliveries/batch-pickup - Mark ALL confirmed orders for warehouse as shipped
  router.post('/batch-pickup', async (req, res) => {
      const loggedInUser = res.locals.loggedInUser;
      console.log(`--- Driver ${loggedInUser._id} attempting BATCH pickup ---`);
      let originWarehouseId = null;
  
      const session = await mongoose.startSession(); // Start session for transaction
  
      try {
          await session.withTransaction(async () => { // Start transaction
              // 1. Find 'confirmed' orders to determine the warehouse and items
              const ordersToPick = await Order.find({
                  assignedDeliveryPartnerId: loggedInUser._id,
                  orderStatus: 'confirmed'
              })
              .populate('orderItems.itemId', 'name sku quantity warehouseId') // Populate item details for stock logic
              .populate('warehouseId', '_id name') // For warehouse name in logs
              .session(session); // Use session
  
              if (ordersToPick.length === 0) throw new Error("No confirmed orders found ready for pickup.");
  
              // Determine and validate origin warehouse (should be consistent for a batch)
              originWarehouseId = ordersToPick[0].warehouseId?._id;
              if (!originWarehouseId) throw new Error("Could not determine origin warehouse from orders.");
              const allFromSameWarehouse = ordersToPick.every(o => o.warehouseId?._id.toString() === originWarehouseId.toString());
              if (!allFromSameWarehouse) throw new Error("Batch pickup orders must be from the same warehouse.");
              console.log(`Attempting batch pickup from warehouse ${originWarehouseId} for driver ${loggedInUser._id}`);
  
              // 2. Aggregate all items needed across these orders
              const itemQuantitiesNeeded = ordersToPick
                  .flatMap(o => o.orderItems)
                  .reduce((acc, current) => {
                      const itemIdStr = current.itemId?._id?.toString();
                      if (itemIdStr) acc[itemIdStr] = (acc[itemIdStr] || 0) + current.quantity;
                      return acc;
                  }, {});
              const neededItemIds = Object.keys(itemQuantitiesNeeded);
              console.log("Aggregated items for stock check:", itemQuantitiesNeeded);
  
              // 3. CRITICAL STOCK CHECK for all aggregated items
              if (neededItemIds.length > 0) {
                  console.log("Checking stock levels for batch pickup...");
                  const stockItems = await Item.find({
                      _id: { $in: neededItemIds },
                      warehouseId: originWarehouseId // IMPORTANT: Check in the correct warehouse
                  }).session(session);
                  const stockMap = new Map(stockItems.map(i => [i._id.toString(), i.quantity]));
  
                  for (const itemId of neededItemIds) {
                      const needed = itemQuantitiesNeeded[itemId];
                      const available = stockMap.get(itemId) ?? -1;
                      const itemDetailsForError = await Item.findById(itemId).select('name sku').lean(); // For better error message
                      if (available < needed) {
                          throw new Error(`Insufficient stock for ${itemDetailsForError?.name || 'Item '+itemId} (SKU: ${itemDetailsForError?.sku || 'N/A'}). Available: ${available < 0 ? 0 : available}, Needed for batch: ${needed}`);
                      }
                      console.log(`Stock OK for item ${itemId}. Needed: ${needed}, Available: ${available}`);
                  }
                  console.log("Stock check passed for all items in batch.");
              }
  
              // 4. Perform Stock Deduction (if all checks passed)
              let stockUpdates = [];
              for (const itemId of neededItemIds) {
                  stockUpdates.push(
                      Item.updateOne(
                          { _id: itemId, warehouseId: originWarehouseId }, // Ensure deduction from correct warehouse
                          { $inc: { quantity: -itemQuantitiesNeeded[itemId] } },
                          { session }
                      )
                  );
              }
              if (stockUpdates.length > 0) {
                  console.log(`Executing ${stockUpdates.length} stock deductions for batch...`);
                  await Promise.all(stockUpdates);
                  console.log("Stock deductions successful for batch.");
              }
  
              // 5. Update Order Statuses
              const orderIdsToUpdate = ordersToPick.map(o => o._id);
              console.log(`Updating status to 'shipped' for ${orderIdsToUpdate.length} orders...`);
              const updateResult = await Order.updateMany(
                  { _id: { $in: orderIdsToUpdate } },
                  { $set: { orderStatus: 'shipped', updatedDate: new Date() } },
                  { session }
              );
              console.log(`Batch pickup complete: ${updateResult.modifiedCount} orders marked as 'shipped'.`);
          }); // End of transaction
  
          res.redirect('/deliveries/map?success=Orders+picked+up.+Route+ready.');
  
      } catch (err) {
          console.error(`Error during batch pickup:`, err);
          res.redirect(`/deliveries/my?error=${encodeURIComponent(`Pickup failed: ${err.message}`)}`);
      } finally {
          await session.endSession();
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