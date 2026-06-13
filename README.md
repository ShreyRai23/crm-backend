<div align="center">
  <h1>Xeno Mini CRM - Backend & Channel Service</h1>
  <p>The core intelligence and data engine powering the AI-Native Mini CRM.</p>
  <p>
    <img src="https://img.shields.io/badge/Node.js-339933?style=for-the-badge&logo=nodedotjs&logoColor=white" alt="Node.js" />
    <img src="https://img.shields.io/badge/Express.js-000000?style=for-the-badge&logo=express&logoColor=white" alt="Express" />
    <img src="https://img.shields.io/badge/MongoDB-4EA94B?style=for-the-badge&logo=mongodb&logoColor=white" alt="MongoDB" />
    <img src="https://img.shields.io/badge/Google_Gemini-8E75B2?style=for-the-badge&logo=googlegemini&logoColor=white" alt="Gemini" />
  </p>
</div>

<br />

This repository contains a monolithic architecture that houses the main CRM API, a background campaign scheduler, and a decoupled Channel Service simulator to mimic real-world messaging delivery.

## Architecture

This project deliberately implements a two-service, callback-driven loop:

1.  **CRM Service**: Manages data ingestion, segment querying, AI interactions, and campaign dispatching.
2.  **Channel Service (Simulator)**: Acts as an external messaging provider. It receives dispatch requests and asynchronously fires webhooks back to the CRM to report simulated delivery statuses (Delivered, Failed, Read, Clicked).

## Key Features

*   **Gemini AI Integration**: Powers natural language querying for audience segmentation and automated content generation.
*   **Asynchronous Campaign Engine**: Handles dispatching messages, audience matching, and tracking statuses efficiently.
*   **Delivery Simulation Engine**: Simulates realistic network latency, failure rates, and engagement tracking via webhooks.
*   **Scalable API Design**: Features cursor-based pagination, rate limiting for AI endpoints, and centralized error handling.

## Tech Stack

*   **Runtime**: Node.js
*   **Framework**: Express.js
*   **Database**: MongoDB + Mongoose
*   **AI Provider**: Google Gemini API (gemini-3.5-flash)
*   **Concurrency Handling**: p-limit for controlled asynchronous batch processing

## Local Development

### Prerequisites

*   Node.js (v18 or higher)
*   MongoDB Instance (Atlas or Local)
*   Google Gemini API Key

### Installation

1. Clone the repository.
2. Install dependencies:
   ```bash
   npm install
   ```
3. Configure environment variables (refer to `.env.example`):
   ```bash
   cp .env.example .env
   ```
   *Ensure you add your MongoDB URI and Gemini API Key to the `.env` file.*

4. Start both services (CRM and Channel Simulator) concurrently:
   ```bash
   npm run dev
   ```

### Seeding Data

To populate the database with realistic sample customers and orders:
```bash
npm run seed
```

## API Structure

*   `/api/customers` - Data ingestion and retrieval
*   `/api/campaigns` - Campaign management and audience matching
*   `/api/ai` - AI features (Suggestions, NL Queries, Content Generation)
*   `/api/receipt` - Webhook endpoints for the Channel Service
*   `/api/analytics` - Aggregated performance and revenue insights

## Deployment

Configured for deployment on Render via `render.yaml`.
