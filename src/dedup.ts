/**
 * Bounded, deterministic event deduplication for the poller.
 *
 * ── Why this exists ──────────────────────────────────────────────────────────
 *
 * Soroban `getEvents` addresses pages by an opaque cursor, and that cursor is
 * INCLUSIVE of the event it names. The same event can therefore come back from
 * a later page (overlapping pages), and again from the next cycle that resumes
 * from the persisted cursor — including the first cycle after a restart. Left
 * unguarded, one on-chain event becomes a duplicate Telegram message.
 *
 * The window keeps only the ids of the most recently processed events and
 * evicts oldest-first. It is deliberately bounded: this is a notifier, not an
 * index, and the chain remains the record. A redelivery older than the window
 * may still be announced; that is the accepted trade-off for O(1) memory and a
 * cursor file whose size does not grow with history.
 */

/** Default number of recent event ids retained per watched contract. */
export const DEFAULT_DEDUP_WINDOW = 256;

/**
 * The minimal shape needed to derive a stable identity for an event.
 *
 * Both the raw RPC response (which carries `id`) and a decoded event (which
 * carries `eventId`) satisfy it, so the window works at either layer.
 */
export interface DedupableEvent {
  id?: string | null;
  eventId?: string | null;
  ledger?: number | string | bigint | null;
  txHash?: string | null;
  topic?: unknown;
}

/**
 * Stable identity for one event.
 *
 * `id` is the RPC's own TOID (`<ledger-packed>-<index>`): unique per event and
 * the field that survives pagination untouched. When a response omits it, fall
 * back to the ledger/transaction/topic-count triple rather than treating every
 * event as unique. `null` means "cannot identify" — callers pass those through
 * un-deduplicated instead of guessing.
 */
export function eventKey(event: DedupableEvent | null | undefined): string | null {
  // A malformed RPC entry (null, a primitive) has no identity; pass it through
  // so the decoder can skip it instead of crashing the page walk.
  if (!event || typeof event !== "object") return null;
  if (typeof event.id === "string" && event.id !== "") return event.id;
  if (typeof event.eventId === "string" && event.eventId !== "") return event.eventId;

  const txHash = typeof event.txHash === "string" ? event.txHash : "";
  if (txHash === "") return null;

  const ledger = event.ledger === null || event.ledger === undefined ? "" : String(event.ledger);
  const topics = Array.isArray(event.topic) ? event.topic.length : 0;
  return `${ledger}:${txHash}:${topics}`;
}

/**
 * Insertion-ordered, capacity-bounded set of recently seen event ids.
 *
 * A capacity of `0` disables deduplication entirely: every key reports as new
 * and nothing is retained, which is the documented escape hatch.
 */
export class EventDedupWindow {
  readonly capacity: number;
  /** Insertion order matters: `values().next()` is always the oldest id. */
  private readonly ids = new Set<string>();

  constructor(capacity: number = DEFAULT_DEDUP_WINDOW) {
    this.capacity = Number.isFinite(capacity) ? Math.max(0, Math.floor(capacity)) : 0;
  }

  get size(): number {
    return this.ids.size;
  }

  has(key: string): boolean {
    return this.ids.has(key);
  }

  /**
   * Record `key`, evicting the oldest id once at capacity.
   *
   * Returns `true` when the key is new (or dedup is disabled/undecidable) and
   * `false` when it had already been seen.
   */
  add(key: string | null): boolean {
    if (key === null || this.capacity === 0) return true;
    if (this.ids.has(key)) return false;

    this.ids.add(key);
    if (this.ids.size > this.capacity) {
      const oldest = this.ids.values().next().value;
      if (oldest !== undefined) this.ids.delete(oldest);
    }
    return true;
  }

  /** Ids oldest-first, at most `capacity` of them. Safe to persist as JSON. */
  toJSON(): string[] {
    return [...this.ids];
  }

  /** Rebuild from a cursor file field, tolerating missing or garbage values. */
  static fromJSON(value: unknown, capacity: number = DEFAULT_DEDUP_WINDOW): EventDedupWindow {
    const window = new EventDedupWindow(capacity);
    if (Array.isArray(value)) {
      for (const id of value) {
        if (typeof id === "string" && id !== "") window.add(id);
      }
    }
    return window;
  }
}
