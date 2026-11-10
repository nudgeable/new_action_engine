/**
 * Per-batch action categories (cohorts.action_categories, migration 088).
 * A superadmin sets up to MAX_ACTION_CATEGORIES in the batch's Settings tab;
 * the AI tags each generated action with one of them (actions.category), and
 * the participant can change it from the action's edit popup.
 */

export const MAX_ACTION_CATEGORIES = 5;
export const ACTION_CATEGORY_MAX_LENGTH = 40;

/** Reads the stored array, keeping non-blank, de-duplicated strings in order. */
export function parseActionCategories(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") continue;
    const name = entry.trim();
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    result.push(name);
  }
  return result.slice(0, MAX_ACTION_CATEGORIES);
}

/** Validates superadmin input before saving. Blank rows are dropped. */
export function sanitizeActionCategories(input: unknown): { categories?: string[]; error?: string } {
  if (!Array.isArray(input)) return { error: "Categories must be a list" };
  const names = input
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter(Boolean);
  if (names.length > MAX_ACTION_CATEGORIES) {
    return { error: `A batch can have at most ${MAX_ACTION_CATEGORIES} categories` };
  }
  const tooLong = names.find((name) => name.length > ACTION_CATEGORY_MAX_LENGTH);
  if (tooLong) {
    return { error: `"${tooLong.slice(0, 20)}…" is too long — keep categories to ${ACTION_CATEGORY_MAX_LENGTH} characters` };
  }
  const lower = names.map((name) => name.toLowerCase());
  if (new Set(lower).size !== lower.length) {
    return { error: "Each category must be different" };
  }
  return { categories: names };
}

/**
 * Returns the batch's own spelling of `value` when it matches one of
 * `categories` (case-insensitive), otherwise null. Used to clean up the AI's
 * pick and to check a participant's edit.
 */
export function matchActionCategory(value: unknown, categories: string[]): string | null {
  if (typeof value !== "string") return null;
  const wanted = value.trim().toLowerCase();
  if (!wanted) return null;
  return categories.find((category) => category.toLowerCase() === wanted) ?? null;
}
