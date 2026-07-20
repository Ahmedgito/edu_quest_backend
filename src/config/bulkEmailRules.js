/**
 * Bulk outbound email tuning — delay between messages and batch pauses
 * to respect provider limits and reduce spam-flag risk.
 */
const rules = {
  delayBetweenMessagesMs: parseInt(process.env.BULK_EMAIL_DELAY_MS || '800', 10),
  batchSize: parseInt(process.env.BULK_EMAIL_BATCH_SIZE || '5', 10),
  batchPauseMs: parseInt(process.env.BULK_EMAIL_BATCH_PAUSE_MS || '3000', 10)
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Sequentially runs async work per item with pacing between items and
 * extra pause after each batch (batchSize) until the list is exhausted.
 */
async function runBulkPaced(items, worker) {
  if (!Array.isArray(items) || items.length === 0) return;
  let done = 0;
  for (const item of items) {
    await worker(item);
    done += 1;
    if (done < items.length) {
      await sleep(rules.delayBetweenMessagesMs);
      if (done % rules.batchSize === 0) {
        await sleep(rules.batchPauseMs);
      }
    }
  }
}

module.exports = { rules, sleep, runBulkPaced };
