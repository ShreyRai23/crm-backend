# Mini CRM Backend — AI-Native B2C CRM

> Xeno Engineering Internship Assignment 2026

## Architecture

```
backend/
├── src/               # CRM Service (port 3000)
│   ├── config/        # DB + Gemini AI config
│   ├── models/        # Mongoose schemas
│   ├── routes/        # Express routers
│   ├── controllers/   # Business logic handlers
│   ├── services/      # Core services (AI, Delivery, Campaign)
│   └── middleware/    # Error handling, Idempotency, Validation
│
├── channel-service/   # Simulated messaging vendor (port 3001)
│   ├── server.js
│   ├── router.js      # POST /send endpoint
│   └── simulator.js   # Latency + outcome randomizer
│
└── scripts/
    └── seed.js        # Seeds 1000+ customers + orders
```

## Quick Start

```bash
# 1. Install dependencies
npm install

# 2. Seed the database (1000 customers + sample campaigns)
npm run seed

# 3. Start both services concurrently
npm run dev
```

## Services

| Service | Port | Purpose |
|---------|------|---------|
| CRM Service | 3000 | Main API — customers, campaigns, AI |
| Channel Service | 3001 | Simulated messaging vendor |

## API Reference

### Customers
```
GET    /api/customers?limit=20&cursor=<id>&search=<text>&tags=vip,premium
GET    /api/customers/stats
GET    /api/customers/:id
POST   /api/customers        { name, email, phone, tags, preferredChannel }
PUT    /api/customers/:id
DELETE /api/customers/:id    (soft delete)
```

### Orders
```
GET  /api/orders?page=1&limit=20&customerId=<id>&minAmount=500
GET  /api/orders/stats
GET  /api/orders/:id
POST /api/orders             { customerId, amount, items, status }
```

### Campaigns
```
GET  /api/campaigns?status=running&channel=email
GET  /api/campaigns/stats
GET  /api/campaigns/:id
GET  /api/campaigns/:id/audience-preview
GET  /api/campaigns/:id/communications?status=delivered
POST /api/campaigns          { name, audienceQuery, message, channel }
                             Header: Idempotency-Key: <uuid>
POST /api/campaigns/:id/send Header: Idempotency-Key: <uuid>
```

### AI Endpoints
```
POST /api/ai/query
     { "prompt": "Find customers who spent over ₹5000 last year" }

POST /api/ai/generate-content
     { "audienceDescription": "...", "channel": "whatsapp", "campaignGoal": "..." }

POST /api/ai/query-and-generate   (wizard: returns pipeline + content)
     { "audiencePrompt": "...", "channel": "email", "campaignGoal": "..." }
```

### Webhooks
```
POST /api/receipt/delivery   (called by Channel Service — not for manual use)
```

## Key Design Decisions

### Async Delivery Loop
1. CRM calls `POST /api/campaigns/:id/send`
2. Audience resolved → Communication docs created (status: pending)
3. Each communication fired to Channel Service (`POST :3001/send`) — returns `vendorMessageId` immediately
4. Channel Service simulates 500ms–5s delay, then fires webhook to CRM
5. Receipt controller atomically updates Communication status + Campaign stats

### Idempotency
- Pass `Idempotency-Key: <uuid>` header on POST /campaigns and POST /campaigns/:id/send
- Retries return the cached response; no duplicate campaigns created
- 24-hour TTL cache (in-memory Map; swap for Redis in production)

### Race Condition Prevention
- Receipt controller uses `findOneAndUpdate` with `status: 'sent'` guard
- `vendorMessageId` has a sparse-unique index as second layer of protection
- Campaign stats updated with `$inc` (atomic counter)

### NL → MongoDB Safety
- Gemini output validated against an operator allowlist
- Blocked: `$where`, `$function`, `$accumulator`, `$out`, `$merge`, `$lookup`
- Pipeline capped at 500 results maximum

## Seeder
```bash
npm run seed           # Add data (safe to run multiple times)
npm run seed -- --reset  # Drop all data first, then seed
```

Generates:
- 1,000 customers (Indian locale, realistic names/cities/emails)
- ~4,000 orders (3–8 per customer)
- 3 sample campaigns ready to send
