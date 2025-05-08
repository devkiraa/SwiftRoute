// models/PurchaseOrder.js
const mongoose = require('mongoose');
const AutoIncrement = require('mongoose-sequence')(mongoose); // For auto-incrementing PO number

const PurchaseOrderItemSchema = new mongoose.Schema({
    itemId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Item', 
        required: true 
    },
    orderedQuantity: { 
        type: Number, 
        required: [true, 'Ordered quantity is required.'], 
        min: [1, 'Ordered quantity must be at least 1.'] 
    },
    receivedQuantity: { // How many have been received against this line item so far
        type: Number, 
        default: 0,
        min: 0,
        validate: [ // Ensure received doesn't exceed ordered
            function(value) { return value <= this.orderedQuantity; },
            'Received quantity ({VALUE}) cannot exceed ordered quantity.'
        ]
    },
    unitCost: { // Cost per item from the supplier for this PO
        type: Number, 
        required: [true, 'Unit cost is required.'],
        min: [0, 'Unit cost cannot be negative.']
    }
}, { _id : false }); // No separate _id for sub-documents by default

const PurchaseOrderSchema = new mongoose.Schema({
    poNumber: { // Auto-incrementing number for easy reference
        type: Number,
        // Unique index will be added by the AutoIncrement plugin
    },
    companyId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Company', 
        required: true, 
        index: true 
    },
    warehouseId: { // Warehouse where stock will be received
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Warehouse', 
        required: true, 
        index: true 
    },
    supplierId: { 
        type: mongoose.Schema.Types.ObjectId, 
        ref: 'Supplier', 
        required: [true, 'Supplier is required.'], 
        index: true 
    },
    orderDate: { 
        type: Date, 
        default: Date.now 
    },
    expectedDeliveryDate: { 
        type: Date 
    },
    status: { 
        type: String, 
        enum: ['draft', 'ordered', 'partially_received', 'received', 'cancelled'], 
        default: 'draft', // Start as draft? Or 'ordered'? Let's use 'ordered' after creation.
        required: true,
        index: true
    },
    items: [PurchaseOrderItemSchema],
    totalValue: { // Calculated total cost of the PO
        type: Number,
        default: 0,
        min: 0
    },
    notes: { 
        type: String, 
        trim: true 
    },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    lastUpdated: { type: Date, default: Date.now }
    
}, { timestamps: true }); // Adds createdAt, updatedAt

// Apply the auto-increment plugin to poNumber, scoped to companyId
// Each company will have its own sequence starting from PO-1, PO-2 etc.
// Note: mongoose-sequence needs to be installed: npm install mongoose-sequence
PurchaseOrderSchema.plugin(AutoIncrement, { inc_field: 'poNumber', id: 'po_counter', reference_fields: ['companyId'] });

// Middleware to update lastUpdated timestamp
PurchaseOrderSchema.pre('save', function(next) { this.lastUpdated = new Date(); next(); });
PurchaseOrderSchema.pre('findOneAndUpdate', function(next) { this.set({ lastUpdated: new Date() }); next(); });

// Method to calculate total value before saving
PurchaseOrderSchema.pre('save', function(next) {
    this.totalValue = this.items.reduce((sum, item) => {
        return sum + (item.orderedQuantity * item.unitCost);
    }, 0);
    next();
});

// Optional: Method to update status based on received quantities (can be called after receiving stock)
PurchaseOrderSchema.methods.updateStatusBasedOnReceived = function() {
    if (this.status === 'cancelled') return; // Don't change if cancelled

    const totalOrdered = this.items.reduce((sum, item) => sum + item.orderedQuantity, 0);
    const totalReceived = this.items.reduce((sum, item) => sum + item.receivedQuantity, 0);

    if (totalReceived === 0) {
        this.status = 'ordered';
    } else if (totalReceived < totalOrdered) {
        this.status = 'partially_received';
    } else { // totalReceived >= totalOrdered
        this.status = 'received';
    }
};


module.exports = mongoose.model('PurchaseOrder', PurchaseOrderSchema);