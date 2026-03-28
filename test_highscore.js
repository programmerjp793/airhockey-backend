const mongoose = require('mongoose');
const jwt = require('jsonwebtoken');
require('dotenv').config();

const Player = require('./models/Player');
const Match = require('./models/Match');

async function runTest() {
  try {
    const mongoUri = process.env.MONGODB_URI_NEW || process.env.MONGODB_URI;
    console.log('Connecting to MongoDB...', mongoUri);
    await mongoose.connect(mongoUri, { useNewUrlParser: true, useUnifiedTopology: true });
    console.log('Connected.');

    // Find or create a test player
    let player = await Player.findOne({ unityPlayerId: 'TEST_HIGHSCORE_PLAYER' });
    if (!player) {
      player = await Player.create({
        unityPlayerId: 'TEST_HIGHSCORE_PLAYER',
        username: 'TestHighScore',
      });
      console.log('Created test player:', player._id);
    } else {
      console.log('Found existing test player:', player._id);
      // Reset best time for clean run
      player.bestTime = null;
      player.bestTimeMatchId = null;
      await player.save();
    }

    // Generate JWT token just like auth.js does
    const token = jwt.sign(
      { playerId: player._id.toString(), unityPlayerId: player.unityPlayerId },
      process.env.JWT_SECRET,
      { expiresIn: '1h' }
    );

    // Now let's simulate the API calls
    const baseUrl = 'http://localhost:3000/api';
    const axios = require('axios');

    console.log('\n--- 1. Testing GET /api/match/highscores (Empty state) ---');
    try {
      const res1 = await axios.get(`${baseUrl}/match/highscores`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      console.log('GET /highscores response:', res1.data);
    } catch (err) {
      console.error('Expected NO ERROR but got:', err.response?.data || err.message);
    }

    console.log('\n--- 2. Testing POST /api/match/create ---');
    let matchId, matchToken, profileHash;
    try {
      const res2 = await axios.post(`${baseUrl}/match/create`, 
        { difficulty: 'easy' },
        { headers: { Authorization: `Bearer ${token}` } }
      );
      console.log('POST /create response:', res2.data);
      matchId = res2.data.matchId;
      matchToken = res2.data.matchToken;
      
      const crypto = require('crypto');
      const profile = res2.data.aiProfile;
      delete profile.profileHash; // just in case
      const profileJson = JSON.stringify(profile);
      profileHash = crypto.createHash("sha256").update(profileJson).digest("hex");
    } catch (err) {
      console.error('POST /create failed:', err.response?.data || err.message);
    }

    console.log('\n--- 3. Testing POST /api/match/submit-result ---');
    try {
      const payload = {
        matchId: matchId,
        matchToken: matchToken,
        winner: 'player',
        playerScore: 5,
        aiScore: 2,
        durationSecs: 42,
        clientProfileHash: profileHash
      };
      const res3 = await axios.post(`${baseUrl}/match/submit-result`, payload, {
        headers: { Authorization: `Bearer ${token}` }
      });
      console.log('POST /submit-result response:', res3.data);
    } catch (err) {
      console.error('POST /submit-result failed:', err.response?.data || err.message);
    }

    console.log('\n--- 4. Testing GET /api/match/highscores (After Win) ---');
    try {
      const res4 = await axios.get(`${baseUrl}/match/highscores`, {
        headers: { Authorization: `Bearer ${token}` }
      });
      console.log('GET /highscores response:', JSON.stringify(res4.data, null, 2));
      
      if (res4.data.bestTime === 42) {
         console.log('SUCCESS! bestTime is correctly updated to 42s.');
      } else {
         console.error('FAILURE! bestTime is not 42s.');
      }
    } catch (err) {
      console.error('GET /highscores failed:', err.response?.data || err.message);
    }

    await mongoose.disconnect();
    console.log('Disconnected from MongoDB.');
    process.exit(0);

  } catch (err) {
    console.error('Fatal Test Error:', err);
    process.exit(1);
  }
}

runTest();
