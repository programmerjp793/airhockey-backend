# Blockchain Transaction Tracking System

## Overview
The backend now integrates blockchain transaction recording and tracking. All purchases and blockchain interactions are automatically recorded in MongoDB for history, analytics, and user reference.

---

## Models

### Transaction Schema (`models/Transaction.js`)

Stores complete blockchain transaction information:

```javascript
{
  // Transaction Identifiers
  transactionHash: String (unique, indexed),
  playerId: ObjectId (ref: Player, indexed),
  playerAddress: String (indexed),

  // Item Details
  itemId: Number (indexed),
  itemName: String,
  priceETH: String (for precision),
  priceWei: String (BigInt-safe),

  // Status Tracking
  status: String (enum: 'pending', 'confirmed', 'failed'),
  failureReason: String,

  // Blockchain Details
  chainId: Number (11155111 for Sepolia),
  blockNumber: Number (indexed),
  gasUsed: String,
  gasPrice: String,
  transactionFeeETH: String,

  // Transaction Type
  type: String (enum: 'purchase', 'admin_action', 'reward', 'refund'),
  methodName: String (e.g., 'buyItem'),
  contractAddress: String,

  // Metadata
  metadata: Mixed (additional data),
  createdAt: Date (indexed),
  confirmedAt: Date,
  updatedAt: Date
}
```

---

## Services

### Transaction Service (`services/transactionService.js`)

Core service for all transaction operations:

#### Recording Transactions
```javascript
await transactionService.recordTransaction({
  transactionHash,
  playerId,
  playerAddress,
  itemId,
  itemName,
  priceETH,
  priceWei,
  chainId,
  contractAddress,
  methodName,
  type,
  metadata
});
```

#### Confirming Transactions
```javascript
await transactionService.confirmTransaction(txHash, {
  blockNumber,
  gasUsed,
  gasPrice
});
```

#### Marking Failed Transactions
```javascript
await transactionService.failTransaction(txHash, 'Reason for failure');
```

#### Querying Transactions
```javascript
// Get by hash
const tx = await transactionService.getTransactionByHash(txHash);

// Get player history
const history = await transactionService.getPlayerTransactions(playerId, {
  limit: 50,
  skip: 0,
  status: 'confirmed',
  type: 'purchase'
});

// Get player stats
const stats = await transactionService.getPlayerPurchaseStats(playerId);

// Get by address
const txs = await transactionService.getTransactionsByAddress(walletAddress);

// Check pending
const pending = await transactionService.getPendingTransactions({
  limit: 100,
  minAgeMinutes: 5
});
```

---

## API Endpoints

### Transaction History Routes (`routes/transactions.js`)

#### 1. Get Player Transaction History
**Endpoint:** `GET /api/transactions/history`

**Authentication:** Required (player token)

**Query Parameters:**
- `limit` (default: 50, max: 100) - Results per page
- `skip` (default: 0) - Pagination offset
- `status` (optional) - Filter: 'pending', 'confirmed', 'failed'
- `type` (optional) - Filter: 'purchase', 'admin_action', 'reward', 'refund'

**Example Request:**
```bash
curl -X GET "http://localhost:3000/api/transactions/history?limit=10&status=confirmed" \
  -H "Authorization: Bearer <player_token>"
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "transactions": [
      {
        "_id": "...",
        "transactionHash": "0xabc...",
        "itemId": 1,
        "itemName": "Wallet Upgrade I",
        "priceETH": "0.001",
        "status": "confirmed",
        "blockNumber": 5123456,
        "createdAt": "2024-03-21T10:30:00Z",
        "confirmedAt": "2024-03-21T10:31:30Z",
        "metadata": {...}
      }
    ],
    "pagination": {
      "total": 15,
      "limit": 10,
      "skip": 0
    }
  }
}
```

---

#### 2. Get Player Purchase Statistics
**Endpoint:** `GET /api/transactions/stats`

**Authentication:** Required (player token)

**Example Request:**
```bash
curl -X GET "http://localhost:3000/api/transactions/stats" \
  -H "Authorization: Bearer <player_token>"
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "purchaseStats": [
      {
        "_id": 1,
        "itemId": 1,
        "itemName": "Wallet Upgrade I",
        "count": 1,
        "totalSpentETH": "0.001",
        "totalSpentWei": "1000000000000000",
        "confirmed": 1
      }
    ],
    "totalItems": 1
  }
}
```

---

#### 3. Get Single Transaction by Hash
**Endpoint:** `GET /api/transactions/:txHash`

**Authentication:** Required (must be transaction owner)

**Path Parameters:**
- `txHash` - Transaction hash (0x... format)

**Example Request:**
```bash
curl -X GET "http://localhost:3000/api/transactions/0xabc123..." \
  -H "Authorization: Bearer <player_token>"
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "_id": "...",
    "transactionHash": "0xabc...",
    "playerAddress": "0x123...",
    "itemId": 1,
    "itemName": "Wallet Upgrade I",
    "priceETH": "0.001",
    "status": "confirmed",
    "blockNumber": 5123456,
    "gasUsed": "45000",
    "gasPrice": "25000000000",
    "transactionFeeETH": "0.001125",
    "createdAt": "2024-03-21T10:30:00Z",
    "confirmedAt": "2024-03-21T10:31:30Z",
    "playerId": {
      "_id": "...",
      "username": "player123",
      "walletAddress": "0x123..."
    },
    "metadata": {...}
  }
}
```

**Error Response (403 - Not Owner):**
```json
{
  "success": false,
  "message": "Access denied"
}
```

---

#### 4. Check Transaction Status
**Endpoint:** `GET /api/transactions/status/:txHash`

**Authentication:** Not required (public endpoint)

**Path Parameters:**
- `txHash` - Transaction hash

**Example Request:**
```bash
curl -X GET "http://localhost:3000/api/transactions/status/0xabc123..."
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "hash": "0xabc...",
    "status": "confirmed",
    "blockNumber": 5123456,
    "failureReason": null,
    "confirmedAt": "2024-03-21T10:31:30Z"
  }
}
```

---

#### 5. Get Transactions by Wallet Address
**Endpoint:** `GET /api/transactions/address/:walletAddress`

**Authentication:** Not required

**Path Parameters:**
- `walletAddress` - Ethereum wallet address (0x... format)

**Query Parameters:**
- `limit` (default: 50, max: 100)
- `skip` (default: 0)
- `status` (optional) - Filter by status

**Example Request:**
```bash
curl -X GET "http://localhost:3000/api/transactions/address/0x123456...?limit=20"
```

**Success Response (200):**
```json
{
  "success": true,
  "data": {
    "walletAddress": "0x123...",
    "transactions": [...],
    "count": 5
  }
}
```

---

## Integration with Purchase Flow

### Automatic Transaction Recording

When a player purchases an item via `/api/purchase/submit-tx`:

1. **Transaction Submitted**
   - Recorded as 'pending' status

2. **Transaction Confirmed (on-chain)**
   - Status updated to 'confirmed'
   - Block details recorded (blockNumber, gasUsed, gasPrice)
   - Transaction fee calculated and stored

3. **Transaction Failed**
   - Status updated to 'failed'
   - Failure reason recorded
   - Still tracked for analytics

### Example Flow

```javascript
// 1. Player submits purchase TX
POST /api/purchase/submit-tx {
  txHash: "0xabc...",
  itemId: 1,
  walletAddress: "0x123..."
}

// Behind the scenes:
// - Transaction recorded as pending
// - waitForTransaction() confirms on-chain
// - confirmTransaction() updates with block details
// - History is now queryable via /api/transactions/history
```

---

## Database Indexes

The Transaction schema includes optimized indexes for common queries:

```javascript
// Single field indexes
transactionHash (unique)
playerId
playerAddress
itemId
status
type
blockNumber
createdAt

// Compound indexes
{ playerId: 1, createdAt: -1 }
{ playerAddress: 1, createdAt: -1 }
{ status: 1, createdAt: -1 }
{ type: 1, createdAt: -1 }
```

This ensures fast querying of:
- All player transactions
- Pending transactions
- Transactions in a time range
- Transactions by status/type

---

## Error Handling

All transaction operations include error handling:

```javascript
try {
  await transactionService.recordTransaction({...});
} catch (err) {
  console.error('Transaction recording failed:', err.message);
  // Transaction is logged but doesn't block purchase completion
}
```

If transaction recording fails, the purchase still completes successfully. Failed recordings are logged for debugging.

---

## Usage Examples

### Backend Integration

```javascript
const transactionService = require('../services/transactionService');

// Record a purchase
const tx = await transactionService.recordTransaction({
  transactionHash: receipt.hash,
  playerId: player._id,
  playerAddress: player.walletAddress,
  itemId: 1,
  itemName: 'Test Item',
  priceETH: '0.001',
  priceWei: receipt.value.toString(),
  chainId: 11155111,
  contractAddress: process.env.SMART_STORE_ADDRESS,
  type: 'purchase'
});

// Confirm it later
await transactionService.confirmTransaction(receipt.hash, {
  blockNumber: receipt.blockNumber,
  gasUsed: receipt.gasUsed.toString(),
  gasPrice: receipt.gasPrice.toString()
});
```

### Frontend (Unity)

```csharp
// Get transaction history
GET /api/transactions/history
Authorization: Bearer <token>

// Check single transaction
GET /api/transactions/0xabc...
Authorization: Bearer <token>

// Public status check (no auth needed)
GET /api/transactions/status/0xabc...
```

---

## Monitoring & Analytics

Use the transaction schema for:

- **User Analytics:** How many items each player purchased
- **Revenue Tracking:** Total ETH collected per item
- **Failed Purchases:** Identify problematic items or edge cases
- **Gas Optimization:** Track gas prices and fees over time
- **Audit Trail:** Complete history of all blockchain interactions

---

## Future Enhancements

- Real-time WebSocket updates for transaction status
- Export transaction history (CSV, PDF)
- Transaction retry logic for stuck pending transactions
- GraphQL API for complex queries
- Advanced analytics dashboard
- Automated refund processing
