// routes/stores.js
const express = require('express');
const Store = require('../models/Store');
const User = require('../models/User');
// Import Google Maps Client
const { Client } = require("@googlemaps/google-maps-services-js");

const router = express.Router();

// Initialize Google Maps Client (uses Maps_API_KEY env variable by default)
const googleMapsClient = new Client({});
const Maps_API_KEY_CONFIG = { key: process.env.Maps_API_KEY }; // Needed for some client methods

// --- Store Form Routes (GET /new, POST /) ---
// These remain largely the same, but GET /new no longer needs to pass an API key
router.get('/new', /* ensureAuthenticated, */ (req, res) => {
  res.render('new_store', {
    title: 'Add New Store',
    // No API key needed here now, it will be in the script tag in the EJS
    googleMapsApiKey: process.env.Maps_API_KEY // Pass key for frontend script
  });
});

router.post('/', /* ensureAuthenticated, */ async (req, res) => {
  // ... (Keep the POST logic to save the store data) ...
  // It still receives latitude and longitude from hidden inputs
   try {
        const { storeName, address, phone, email, deliveryWindow, latitude, longitude } = req.body;
        if (!latitude || !longitude || !storeName || !address) {
           throw new Error('Missing required fields (Store Name, Address, Location).');
        }
        const loggedInUserId = req.session.userId;
        const currentUser = await User.findById(loggedInUserId).lean();
        if (!currentUser || !currentUser.companyId) { throw new Error('User or company not found.'); }

        const newStore = new Store({
          companyId: currentUser.companyId,
          storeName, address, phone, email, deliveryWindow,
          location: { type: 'Point', coordinates: [parseFloat(longitude), parseFloat(latitude)] }
        });
        await newStore.save();
        res.redirect('/dashboard');
      } catch (err) {
        console.error('Error adding store:', err);
        res.render('new_store', {
          title: 'Add New Store',
           googleMapsApiKey: process.env.Maps_API_KEY, // Pass key again on error
          error: `Failed to add store: ${err.message}`,
          formData: req.body
        });
      }
});


// --- NEW Google Maps API Proxy Routes ---

// 1. Google Place Autocomplete Proxy
// Note: Google Autocomplete is often handled entirely client-side with the JS API library for simplicity and better billing (using session tokens).
// This backend proxy is an alternative if you want server-side control or logging.
router.get('/api/google/autocomplete', async (req, res) => {
  const { input } = req.query;
  if (!input) {
    return res.status(400).json({ error: 'Input query is required' });
  }
  try {
    const response = await googleMapsClient.placeAutocomplete({
      params: {
        input: input,
        key: Maps_API_KEY_CONFIG.key,
        // Optional: Add components for country restriction, e.g., components: 'country:in'
        components: ['country:in'],
        // Optional: Add location biasing (lat/lng and radius)
      },
      timeout: 1000 // Optional timeout
    });
    res.json(response.data.predictions || []);
  } catch (error) {
    console.error('Google Autocomplete Error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: 'Failed to fetch autocomplete suggestions' });
  }
});

// 2. Google Geocoding Proxy (Address -> Lat/Lng)
router.get('/api/google/geocode', async (req, res) => {
  const { address } = req.query;
   if (!address) {
    return res.status(400).json({ error: 'Address is required' });
  }
  try {
      const response = await googleMapsClient.geocode({
          params: {
              address: address,
              key: Maps_API_KEY_CONFIG.key,
              // Optional: components: { country: 'IN' }
              components: { country: 'IN' }
          }
      });

      if (response.data.results && response.data.results.length > 0) {
          const location = response.data.results[0].geometry.location; // { lat: ..., lng: ... }
          res.json({ latitude: location.lat, longitude: location.lng });
      } else {
          console.warn("Google Geocode: No results found for address:", address);
          res.status(404).json({ error: 'Coordinates not found for the address' });
      }
  } catch (error) {
    console.error('Google Geocode Error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: 'Failed to geocode address' });
  }
});

// 3. Google Reverse Geocoding Proxy (Lat/Lng -> Address)
router.get('/api/google/reverse_geocode', async (req, res) => {
  const { lat, lng } = req.query;
  const latitude = parseFloat(lat);
  const longitude = parseFloat(lng);

  if (isNaN(latitude) || isNaN(longitude)) {
    return res.status(400).json({ error: 'Valid Latitude and Longitude are required' });
  }

  try {
      const response = await googleMapsClient.reverseGeocode({
          params: {
              latlng: { latitude, longitude },
              key: Maps_API_KEY_CONFIG.key,
              // Optional: result_type: 'street_address', location_type: 'ROOFTOP'
          }
      });

      if (response.data.results && response.data.results.length > 0) {
           // Return the first result's formatted address
          const formattedAddress = response.data.results[0].formatted_address;
          res.json({ address: formattedAddress });
       } else {
          console.warn("Google Reverse Geocode: No results found for coordinates:", {latitude, longitude});
          res.status(404).json({ error: 'Address not found for the given coordinates' });
       }
  } catch (error) {
    console.error('Google Reverse Geocode Error:', error.response?.data || error.message);
    res.status(error.response?.status || 500).json({ error: 'Failed to reverse geocode coordinates' });
  }
});


module.exports = router;