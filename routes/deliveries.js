// routes/deliveries.js
const express = require('express');
const axios = require('axios'); // For OSRM
const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const Store = require('../models/Store');
const Item = require('../models/Item');
const Vehicle = require('../models/Vehicle');
const FuelLog = require('../models/FuelLog');
const TripLog = require('../models/TripLog');
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

// --- GET /deliveries/my --- 
// Shows current vehicle/trip status, loading list for pickup, and orders in progress.
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
    let activeTrip = null;
    let aggregationErrorMsg = null; // Potential error message for aggregation

    try {
        // 1. Ensure driver is linked to a company
        if (!loggedInUser.companyId) {
            throw new Error("Delivery partner is not associated with a company.");
        }
        const companyId = loggedInUser.companyId._id || loggedInUser.companyId; // Ensure we have the ID

        // 2. Fetch current vehicle and active trip status
        if (loggedInUser.currentVehicleId) {
            currentVehicle = await Vehicle.findById(loggedInUser.currentVehicleId)
                                          .select('vehicleNumber modelName type currentOdometer') 
                                          .lean();
            if (currentVehicle) {
                activeTrip = await TripLog.findOne({
                    driverId: loggedInUser._id,
                    vehicleId: currentVehicle._id,
                    status: 'active' 
                }).sort({ tripStartDate: -1 }).lean();
                console.log(`Active Trip Found for Vehicle ${currentVehicle.vehicleNumber}:`, activeTrip ? activeTrip._id : 'None');
            } else {
                // Vehicle ID exists on user but vehicle not found (maybe deleted?) - clear it
                console.warn(`Clearing non-existent currentVehicleId ${loggedInUser.currentVehicleId} for user ${loggedInUser._id}`);
                await User.findByIdAndUpdate(loggedInUser._id, { currentVehicleId: null });
                // Refresh loggedInUser in locals? Not straightforward without re-querying or session update
                 res.locals.loggedInUser.currentVehicleId = null; // Update locals for this request at least
            }
        } 
        
        // 3. Fetch available vehicles if none currently selected
        if (!currentVehicle) {
            availableVehicles = await Vehicle.find({
                companyId: companyId, // Use determined companyId
                isActive: true,
                assignedDriverId: null 
            }).select('vehicleNumber modelName type').sort({ vehicleNumber: 1 }).lean();
            console.log(`Found ${availableVehicles.length} available vehicles.`);
        }
        
        // 4. Fetch Assigned Orders ('confirmed' for pickup, 'shipped' for in progress)
        const allAssignedOrders = await Order.find({ 
            assignedDeliveryPartnerId: loggedInUser._id,
            orderStatus: { $in: ['confirmed', 'shipped'] } 
        })
        .populate('warehouseId', 'name location address _id') // Populate warehouse for info
        .populate('storeId', 'storeName') // Populate store for display
        .populate('orderItems.itemId', 'name sku') // Populate item names for potential display
        .sort({ placedDate: 1 }) // Or sort based on route optimization later?
        .lean();
        console.log(`Found ${allAssignedOrders.length} total active assigned orders.`);

        if (allAssignedOrders.length > 0) {
            originWarehouse = allAssignedOrders[0].warehouseId;
            // Basic check if all orders are from the same warehouse
             if (!originWarehouse?._id) { throw new Error("Cannot determine origin warehouse for deliveries."); }
             const originWarehouseId = originWarehouse._id;
             const allFromSameWarehouse = allAssignedOrders.every(order => order.warehouseId?._id?.toString() === originWarehouseId.toString());
             if (!allFromSameWarehouse) { throw new Error("Assigned deliveries originate from multiple warehouses. Please contact dispatch."); }
             console.log(`All orders originate from warehouse: ${originWarehouse.name}`);

            ordersForPickup = allAssignedOrders.filter(o => o.orderStatus === 'confirmed');
            ordersInProgress = allAssignedOrders.filter(o => o.orderStatus === 'shipped');
            
            // Show pickup button if there are orders to pick up AND driver has selected a vehicle AND has an active trip
            showPickupButton = ordersForPickup.length > 0 && !!currentVehicle && !!activeTrip; 
            console.log(`Orders for pickup: ${ordersForPickup.length}, Orders in progress: ${ordersInProgress.length}, Show pickup button: ${showPickupButton}`);

            // 5. Aggregate items ONLY if there are orders for pickup
            if (ordersForPickup.length > 0) {
                console.log("Aggregating items for pickup list...");
                try {
                    aggregatedItems = await Order.aggregate([
                        { $match: { 
                            _id: { $in: ordersForPickup.map(o => o._id) }, 
                            warehouseId: originWarehouseId // Use the actual ObjectId
                        }},
                        { $unwind: "$orderItems" },
                        { $group: { 
                            _id: "$orderItems.itemId", 
                            totalQuantity: { $sum: "$orderItems.quantity" } 
                        }},
                        { $match: { _id: { $ne: null } } }, // Ensure itemId wasn't null
                        { $lookup: { 
                            from: "items", localField: "_id", foreignField: "_id", 
                            as: "itemDetails" 
                        }},
                        { $unwind: { path: "$itemDetails", preserveNullAndEmptyArrays: true } }, 
                        { $project: { 
                            _id: 0, itemId: "$_id", 
                            name: { $ifNull: [ "$itemDetails.name", "Unknown Item" ] }, 
                            sku: { $ifNull: [ "$itemDetails.sku", "N/A" ] }, 
                            neededQuantity: "$totalQuantity" 
                        }},
                        { $sort: { name: 1 } }
                    ]);
                    console.log(`Aggregation complete. Found ${aggregatedItems.length} unique items for pickup list.`);
                    if (aggregatedItems.some(item => item.name === 'Unknown Item')) {
                        console.warn("Warning: Some aggregated items could not be found in the 'items' collection.");
                    }
                     if (aggregatedItems.length === 0 && ordersForPickup.length > 0) {
                         console.warn("Warning: Aggregation resulted in zero items, even though orders were found for pickup. Check match stage or data.");
                         aggregationErrorMsg = "Could not load item details for pickup list."; // Set specific error
                    }
                } catch (aggError) {
                    console.error("Error during item aggregation:", aggError);
                    aggregatedItems = []; 
                    aggregationErrorMsg = "Error loading pickup list details.";
                }
            }
        }

        // Pass query param messages OR the aggregation error
        let displayError = req.query.error ? decodeURIComponent(req.query.error.replace(/\+/g, ' ')) : aggregationErrorMsg; // Prioritize query error
        let displaySuccess = req.query.success ? decodeURIComponent(req.query.success.replace(/\+/g, ' ')) : null;
        
        res.render('deliveries/my_deliveries', {
            title: 'My Deliveries', 
            originWarehouse, 
            aggregatedItems,
            ordersForPickup, 
            ordersInProgress, 
            showPickupButton, // Determines if the pickup list section *could* show actions
            availableVehicles, 
            currentVehicle,    
            activeTrip, 
            showFuelLogButton: !!currentVehicle, 
            error_msg: displayError, // Use the consolidated error message
            success_msg: displaySuccess, 
            layout: './layouts/dashboard_layout'
        });

    } catch (err) {
        console.error(`Error in GET /deliveries/my for driver ${loggedInUser?._id}:`, err);
        // Render error page if main logic fails
        res.status(500).render('error_page', { 
            title: "Error", 
            message: `Failed to load deliveries: ${err.message}`, 
            layout: './layouts/dashboard_layout' // Use dashboard layout for consistency if possible
        });
    }
});

// POST /deliveries/trip/start - Start a new delivery trip
router.post('/trip/start', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    const { startOdometer } = req.body;
    const vehicleId = loggedInUser.currentVehicleId; // Assumes vehicle is already selected via POST /vehicle/select

    console.log(`--- Driver ${loggedInUser._id} attempting START TRIP with vehicle ${vehicleId}, Odo: ${startOdometer} ---`);

    if (!vehicleId) {
        return res.redirect('/deliveries/my?error=No+vehicle+selected.+Please+select+a+vehicle+first.');
    }
    if (startOdometer === undefined || startOdometer === null || startOdometer === '') {
         return res.redirect('/deliveries/my?error=Start+Odometer+reading+is+required.');
    }
    const startOdoNum = parseFloat(startOdometer);
     if (isNaN(startOdoNum) || startOdoNum < 0) {
         return res.redirect('/deliveries/my?error=Invalid+Start+Odometer+reading.');
     }


    const session = await mongoose.startSession();
    try {
        let newTrip = null;
        await session.withTransaction(async () => {
            // 1. Check if driver already has an active trip
            const existingActiveTrip = await TripLog.findOne({ 
                driverId: loggedInUser._id, 
                status: 'active' 
            }).session(session);

            if (existingActiveTrip) {
                 throw new Error(`You already have an active trip started at ${existingActiveTrip.tripStartDate.toLocaleString()}. Please end it first.`);
            }

            // 2. Get selected vehicle and validate odometer
            const vehicle = await Vehicle.findById(vehicleId).session(session);
            if (!vehicle) throw new Error("Selected vehicle not found.");
            if (vehicle.assignedDriverId?.toString() !== loggedInUser._id.toString()) {
                 throw new Error("Vehicle is not assigned to you."); // Should not happen if UI is correct
            }
            if (startOdoNum < vehicle.currentOdometer) {
                 throw new Error(`Start Odometer (${startOdoNum}km) cannot be less than vehicle's last known reading (${vehicle.currentOdometer}km).`);
            }
             if (!vehicle.isActive) {
                 throw new Error(`Vehicle ${vehicle.vehicleNumber} is marked as inactive.`);
             }

            // 3. Find orders to associate with this trip ('confirmed' or 'shipped' assigned to driver)
             const ordersForThisTrip = await Order.find({
                 assignedDeliveryPartnerId: loggedInUser._id,
                 orderStatus: { $in: ['confirmed', 'shipped'] },
                 // Optionally add criteria like warehouseId matching vehicle's warehouse?
             }).select('_id').session(session).lean(); // Just get IDs

            // 4. Create the TripLog
            newTrip = new TripLog({
                vehicleId: vehicle._id,
                driverId: loggedInUser._id,
                companyId: loggedInUser.companyId,
                tripStartDate: new Date(),
                startOdometer: startOdoNum,
                status: 'active',
                ordersOnTrip: ordersForThisTrip.map(o => o._id)
            });
            await newTrip.save({ session });
            console.log(`New TripLog created: ${newTrip._id}`);

            // 5. Update vehicle's current odometer
            vehicle.currentOdometer = startOdoNum;
            vehicle.lastUpdated = new Date();
            await vehicle.save({ session });
             console.log(`Vehicle ${vehicleId} odometer updated to ${startOdoNum}`);

        }); // Transaction commits

        res.redirect('/deliveries/my?success=New+trip+started+successfully!');

    } catch (err) {
        console.error("Error starting trip:", err);
        res.redirect(`/deliveries/my?error=Failed+to+start+trip:+${err.message}`);
    } finally {
        await session.endSession();
    }
});

// POST /deliveries/trip/end - End the current active trip
router.post('/trip/end', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    const { endOdometer } = req.body;

    console.log(`--- Driver ${loggedInUser._id} attempting END TRIP, Odo: ${endOdometer} ---`);

    if (endOdometer === undefined || endOdometer === null || endOdometer === '') {
         return res.redirect('/deliveries/my?error=End+Odometer+reading+is+required.');
    }
    const endOdoNum = parseFloat(endOdometer);
    if (isNaN(endOdoNum) || endOdoNum < 0) {
         return res.redirect('/deliveries/my?error=Invalid+End+Odometer+reading.');
    }

    const session = await mongoose.startSession();
    try {
        await session.withTransaction(async () => {
            // 1. Find the active trip for this driver
            const activeTrip = await TripLog.findOne({ 
                driverId: loggedInUser._id, 
                status: 'active' 
            }).session(session);

            if (!activeTrip) {
                throw new Error("No active trip found to end.");
            }

            // 2. Validate odometer reading
            if (endOdoNum < activeTrip.startOdometer) {
                 throw new Error(`End Odometer (${endOdoNum}km) cannot be less than the trip start reading (${activeTrip.startOdometer}km).`);
            }

            // 3. Update TripLog
            activeTrip.tripEndDate = new Date();
            activeTrip.endOdometer = endOdoNum;
            activeTrip.status = 'completed';
            // Optionally calculate duration/distance here if needed
            await activeTrip.save({ session });
            console.log(`TripLog ${activeTrip._id} marked as completed.`);

            // 4. Update Vehicle's Current Odometer
            // Fetch vehicle again within transaction to be safe
             const vehicle = await Vehicle.findById(activeTrip.vehicleId).session(session);
             if (vehicle) {
                 if (endOdoNum >= vehicle.currentOdometer) { // Update only if greater or equal
                     vehicle.currentOdometer = endOdoNum;
                     vehicle.lastUpdated = new Date();
                     await vehicle.save({ session });
                     console.log(`Vehicle ${vehicle._id} odometer updated to ${endOdoNum} on trip end.`);
                 } else {
                     console.warn(`End odometer ${endOdoNum} is less than vehicle's current ${vehicle.currentOdometer}. Not updating vehicle odo.`);
                 }
             } else {
                 console.warn(`Vehicle ${activeTrip.vehicleId} not found during trip end odometer update.`);
             }
        }); // Transaction commits

        res.redirect('/deliveries/my?success=Trip+ended+successfully.');

    } catch (err) {
        console.error("Error ending trip:", err);
        res.redirect(`/deliveries/my?error=Failed+to+end+trip:+${err.message}`);
    } finally {
        await session.endSession();
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

// GET /deliveries/vehicle/fuel-log/new - Show fuel log form
router.get('/vehicle/fuel-log/new', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;

    if (!loggedInUser.currentVehicleId) {
        return res.redirect('/deliveries/my?error=Please+select+a+vehicle+first+to+log+fuel.');
    }

    try {
        const currentVehicle = await Vehicle.findById(loggedInUser.currentVehicleId).lean();
        if (!currentVehicle) {
             // Clear user's current vehicle if it no longer exists? Or redirect with error.
             await User.findByIdAndUpdate(loggedInUser._id, { currentVehicleId: null });
             return res.redirect('/deliveries/my?error=Selected+vehicle+not+found.+Please+re-select.');
        }

        res.render('deliveries/fuel_log_form', {
            title: 'Log Fuel Entry',
            currentVehicle: currentVehicle,
            fuelTypes: Vehicle.FUEL_TYPES, // Pass fuel types enum
            formData: {}, // For initial form display
            layout: './layouts/dashboard_layout'
        });
    } catch(err) {
        console.error("Error showing fuel log form:", err);
        res.redirect(`/deliveries/my?error=Could+not+load+fuel+log+form.`);
    }
});

// POST /deliveries/vehicle/fuel-log - Save fuel log entry
router.post('/vehicle/fuel-log', async (req, res) => {
    const loggedInUser = res.locals.loggedInUser;
    const { vehicleId, odometerReading, fuelQuantityLiters, fuelCostTotalINR, fuelTypeFilled, notes } = req.body;

    if (!vehicleId || vehicleId !== loggedInUser.currentVehicleId?.toString()) {
         return res.redirect('/deliveries/my?error=Invalid+vehicle+for+fuel+log.');
    }

    const session = await mongoose.startSession(); // Use transaction for consistency
    try {
         await session.withTransaction(async () => {
            const odo = parseFloat(odometerReading);
            const qty = parseFloat(fuelQuantityLiters);
            const cost = parseFloat(fuelCostTotalINR);

            if (isNaN(odo) || isNaN(qty) || isNaN(cost)) {
                 throw new Error("Odometer, Quantity, and Cost must be valid numbers.");
            }
             if (qty <= 0 || cost < 0) {
                  throw new Error("Fuel quantity must be positive and cost cannot be negative.");
             }

            const vehicle = await Vehicle.findById(vehicleId).session(session);
            if (!vehicle) throw new Error("Vehicle not found.");
            if (odo < vehicle.currentOdometer) {
                 throw new Error(`New odometer reading (${odo}km) cannot be less than the current reading (${vehicle.currentOdometer}km).`);
            }

            // Create Fuel Log Entry
            const fuelLog = new FuelLog({
                vehicleId,
                driverId: loggedInUser._id,
                companyId: loggedInUser.companyId,
                logDate: new Date(), // Or allow user to set date? For now, use current time.
                odometerReading: odo,
                fuelQuantityLiters: qty,
                fuelCostTotalINR: cost,
                fuelTypeFilled: fuelTypeFilled || vehicle.fuelType, // Use vehicle's default if not specified
                notes
            });
            await fuelLog.save({ session });
            console.log(`Fuel log saved for vehicle ${vehicleId}`);

            // Update Vehicle's Current Odometer
            vehicle.currentOdometer = odo;
            vehicle.lastUpdated = new Date();
            await vehicle.save({ session });
            console.log(`Vehicle ${vehicleId} odometer updated to ${odo}`);
         }); // Transaction commits

        res.redirect('/deliveries/my?success=Fuel+log+added+successfully');

    } catch (err) {
        console.error("Error saving fuel log:", err);
        // Re-fetch vehicle data to re-render form accurately
        const currentVehicleData = await Vehicle.findById(vehicleId).lean(); // Fetch outside transaction for render
        res.status(400).render('deliveries/fuel_log_form', {
            title: 'Log Fuel Entry',
            currentVehicle: currentVehicleData || { _id: vehicleId }, // Provide vehicle data if possible
            fuelTypes: Vehicle.FUEL_TYPES,
            formData: req.body, // Repopulate form with submitted data
            error: `Failed to save fuel log: ${err.message}`,
            layout: './layouts/dashboard_layout'
        });
    } finally {
         await session.endSession();
    }
});

module.exports = router;