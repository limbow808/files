/**
 * charColors.js
 * Assigns a unique, stable color to each character ID.
 * Colors are picked from a carefully chosen palette that looks good on dark backgrounds.
 */

const PALETTE = [
  '#ff7733', // orange-red
  '#4da6ff', // sky blue
  '#44ffaa', // mint green
  '#cc88ff', // lavender
  '#ffcc44', // amber
  '#ff4488', // pink
  '#33ddcc', // teal
  '#ff9966', // peach
  '#88cc00', // lime
  '#aa88ff', // periwinkle
  '#ff6644', // coral
  '#44aaff', // cornflower
];

// Map characterId (string) → color string
const _assigned = new Map();

/**
 * Returns a stable color hex for a given character_id.
 * The same ID always gets the same color within a session.
 * Order of first encounter determines the palette slot.
 */
export function charColor(characterId) {
  const key = String(characterId);
  if (!_assigned.has(key)) {
    _assigned.set(key, PALETTE[_assigned.size % PALETTE.length]);
  }
  return _assigned.get(key);
}

/**
 * Pre-seed colors for a list of characters so order is deterministic
 * (call this once when you load the character list).
 */
export function seedCharColors(characters) {
  characters.forEach(c => charColor(c.character_id));
}
