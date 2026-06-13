'use strict';

/**
 * Campaign Scheduler Service
 *
 * Polls the database every minute for campaigns with:
 *   status: 'scheduled'
 *   scheduledAt: <= now
 *
 * For each due campaign, it fires sendCampaign() to kick off the
 * async dispatch loop — exactly as if the user had manually pressed "Send".
 *
 * Design decisions:
 * - Uses setInterval (not cron) — simpler, no external dependency
 * - Atomic status transition: findOneAndUpdate with status:'scheduled' guard
 *   prevents double-firing if the scheduler runs twice for the same campaign
 *   (e.g. in a multi-process deployment)
 * - Scheduler errors are isolated per-campaign; one failure doesn't block others
 */

const Campaign = require('../models/Campaign');
const { sendCampaign } = require('./campaign.service');

const POLL_INTERVAL_MS = 60 * 1000; // 1 minute

let schedulerInterval = null;

/**
 * Checks for campaigns due to be sent and dispatches them.
 * Called every POLL_INTERVAL_MS and also immediately on startup.
 */
const processDueCampaigns = async () => {
  const now = new Date();

  // Find ALL campaigns that are due — don't limit to 1, process all at once
  // Using lean() for performance since we only need the _id to call sendCampaign
  const dueCampaigns = await Campaign.find({
    status: 'scheduled',
    scheduledAt: { $lte: now },
  })
    .select('_id name scheduledAt')
    .lean();

  if (dueCampaigns.length === 0) return;

  console.log(`[Scheduler] Found ${dueCampaigns.length} campaign(s) due for dispatch`);

  // Process campaigns concurrently (they're independent)
  await Promise.allSettled(
    dueCampaigns.map(async (campaign) => {
      try {
        // Atomic guard: only proceed if still 'scheduled' (handles race conditions)
        const claimed = await Campaign.findOneAndUpdate(
          { _id: campaign._id, status: 'scheduled' },
          { $set: { status: 'running' } }, // pre-mark as running before dispatch
          { new: false } // return old doc to check if we won the race
        );

        if (!claimed) {
          // Another process already claimed this campaign
          console.log(`[Scheduler] Campaign ${campaign._id} already claimed by another process`);
          return;
        }

        // Reset status back to 'scheduled' so sendCampaign can transition it cleanly
        await Campaign.findByIdAndUpdate(campaign._id, { $set: { status: 'scheduled' } });

        console.log(`[Scheduler] Dispatching scheduled campaign: "${campaign.name}" (${campaign._id})`);
        await sendCampaign(campaign._id.toString());
        console.log(`[Scheduler] Campaign "${campaign.name}" dispatched successfully`);
      } catch (err) {
        console.error(`[Scheduler] Failed to dispatch campaign ${campaign._id}:`, err.message);
        // Mark as failed so it doesn't get stuck in 'scheduled' forever
        await Campaign.findByIdAndUpdate(campaign._id, {
          $set: { status: 'failed' },
        }).catch(() => {}); // Swallow this — DB might be down
      }
    })
  );
};

/**
 * Starts the campaign scheduler.
 * Called once from server.js after the DB connects.
 * Idempotent — calling multiple times does nothing after the first call.
 */
const startScheduler = () => {
  if (schedulerInterval) {
    console.log('[Scheduler] Already running — skipping duplicate start');
    return;
  }

  console.log(`[Scheduler] Starting campaign scheduler (poll every ${POLL_INTERVAL_MS / 1000}s)`);

  // Run immediately on startup to catch any campaigns missed while server was down
  processDueCampaigns().catch((err) => {
    console.error('[Scheduler] Initial poll error:', err.message);
  });

  schedulerInterval = setInterval(() => {
    processDueCampaigns().catch((err) => {
      console.error('[Scheduler] Poll error:', err.message);
      // Don't crash — just log and wait for next interval
    });
  }, POLL_INTERVAL_MS);

  // Allow Node.js to exit even if the interval is still running
  if (schedulerInterval.unref) schedulerInterval.unref();
};

/**
 * Stops the scheduler. Used in tests and graceful shutdown.
 */
const stopScheduler = () => {
  if (schedulerInterval) {
    clearInterval(schedulerInterval);
    schedulerInterval = null;
    console.log('[Scheduler] Stopped');
  }
};

module.exports = { startScheduler, stopScheduler, processDueCampaigns };
