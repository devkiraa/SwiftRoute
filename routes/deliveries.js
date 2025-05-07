// routes/deliveries.js
const express = require('express');
const axios = require('axios'); // For OSRM
const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Store = require('../models/Store');
const Item = require('../models/Item');
const Vehicle = require('../models/Vehicle');
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

// GET /deliveries/my - Show Aggregated Loading List, Individual Orders, and Vehicle Selection
router.get('/my', async (req, res) => {
    console.log("--- Accessing GET /deliveries/my ---");
    const loggedInUser = res.locals.loggedInUser;
    let originWarehouse = null;
    let aggregatedItems = [];
    let ordersForPickup = [];
    let ordersInProgress = [];
    let showPickupButton = false;
    let availableVehicles = [];
    let currentVehicle = null;

    try {
        if (!loggedInUser.companyId) {
            throw new Error("Delivery partner is not associated with a company.");
        }

        // Fetch current vehicle if assigned to user
        if (loggedInUser.currentVehicleId) {
            currentVehicle = await Vehicle.findById(loggedInUser.currentVehicleId).lean();
        }

        // Fetch available vehicles for selection if no vehicle is currently selected by the user
        if (!currentVehicle) {
            availableVehicles = await Vehicle.find({
                companyId: loggedInUser.companyId,
                isActive: true,
                assignedDriverId: null // Only show vehicles not currently assigned to anyone
            }).select('vehicleNumber modelName type').sort({ vehicleNumber: 1 }).lean();
        }
        
        const allAssignedOrders = await Order.find({
            assignedDeliveryPartnerId: loggedInUser._id,
            orderStatus: { $in: ['confirmed', 'shipped'] }
        })
        .populate('warehouseId', 'name location address _id')
        .populate('storeId', 'storeName')
        .sort({ placedDate: 1 }).lean();
        
        if (allAssignedOrders.length > 0) {
            originWarehouse = allAssignedOrders[0].warehouseId;
            // ... (rest of your existing logic for ordersForPickup, ordersInProgress, aggregatedItems) ...
            if (!originWarehouse?._id) { throw new Error("Cannot determine origin warehouse for deliveries."); }
            const originWarehouseIdString = originWarehouse._id.toString();
            const allFromSameWarehouse = allAssignedOrders.every(order => order.warehouseId?._id?.toString() === originWarehouseIdString);
            if (!allFromSameWarehouse) { throw new Error("Deliveries assigned from multiple warehouses."); }
            
            ordersForPickup = allAssignedOrders.filter(o => o.orderStatus === 'confirmed');
            ordersInProgress = allAssignedOrders.filter(o => o.orderStatus === 'shipped');
            showPickupButton = ordersForPickup.length > 0 && !!currentVehicle; // Can only pickup if vehicle is selected

            if (showPickupButton) { /* ... your aggregation logic ... */ }
        }

        res.render('deliveries/my_deliveries', {
            title: 'My Deliveries', originWarehouse, aggregatedItems,
            ordersForPickup, ordersInProgress, showPickupButton,
            availableVehicles, // Pass available vehicles to the view
            currentVehicle,    // Pass currently selected vehicle to the view
            error: req.query.error, success_msg: req.query.success, 
            layout: './layouts/dashboard_layout'
        });
    } catch (err) {
        console.error(`Error in GET /deliveries/my for driver ${loggedInUser?._id}:`, err);
        res.status(500).render('error_page', { title: "Error", message: `Failed to load deliveries: ${err.message}`, layout: false });
    }
});


// GET /deliveries/map — OSRM + Nearest-Neighbor Optimization
router.get('/map', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    const googleMapsApiKeyForView = process.env.Maps_API_KEY;
    let errorMsg = null;
    if (!googleMapsApiKeyForView) {
      console.error("FATAL: Maps_API_KEY missing!");
      errorMsg = "Mapping service API key not configured.";
    }
  
    try {
      // 1) Fetch active orders with item names populated
      const allAssignedOrders = await Order.find({
        assignedDeliveryPartnerId: loggedInUser._id,
        orderStatus: { $in: ['confirmed', 'shipped'] }
      })
      .populate('warehouseId', 'name location address')
      .populate({
        path: 'orderItems.itemId',
        select: 'name'
      })
      .populate('storeId', 'storeName address location')
      .lean();
  
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
            type: 'warehouse', name: w.name, address: w.address
          });
          originWarehouseForView = w;
        } else throw new Error("Valid origin warehouse location is missing.");
  
        allAssignedOrders.forEach(order => {
          const coords = order.shippingLocation?.coordinates?.length === 2
            ? order.shippingLocation.coordinates
            : order.storeId?.location?.coordinates;
          if (coords?.length === 2) {
            originalOrdersWithCoords.push({ orderDoc: order });
            uniqueCoordsForOSRM.push({
              lng: coords[0], lat: coords[1],
              type: 'delivery', orderId: order._id,
              name: order.customerName || order.storeId?.storeName,
              address: order.storeId?.address || order.shippingAddress
            });
          }
        });
      }
      
      if (!originalOrdersWithCoords.length) {
        return res.render('deliveries/route_map', {
          title: 'Delivery Route', orders: [], originWarehouse: originWarehouseForView,
          routeLegs: [], googleMapsApiKey: googleMapsApiKeyForView,
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

      // Find the matching order document
      const orderDoc = toP.orderId
        ? originalOrdersWithCoords.find(o => o.orderDoc._id.toString() === toP.orderId.toString())?.orderDoc
        : null;

      // Build items list
      const itemsList = (orderDoc?.orderItems || []).map(oi => ({
        name: oi.itemId?.name || 'Unknown',
        quantity: oi.quantity
      }));

      routeLegs.push({
        startName: fromP.name,
        startAddress: fromP.address,
        endName: toP.name,
        endAddress: toP.address,
        distance: distances[fromIdx][toIdx],
        duration: durations[fromIdx][toIdx],
        startCoords: { lat: fromP.lat, lng: fromP.lng },
        endCoords:   { lat: toP.lat, lng: toP.lng },
        orderId:     toP.type === 'delivery' ? toP.orderId : null,
        items:       itemsList    // ← make sure this comma is here!
      });
    }

    res.render('deliveries/route_map', {
      title: 'Optimized Delivery Route',
      routeLegs,
      googleMapsApiKey: googleMapsApiKeyForView,
      errorMsg,
      layout: './layouts/dashboard_layout'
    });

  } catch (err) {
    console.error('Error in /deliveries/map:', err);
    res.status(500).render('deliveries/route_map', {
      title: 'Error Loading Route',
      routeLegs: [],
      googleMapsApiKey: googleMapsApiKeyForView,
      errorMsg: `Server error: ${err.message}`,
      layout: './layouts/dashboard_layout'
    });
  }
});
async function updateStockForBatchPickup(aggregatedItems, warehouseId, session) {
    console.log(`[StockHelper-Batch] Starting stock DEDUCTION for warehouse ${warehouseId}`);
    const stockUpdates = [];
    for (const aggItem of aggregatedItems) { // aggregatedItems: { itemId, name, sku, neededQuantity }
        const itemIdToUpdate = aggItem.itemId;
        const quantityToAdjust = aggItem.neededQuantity;

        if (!itemIdToUpdate || !mongoose.Types.ObjectId.isValid(itemIdToUpdate)) {
            throw new Error(`Invalid item data in aggregated list for stock adjustment. Item ID: ${itemIdToUpdate}`);
        }

        // Check current stock *within the transaction*
        const currentItemInDB = await Item.findOne({ _id: itemIdToUpdate, warehouseId: warehouseId }).session(session);
        if (!currentItemInDB) {
            throw new Error(`Item ${aggItem.name || itemIdToUpdate} (SKU: ${aggItem.sku}) not found in warehouse ${warehouseId} for stock deduction.`);
        }
        if (currentItemInDB.quantity < quantityToAdjust) {
            throw new Error(`Insufficient stock for item ${aggItem.name} (SKU: ${aggItem.sku}) during batch deduction. Available: ${currentItemInDB.quantity}, Total Needed for Batch: ${quantityToAdjust}.`);
        }
        
        console.log(`[StockHelper-Batch] Preparing to deduct ${quantityToAdjust} from Item ${itemIdToUpdate} (SKU: ${aggItem.sku}) in Warehouse ${warehouseId}`);
        stockUpdates.push(
            Item.updateOne(
                { _id: itemIdToUpdate, warehouseId: warehouseId },
                { $inc: { quantity: -quantityToAdjust }, $set: { lastUpdated: new Date() } },
                { session }
            )
        );
    }
    await Promise.all(stockUpdates);
    console.log(`[StockHelper-Batch] Stock deductions successful for batch items.`);
}
 
  
  // POST /deliveries/batch-pickup (WITH TRANSACTION)
router.post('/batch-pickup', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    console.log(`--- Driver ${loggedInUser._id} attempting BATCH pickup ---`);
    
    const session = await mongoose.startSession(); // Start session

    try {
        await session.withTransaction(async () => { // Start transaction
            const ordersToPick = await Order.find({
                assignedDeliveryPartnerId: loggedInUser._id,
                orderStatus: 'confirmed'
            })
            .populate('orderItems.itemId', 'name sku') // For better error messages if needed
            .populate('warehouseId', '_id name')
            .session(session); // Use session

            if (ordersToPick.length === 0) throw new Error("No confirmed orders found ready for pickup.");

            const originWarehouseId = ordersToPick[0].warehouseId?._id;
            if (!originWarehouseId) throw new Error("Could not determine origin warehouse.");
            if (!ordersToPick.every(o => o.warehouseId?._id.toString() === originWarehouseId.toString())) {
                throw new Error("Batch pickup orders must be from the same warehouse.");
            }
            console.log(`Batch pickup from warehouse ${originWarehouseId} for ${ordersToPick.length} orders.`);

            // Aggregate all items and their quantities needed for this batch from this warehouse
            const aggregatedItemsForStock = await Order.aggregate([
                { $match: { _id: { $in: ordersToPick.map(o => o._id) }, warehouseId: originWarehouseId } }, // Ensure matching correct orders and warehouse
                { $unwind: "$orderItems" },
                { $group: { 
                    _id: "$orderItems.itemId", 
                    neededQuantity: { $sum: "$orderItems.quantity" } 
                }},
                { $lookup: { from: "items", localField: "_id", foreignField: "_id", as: "itemDetails" }},
                { $unwind: "$itemDetails" }, // Assume item must exist
                { $project: { 
                    _id: 0, itemId: "$_id", 
                    name: "$itemDetails.name", sku: "$itemDetails.sku", 
                    neededQuantity: "$neededQuantity" 
                }}
            ]).session(session); // Run aggregation within session

            console.log("Aggregated items for stock check/deduction:", JSON.stringify(aggregatedItemsForStock));

            if (aggregatedItemsForStock.length > 0) {
                // This helper will do the check and then the update for each item
                await updateStockForBatchPickup(aggregatedItemsForStock, originWarehouseId, session);
            }

            const orderIdsToUpdate = ordersToPick.map(o => o._id);
            await Order.updateMany(
                { _id: { $in: orderIdsToUpdate } },
                { $set: { orderStatus: 'shipped', updatedDate: new Date(), lastUpdatedBy: loggedInUser._id } },
                { session }
            );
            console.log(`Batch pickup complete: ${orderIdsToUpdate.length} orders marked 'shipped'.`);
        }); // Transaction commits here

        res.redirect('/deliveries/map?success=Orders+picked+up.+Route+ready.');
    } catch (err) {
        console.error(`Error during batch pickup (transaction may have aborted):`, err);
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

// POST /deliveries/vehicle/select - Driver selects a vehicle
router.post('/vehicle/select', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    const { vehicleId, startOdometer } = req.body; // Odometer is optional for now

    if (!vehicleId || !mongoose.Types.ObjectId.isValid(vehicleId)) {
        return res.redirect('/deliveries/my?error=Invalid+vehicle+selection.');
    }

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            // Ensure driver doesn't already have a vehicle or release it first
            if (loggedInUser.currentVehicleId) {
                const oldVehicle = await Vehicle.findById(loggedInUser.currentVehicleId).session(session);
                if (oldVehicle) {
                    oldVehicle.assignedDriverId = null;
                    // Consider asking for end odometer for oldVehicle here
                    await oldVehicle.save({ session });
                }
            }

            const vehicleToAssign = await Vehicle.findOne({ 
                _id: vehicleId, 
                companyId: loggedInUser.companyId, 
                isActive: true,
                assignedDriverId: null // Ensure it's still available
            }).session(session);

            if (!vehicleToAssign) {
                throw new Error("Selected vehicle is not available or does not belong to your company.");
            }

            // Assign vehicle to user
            await User.findByIdAndUpdate(loggedInUser._id, { currentVehicleId: vehicleToAssign._id }, { session });
            
            // Assign user to vehicle and update odometer
            vehicleToAssign.assignedDriverId = loggedInUser._id;
            if (startOdometer && !isNaN(parseFloat(startOdometer)) && parseFloat(startOdometer) >= vehicleToAssign.currentOdometer) {
                vehicleToAssign.currentOdometer = parseFloat(startOdometer);
            } else if (startOdometer) {
                 console.warn(`Provided start odometer ${startOdometer} is less than current ${vehicleToAssign.currentOdometer} for vehicle ${vehicleToAssign.vehicleNumber}. Not updating.`);
            }
            await vehicleToAssign.save({ session });
            
            res.locals.loggedInUser.currentVehicleId = vehicleToAssign._id; // Update res.locals for immediate effect
        });
        res.redirect('/deliveries/my?success=Vehicle+selected+successfully.');
    } catch (err) {
        console.error("Error selecting vehicle:", err);
        res.redirect(`/deliveries/my?error=Failed+to+select+vehicle:+${err.message}`);
    } finally {
        await session.endSession();
    }
});

// POST /deliveries/vehicle/release - Driver releases a vehicle
router.post('/vehicle/release', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    const { endOdometer } = req.body; // Odometer is optional for now

    if (!loggedInUser.currentVehicleId) {
        return res.redirect('/deliveries/my?error=No+vehicle+currently+selected.');
    }
    
    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            const vehicleToRelease = await Vehicle.findById(loggedInUser.currentVehicleId).session(session);
            if (vehicleToRelease) {
                vehicleToRelease.assignedDriverId = null;
                if (endOdometer && !isNaN(parseFloat(endOdometer)) && parseFloat(endOdometer) >= vehicleToRelease.currentOdometer) {
                    vehicleToRelease.currentOdometer = parseFloat(endOdometer);
                } else if (endOdometer) {
                    console.warn(`Provided end odometer ${endOdometer} is less than current ${vehicleToRelease.currentOdometer} for vehicle ${vehicleToRelease.vehicleNumber}. Not updating.`);
                }
                await vehicleToRelease.save({ session });
            }
            await User.findByIdAndUpdate(loggedInUser._id, { currentVehicleId: null }, { session });
            res.locals.loggedInUser.currentVehicleId = null; // Update res.locals
        });
        res.redirect('/deliveries/my?success=Vehicle+released+successfully.');
    } catch (err) {
        console.error("Error releasing vehicle:", err);
        res.redirect(`/deliveries/my?error=Failed+to+release+vehicle:+${err.message}`);
    } finally {
        await session.endSession();
    }
});

module.exports = router;