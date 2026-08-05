// Parses the per-request "what have I already seen" state for /api/tonight's
// "Nytt förslag" flow. Deliberately no validation beyond shape: an unknown or
// stale template id is just an id nothing in the candidate set matches, so it has
// no effect downstream rather than needing to be rejected here.

// Matches ShoppingList's cap of "everything shown so far" at a size that can never
// grow unbounded within a single session — 30 is comfortably above the real
// candidate set a household would page through in one sitting.
const MAX_EXCLUDED_IDS = 30;

export function parseExcludeFromQuery(raw: unknown): ReadonlySet<string> {
  if (typeof raw !== "string" || raw.length === 0) return new Set();

  const ids = raw
    .split(",")
    .map((id) => id.trim())
    .filter((id) => id.length > 0);

  return new Set(ids.slice(0, MAX_EXCLUDED_IDS));
}

export function parsePreviousFromQuery(raw: unknown): string | undefined {
  return typeof raw === "string" && raw.length > 0 ? raw : undefined;
}
