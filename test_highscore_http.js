const crypto = require('crypto');

async function runTest() {
  try {
    const baseUrl = 'http://localhost:3000/api';
    
    console.log('--- Logging in to get token (wallet-login) ---');
    const loginRes = await fetch(`${baseUrl}/auth/wallet-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: '0x1A2b3c4D5e6F7g8H9i0j1K2L3M4N5O6P7Q8R9S0T'.replace(/g8H9i0j1K2L3M4N5O6P7Q8R9S0T/, 'a8b9c0d1e2f3a4b5c6d7e8f9a0b1'), // Make it valid hex 40 chars
      })
    });
    
    // valid address: 0x1111222233334444555566667777888899990000
    const walletAddress = '0x1111222233334444555566667777888899990000';

    const loginRes2 = await fetch(`${baseUrl}/auth/wallet-login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        walletAddress: walletAddress,
      })
    });

    if (!loginRes2.ok) throw new Error(await loginRes2.text());
    const loginData = await loginRes2.json();
    const token = loginData.token;
    console.log('Login success, acquired token.');

    console.log('\n--- 1. Testing GET /api/match/highscores (Empty state) ---');
    let res1 = await fetch(`${baseUrl}/match/highscores`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    console.log('GET /highscores response:', await res1.json());

    console.log('\n--- 2. Testing POST /api/match/create ---');
    let res2 = await fetch(`${baseUrl}/match/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ difficulty: 'easy' })
    });
    const matchData = await res2.json();
    console.log('POST /create response:', matchData);
    
    const { matchId, matchToken, aiProfile } = matchData;
    delete aiProfile.profileHash;
    const profileJson = JSON.stringify(aiProfile);
    const profileHash = crypto.createHash("sha256").update(profileJson).digest("hex");

    console.log('\n--- 3. Testing POST /api/match/submit-result ---');
    let res3 = await fetch(`${baseUrl}/match/submit-result`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        matchId: matchId,
        matchToken: matchToken,
        winner: 'player',
        playerScore: 5,
        aiScore: 2,
        durationSecs: 42,
        clientProfileHash: profileHash
      })
    });
    console.log('POST /submit-result response:', await res3.json());

    console.log('\n--- 4. Testing GET /api/match/highscores (After Win) ---');
    let res4 = await fetch(`${baseUrl}/match/highscores`, {
      headers: { Authorization: `Bearer ${token}` }
    });
    const highscoresData = await res4.json();
    console.log('GET /highscores response:', JSON.stringify(highscoresData, null, 2));
    
    if (highscoresData.bestTime === 42) {
       console.log('SUCCESS! bestTime is correctly updated to 42s.');
    } else {
       console.error('FAILURE! bestTime is not 42s.');
    }

  } catch (err) {
    console.error('Test failed:', err);
  }
}

runTest();
