import { ExpiringMap } from "./expiring-map";
import { toStringId } from "./normalize";

/**
 * Which outgoing messages this process sent itself.
 *
 * Telegram reports every message the account sends as an outgoing update —
 * the owner typing on their phone and the agent sending through this plugin
 * alike. `recordOutgoing` is about the first kind only: the agent's own sends
 * are already in the session that made them (its `message` tool call), and
 * recording one again as "the owner wrote" would both misattribute it and
 * start another turn on the agent's own words.
 *
 * Every send the client makes goes through `track`. The update for a send can
 * arrive before the call that made it resolves, so `isOwnSend` first waits —
 * bounded — for the sends still in flight, then looks the message up.
 */
export class OwnSendTracker {
  private readonly sent: ExpiringMap<true>;
  private inFlight = 0;
  private idleWaiters: Array<() => void> = [];

  constructor(ttlMs = 10 * 60_000, maxEntries = 2000) {
    this.sent = new ExpiringMap<true>(ttlMs, maxEntries);
  }

  /** Runs one send and remembers the message(s) it produced. */
  async track<T>(send: () => Promise<T>): Promise<T> {
    this.inFlight += 1;
    try {
      const result = await send();
      this.remember(result);
      return result;
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0) {
        const waiters = this.idleWaiters;
        this.idleWaiters = [];
        for (const wake of waiters) wake();
      }
    }
  }

  /** Records a sent message (or an album of them). */
  remember(result: unknown, now: number = Date.now()): void {
    const messages = Array.isArray(result) ? result : [ result ];
    for (const message of messages) {
      const id = toStringId((message as any)?.id);
      if (!id) continue;
      this.sent.set(keyOf(toStringId((message as any)?.chatId), id), true, now);
    }
  }

  /**
   * Whether this process sent the message. Waits up to `timeoutMs` for sends
   * still in flight, since the update may have overtaken the call's result.
   */
  async isOwnSend(chatId: string, messageId: string, timeoutMs = 15_000): Promise<boolean> {
    if (this.inFlight > 0) {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        this.idleWaiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return this.sent.get(keyOf(chatId, messageId)) === true
      || this.sent.get(keyOf(undefined, messageId)) === true;
  }
}

function keyOf(chatId: string | undefined, messageId: string): string {
  return `${chatId ?? "*"}:${messageId}`;
}
