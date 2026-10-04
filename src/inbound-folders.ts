import { Api } from "telegram";

import { CHANNEL_ID } from "./constants";
import { ExpiringMap } from "./expiring-map";
import { toStringId } from "./normalize";

/**
 * `inboundFolders`: only chats in the named Telegram folders wake the agent.
 *
 * A person's own account read by an agent as a silent inbox is read by its
 * owner too, and the owner already keeps the chats that matter in a folder
 * (a "dialog filter"). The folder is not a list of chats: Telegram fills it
 * from hand-picked peers *and* from category rules — "all contacts", "all
 * groups", minus the muted ones, minus the archived ones — so a copy of its
 * peers in the config would be wrong the moment someone new writes. The
 * folder is therefore read from Telegram and evaluated the way Telegram
 * evaluates it, and re-read when it changes.
 *
 * What the filter does and does not touch:
 *
 * - It narrows inbound handling only. A message from outside the folders is
 *   dropped before any sender lookup or attachment fetch; `read` and every
 *   other action are unaffected.
 * - It never widens. A DM still needs `allowFrom`, a group still needs an
 *   entry in `groups` (a `"*"` entry plus the filter admits exactly the
 *   folder's groups).
 * - It fails closed. A folder name that matches nothing admits nothing, and
 *   a lookup that fails skips the message — logged, never thrown.
 *
 * Membership follows Telegram's own order (TDLib's `DialogFilter::need_dialog`),
 * with one deliberate difference noted at {@link peerInFolder}.
 */

/** A folder named in the config: its title as shown in Telegram, or its numeric id. */
export type FolderSelector = string | number;

/**
 * The account's `inboundFolders`, cleaned. `undefined` means "no filter" —
 * absent, not a list, or a list with nothing usable in it — which is the
 * behaviour every version before this had.
 *
 * Numbers are folder ids; strings are titles, compared after trimming. A
 * title made of digits stays a title: Telegram allows one, and guessing
 * would make `"2"` mean different folders on different accounts.
 */
export function readAccountInboundFolders(cfg: any, accountId: string): FolderSelector[] | undefined {
  const raw = cfg?.channels?.[ CHANNEL_ID ]?.accounts?.[ accountId ]?.inboundFolders;
  if (!Array.isArray(raw)) {
    return undefined;
  }

  const selectors: FolderSelector[] = [];
  for (const entry of raw) {
    if (typeof entry === "number" && Number.isInteger(entry) && entry >= 0) {
      selectors.push(entry);
    } else if (typeof entry === "string" && entry.trim()) {
      selectors.push(entry.trim());
    }
  }

  return selectors.length > 0 ? selectors : undefined;
}

/**
 * A folder title as plain text. Layer 185 turned `DialogFilter.title` from a
 * string into `TextWithEntities` (custom emoji ride in the entities); both
 * shapes are accepted, and the entities are irrelevant to the name.
 */
export function folderTitleText(title: unknown): string {
  if (typeof title === "string") {
    return title;
  }
  const text = (title as { text?: unknown } | undefined)?.text;
  return typeof text === "string" ? text : "";
}

/**
 * The comparison form of a title. Exact, except for what a person cannot
 * see: Unicode normalization and the emoji variation selectors. "❤️" typed
 * into a config and "❤" saved by a Telegram client are the same heart, and
 * a filter that silently admitted nothing over U+FE0F would be a cruel one.
 */
export function titleKey(title: string): string {
  return title.normalize("NFC").replace(/[︎️]/g, "").trim();
}

/** One folder, reduced to what membership needs. */
export type FolderRule = {
  id: number;
  title: string;
  /** `dialogFilterChatlist` — a shared folder: explicit peers only, no rules. */
  chatlist: boolean;
  /** Chat keys (see {@link chatKeyOfPeer}) of pinned and included peers. */
  include: Set<string>;
  exclude: Set<string>;
  contacts: boolean;
  nonContacts: boolean;
  groups: boolean;
  broadcasts: boolean;
  bots: boolean;
  excludeMuted: boolean;
  excludeRead: boolean;
  excludeArchived: boolean;
};

/**
 * The key an inbound message's chat already has: a user id, `-<id>` for a
 * basic group, `-100<id>` for a supergroup or channel — `normalized.chatId`.
 * Accepts every `InputPeer` and `Peer` shape that can name a chat.
 */
export function chatKeyOfPeer(peer: any, selfId?: string): string | undefined {
  if (!peer || typeof peer !== "object") {
    return undefined;
  }
  if (peer.className === "InputPeerSelf") {
    return selfId;
  }
  const userId = toStringId(peer.userId);
  if (userId) return userId;
  const chatId = toStringId(peer.chatId);
  if (chatId) return `-${chatId.replace(/^-/, "")}`;
  const channelId = toStringId(peer.channelId);
  if (channelId) return `-100${channelId.replace(/^-100|^-/, "")}`;
  return undefined;
}

function peerKeys(peers: unknown, selfId?: string): Set<string> {
  const keys = new Set<string>();
  if (Array.isArray(peers)) {
    for (const peer of peers) {
      const key = chatKeyOfPeer(peer, selfId);
      if (key) keys.add(key);
    }
  }
  return keys;
}

/**
 * A `DialogFilter` or `DialogFilterChatlist` as a rule; anything else —
 * `DialogFilterDefault` ("All chats", which has no id), an unknown future
 * constructor — is not a folder one can name and yields `undefined`.
 */
export function toFolderRule(raw: any, selfId?: string): FolderRule | undefined {
  const className = raw?.className;
  if (className !== "DialogFilter" && className !== "DialogFilterChatlist") {
    return undefined;
  }
  if (typeof raw.id !== "number") {
    return undefined;
  }

  const chatlist = className === "DialogFilterChatlist";
  const include = peerKeys(raw.pinnedPeers, selfId);
  for (const key of peerKeys(raw.includePeers, selfId)) include.add(key);

  return {
    id: raw.id,
    title: folderTitleText(raw.title),
    chatlist,
    include,
    exclude: chatlist ? new Set() : peerKeys(raw.excludePeers, selfId),
    contacts: !chatlist && raw.contacts === true,
    nonContacts: !chatlist && raw.nonContacts === true,
    groups: !chatlist && raw.groups === true,
    broadcasts: !chatlist && raw.broadcasts === true,
    bots: !chatlist && raw.bots === true,
    excludeMuted: !chatlist && raw.excludeMuted === true,
    excludeRead: !chatlist && raw.excludeRead === true,
    excludeArchived: !chatlist && raw.excludeArchived === true,
  };
}

/**
 * The folders the selectors name. A number matches an id, a string a title
 * ({@link titleKey}); two folders with one title are both selected. What
 * matched nothing comes back in `unknown` for the caller to warn about.
 */
export function selectFolders(rules: FolderRule[], selectors: FolderSelector[]): {
  selected: FolderRule[];
  unknown: FolderSelector[];
} {
  const selected = new Map<number, FolderRule>();
  const unknown: FolderSelector[] = [];

  for (const selector of selectors) {
    const matches = typeof selector === "number"
      ? rules.filter((rule) => rule.id === selector)
      : rules.filter((rule) => titleKey(rule.title) === titleKey(selector));
    if (matches.length === 0) {
      unknown.push(selector);
    }
    for (const rule of matches) selected.set(rule.id, rule);
  }

  return { selected: [ ...selected.values() ], unknown };
}

/** What Telegram's category rules distinguish a chat by. */
export type PeerType = "user" | "group" | "broadcast";

/**
 * Facts about the chat of one inbound message. Anything left `undefined` is
 * unknown; {@link peerInFolder} asks only for what the folder needs, and an
 * unknown it needs makes the answer "no" (fail closed).
 */
export type PeerFacts = {
  key: string;
  type: PeerType;
  bot?: boolean;
  contact?: boolean;
  muted?: boolean;
  archived?: boolean;
  /** The message mentions (or replies to) the account — `message.mentioned`. */
  mentioned?: boolean;
};

export type FolderVerdict = {
  member: boolean;
  /** Set when `member`: how the chat got in. */
  via?: "include" | "category";
  /** Set when not: why. */
  reason?: "excluded" | "not-in-folder" | "muted" | "archived" | "lookup-failed";
};

/**
 * Whether a chat belongs to one folder.
 *
 * 1. `exclude_peers` — never in. TDLib checks the include list first; the
 *    server keeps the two lists disjoint, so the order only matters for an
 *    inconsistent folder, and there the filter errs on the side of silence.
 * 2. `pinned_peers` / `include_peers` — in, whatever else is true of the chat
 *    (an included muted chat stays in a folder that excludes muted ones).
 * 3. The category: a bot by `bots`; any other user by `contacts` or
 *    `non_contacts`; a basic group or supergroup by `groups`; a broadcast
 *    channel by `broadcasts`.
 * 4. Exclusions, for chats that got in by category only:
 *    - `exclude_muted` — unless the message mentions the account: Telegram
 *      keeps a muted chat with an unread mention in the folder;
 *    - `exclude_read` — never applies here. The message being judged has just
 *      arrived, so the chat holds at least one unread message, which is what
 *      the flag keeps;
 *    - `exclude_archived` — the chat's dialog sits in folder 1.
 */
export function peerInFolder(rule: FolderRule, facts: PeerFacts): FolderVerdict {
  if (rule.exclude.has(facts.key)) {
    return { member: false, reason: "excluded" };
  }
  if (rule.include.has(facts.key)) {
    return { member: true, via: "include" };
  }

  const category = categoryAdmits(rule, facts);
  if (category === undefined) {
    return { member: false, reason: "lookup-failed" };
  }
  if (!category) {
    return { member: false, reason: "not-in-folder" };
  }

  if (rule.excludeMuted && facts.mentioned !== true) {
    if (facts.muted === undefined) return { member: false, reason: "lookup-failed" };
    if (facts.muted) return { member: false, reason: "muted" };
  }
  if (rule.excludeArchived) {
    if (facts.archived === undefined) return { member: false, reason: "lookup-failed" };
    if (facts.archived) return { member: false, reason: "archived" };
  }

  return { member: true, via: "category" };
}

/** `undefined` when the answer depends on a fact nobody supplied. */
function categoryAdmits(rule: FolderRule, facts: PeerFacts): boolean | undefined {
  switch (facts.type) {
    case "group":
      return rule.groups;
    case "broadcast":
      return rule.broadcasts;
    case "user": {
      if (!rule.contacts && !rule.nonContacts && !rule.bots) return false;
      if (rule.contacts && rule.nonContacts && rule.bots) return true;
      if (facts.bot === undefined) return undefined;
      if (facts.bot) return rule.bots;
      if (rule.contacts && rule.nonContacts) return true;
      if (facts.contact === undefined) return undefined;
      return facts.contact ? rule.contacts : rule.nonContacts;
    }
  }
}

/** Several folders can say no; the log gets the reason most worth reading. A failed lookup tops it. */
const REASON_RANK: Record<string, number> = {
  "not-in-folder": 1,
  excluded: 2,
  muted: 3,
  archived: 3,
  "lookup-failed": 4,
};

/** The union of folders: in any one is in. */
function judge(rules: FolderRule[], facts: PeerFacts, initialReason: string): InboundFolderDecision {
  let strongest = initialReason;
  for (const rule of rules) {
    const verdict = peerInFolder(rule, facts);
    if (verdict.member) {
      return { admit: true, reason: verdict.via, folderId: rule.id };
    }
    if ((REASON_RANK[ verdict.reason ] ?? 0) > (REASON_RANK[ strongest ] ?? 0)) {
      strongest = verdict.reason;
    }
  }
  return { admit: false, reason: strongest };
}

/** Whether any category of the folder can take a chat of this type at all. */
export function categoryCovers(rule: FolderRule, type: PeerType): boolean {
  switch (type) {
    case "user": return rule.contacts || rule.nonContacts || rule.bots;
    case "group": return rule.groups;
    case "broadcast": return rule.broadcasts;
  }
}

/** What the pipeline asks, and what it is told. */
export type InboundFolderQuery = {
  chatId: string;
  chatType: "direct" | "group" | "channel";
  /** The raw GramJS message: its cached sender entity, input peer and `mentioned` flag. */
  message?: any;
};

export type InboundFolderDecision = {
  admit: boolean;
  /** Why: `include`/`category` when admitted, else the strongest reason a folder gave. */
  reason: string;
  folderId?: number;
};

/** The surface `handleInboundEvent` uses; a fake in tests. */
export type InboundFolderGate = {
  decide(query: InboundFolderQuery): Promise<InboundFolderDecision>;
};

type Log = {
  info?: (message: string, meta?: Record<string, unknown>) => void;
  warn?: (message: string, meta?: Record<string, unknown>) => void;
};

/** What the chat's dialog says: mute, archive and — from the same reply — who the peer is. */
type DialogFacts = {
  /** Seconds since the epoch; `undefined` = "use the scope default". */
  muteUntil?: number;
  archived: boolean;
  bot?: boolean;
  contact?: boolean;
};

type NotifyScope = "users" | "chats" | "broadcasts";

export type InboundFolderFilterOptions = {
  accountId: string;
  selectors: FolderSelector[];
  log?: Log;
  selfId?: string;
  /** `client.invoke`. Every network call the filter makes goes through it. */
  invoke: (request: unknown) => Promise<any>;
  /** The message's chat as an `InputPeer` — the session cache first, at most one call. */
  resolveInputPeer: (message: any) => Promise<unknown>;
  now?: () => number;
  /** Safety-net re-read of the folders (default 10 min). */
  refreshIntervalMs?: number;
  /** How long a chat's dialog facts are trusted without an update (default 5 min). */
  peerTtlMs?: number;
  /** How long the per-type default notification settings are trusted (default 30 min). */
  scopeTtlMs?: number;
  /** Each network call gives up after this long (default 5 s). */
  lookupTimeoutMs?: number;
  /** After a failed folder read, no new attempt for this long (default 30 s). */
  retryAfterMs?: number;
};

const ARCHIVE_FOLDER_ID = 1;

/**
 * The live side: folders read from Telegram, kept current, and asked per
 * message.
 *
 * Network cost, per inbound message, is bounded at four calls and is zero
 * once warm:
 *
 * 1. `messages.getDialogFilters` — on first use, after a folder update, or
 *    when the periodic re-read is due; shared by concurrent messages.
 * 2. The chat's `InputPeer` — normally the session's cache; at most one call.
 * 3. `messages.getPeerDialogs` for that chat — only when a folder admits by
 *    category and needs the mute or archive state, or the sender entity on
 *    the message cannot tell a contact from a non-contact. Cached per chat.
 * 4. `account.getNotifySettings` for the chat's type — only when the chat's
 *    own mute setting is "default". Cached per type.
 *
 * Updates keep the caches honest: `updateDialogFilter` is applied as it
 * arrives, `updateDialogFilters` and `updateDialogFilterOrder` re-read the
 * folders, `updateNotifySettings`, `updateFolderPeers`, `updatePeerSettings`
 * and `updateUser` drop what they make stale.
 */
export class InboundFolderFilter implements InboundFolderGate {
  private readonly accountId: string;
  private readonly selectors: FolderSelector[];
  private readonly log?: Log;
  private readonly selfId?: string;
  private readonly invoke: (request: unknown) => Promise<any>;
  private readonly resolveInputPeer: (message: any) => Promise<unknown>;
  private readonly now: () => number;
  private readonly refreshIntervalMs: number;
  private readonly lookupTimeoutMs: number;
  private readonly retryAfterMs: number;

  private rules: FolderRule[] | undefined;
  private selected: FolderRule[] = [];
  private stale = true;
  /** Bumped by every change that a read already under way may have missed. */
  private generation = 0;
  private inflight: Promise<void> | undefined;
  private lastFailureAt: number | undefined;
  private readonly warnedUnknown = new Set<string>();
  private timer: ReturnType<typeof setInterval> | undefined;

  private readonly dialogs: ExpiringMap<DialogFacts>;
  private readonly scopes: ExpiringMap<number | null>;

  constructor(options: InboundFolderFilterOptions) {
    this.accountId = options.accountId;
    this.selectors = options.selectors;
    this.log = options.log;
    this.selfId = options.selfId;
    this.invoke = options.invoke;
    this.resolveInputPeer = options.resolveInputPeer;
    this.now = options.now ?? Date.now;
    this.refreshIntervalMs = options.refreshIntervalMs ?? 10 * 60_000;
    this.lookupTimeoutMs = options.lookupTimeoutMs ?? 5_000;
    this.retryAfterMs = options.retryAfterMs ?? 30_000;
    this.dialogs = new ExpiringMap<DialogFacts>(options.peerTtlMs ?? 5 * 60_000, 2000);
    this.scopes = new ExpiringMap<number | null>(options.scopeTtlMs ?? 30 * 60_000, 10);
  }

  /** Reads the folders now (so a misspelt name is reported at start) and every interval after. */
  start(): void {
    void this.refresh().catch(() => undefined);
    if (this.timer || this.refreshIntervalMs <= 0) {
      return;
    }
    this.timer = setInterval(() => {
      this.invalidate();
      void this.refresh().catch(() => undefined);
    }, this.refreshIntervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
  }

  /** The folders currently selected — for logs and tests. */
  selectedFolders(): Array<{ id: number; title: string }> {
    return this.selected.map((rule) => ({ id: rule.id, title: rule.title }));
  }

  /**
   * A raw update from GramJS. Synchronous and never throws: it runs on the
   * client's update loop, next to every other handler.
   */
  handleUpdate(update: any): void {
    try {
      switch (update?.className) {
        case "UpdateDialogFilter":
          this.applyFolderUpdate(update);
          return;
        case "UpdateDialogFilters":
        case "UpdateDialogFilterOrder":
          this.invalidate();
          void this.refresh().catch(() => undefined);
          return;
        case "UpdateNotifySettings":
          this.forgetNotify(update.peer);
          return;
        case "UpdateFolderPeers":
          for (const folderPeer of Array.isArray(update.folderPeers) ? update.folderPeers : []) {
            const key = chatKeyOfPeer(folderPeer?.peer, this.selfId);
            if (key) this.dialogs.delete(key);
          }
          return;
        case "UpdatePeerSettings": {
          const key = chatKeyOfPeer(update.peer, this.selfId);
          if (key) this.dialogs.delete(key);
          return;
        }
        case "UpdateUser": {
          const key = toStringId(update.userId);
          if (key) this.dialogs.delete(key);
          return;
        }
      }
    } catch (error) {
      this.log?.warn?.("clawgram inboundFolders update not applied", {
        accountId: this.accountId,
        update: String(update?.className ?? ""),
        error: String(error),
      });
    }
  }

  async decide(query: InboundFolderQuery): Promise<InboundFolderDecision> {
    const ready = await this.ensureFolders();
    if (!ready) {
      return { admit: false, reason: "folders-unavailable" };
    }
    if (this.selected.length === 0) {
      return { admit: false, reason: "no-known-folder" };
    }

    const key = query.chatId;
    const type: PeerType = query.chatType === "direct"
      ? "user"
      : query.chatType === "channel" ? "broadcast" : "group";
    const mentioned = query.message?.mentioned === true;
    const facts: PeerFacts = { key, type, mentioned };

    // The explicit lists cost nothing; most of an owner's folder is usually
    // hand-picked, so most messages are decided here.
    const undecided: FolderRule[] = [];
    let reason = "not-in-folder";
    for (const rule of this.selected) {
      if (rule.exclude.has(key)) {
        reason = "excluded";
        continue;
      }
      if (rule.include.has(key)) {
        return { admit: true, reason: "include", folderId: rule.id };
      }
      if (categoryCovers(rule, type)) {
        undecided.push(rule);
      }
    }
    if (undecided.length === 0) {
      return { admit: false, reason };
    }

    // What costs nothing first: the sender entity GramJS attached to the message.
    const identity = type === "user" ? senderIdentity(query.message, key) : undefined;
    if (identity) {
      facts.bot = identity.bot;
      facts.contact = identity.contact;
    }

    let decision = judge(undecided, facts, reason);
    if (decision.admit || decision.reason !== "lookup-failed") {
      return decision;
    }

    // A folder could take the chat but needs what only its dialog knows: the
    // mute and archive state, or who a sender GramJS knew nothing about is.
    const dialog = await this.dialogFacts(query, type);
    if (!dialog) {
      return decision;
    }
    const nowSeconds = Math.floor(this.now() / 1000);
    facts.archived = dialog.archived;
    if (facts.bot === undefined) {
      facts.bot = dialog.bot;
      facts.contact = dialog.contact;
    }
    if (dialog.muteUntil !== undefined) {
      facts.muted = dialog.muteUntil > nowSeconds;
    }
    decision = judge(undecided, facts, reason);
    if (decision.admit || decision.reason !== "lookup-failed" || dialog.muteUntil !== undefined) {
      return decision;
    }

    // The chat follows its type's default notification setting.
    const scopeMuteUntil = await this.scopeMuteUntil(type, query.chatId);
    if (scopeMuteUntil !== undefined) {
      facts.muted = scopeMuteUntil > nowSeconds;
    }
    return judge(undecided, facts, reason);
  }

  /** `true` once a folder list is in hand — fresh, or the last good one. */
  private async ensureFolders(): Promise<boolean> {
    if (this.rules && !this.stale) {
      return true;
    }
    if (this.lastFailureAt !== undefined && this.now() - this.lastFailureAt < this.retryAfterMs && !this.inflight) {
      return this.rules !== undefined;
    }
    await this.refresh().catch(() => undefined);
    return this.rules !== undefined;
  }

  private invalidate(): void {
    this.generation += 1;
    this.stale = true;
  }

  /**
   * One read of the folders at a time; every caller waits on the same one.
   * A change that lands while the read is under way leaves the result stale,
   * so the next message reads again rather than trusting what may predate it.
   */
  private refresh(): Promise<void> {
    this.inflight ??= (async () => {
      const startedAt = this.generation;
      try {
        const result = await this.call(new Api.messages.GetDialogFilters());
        // Layer 176 wrapped the vector in `messages.dialogFilters`; take either.
        const raw = Array.isArray(result) ? result : result?.filters;
        if (!Array.isArray(raw)) {
          throw new Error("messages.getDialogFilters returned no folder list");
        }
        this.setRules(raw.map((item) => toFolderRule(item, this.selfId)).filter((rule): rule is FolderRule => Boolean(rule)));
        this.stale = this.generation !== startedAt;
        this.lastFailureAt = undefined;
      } catch (error) {
        this.lastFailureAt = this.now();
        this.log?.warn?.("clawgram inboundFolders could not read the account's folders", {
          accountId: this.accountId,
          keeping: this.rules ? "the last folder list" : "nothing — inbound is skipped until a read succeeds",
          error: String(error),
        });
        throw error;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }

  private applyFolderUpdate(update: any): void {
    if (!this.rules || this.inflight) {
      // Nothing to patch yet, or a read under way would overwrite the patch
      // with what it fetched before the change: read again instead.
      this.invalidate();
      return;
    }
    const id = update.id;
    const rule = update.filter ? toFolderRule(update.filter, this.selfId) : undefined;
    const rules = this.rules.filter((existing) => existing.id !== id);
    if (rule) rules.push(rule);
    this.setRules(rules);
  }

  private setRules(rules: FolderRule[]): void {
    const previous = this.selectedFolders().map((folder) => folder.id).join(",");
    this.rules = rules;
    const { selected, unknown } = selectFolders(rules, this.selectors);
    this.selected = selected;

    // Warned once per name, and again only if it comes back after being found.
    const stillUnknown = new Set(unknown.map(selectorKey));
    for (const warned of [ ...this.warnedUnknown ]) {
      if (!stillUnknown.has(warned)) this.warnedUnknown.delete(warned);
    }
    const fresh = unknown.filter((selector) => !this.warnedUnknown.has(selectorKey(selector)));
    if (fresh.length > 0) {
      for (const selector of fresh) this.warnedUnknown.add(selectorKey(selector));
      this.log?.warn?.("clawgram inboundFolders names a folder this account does not have; it admits nothing", {
        accountId: this.accountId,
        unknown: fresh,
        available: rules.map((rule) => ({ id: rule.id, title: rule.title })),
      });
    }

    const current = this.selectedFolders();
    if (current.map((folder) => folder.id).join(",") !== previous) {
      this.log?.info?.("clawgram inboundFolders in effect", { accountId: this.accountId, folders: current });
    }
  }

  private async dialogFacts(query: InboundFolderQuery, type: PeerType): Promise<DialogFacts | undefined> {
    const cached = this.dialogs.get(query.chatId, this.now());
    if (cached) {
      return cached;
    }

    try {
      const peer = await this.withTimeout(this.resolveInputPeer(query.message));
      if (!peer) {
        throw new Error("the chat has no input peer in the session cache");
      }
      const result = await this.call(new Api.messages.GetPeerDialogs({
        peers: [ new Api.InputDialogPeer({ peer: peer as Api.TypeInputPeer }) ],
      }));
      const dialog = (Array.isArray(result?.dialogs) ? result.dialogs : [])
        .find((item: any) => chatKeyOfPeer(item?.peer, this.selfId) === query.chatId);
      const user = type === "user"
        ? (Array.isArray(result?.users) ? result.users : []).find((item: any) => toStringId(item?.id) === query.chatId)
        : undefined;
      const muteUntil = dialog?.notifySettings?.muteUntil;
      const facts: DialogFacts = {
        // No dialog yet (a first message can arrive before one exists) — not muted
        // on its own account and not archived.
        muteUntil: typeof muteUntil === "number" ? muteUntil : undefined,
        archived: dialog?.folderId === ARCHIVE_FOLDER_ID,
        bot: user ? user.bot === true : undefined,
        contact: user ? user.contact === true : undefined,
      };
      this.dialogs.set(query.chatId, facts, this.now());
      return facts;
    } catch (error) {
      this.log?.warn?.("clawgram inboundFolders could not look up the chat", {
        accountId: this.accountId,
        chatId: query.chatId,
        step: "getPeerDialogs",
        error: String(error),
      });
      return undefined;
    }
  }

  private async scopeMuteUntil(type: PeerType, chatId: string): Promise<number | undefined> {
    const scope: NotifyScope = type === "user" ? "users" : type === "broadcast" ? "broadcasts" : "chats";
    const cached = this.scopes.get(scope, this.now());
    if (cached !== undefined) {
      return cached ?? 0;
    }

    try {
      const peer = scope === "users"
        ? new Api.InputNotifyUsers()
        : scope === "broadcasts" ? new Api.InputNotifyBroadcasts() : new Api.InputNotifyChats();
      const settings = await this.call(new Api.account.GetNotifySettings({ peer }));
      const muteUntil = typeof settings?.muteUntil === "number" ? settings.muteUntil : null;
      this.scopes.set(scope, muteUntil, this.now());
      return muteUntil ?? 0;
    } catch (error) {
      this.log?.warn?.("clawgram inboundFolders could not look up the chat", {
        accountId: this.accountId,
        chatId,
        step: "getNotifySettings",
        scope,
        error: String(error),
      });
      return undefined;
    }
  }

  private forgetNotify(notifyPeer: any): void {
    switch (notifyPeer?.className) {
      case "NotifyUsers": this.scopes.delete("users"); return;
      case "NotifyChats": this.scopes.delete("chats"); return;
      case "NotifyBroadcasts": this.scopes.delete("broadcasts"); return;
      default: {
        const key = chatKeyOfPeer(notifyPeer?.peer, this.selfId);
        if (key) this.dialogs.delete(key);
      }
    }
  }

  private call(request: unknown): Promise<any> {
    return this.withTimeout(this.invoke(request));
  }

  private withTimeout<T>(promise: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      // Not unref'd: it is cleared the moment the call settles, and a pending
      // lookup is exactly what should keep the process waiting for its answer.
      timer = setTimeout(() => reject(new Error(`timed out after ${this.lookupTimeoutMs} ms`)), this.lookupTimeoutMs);
    });
    return Promise.race([ promise, timeout ]).finally(() => clearTimeout(timer));
  }
}

function selectorKey(selector: FolderSelector): string {
  return `${typeof selector}:${selector}`;
}

/**
 * Bot and contact flags from the entity GramJS attached to the message, when
 * it is the chat's own user and a full one. A `min` user carries no reliable
 * `contact` flag, so it does not count.
 */
export function senderIdentity(message: any, chatKey: string): { bot: boolean; contact: boolean } | undefined {
  for (const entity of [ message?._chat, message?.chat, message?._sender, message?.sender ]) {
    if (!entity || typeof entity !== "object" || entity.min === true) continue;
    if (entity.className !== undefined && entity.className !== "User") continue;
    if (toStringId(entity.id) !== chatKey) continue;
    return { bot: entity.bot === true, contact: entity.contact === true };
  }
  return undefined;
}

/**
 * The filter for one account, or `undefined` when the account sets no
 * `inboundFolders` — then the pipeline is exactly what it was before.
 */
export function createInboundFolderFilter(params: {
  cfg: any;
  accountId: string;
  client: any;
  log?: Log;
  selfId?: string;
}): InboundFolderFilter | undefined {
  const selectors = readAccountInboundFolders(params.cfg, params.accountId);
  if (!selectors) {
    return undefined;
  }

  const client = params.client;
  return new InboundFolderFilter({
    accountId: params.accountId,
    selectors,
    log: params.log,
    selfId: params.selfId,
    invoke: (request) => client.invoke(request),
    resolveInputPeer: async (message) => {
      const cached = message?.inputChat ?? message?._inputChat;
      if (cached) return cached;
      // Not `message.getInputChat()`: on a cache miss it walks a hundred
      // dialogs. `getInputEntity` asks the session, then makes one call.
      return message?.peerId ? client.getInputEntity(message.peerId) : undefined;
    },
  });
}
