'use strict';

/**
 * Database Seeder
 *
 * Generates realistic dummy data for the Mini CRM:
 * - 1,000 customers with realistic profiles
 * - 3-8 orders per customer (3,000–8,000 total orders)
 * - Customer totalSpend and visitCount computed from actual orders
 * - 3 sample campaigns with proper audience pipelines
 *
 * Usage: node scripts/seed.js [--reset]
 *   --reset: drops existing data before seeding
 */

const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']); // Google DNS resolver

require('dotenv').config({ path: require('path').join(__dirname, '../.env') });

const mongoose = require('mongoose');
const { faker } = require('@faker-js/faker/locale/en_IN'); // Indian locale for realistic data

// Models
const Customer = require('../src/models/Customer');
const Order = require('../src/models/Order');
const Campaign = require('../src/models/Campaign');
const Communication = require('../src/models/Communication');

// ─── Config ───────────────────────────────────────────────────────────────────
const NUM_CUSTOMERS = 1000;
const MIN_ORDERS_PER_CUSTOMER = 3;
const MAX_ORDERS_PER_CUSTOMER = 8;
const BATCH_SIZE = 100; // Insert in batches to avoid memory issues
const RESET = process.argv.includes('--reset');

// ─── Helpers ─────────────────────────────────────────────────────────────────
const randomBetween = (min, max) =>
  Math.floor(Math.random() * (max - min + 1)) + min;

const randomFrom = (arr) => arr[Math.floor(Math.random() * arr.length)];

const randomDate = (start, end) =>
  new Date(start.getTime() + Math.random() * (end.getTime() - start.getTime()));

const CHANNELS = ['whatsapp', 'email', 'sms', 'rcs'];

const TAGS_POOL = [
  'vip', 'new', 'churned', 'premium', 'loyal', 'at-risk',
  'high-value', 'discount-seeker', 'returning', 'first-time',
  'referral', 'organic', 'paid', 'social', 'inactive',
];

const ORDER_ITEMS_POOL = [
  { name: 'Running Shoes', price: 2499 },
  { name: 'Cotton T-Shirt', price: 799 },
  { name: 'Wireless Earbuds', price: 3999 },
  { name: 'Yoga Mat', price: 1299 },
  { name: 'Water Bottle', price: 599 },
  { name: 'Backpack', price: 1999 },
  { name: 'Sunglasses', price: 1499 },
  { name: 'Face Wash', price: 349 },
  { name: 'Moisturizer', price: 699 },
  { name: 'Phone Case', price: 299 },
  { name: 'Notebook', price: 199 },
  { name: 'Protein Bar (pack)', price: 599 },
  { name: 'Coffee Mug', price: 449 },
  { name: 'Desk Lamp', price: 1299 },
  { name: 'USB-C Cable', price: 499 },
  { name: 'Polo Shirt', price: 999 },
  { name: 'Denim Jeans', price: 1799 },
  { name: 'Smart Watch Band', price: 899 },
  { name: 'Face Serum', price: 1199 },
  { name: 'Resistance Bands Set', price: 799 },
];

const ORDER_STATUSES = ['delivered', 'delivered', 'delivered', 'delivered', 'shipped', 'cancelled', 'refunded'];

const INDIAN_CITIES = [
  'Mumbai', 'Delhi', 'Bangalore', 'Hyderabad', 'Chennai',
  'Kolkata', 'Pune', 'Ahmedabad', 'Jaipur', 'Lucknow',
  'Surat', 'Kanpur', 'Nagpur', 'Visakhapatnam', 'Indore',
  'Thane', 'Bhopal', 'Patna', 'Vadodara', 'Ghaziabad',
];

// ─── Data generators ─────────────────────────────────────────────────────────

const generateCustomer = (index) => {
  const firstName = faker.person.firstName();
  const lastName = faker.person.lastName();
  const email = `${firstName.toLowerCase()}.${lastName.toLowerCase()}${index}@${faker.internet.domainName()}`;

  const numTags = randomBetween(1, 4);
  const tags = [];
  for (let i = 0; i < numTags; i++) {
    const tag = randomFrom(TAGS_POOL);
    if (!tags.includes(tag)) tags.push(tag);
  }

  // Skew distribution: 20% high-value (₹5k-₹50k), 60% mid (₹500-₹5k), 20% low (<₹500)
  // We'll compute totalSpend from orders, but initialize to 0
  return {
    name: `${firstName} ${lastName}`,
    email,
    phone: faker.phone.number('+91##########'),
    totalSpend: 0,
    visitCount: 0,
    lastVisit: null,
    tags,
    preferredChannel: randomFrom(CHANNELS),
    isActive: Math.random() > 0.1, // 90% active
    city: randomFrom(INDIAN_CITIES),
    country: 'IN',
    createdAt: randomDate(new Date('2023-01-01'), new Date()),
  };
};

const generateOrdersForCustomer = (customerId, customerCreatedAt) => {
  const numOrders = randomBetween(MIN_ORDERS_PER_CUSTOMER, MAX_ORDERS_PER_CUSTOMER);
  const orders = [];

  for (let i = 0; i < numOrders; i++) {
    const numItems = randomBetween(1, 4);
    const items = [];
    let amount = 0;

    for (let j = 0; j < numItems; j++) {
      const product = randomFrom(ORDER_ITEMS_POOL);
      const quantity = randomBetween(1, 3);
      const itemTotal = product.price * quantity;
      amount += itemTotal;
      items.push({
        name: product.name,
        quantity,
        price: product.price,
      });
    }

    const purchasedAt = randomDate(customerCreatedAt, new Date());

    orders.push({
      customerId,
      amount,
      items,
      status: randomFrom(ORDER_STATUSES),
      purchasedAt,
      createdAt: purchasedAt,
    });
  }

  return orders;
};

// ─── Sample campaigns ─────────────────────────────────────────────────────────
const SAMPLE_CAMPAIGNS = [
  {
    name: 'High-Value Customer Appreciation',
    description: 'Reward customers who spent over ₹5,000 with an exclusive 15% off coupon',
    audienceQuery: [
      { $match: { isActive: true, totalSpend: { $gte: 5000 } } },
      { $sort: { totalSpend: -1 } },
    ],
    message: 'Hi {{customer_name}}! 🎉 As one of our most valued customers, here\'s an exclusive 15% OFF just for you. Use code VIP15 at checkout. Valid till Sunday! Shop now: {{CTA_LINK}}',
    channel: 'whatsapp',
    status: 'draft',
  },
  {
    name: 'Win-Back Inactive Users',
    description: 'Re-engage customers who haven\'t visited in 90+ days',
    audienceQuery: [
      {
        $match: {
          isActive: true,
          lastVisit: {
            $lt: new Date(Date.now() - 90 * 24 * 60 * 60 * 1000),
          },
        },
      },
      { $sort: { lastVisit: 1 } },
    ],
    message: 'We miss you! It\'s been a while since your last visit. Come back and discover what\'s new — enjoy FREE shipping on your next order. Code: COMEBACK. Shop now!',
    channel: 'sms',
    status: 'draft',
  },
  {
    name: 'New Customer Welcome Series',
    description: 'Welcome customers who joined in the last 30 days',
    audienceQuery: [
      {
        $match: {
          isActive: true,
          createdAt: {
            $gte: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
          },
        },
      },
      { $sort: { createdAt: -1 } },
    ],
    message: 'Subject: Welcome to the family! 🎊\n\nHi {{customer_name}},\n\nWelcome aboard! We\'re thrilled to have you. As a thank-you for joining us, here\'s 10% OFF your first order.\n\nUse code: WELCOME10\n\nDiscover our bestsellers and find something you\'ll love.\n\nWarm regards,\nThe Team',
    channel: 'email',
    status: 'draft',
  },
  {
    name: 'RCS Premium Re-engagement',
    description: 'Rich conversational re-engagement for customers inactive for 60+ days via RCS',
    audienceQuery: [
      {
        $match: {
          isActive: true,
          preferredChannel: 'rcs',
          lastVisit: {
            $lt: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000),
          },
        },
      },
      { $sort: { totalSpend: -1 } },
    ],
    message: 'Hey {{customer_name}}! 👋 We noticed it\'s been a while. We\'ve got exciting new arrivals and a special comeback offer just for you — 20% off your next purchase. Tap below to explore. {{CTA_LINK}} Reply STOP to unsubscribe.',
    channel: 'rcs',
    status: 'draft',
  },
];

// ─── Main seeder ─────────────────────────────────────────────────────────────

const seed = async () => {
  console.log('\n🌱 Mini CRM Database Seeder\n');

  // Connect to MongoDB
  console.log('📡 Connecting to MongoDB...');
  await mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 15000,
    family: 4,
  });
  console.log('✅ Connected to MongoDB\n');

  if (RESET) {
    console.log('🗑️  Dropping existing data (--reset flag)...');
    await Promise.all([
      Customer.deleteMany({}),
      Order.deleteMany({}),
      Campaign.deleteMany({}),
      Communication.deleteMany({}),
    ]);
    console.log('✅ Existing data cleared\n');
  }

  // ─── Seed Customers ───────────────────────────────────────────────────────
  console.log(`👥 Generating ${NUM_CUSTOMERS} customers...`);
  const customerDocs = [];
  for (let i = 0; i < NUM_CUSTOMERS; i++) {
    customerDocs.push(generateCustomer(i));
  }

  // Insert in batches
  const insertedCustomers = [];
  for (let i = 0; i < customerDocs.length; i += BATCH_SIZE) {
    const batch = customerDocs.slice(i, i + BATCH_SIZE);
    const inserted = await Customer.insertMany(batch, { ordered: false });
    insertedCustomers.push(...inserted);
    process.stdout.write(`\r  Inserted ${Math.min(i + BATCH_SIZE, NUM_CUSTOMERS)}/${NUM_CUSTOMERS} customers...`);
  }
  console.log(`\n✅ Inserted ${insertedCustomers.length} customers\n`);

  // ─── Seed Orders ─────────────────────────────────────────────────────────
  console.log('📦 Generating orders for each customer...');
  let totalOrders = 0;
  const customerUpdates = []; // Track spend aggregation

  for (let i = 0; i < insertedCustomers.length; i += BATCH_SIZE) {
    const batch = insertedCustomers.slice(i, i + BATCH_SIZE);
    const allOrders = [];

    for (const customer of batch) {
      const orders = generateOrdersForCustomer(customer._id, customer.createdAt);
      allOrders.push(...orders);

      // Compute aggregate spend and visit data for this customer
      const totalSpend = orders.reduce((sum, o) => sum + o.amount, 0);
      const visitCount = orders.length;
      const lastVisit = orders.reduce(
        (latest, o) => (o.purchasedAt > latest ? o.purchasedAt : latest),
        orders[0].purchasedAt
      );

      customerUpdates.push({
        id: customer._id,
        totalSpend,
        visitCount,
        lastVisit,
      });
    }

    await Order.insertMany(allOrders, { ordered: false });
    totalOrders += allOrders.length;
    process.stdout.write(`\r  Generated orders for ${Math.min(i + BATCH_SIZE, insertedCustomers.length)}/${insertedCustomers.length} customers (${totalOrders} orders so far)...`);
  }
  console.log(`\n✅ Inserted ${totalOrders} orders\n`);

  // ─── Update Customer totalSpend and visitCount ────────────────────────────
  console.log('💰 Updating customer spend & visit stats...');
  let updated = 0;
  for (let i = 0; i < customerUpdates.length; i += BATCH_SIZE) {
    const batch = customerUpdates.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(({ id, totalSpend, visitCount, lastVisit }) =>
        Customer.findByIdAndUpdate(id, {
          $set: { totalSpend, visitCount, lastVisit },
        })
      )
    );
    updated += batch.length;
    process.stdout.write(`\r  Updated ${updated}/${customerUpdates.length} customers...`);
  }
  console.log(`\n✅ Customer stats updated\n`);

  // ─── Seed Sample Campaigns ────────────────────────────────────────────────
  console.log('📢 Creating sample campaigns...');
  for (const campaignData of SAMPLE_CAMPAIGNS) {
    // Compute audience size
    let audienceSize = 0;
    try {
      const countResult = await Customer.aggregate([
        ...campaignData.audienceQuery,
        { $count: 'total' },
      ]);
      audienceSize = countResult.length > 0 ? countResult[0].total : 0;
    } catch {
      // Non-critical
    }

    await Campaign.create({
      ...campaignData,
      audienceSize,
    });
    console.log(`  ✓ "${campaignData.name}" (audience: ${audienceSize})`);
  }
  console.log(`\n✅ ${SAMPLE_CAMPAIGNS.length} sample campaigns created\n`);

  // ─── Summary ─────────────────────────────────────────────────────────────
  const customerCount = await Customer.countDocuments();
  const orderCount = await Order.countDocuments();
  const campaignCount = await Campaign.countDocuments();

  const spendStats = await Customer.aggregate([
    {
      $group: {
        _id: null,
        totalRevenue: { $sum: '$totalSpend' },
        avgSpend: { $avg: '$totalSpend' },
        maxSpend: { $max: '$totalSpend' },
      },
    },
  ]);

  console.log('═══════════════════════════════════════════');
  console.log('  SEED COMPLETE — Summary');
  console.log('═══════════════════════════════════════════');
  console.log(`  Customers:    ${customerCount}`);
  console.log(`  Orders:       ${orderCount}`);
  console.log(`  Campaigns:    ${campaignCount}`);
  if (spendStats[0]) {
    console.log(`  Total Revenue: ₹${spendStats[0].totalRevenue.toLocaleString('en-IN')}`);
    console.log(`  Avg Spend:     ₹${Math.round(spendStats[0].avgSpend).toLocaleString('en-IN')}`);
    console.log(`  Max Spend:     ₹${spendStats[0].maxSpend.toLocaleString('en-IN')}`);
  }
  console.log('═══════════════════════════════════════════\n');

  await mongoose.disconnect();
  console.log('👋 Database connection closed. Happy demoing!\n');
  process.exit(0);
};

seed().catch((err) => {
  console.error('\n❌ Seeder failed:', err.message);
  console.error(err.stack);
  mongoose.disconnect();
  process.exit(1);
});
