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
  const loggedInUser = res.locals.loggedInUser;
  let finalOrdersToDisplay = [];
  let originWarehouseForView = null;
  let routePolylineFromOSRM = null;
  let errorMsg = null;
  const googleMapsApiKeyForView = process.env.Maps_API_KEY; // For frontend Google Map display

  if (!googleMapsApiKeyForView) {
      console.error("FATAL: Maps_API_KEY for frontend map display is missing!");
      errorMsg = "Mapping service API key not configured for map display.";
  }

  try {
      // 1) Fetch active orders
      const allAssignedOrders = await Order.find({
          assignedDeliveryPartnerId: loggedInUser._id,
          orderStatus: { $in: ['confirmed', 'shipped'] } // Primarily 'shipped' if pickup is done
      })
      .populate('warehouseId', 'name location address') // Ensure location is populated
      .populate('storeId', 'storeName address location') // Ensure location is populated
      .lean();
      console.log(`Found ${allAssignedOrders.length} assigned orders.`);

      // 2) Build arrays for OSRM:
      //    - originalOrdersWithCoords: stores order doc + delivery coords for re-linking later
      //    - uniqueCoordsForOSRM: [{lng, lat}] for OSRM, warehouse first
      const originalOrdersWithCoords = [];
      const uniqueCoordsForOSRM = [];

      if (allAssignedOrders.length > 0) {
          const firstWarehouse = allAssignedOrders[0].warehouseId;
          if (firstWarehouse?.location?.coordinates?.length === 2) {
              uniqueCoordsForOSRM.push({ lng: firstWarehouse.location.coordinates[0], lat: firstWarehouse.location.coordinates[1], type: 'warehouse', name: firstWarehouse.name });
              originWarehouseForView = firstWarehouse; // For view display
          } else {
              throw new Error("Valid origin warehouse location is missing for the first order.");
          }

          allAssignedOrders.forEach(order => {
              const deliveryLocation = order.shippingLocation?.coordinates?.length === 2 ? order.shippingLocation.coordinates : order.storeId?.location?.coordinates;
              if (deliveryLocation?.length === 2) {
                  originalOrdersWithCoords.push({ orderDoc: order, deliveryLng: deliveryLocation[0], deliveryLat: deliveryLocation[1] });
                  uniqueCoordsForOSRM.push({ lng: deliveryLocation[0], lat: deliveryLocation[1], type: 'delivery', orderId: order._id, name: order.customerName || order.storeId?.storeName });
              } else {
                  console.warn(`Order ${order._id} skipped due to missing valid delivery coordinates.`);
              }
          });
      }
      console.log(`Prepared ${originalOrdersWithCoords.length} orders for routing. Unique OSRM points: ${uniqueCoordsForOSRM.length}`);

      if (originalOrdersWithCoords.length === 0) { // No orders with valid coords to route
          errorMsg = errorMsg || 'No valid delivery locations found to route.';
          // Render with empty orders but provide API key for empty map
          return res.render('deliveries/route_map', { title: 'Delivery Route', orders: [], originWarehouse: originWarehouseForView, routePolyline: null, googleMapsApiKey: googleMapsApiKeyForView, errorMsg, layout: './layouts/dashboard_layout' });
      }

      // 3) OSRM Table API
      const coordList = uniqueCoordsForOSRM.map(c => `${c.lng},${c.lat}`).join(';');
      const tableUrl = `http://router.project-osrm.org/table/v1/driving/${coordList}?annotations=distance,duration`;
      console.log("Requesting OSRM Table:", tableUrl);
      const tableRes = await axios.get(tableUrl);

      if (tableRes.data.code !== 'Ok') {
          throw new Error(`OSRM Table API error: ${tableRes.data.message || tableRes.data.code}`);
      }
      const { distances, durations } = tableRes.data;
      console.log(`OSRM Table API success. Distances matrix size: ${distances?.length}`);

      // 4) Nearest-Neighbor TSP
      const N = uniqueCoordsForOSRM.length; // Number of points including warehouse
      const visited = Array(N).fill(false);
      const visitOrderIndices = [0]; // Start at warehouse (index 0 in uniqueCoordsForOSRM)
      visited[0] = true;
      let currentPointIndex = 0; // Current point's index in uniqueCoordsForOSRM

      for (let i = 0; i < originalOrdersWithCoords.length; i++) { // We need to visit N-1 delivery points
          let nextPointIndex = -1;
          let bestCost = Infinity;
          for (let j = 1; j < N; j++) { // Iterate through potential next stops (excluding warehouse as next stop unless it's the end)
              if (!visited[j]) {
                  const cost = (distances[currentPointIndex][j] || Infinity) + (durations[currentPointIndex][j] || Infinity); // Simple cost
                  if (cost < bestCost) {
                      bestCost = cost;
                      nextPointIndex = j;
                  }
              }
          }
          if (nextPointIndex !== -1) {
              visited[nextPointIndex] = true;
              visitOrderIndices.push(nextPointIndex);
              currentPointIndex = nextPointIndex;
          } else {
              console.warn("Nearest neighbor could not find next unvisited point. Breaking.");
              break; // Should not happen if all points are connectable
          }
      }
      visitOrderIndices.push(0); // Return to warehouse
      console.log("Nearest Neighbor visitOrderIndices (indices from uniqueCoordsForOSRM):", visitOrderIndices);

      // 5) OSRM Route API for the optimized sequence
      const reorderedCoordsForRouteAPI = visitOrderIndices.map(i => `${uniqueCoordsForOSRM[i].lng},${uniqueCoordsForOSRM[i].lat}`).join(';');
      const routeUrl = `http://router.project-osrm.org/route/v1/driving/${reorderedCoordsForRouteAPI}?overview=full&geometries=polyline`;
      console.log("Requesting OSRM Route:", routeUrl);
      const routeRes = await axios.get(routeUrl);

      if (routeRes.data.code !== 'Ok') {
          throw new Error(`OSRM Route API error: ${routeRes.data.message || routeRes.data.code}`);
      }
      routePolylineFromOSRM = routeRes.data.routes?.[0]?.geometry || null;
      console.log(`OSRM Route API success. Polyline received: ${!!routePolylineFromOSRM}`);

      // 6) Map back to original order documents in the optimized sequence
      // visitOrderIndices contains indices of uniqueCoordsForOSRM.
      // The first and last are the warehouse. The ones in between are delivery points.
      finalOrdersToDisplay = visitOrderIndices.slice(1, -1).map(uniqueCoordIndex => {
          // Find the original order that corresponds to this uniqueCoord point
          const coordPoint = uniqueCoordsForOSRM[uniqueCoordIndex];
          const originalOrderData = originalOrdersWithCoords.find(o => o.orderDoc._id.toString() === coordPoint.orderId?.toString());
          return originalOrderData ? originalOrderData.orderDoc : null;
      }).filter(Boolean); // Remove any nulls if mapping failed

      console.log(`Final ordered stops for display: ${finalOrdersToDisplay.length}`);

      // 7) Render view
      res.render('deliveries/route_map', {
          title: 'Optimized Delivery Route (OSRM)',
          orders: finalOrdersToDisplay, // These are now sorted by OSRM/NN
          originWarehouse: originWarehouseForView,
          routePolyline: routePolylineFromOSRM,
          googleMapsApiKey: googleApiKeyForView, // For frontend map
          errorMsg: errorMsg,
          layout: './layouts/dashboard_layout'
      });

  } catch (err) {
      console.error('Error in /deliveries/map (OSRM NN):', err);
      res.status(500).render('deliveries/route_map', {
          title: 'Error Loading Route', orders: [], originWarehouse: null, routePolyline: null,
          googleMapsApiKey: googleApiKeyForView,
          errorMsg: `Server error: ${err.message}`,
          layout: './layouts/dashboard_layout'
      });
  }
});

  
    // --- Status Update Routes ---

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