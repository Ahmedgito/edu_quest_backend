/**
 * Grade → Category mapping (server-side mirror of the frontend util).
 *
 *   Grade 1–2   → Seeker
 *   Grade 3–4   → Voyager
 *   Grade 5–6   → Trailblazer
 *   Grade 7–8   → Innovator
 *   Grade 9–10  → Visionary
 *   Grade 11–12 → Luminary
 */

const GRADE_CATEGORIES = [
  { name: 'Seeker', min: 1, max: 2 },
  { name: 'Voyager', min: 3, max: 4 },
  { name: 'Trailblazer', min: 5, max: 6 },
  { name: 'Innovator', min: 7, max: 8 },
  { name: 'Visionary', min: 9, max: 10 },
  { name: 'Luminary', min: 11, max: 12 }
];

/** Grade band { min, max } for a category name (case-insensitive), or null. */
const getBandForCategory = (name) => {
  if (!name) return null;
  const target = String(name).trim().toLowerCase();
  const category = GRADE_CATEGORIES.find((c) => c.name.toLowerCase() === target);
  return category ? { min: category.min, max: category.max } : null;
};

module.exports = { GRADE_CATEGORIES, getBandForCategory };
