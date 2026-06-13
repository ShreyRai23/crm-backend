'use strict';

/**
 * Gemini Service
 *
 * Two core AI capabilities:
 * 1. nlToMongodbPipeline  — Converts natural language to a validated
 *    MongoDB aggregation pipeline using the Customer & Order schemas as context.
 *
 * 2. generateCampaignContent — Generates channel-personalized campaign
 *    messaging (WhatsApp, Email, SMS) given audience context and campaign goal.
 */

const { generateContent } = require('../config/gemini');
const { AppError } = require('../middleware/errorHandler');

// ─── Operator allowlist ───────────────────────────────────────────────────────
// Only safe, read-only aggregation operators are permitted.
// Any operator containing $where, $function, $accumulator with JS,
// or $out/$merge (write operators) are blocked.
const BLOCKED_OPERATORS = [
  '$where',
  '$function',
  '$accumulator',
  '$out',
  '$merge',
  '$lookup', // Blocked to prevent cross-collection data exfiltration
  '$graphLookup',
];

const ALLOWED_STAGES = [
  '$match',
  '$group',
  '$sort',
  '$limit',
  '$skip',
  '$project',
  '$unwind',
  '$count',
  '$addFields',
  '$replaceRoot',
  '$bucket',
  '$bucketAuto',
  '$sortByCount',
  '$facet',
  '$sample',
];

/**
 * Recursively scans a pipeline for blocked operators.
 * @param {*} obj - Any part of the pipeline object.
 * @returns {string|null} The blocked operator found, or null if safe.
 */
const findBlockedOperator = (obj) => {
  if (typeof obj !== 'object' || obj === null) return null;

  for (const key of Object.keys(obj)) {
    if (BLOCKED_OPERATORS.includes(key)) return key;
    const nested = findBlockedOperator(obj[key]);
    if (nested) return nested;
  }
  return null;
};

/**
 * Validates a pipeline array against the allowlist.
 * @param {Array} pipeline
 * @throws {AppError} If the pipeline is invalid or contains blocked operators.
 */
const validatePipeline = (pipeline) => {
  if (!Array.isArray(pipeline)) {
    throw new AppError('AI returned a non-array pipeline. Please rephrase your query.', 400, 'INVALID_PIPELINE');
  }

  for (const stage of pipeline) {
    const stageKey = Object.keys(stage)[0];
    if (!ALLOWED_STAGES.includes(stageKey)) {
      throw new AppError(
        `Pipeline stage '${stageKey}' is not permitted for security reasons.`,
        400,
        'BLOCKED_PIPELINE_STAGE'
      );
    }
    const blocked = findBlockedOperator(stage);
    if (blocked) {
      throw new AppError(
        `Pipeline contains blocked operator '${blocked}'.`,
        400,
        'BLOCKED_PIPELINE_OPERATOR'
      );
    }
  }
};

// ─── Schema context injected into Gemini prompts ──────────────────────────────
const CUSTOMER_SCHEMA_CONTEXT = `
Collection: customers
Fields:
  - _id: ObjectId
  - name: String (customer name)
  - email: String
  - phone: String
  - totalSpend: Number (total money spent across all orders)
  - visitCount: Number (number of store visits/sessions)
  - lastVisit: Date (last activity date)
  - tags: [String] (e.g., "vip", "new", "churned", "premium")
  - preferredChannel: String ("whatsapp" | "email" | "sms" | "rcs")
  - isActive: Boolean
  - city: String
  - country: String
  - createdAt: Date

Collection: orders
Fields:
  - _id: ObjectId
  - customerId: ObjectId (ref to customers._id)
  - amount: Number (order total in INR)
  - items: [{name: String, quantity: Number, price: Number}]
  - status: String ("pending" | "processing" | "shipped" | "delivered" | "cancelled" | "refunded")
  - purchasedAt: Date
  - createdAt: Date
`.trim();

// ─── 1. Natural Language → MongoDB Aggregation Pipeline ──────────────────────

/**
 * Converts a marketer's natural language query into a validated
 * MongoDB aggregation pipeline that can run against the 'customers' collection.
 *
 * @param {string} prompt - e.g., "Find customers who spent over ₹500 last year"
 * @returns {Promise<{ pipeline: Array, explanation: string }>}
 */
const nlToMongodbPipeline = async (prompt) => {
  const systemPrompt = `
You are a MongoDB aggregation pipeline expert for a B2C CRM system.
Your ONLY job is to convert natural language queries into safe, read-only MongoDB aggregation pipelines.

DATABASE SCHEMA:
${CUSTOMER_SCHEMA_CONTEXT}

RULES (CRITICAL):
1. Return ONLY valid JSON — a MongoDB aggregation pipeline array.
2. Do NOT include markdown code blocks, explanations, or any text outside the JSON.
3. The pipeline MUST start with a $match or valid stage that targets the "customers" collection.
4. NEVER use: $where, $function, $accumulator, $out, $merge, $lookup, $graphLookup.
5. Use only: $match, $group, $sort, $limit, $skip, $project, $unwind, $count, $addFields, $replaceRoot, $bucket, $bucketAuto, $sortByCount, $facet, $sample.
6. For date comparisons, use ISO date strings in $date expressions.
7. Always add a $limit stage capped at 500 to prevent full scans.
8. For queries involving orders (spend, purchases), use $match on customers.totalSpend since orders are pre-aggregated there.
9. Return customers that are isActive: true unless the query specifically asks for inactive ones.

EXAMPLE:
Input: "customers who haven't visited in 3 months"
Output: [{"$match":{"isActive":true,"lastVisit":{"$lt":{"$date":"2024-03-10T00:00:00.000Z"}}}},{"$sort":{"lastVisit":-1}},{"$limit":500}]

Now convert this query into a pipeline JSON array. Return ONLY the JSON array, nothing else:
"${prompt}"
`.trim();

  let rawResponse;
  try {
    rawResponse = await generateContent(systemPrompt, { temperature: 0.1 });
  } catch (err) {
    throw new AppError(`Gemini AI error: ${err.message}`, 502, 'AI_SERVICE_ERROR');
  }

  // Strip markdown code fences if model adds them
  const cleaned = rawResponse
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  let pipeline;
  try {
    pipeline = JSON.parse(cleaned);
  } catch {
    throw new AppError(
      'AI returned an unparseable response. Please rephrase your query.',
      422,
      'AI_PARSE_ERROR'
    );
  }

  // Security validation
  validatePipeline(pipeline);

  // Generate a human-readable explanation
  const explanationPrompt = `
In one concise sentence (max 20 words), explain what this MongoDB pipeline does for a non-technical marketer:
${JSON.stringify(pipeline)}
Return only the sentence, no extra text.
`.trim();

  let explanation = 'AI-generated audience query';
  try {
    explanation = (await generateContent(explanationPrompt, { temperature: 0.3 })).trim();
  } catch {
    // Non-critical — use default
  }

  return { pipeline, explanation };
};

// ─── 2. Context-Aware Campaign Content Generation ─────────────────────────────

/**
 * Generates channel-personalized campaign messaging.
 *
 * @param {object} params
 * @param {string} params.audienceDescription - e.g., "High-value customers who spent over ₹10,000"
 * @param {string} params.channel - "whatsapp" | "email" | "sms"
 * @param {string} params.campaignGoal - e.g., "Promote our summer sale with 20% discount"
 * @param {string} [params.brandName="Mini CRM Brand"] - Brand name to personalize
 * @returns {Promise<{ subject?, body, ctaText, preview, characterCount }>}
 */
const generateCampaignContent = async ({
  audienceDescription,
  channel,
  campaignGoal,
  brandName = 'Our Brand',
}) => {
  const channelGuidelines = {
    whatsapp: `
- Conversational and warm tone
- Use emojis naturally (2-4 per message)
- Keep under 1000 characters
- Include a clear call-to-action with a link placeholder {{CTA_LINK}}
- Start with a personalized greeting using {{customer_name}}
- WhatsApp formatting: *bold* for emphasis
`.trim(),
    email: `
- Professional yet friendly tone
- Write a compelling subject line (max 60 chars)
- Email body: 150-250 words
- Use HTML-friendly structure (paragraphs, not markdown)
- Include a CTA button text
- Personalize with {{customer_name}} and {{customer_totalSpend}}
- Sign off with brand name
`.trim(),
    sms: `
- Ultra concise: max 160 characters
- Direct and action-oriented
- Include short CTA (e.g., "Reply YES" or short link)
- No emojis (SMS compatibility)
- Include opt-out: "Reply STOP to unsubscribe"
`.trim(),
    rcs: `
- Rich Conversational SMS — modern, visual-friendly format
- Conversational tone like WhatsApp but slightly more formal
- Can use emojis (1-2 per message)
- Keep under 800 characters
- Include a clear CTA with a link placeholder {{CTA_LINK}}
- RCS supports rich cards — structure message as: opening hook + offer + CTA
- Start with a personalized greeting using {{customer_name}}
- Include opt-out: "Reply STOP to unsubscribe"
`.trim(),
  };

  const guidelines = channelGuidelines[channel] || channelGuidelines.email;

  const prompt = `
You are an expert B2C marketing copywriter for a CRM platform.

TASK: Create personalized campaign content for the following:
- Brand: ${brandName}
- Target Audience: ${audienceDescription}
- Campaign Goal: ${campaignGoal}
- Delivery Channel: ${channel.toUpperCase()}

CHANNEL GUIDELINES:
${guidelines}

OUTPUT FORMAT (return valid JSON only, no markdown):
${
  channel === 'email'
    ? '{"subject": "...", "body": "...", "ctaText": "...", "preview": "..."}'
    : '{"body": "...", "ctaText": "...", "preview": "..."}'
}

Where:
- "body": The complete message body
- "ctaText": The call-to-action button/link text
- "preview": A 1-sentence preview/summary of this message (for marketer's dashboard)
${channel === 'email' ? '- "subject": The email subject line' : ''}

Return ONLY the JSON object, nothing else.
`.trim();

  let rawResponse;
  try {
    rawResponse = await generateContent(prompt, { temperature: 0.75 });
  } catch (err) {
    throw new AppError(`Gemini AI error: ${err.message}`, 502, 'AI_SERVICE_ERROR');
  }

  const cleaned = rawResponse
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  let content;
  try {
    content = JSON.parse(cleaned);
  } catch {
    // If JSON parse fails, return the raw text as body
    content = {
      body: cleaned,
      ctaText: 'Learn More',
      preview: 'AI-generated campaign message',
    };
  }

  content.characterCount = (content.body || '').length;
  content.channel = channel;

  return content;
};

// ─── 3. AI-Powered Campaign Suggestions ───────────────────────────────────────

/**
 * Analyzes real customer data from the database and generates 3–5 actionable
 * campaign suggestions using Gemini.
 *
 * Each suggestion includes:
 *   - name: Campaign name
 *   - description: What the campaign does and why
 *   - rationale: Why this segment matters NOW (data-driven insight)
 *   - audienceQuery: A ready-to-use MongoDB pipeline
 *   - suggestedChannel: Best channel for this audience
 *   - messageTone: Suggested tone/approach
 *   - estimatedImpact: Expected outcome (e.g., "recover 15% of churned revenue")
 *
 * @param {object} dbContext - Real aggregate data from the database
 * @returns {Promise<Array>} Array of campaign suggestion objects
 */
const generateCampaignSuggestions = async (dbContext) => {
  const {
    totalCustomers,
    activeCustomers,
    avgSpend,
    highValueThreshold,
    inactiveCount,
    newCustomerCount,
    tagFrequency,
    channelDistribution,
    revenueThisMonth,
    revenuePrevMonth,
  } = dbContext;

  const revenueChange = revenuePrevMonth > 0
    ? (((revenueThisMonth - revenuePrevMonth) / revenuePrevMonth) * 100).toFixed(1)
    : 0;

  const prompt = `
You are an expert B2C CRM strategist analyzing real customer data to suggest high-impact campaigns.

REAL DATABASE SNAPSHOT (as of today):
- Total customers: ${totalCustomers}
- Active customers: ${activeCustomers} (${Math.round((activeCustomers / totalCustomers) * 100)}%)
- Average customer lifetime spend: ₹${Math.round(avgSpend).toLocaleString('en-IN')}
- High-value threshold (top 20%): ₹${Math.round(highValueThreshold).toLocaleString('en-IN')}+
- Customers inactive for 90+ days: ${inactiveCount}
- New customers this month: ${newCustomerCount}
- Revenue this month vs last month: ${revenueChange > 0 ? '+' : ''}${revenueChange}%
- Channel distribution: ${JSON.stringify(channelDistribution)}
- Most common customer tags: ${tagFrequency.slice(0, 8).map(t => `${t._id}(${t.count})`).join(', ')}

DATABASE SCHEMA REMINDER:
- customers: { totalSpend, visitCount, lastVisit, tags, preferredChannel, isActive, createdAt }
- All amounts in INR (₹)

TASK: Generate exactly 3 campaign suggestions that would have the highest business impact RIGHT NOW based on this data. Each should target a different customer segment.

RULES:
1. Return ONLY a JSON array — no markdown, no text outside the JSON.
2. Each suggestion must have: name, description, rationale, audienceQuery (MongoDB pipeline array), suggestedChannel, messageTone, estimatedImpact
3. audienceQuery must be a valid MongoDB aggregation pipeline for the 'customers' collection.
4. Use ONLY: $match, $sort, $limit, $project. Keep pipelines simple.
5. Base the suggestions on the actual data patterns you see — make them specific.
6. suggestedChannel must be one of: "whatsapp", "email", "sms", "rcs"
7. messageTone: short descriptor like "urgent & exclusive", "warm & nostalgic", "celebratory"
8. estimatedImpact: a specific, realistic prediction like "Recover ₹2L+ from ${inactiveCount} dormant customers"
9. Keep audienceQuery limited to 500 customers max.

Return ONLY the JSON array:
`.trim();

  let rawResponse;
  try {
    rawResponse = await generateContent(prompt, { temperature: 0.4 });
  } catch (err) {
    throw new AppError(`Gemini AI error: ${err.message}`, 502, 'AI_SERVICE_ERROR');
  }

  const cleaned = rawResponse
    .replace(/```json/gi, '')
    .replace(/```/g, '')
    .trim();

  let suggestions;
  try {
    suggestions = JSON.parse(cleaned);
    if (!Array.isArray(suggestions)) {
      suggestions = [suggestions]; // Handle single-object response
    }
  } catch {
    throw new AppError(
      'AI returned an unparseable suggestions response. Please try again.',
      422,
      'AI_PARSE_ERROR'
    );
  }

  // Validate that audienceQuery is an array in each suggestion
  return suggestions.map((s) => ({
    ...s,
    audienceQuery: Array.isArray(s.audienceQuery) ? s.audienceQuery : [],
  }));
};

module.exports = { nlToMongodbPipeline, generateCampaignContent, generateCampaignSuggestions };

