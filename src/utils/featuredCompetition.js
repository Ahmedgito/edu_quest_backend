const { query } = require('../db');

/**
 * Resolve the competition an announcement should feature.
 *
 * `competitionId` pins a specific competition (the admin's explicit choice).
 * When it is null — the "automatic" setting, and also what a deleted
 * competition falls back to — the soonest upcoming active competition wins.
 *
 * Returns the competition row, or null when there is nothing to announce.
 */
const resolveFeaturedCompetition = async (competitionId) => {
  if (competitionId) {
    const pinned = await query('SELECT * FROM competitions WHERE id = $1', [competitionId]);
    if (pinned.rowCount > 0) {
      return pinned.rows[0];
    }
  }

  const upcoming = await query(
    `SELECT * FROM competitions
     WHERE status = 'active'
       AND start_date IS NOT NULL
       AND start_date >= CURRENT_DATE
     ORDER BY start_date ASC
     LIMIT 1`
  );

  return upcoming.rows[0] || null;
};

module.exports = { resolveFeaturedCompetition };
