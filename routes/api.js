// routes/api.js (or in index.js)
const express = require('express');
const axios = require('axios');
const router = express.Router();

router.get('/geocode/reverse', async (req, res) => {
    const { lat, lng } = req.query;
    if (!lat || !lng) {
        return res.status(400).json({ error: 'Latitude and longitude are required.' });
    }
    try {
        const apiKey = process.env.Maps_API_KEY; // Use your backend key
        const url = `https://maps.googleapis.com/maps/api/geocode/json?latlng=<span class="math-inline">\{lat\},</span>{lng}&key=${apiKey}`;
        const response = await axios.get(url);
        if (response.data.results && response.data.results.length > 0) {
            res.json({ address: response.data.results[0].formatted_address });
        } else {
            res.json({ address: 'Address not found for these coordinates.' });
        }
    } catch (error) {
        console.error('Reverse geocoding API error:', error.message);
        res.status(500).json({ error: 'Failed to fetch address.' });
    }
});
module.exports = router;