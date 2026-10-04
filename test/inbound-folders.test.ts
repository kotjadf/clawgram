import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it, mock } from "node:test";

import {
  InboundFolderFilter,
  chatKeyOfPeer,
  createInboundFolderFilter,
  folderTitleText,
  peerInFolder,
  readAccountInboundFolders,
  selectFolders,
  senderIdentity,
  toFolderRule,
  type FolderRule,
  type PeerFacts,
} from "../src/inbound-folders";
import { handleInboundEvent } from "../src/inbound-pipeline";

/**
 * `inboundFolders` — only chats in the owner's Telegram folders wake the agent.
 *
 * The owner reads one folder in their own Telegram and wants the agent to
 * read exactly that. The folder holds chats picked by hand and chats Telegram
 * adds by rule (contacts, groups, …), so the filter has to evaluate the rules
 * the way Telegram does, follow the folder as it changes, and say "no" — not
 * crash, not admit — when it cannot tell.
 */

const cfgWith = (account: Record<string, unknown>) => ({
  channels: { clawgram: { accounts: { default: { allowFrom: [ "*" ], ...account } } } },
});

/** A `dialogFilter` as GramJS hands it over, with the title in the layer-185 shape. */
function dialogFilter(over: Record<string, unknown> = {}) {
  return {
    className: "DialogFilter",
    id: 2,
    title: { className: "TextWithEntities", text: "❤️ Inbox", entities: [] },
    pinnedPeers: [],
    includePeers: [],
    excludePeers: [],
    ...over,
  };
}

const user = (id: number) => ({ className: "InputPeerUser", userId: id, accessHash: 1 });
const chat = (id: number) => ({ className: "InputPeerChat", chatId: id });
const channel = (id: number) => ({ className: "InputPeerChannel", channelId: id, accessHash: 1 });

function rule(over: Partial<FolderRule> = {}): FolderRule {
  return {
    id: 2, title: "Inbox", chatlist: false,
    include: new Set(), exclude: new Set(),
    contacts: false, nonContacts: false, groups: false, broadcasts: false, bots: false,
    excludeMuted: false, excludeRead: false, excludeArchived: false,
    ...over,
  };
}

describe("inboundFolders in the config", () => {
  it("absent, empty or unusable means no filter — today's behaviour", () => {
    assert.equal(readAccountInboundFolders(cfgWith({}), "default"), undefined);
    assert.equal(readAccountInboundFolders(cfgWith({ inboundFolders: [] }), "default"), undefined);
    assert.equal(readAccountInboundFolders(cfgWith({ inboundFolders: "❤️" }), "default"), undefined);
    assert.equal(readAccountInboundFolders(cfgWith({ inboundFolders: [ "  ", null, 1.5, -1, {} ] }), "default"), undefined);
    assert.equal(readAccountInboundFolders(undefined, "default"), undefined);
  });

  it("keeps titles (trimmed) and integer ids, in order; a digit string stays a title", () => {
    assert.deepEqual(
      readAccountInboundFolders(cfgWith({ inboundFolders: [ " ❤️ ", 3, "7", false ] }), "default"),
      [ "❤️", 3, "7" ],
    );
  });

  it("is per account", () => {
    const cfg = { channels: { clawgram: { accounts: { a: { inboundFolders: [ "Work" ] }, b: {} } } } };
    assert.deepEqual(readAccountInboundFolders(cfg, "a"), [ "Work" ]);
    assert.equal(readAccountInboundFolders(cfg, "b"), undefined);
  });

  it("an account without the option gets no filter object at all", () => {
    assert.equal(createInboundFolderFilter({ cfg: cfgWith({}), accountId: "default", client: {} }), undefined);
    assert.ok(createInboundFolderFilter({ cfg: cfgWith({ inboundFolders: [ 2 ] }), accountId: "default", client: {} }));
  });
});

describe("folders are named by title or id", () => {
  it("reads a title as a string or as TextWithEntities", () => {
    assert.equal(folderTitleText("Work"), "Work");
    assert.equal(folderTitleText({ text: "❤️ Inbox", entities: [ { offset: 0, length: 2 } ] }), "❤️ Inbox");
    assert.equal(folderTitleText(undefined), "");
  });

  it("matches the exact title, emoji included, whatever its wire shape", () => {
    const rules = [
      toFolderRule(dialogFilter({ id: 2, title: { text: "❤️", entities: [] } })),
      toFolderRule(dialogFilter({ id: 3, title: "Work" })),
      toFolderRule(dialogFilter({ id: 4, title: { text: "Work chats", entities: [] } })),
    ];
    const { selected, unknown } = selectFolders(rules, [ "❤️", "Work" ]);
    assert.deepEqual(selected.map((r) => r.id), [ 2, 3 ], "a prefix is not a match");
    assert.deepEqual(unknown, []);
  });

  it("an invisible variation selector does not make the heart a different folder", () => {
    const rules = [ toFolderRule(dialogFilter({ id: 2, title: { text: "❤", entities: [] } })) ];
    assert.deepEqual(selectFolders(rules, [ "❤️" ]).selected.map((r) => r.id), [ 2 ]);
  });

  it("matches a number to the id, and reports what matched nothing", () => {
    const rules = [ toFolderRule(dialogFilter({ id: 5, title: "5" })) ];
    const byId = selectFolders(rules, [ 5 ]);
    assert.deepEqual(byId.selected.map((r) => r.id), [ 5 ]);
    const missing = selectFolders(rules, [ 9, "Nope" ]);
    assert.deepEqual(missing.selected, []);
    assert.deepEqual(missing.unknown, [ 9, "Nope" ]);
  });

  it("two folders with one title are both selected", () => {
    const rules = [ toFolderRule(dialogFilter({ id: 2, title: "A" })), toFolderRule(dialogFilter({ id: 3, title: "A" })) ];
    assert.deepEqual(selectFolders(rules, [ "A" ]).selected.map((r) => r.id), [ 2, 3 ]);
  });
});

describe("a folder as Telegram sends it", () => {
  it("collects pinned and included peers of every kind under the inbound chat key", () => {
    const parsed = toFolderRule(dialogFilter({
      pinnedPeers: [ user(500) ],
      includePeers: [ chat(4242), channel(77), { className: "InputPeerSelf" } ],
      excludePeers: [ user(501) ],
      contacts: true, excludeMuted: true,
    }), "777");
    assert.deepEqual([ ...parsed.include ].sort(), [ "-10077", "-4242", "500", "777" ]);
    assert.deepEqual([ ...parsed.exclude ], [ "501" ]);
    assert.equal(parsed.contacts, true);
    assert.equal(parsed.excludeMuted, true);
    assert.equal(parsed.groups, false);
  });

  it("a shared folder (chatlist) has explicit peers and no rules", () => {
    const parsed = toFolderRule({
      className: "DialogFilterChatlist", id: 6, title: { text: "Shared" },
      pinnedPeers: [], includePeers: [ channel(77) ],
      contacts: true, groups: true, excludePeers: [ user(500) ],
    });
    assert.equal(parsed.chatlist, true);
    assert.deepEqual([ ...parsed.include ], [ "-10077" ]);
    assert.equal(parsed.exclude.size, 0);
    assert.equal(parsed.contacts || parsed.groups, false);
  });

  it("\"All chats\" is not a folder one can name", () => {
    assert.equal(toFolderRule({ className: "DialogFilterDefault" }), undefined);
    assert.equal(toFolderRule(undefined), undefined);
  });

  it("peer keys match what the pipeline calls the chat", () => {
    assert.equal(chatKeyOfPeer({ className: "PeerUser", userId: 500 }), "500");
    assert.equal(chatKeyOfPeer({ className: "PeerChat", chatId: 4242 }), "-4242");
    assert.equal(chatKeyOfPeer({ className: "PeerChannel", channelId: 77 }), "-10077");
    assert.equal(chatKeyOfPeer({ className: "InputPeerSelf" }, "777"), "777");
    assert.equal(chatKeyOfPeer({ className: "InputPeerEmpty" }), undefined);
  });
});

describe("membership, in Telegram's order", () => {
  const facts = (over: Partial<PeerFacts> = {}): PeerFacts => ({ key: "500", type: "user", ...over });

  it("exclude_peers wins over include_peers and over every category", () => {
    const r = rule({ include: new Set([ "500" ]), exclude: new Set([ "500" ]), contacts: true, nonContacts: true, bots: true });
    assert.deepEqual(peerInFolder(r, facts()), { member: false, reason: "excluded" });
  });

  it("an included chat is in even if it is muted, archived and of no listed category", () => {
    const r = rule({ include: new Set([ "500" ]), excludeMuted: true, excludeArchived: true, excludeRead: true });
    assert.deepEqual(peerInFolder(r, facts({ muted: true, archived: true })), { member: true, via: "include" });
  });

  it("contacts and non_contacts split users by the contact flag", () => {
    assert.equal(peerInFolder(rule({ contacts: true }), facts({ bot: false, contact: true })).member, true);
    assert.equal(peerInFolder(rule({ contacts: true }), facts({ bot: false, contact: false })).reason, "not-in-folder");
    assert.equal(peerInFolder(rule({ nonContacts: true }), facts({ bot: false, contact: false })).member, true);
    assert.equal(peerInFolder(rule({ nonContacts: true }), facts({ bot: false, contact: true })).member, false);
  });

  it("a bot is judged by bots alone, contact or not", () => {
    assert.equal(peerInFolder(rule({ bots: true }), facts({ bot: true, contact: false })).member, true);
    assert.equal(peerInFolder(rule({ contacts: true, nonContacts: true }), facts({ bot: true, contact: true })).member, false);
  });

  it("groups take basic groups and supergroups; broadcasts take channels; neither takes users", () => {
    assert.equal(peerInFolder(rule({ groups: true }), { key: "-4242", type: "group" }).member, true);
    assert.equal(peerInFolder(rule({ groups: true }), { key: "-10077", type: "broadcast" }).member, false);
    assert.equal(peerInFolder(rule({ broadcasts: true }), { key: "-10077", type: "broadcast" }).member, true);
    assert.equal(peerInFolder(rule({ groups: true, broadcasts: true }), facts({ bot: false, contact: true })).member, false);
  });

  it("exclude_muted drops a muted chat — unless the message mentions the account", () => {
    const r = rule({ groups: true, excludeMuted: true });
    const group = { key: "-4242", type: "group" as const };
    assert.deepEqual(peerInFolder(r, { ...group, muted: true }), { member: false, reason: "muted" });
    assert.equal(peerInFolder(r, { ...group, muted: false }).member, true);
    assert.equal(peerInFolder(r, { ...group, muted: true, mentioned: true }).member, true);
  });

  it("exclude_read never drops a chat that has just received a message", () => {
    const r = rule({ contacts: true, excludeRead: true });
    assert.equal(peerInFolder(r, facts({ bot: false, contact: true })).member, true);
  });

  it("exclude_archived drops a chat in the archive", () => {
    const r = rule({ nonContacts: true, excludeArchived: true });
    assert.deepEqual(peerInFolder(r, facts({ bot: false, contact: false, archived: true })), { member: false, reason: "archived" });
    assert.equal(peerInFolder(r, facts({ bot: false, contact: false, archived: false })).member, true);
  });

  it("a fact the folder needs and nobody knows is a no, not a guess", () => {
    assert.equal(peerInFolder(rule({ contacts: true }), facts()).reason, "lookup-failed");
    assert.equal(peerInFolder(rule({ groups: true, excludeMuted: true }), { key: "-4242", type: "group" }).reason, "lookup-failed");
    assert.equal(peerInFolder(rule({ groups: true, excludeArchived: true }), { key: "-4242", type: "group" }).reason, "lookup-failed");
    // All three user categories: who the user is does not matter.
    assert.equal(peerInFolder(rule({ contacts: true, nonContacts: true, bots: true }), facts()).member, true);
  });

  it("a folder with no rules and no peers holds nothing", () => {
    assert.equal(peerInFolder(rule(), facts({ bot: false, contact: true })).reason, "not-in-folder");
  });
});

describe("who the sender is, without a call", () => {
  it("uses a full user entity GramJS attached to the message", () => {
    assert.deepEqual(senderIdentity({ _sender: { className: "User", id: 500, contact: true } }, "500"), { bot: false, contact: true });
    assert.deepEqual(senderIdentity({ sender: { id: 500, bot: true } }, "500"), { bot: true, contact: false });
  });

  it("ignores a min user, a different id and a chat entity", () => {
    assert.equal(senderIdentity({ _sender: { className: "User", id: 500, min: true, contact: true } }, "500"), undefined);
    assert.equal(senderIdentity({ _sender: { className: "User", id: 501, contact: true } }, "500"), undefined);
    assert.equal(senderIdentity({ _chat: { className: "Chat", id: 500 } }, "500"), undefined);
    assert.equal(senderIdentity(undefined, "500"), undefined);
  });
});

/**
 * A fake Telegram behind `invoke`: answers by request name and counts calls,
 * so each test can say how many round trips a message cost.
 */
function fakeTelegram(state: {
  filters?: unknown[];
  peerDialogs?: (request: any) => unknown;
  scope?: Record<string, unknown>;
  fail?: Set<string>;
} = {}) {
  const calls: string[] = [];
  const invoke = async (request: any) => {
    const name = request?.className;
    calls.push(name);
    if (state.fail?.has(name)) throw new Error(`${name} failed`);
    switch (name) {
      case "messages.GetDialogFilters":
        return { className: "messages.DialogFilters", filters: state.filters ?? [] };
      case "messages.GetPeerDialogs":
        return state.peerDialogs?.(request) ?? { dialogs: [], users: [], chats: [] };
      case "account.GetNotifySettings":
        return state.scope?.[ request.peer.className ] ?? { className: "PeerNotifySettings" };
      default:
        throw new Error(`unexpected ${name}`);
    }
  };
  return { calls, invoke };
}

function makeFilter(telegram: ReturnType<typeof fakeTelegram>, over: Record<string, unknown> = {}) {
  const warnings: Array<[ string, any ]> = [];
  const infos: Array<[ string, any ]> = [];
  let now = 1_700_000_000_000;
  const filter = new InboundFolderFilter({
    accountId: "default",
    selectors: [ "❤️ Inbox" ],
    selfId: "777",
    invoke: telegram.invoke,
    resolveInputPeer: async (message) => message?.peerId ? { className: "InputPeerUser", ...message.peerId } : undefined,
    log: {
      warn: (m, meta) => { warnings.push([ m, meta ]); },
      info: (m, meta) => { infos.push([ m, meta ]); },
    },
    now: () => now,
    refreshIntervalMs: 0,
    ...over,
  });
  return { filter, warnings, infos, advance: (ms: number) => { now += ms; }, nowSeconds: () => Math.floor(now / 1000) };
}

const dm = (id: number, extra: Record<string, unknown> = {}) => ({
  chatId: String(id), chatType: "direct" as const,
  message: { id: 1, peerId: { userId: id }, ...extra },
});
const groupMsg = (id: number, extra: Record<string, unknown> = {}) => ({
  chatId: `-${id}`, chatType: "group" as const,
  message: { id: 1, peerId: { chatId: id }, ...extra },
});

describe("the live filter", () => {
  it("reads the folders once, lazily, and decides an included chat with no further call", async () => {
    const tg = fakeTelegram({ filters: [ { className: "DialogFilterDefault" }, dialogFilter({ includePeers: [ user(500) ] }) ] });
    const { filter } = makeFilter(tg);
    assert.deepEqual(tg.calls, [], "nothing is read before the first message");

    assert.deepEqual(await filter.decide(dm(500)), { admit: true, reason: "include", folderId: 2 });
    assert.deepEqual(await filter.decide(dm(501)), { admit: false, reason: "not-in-folder" });
    assert.deepEqual(tg.calls, [ "messages.GetDialogFilters" ]);
  });

  it("concurrent first messages share one read", async () => {
    const tg = fakeTelegram({ filters: [ dialogFilter({ includePeers: [ user(500) ] }) ] });
    const { filter } = makeFilter(tg);
    await Promise.all([ filter.decide(dm(500)), filter.decide(dm(500)), filter.decide(dm(501)) ]);
    assert.deepEqual(tg.calls, [ "messages.GetDialogFilters" ]);
  });

  it("a contacts rule is decided from the sender entity on the message when it has one", async () => {
    const tg = fakeTelegram({ filters: [ dialogFilter({ contacts: true }) ] });
    const { filter } = makeFilter(tg);
    const contact = await filter.decide(dm(500, { _sender: { className: "User", id: 500, contact: true } }));
    const stranger = await filter.decide(dm(501, { _sender: { className: "User", id: 501, contact: false } }));
    assert.equal(contact.admit, true);
    assert.deepEqual(stranger, { admit: false, reason: "not-in-folder" });
    assert.deepEqual(tg.calls, [ "messages.GetDialogFilters" ]);
  });

  it("without one, the chat's dialog is looked up once and cached", async () => {
    const tg = fakeTelegram({
      filters: [ dialogFilter({ contacts: true }) ],
      peerDialogs: () => ({
        dialogs: [ { peer: { className: "PeerUser", userId: 500 }, notifySettings: {} } ],
        users: [ { className: "User", id: 500, contact: true } ],
      }),
    });
    const { filter } = makeFilter(tg);
    assert.equal((await filter.decide(dm(500))).admit, true);
    assert.equal((await filter.decide(dm(500))).admit, true);
    assert.deepEqual(tg.calls, [ "messages.GetDialogFilters", "messages.GetPeerDialogs" ]);
  });

  it("no category of the folder fits the chat: decided without any lookup", async () => {
    const tg = fakeTelegram({ filters: [ dialogFilter({ contacts: true, excludeMuted: true, excludeArchived: true }) ] });
    const { filter } = makeFilter(tg);
    assert.deepEqual(await filter.decide(groupMsg(4242)), { admit: false, reason: "not-in-folder" });
    assert.deepEqual(tg.calls, [ "messages.GetDialogFilters" ]);
  });

  it("exclude_muted reads the chat's own setting, then its type's default when the chat has none", async () => {
    let muteUntil: number | undefined;
    const tg = fakeTelegram({
      filters: [ dialogFilter({ groups: true, excludeMuted: true }) ],
      peerDialogs: () => ({ dialogs: [ { peer: { className: "PeerChat", chatId: 4242 }, notifySettings: { muteUntil } } ] }),
      scope: { InputNotifyChats: { muteUntil: 2147483647 } },
    });
    const { filter, nowSeconds } = makeFilter(tg, { peerTtlMs: 0 });

    muteUntil = nowSeconds() + 3600;
    assert.deepEqual(await filter.decide(groupMsg(4242)), { admit: false, reason: "muted" });
    muteUntil = nowSeconds() - 1;
    assert.deepEqual(await filter.decide(groupMsg(4242)), { admit: true, reason: "category", folderId: 2 });
    assert.equal(tg.calls.includes("account.GetNotifySettings"), false, "an explicit setting needs no default");

    muteUntil = undefined;
    assert.deepEqual(await filter.decide(groupMsg(4242)), { admit: false, reason: "muted" }, "groups are muted by default here");
    assert.equal(tg.calls.filter((c) => c === "account.GetNotifySettings").length, 1);

    // A mention keeps a muted chat in the folder, and needs no lookup at all.
    tg.calls.length = 0;
    assert.equal((await filter.decide(groupMsg(4242, { mentioned: true }))).admit, true);
    assert.deepEqual(tg.calls, []);
  });

  it("exclude_archived reads the dialog's folder", async () => {
    let folderId: number | undefined = 1;
    const tg = fakeTelegram({
      filters: [ dialogFilter({ groups: true, excludeArchived: true }) ],
      peerDialogs: () => ({ dialogs: [ { peer: { className: "PeerChat", chatId: 4242 }, notifySettings: {}, folderId } ] }),
    });
    const { filter } = makeFilter(tg);
    assert.deepEqual(await filter.decide(groupMsg(4242)), { admit: false, reason: "archived" });

    // Unarchived on the phone: the update drops the cached dialog.
    folderId = undefined;
    filter.handleUpdate({ className: "UpdateFolderPeers", folderPeers: [ { peer: { className: "PeerChat", chatId: 4242 }, folderId: 0 } ] });
    assert.equal((await filter.decide(groupMsg(4242))).admit, true);
  });

  it("an included chat in a folder that also excludes muted chats costs no lookup", async () => {
    const tg = fakeTelegram({ filters: [ dialogFilter({ includePeers: [ chat(4242) ], groups: true, excludeMuted: true }) ] });
    const { filter } = makeFilter(tg);
    assert.equal((await filter.decide(groupMsg(4242))).admit, true);
    assert.deepEqual(tg.calls, [ "messages.GetDialogFilters" ]);
  });

  it("several folders are a union, and an exclusion in one does not veto another", async () => {
    const tg = fakeTelegram({ filters: [
      dialogFilter({ id: 2, title: "A", excludePeers: [ user(500) ], contacts: true }),
      dialogFilter({ id: 3, title: "B", includePeers: [ user(500) ] }),
    ] });
    const { filter } = makeFilter(tg, { selectors: [ "A", 3 ] });
    assert.deepEqual(await filter.decide(dm(500)), { admit: true, reason: "include", folderId: 3 });
  });

  it("never spends more than four calls on one message", async () => {
    const tg = fakeTelegram({
      filters: [ dialogFilter({ contacts: true, excludeMuted: true, excludeArchived: true }) ],
      peerDialogs: () => ({ dialogs: [ { peer: { className: "PeerUser", userId: 500 }, notifySettings: {} } ], users: [] }),
    });
    const { filter } = makeFilter(tg);
    const decision = await filter.decide(dm(500));
    assert.ok(tg.calls.length <= 4, `calls: ${tg.calls.join(", ")}`);
    // The dialog did not name the user: who it is stays unknown, and unknown is a no.
    assert.deepEqual(decision, { admit: false, reason: "lookup-failed" });
  });
});

describe("folders change while the channel runs", () => {
  it("updateDialogFilter is applied as it arrives — no restart, no re-read", async () => {
    const tg = fakeTelegram({ filters: [ dialogFilter({ includePeers: [ user(500) ] }) ] });
    const { filter } = makeFilter(tg);
    assert.equal((await filter.decide(dm(501))).admit, false);

    filter.handleUpdate({ className: "UpdateDialogFilter", id: 2, filter: dialogFilter({ includePeers: [ user(500), user(501) ] }) });
    assert.equal((await filter.decide(dm(501))).admit, true);
    assert.deepEqual(tg.calls, [ "messages.GetDialogFilters" ]);
  });

  it("a renamed folder stops matching its old title; a deleted one admits nothing", async () => {
    const tg = fakeTelegram({ filters: [ dialogFilter({ includePeers: [ user(500) ] }) ] });
    const { filter, warnings } = makeFilter(tg);
    assert.equal((await filter.decide(dm(500))).admit, true);

    filter.handleUpdate({ className: "UpdateDialogFilter", id: 2, filter: dialogFilter({ title: { text: "Other" }, includePeers: [ user(500) ] }) });
    assert.deepEqual(await filter.decide(dm(500)), { admit: false, reason: "no-known-folder" });
    assert.equal(warnings.length, 1);

    filter.handleUpdate({ className: "UpdateDialogFilter", id: 2, filter: dialogFilter({ includePeers: [ user(500) ] }) });
    assert.equal((await filter.decide(dm(500))).admit, true);
    filter.handleUpdate({ className: "UpdateDialogFilter", id: 2 });
    assert.equal((await filter.decide(dm(500))).admit, false);
  });

  for (const className of [ "UpdateDialogFilters", "UpdateDialogFilterOrder" ]) {
    it(`${className} re-reads the folders`, async () => {
      const state = { filters: [ dialogFilter({ includePeers: [ user(500) ] }) ] as unknown[] };
      const tg = fakeTelegram(state);
      const { filter } = makeFilter(tg);
      assert.equal((await filter.decide(dm(501))).admit, false);

      state.filters = [ dialogFilter({ includePeers: [ user(501) ] }) ];
      filter.handleUpdate({ className, order: [ 2 ] });
      assert.equal((await filter.decide(dm(501))).admit, true);
      assert.equal(tg.calls.filter((c) => c === "messages.GetDialogFilters").length, 2);
    });
  }

  it("a change that lands during a read is not lost to it", async () => {
    const state = { filters: [ dialogFilter({ includePeers: [ user(500) ] }) ] as unknown[] };
    const tg = fakeTelegram(state);
    let release: () => void = () => {};
    const gated = async (request: any) => {
      const answer = await tg.invoke(request);
      if (request.className === "messages.GetDialogFilters" && tg.calls.length === 1) {
        await new Promise<void>((resolve) => { release = resolve; });
      }
      return answer;
    };
    const { filter } = makeFilter(tg, { invoke: gated });

    const first = filter.decide(dm(501));
    await new Promise((resolve) => setImmediate(resolve));
    // The folder changes after the read was answered but before it was applied.
    state.filters = [ dialogFilter({ includePeers: [ user(501) ] }) ];
    filter.handleUpdate({ className: "UpdateDialogFilter", id: 2, filter: state.filters[ 0 ] });
    release();
    assert.equal((await first).admit, false, "the message that started the read sees what it read");
    assert.equal((await filter.decide(dm(501))).admit, true, "the next one reads again");
  });

  it("notify-settings updates drop the cached mute state", async () => {
    let muteUntil = 0;
    const tg = fakeTelegram({
      filters: [ dialogFilter({ groups: true, excludeMuted: true }) ],
      peerDialogs: () => ({ dialogs: [ { peer: { className: "PeerChat", chatId: 4242 }, notifySettings: { muteUntil } } ] }),
    });
    const { filter, nowSeconds } = makeFilter(tg);
    assert.equal((await filter.decide(groupMsg(4242))).admit, true);

    muteUntil = nowSeconds() + 3600;
    assert.equal((await filter.decide(groupMsg(4242))).admit, true, "still cached");
    filter.handleUpdate({
      className: "UpdateNotifySettings",
      peer: { className: "NotifyPeer", peer: { className: "PeerChat", chatId: 4242 } },
      notifySettings: { muteUntil },
    });
    assert.deepEqual(await filter.decide(groupMsg(4242)), { admit: false, reason: "muted" });
  });

  it("the periodic re-read is a safety net for updates that never arrive", async () => {
    mock.timers.enable({ apis: [ "setInterval" ] });
    try {
      const state = { filters: [ dialogFilter({ includePeers: [ user(500) ] }) ] as unknown[] };
      const tg = fakeTelegram(state);
      const { filter } = makeFilter(tg, { refreshIntervalMs: 600_000 });
      filter.start();
      await new Promise((resolve) => setImmediate(resolve));
      assert.deepEqual(tg.calls, [ "messages.GetDialogFilters" ], "start reads the folders once, to report a bad name early");

      state.filters = [ dialogFilter({ includePeers: [ user(501) ] }) ];
      mock.timers.tick(600_000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(tg.calls.length, 2);
      assert.equal((await filter.decide(dm(501))).admit, true);
      filter.stop();

      mock.timers.tick(600_000);
      await new Promise((resolve) => setImmediate(resolve));
      assert.equal(tg.calls.length, 2, "a stopped filter keeps no timer");
    } finally {
      mock.timers.reset();
    }
  });

  it("an update it does not understand is ignored, and none throws", () => {
    const { filter } = makeFilter(fakeTelegram());
    for (const update of [ undefined, null, {}, { className: "UpdateNewMessage" }, { className: "UpdateFolderPeers", folderPeers: "x" } ]) {
      assert.doesNotThrow(() => filter.handleUpdate(update));
    }
  });
});

describe("failing closed", () => {
  it("a folder name the account does not have admits nothing and is reported once", async () => {
    const tg = fakeTelegram({ filters: [ dialogFilter({ id: 3, title: "Work", includePeers: [ user(500) ] }) ] });
    const { filter, warnings } = makeFilter(tg, { selectors: [ "❤️ Inbox" ] });
    assert.deepEqual(await filter.decide(dm(500)), { admit: false, reason: "no-known-folder" });
    assert.deepEqual(await filter.decide(dm(500)), { admit: false, reason: "no-known-folder" });
    assert.equal(warnings.length, 1);
    assert.deepEqual(warnings[ 0 ][ 1 ].unknown, [ "❤️ Inbox" ]);
    assert.deepEqual(warnings[ 0 ][ 1 ].available, [ { id: 3, title: "Work" } ], "the warning says what there is to choose from");
  });

  it("one unknown name does not switch off the folders that were found", async () => {
    const tg = fakeTelegram({ filters: [ dialogFilter({ includePeers: [ user(500) ] }) ] });
    const { filter, warnings } = makeFilter(tg, { selectors: [ "❤️ Inbox", "Typo" ] });
    assert.equal((await filter.decide(dm(500))).admit, true);
    assert.equal(warnings.length, 1);
  });

  it("folders that cannot be read skip the message, and the read is not retried on every message", async () => {
    const tg = fakeTelegram({ filters: [ dialogFilter({ includePeers: [ user(500) ] }) ], fail: new Set([ "messages.GetDialogFilters" ]) });
    const { filter, warnings, advance } = makeFilter(tg);
    assert.deepEqual(await filter.decide(dm(500)), { admit: false, reason: "folders-unavailable" });
    assert.deepEqual(await filter.decide(dm(500)), { admit: false, reason: "folders-unavailable" });
    assert.equal(tg.calls.length, 1, "a second message inside the back-off makes no call");
    assert.equal(warnings.length, 1);

    tg.calls.length = 0;
    advance(31_000);
    const healed = fakeTelegram({ filters: [ dialogFilter({ includePeers: [ user(500) ] }) ] });
    (filter as any).invoke = healed.invoke;
    assert.equal((await filter.decide(dm(500))).admit, true);
  });

  it("a failed re-read keeps the last good folders", async () => {
    const state = { filters: [ dialogFilter({ includePeers: [ user(500) ] }) ] as unknown[], fail: new Set<string>() };
    const tg = fakeTelegram(state);
    const { filter } = makeFilter(tg);
    assert.equal((await filter.decide(dm(500))).admit, true);

    state.fail.add("messages.GetDialogFilters");
    filter.handleUpdate({ className: "UpdateDialogFilters" });
    assert.equal((await filter.decide(dm(500))).admit, true);
  });

  it("a chat lookup that fails skips the message and says why", async () => {
    const tg = fakeTelegram({ filters: [ dialogFilter({ groups: true, excludeArchived: true }) ], fail: new Set([ "messages.GetPeerDialogs" ]) });
    const { filter, warnings } = makeFilter(tg);
    assert.deepEqual(await filter.decide(groupMsg(4242)), { admit: false, reason: "lookup-failed" });
    assert.equal(warnings.at(-1)[ 1 ].step, "getPeerDialogs");
  });

  it("a chat with no input peer in the session is a failed lookup too", async () => {
    const tg = fakeTelegram({ filters: [ dialogFilter({ groups: true, excludeArchived: true }) ] });
    const { filter } = makeFilter(tg, { resolveInputPeer: async () => undefined });
    assert.deepEqual(await filter.decide(groupMsg(4242)), { admit: false, reason: "lookup-failed" });
    assert.equal(tg.calls.includes("messages.GetPeerDialogs"), false);
  });

  it("a lookup that hangs gives up instead of holding the message", async () => {
    const tg = fakeTelegram({ filters: [ dialogFilter({ groups: true, excludeArchived: true }) ] });
    const hanging = async (request: any) => request.className === "messages.GetPeerDialogs" ? new Promise(() => {}) : tg.invoke(request);
    const { filter } = makeFilter(tg, { invoke: hanging, lookupTimeoutMs: 20 });
    assert.deepEqual(await filter.decide(groupMsg(4242)), { admit: false, reason: "lookup-failed" });
  });
});

/**
 * Through the real entrance: where the gate sits and what it saves.
 */
describe("the folder gate in the inbound pipeline", () => {
  const PEER = "500000001";

  function context(opts: { gate?: any; account?: Record<string, unknown> } = {}) {
    const touched: string[] = [];
    const logged: Array<[ string, any ]> = [];
    const dispatched: string[] = [];
    const ctx: any = {
      accountId: "default",
      cfg: {
        channels: { clawgram: { accounts: { default: {
          allowFrom: [ "@someone", PEER ],
          groups: { "-4242": { enabled: true, groupPolicy: "open", allowFrom: [ "*" ] } },
          ...opts.account,
        } } } },
      },
      channelRuntime: {
        reply: Object.assign(() => {}, {
          resolveEnvelopeFormatOptions: () => ({}),
          formatAgentEnvelope: ({ body }: { body: string }) => body,
          finalizeInboundContext: (x: unknown) => x,
          dispatchReplyWithBufferedBlockDispatcher: async () => {
            dispatched.push("dispatch");
            return { queuedFinal: false, counts: { final: 0 } };
          },
        }),
        session: {
          get: () => undefined,
          set: () => {},
          resolveStorePath: () => path.join(__dirname, "..", "..", "dist-test", "probe-store"),
          readSessionUpdatedAt: () => undefined,
          recordInboundSession: async () => {},
        },
        commands: {
          list: () => [],
          shouldComputeCommandAuthorized: () => false,
          resolveCommandAuthorizedFromAuthorizers: () => false,
        },
        routing: {
          resolveAgentRoute: () => ({
            agentId: "main", accountId: "default", matchedBy: "default",
            sessionKey: `agent:main:clawgram:direct:default:${PEER}`,
          }),
        },
      },
      client: new Proxy({}, {
        get: (_t, k) => {
          if (typeof k !== "string") return undefined;
          touched.push(k);
          return async () => ({ firstName: "Вася", username: "someone" });
        },
      }),
      gram: {
        sendText: async () => ({ id: 1 }),
        withTyping: async (_t: unknown, fn: () => unknown) => fn(),
        replyParseMode: undefined,
      },
      inboundFolders: opts.gate,
      log: {
        info: (m: string, meta: any) => { logged.push([ m, meta ]); },
        warn: () => {}, error: () => {},
      },
      pluginRuntime: undefined,
      runtimes: new Map(),
      selfId: "777",
      selfLabel: "@agent",
      selfUsername: "agent",
    };
    return { ctx, touched, logged, dispatched };
  }

  const gate = (admit: boolean, asked: unknown[] = []) => ({
    decide: async (query: unknown) => { asked.push(query); return admit ? { admit, reason: "include", folderId: 2 } : { admit, reason: "not-in-folder" }; },
  });
  const dmEvent = { message: { id: 8, peerId: { userId: Number(PEER) }, senderId: Number(PEER), message: "привет" } };
  const groupEvent = { message: { id: 9, peerId: { chatId: 4242 }, senderId: 500, message: "статус?" } };

  it("a DM outside the folders is skipped before the sender profile is fetched, and the skip is logged", async () => {
    const asked: any[] = [];
    const turn = context({ gate: gate(false, asked) });
    await handleInboundEvent(dmEvent, turn.ctx);
    assert.equal(asked.length, 1);
    assert.equal(asked[ 0 ].chatId, PEER);
    assert.equal(asked[ 0 ].chatType, "direct");
    assert.deepEqual(turn.touched, [], `a skipped message touched the client: ${turn.touched.join(", ")}`);
    assert.deepEqual(turn.dispatched, []);
    const skip = turn.logged.find(([ m ]) => m === "clawgram skipping inbound outside inboundFolders");
    assert.ok(skip, "the skip is not logged");
    assert.deepEqual(skip[ 1 ], { accountId: "default", chatId: PEER, messageId: "8", reason: "not-in-folder" });
  });

  it("a DM inside the folders goes on exactly as before", async () => {
    const turn = context({ gate: gate(true) });
    await handleInboundEvent(dmEvent, turn.ctx);
    assert.ok(turn.touched.includes("getEntity"), "the @handle allowFrom lookup should still run after the gate");
    assert.deepEqual(turn.dispatched, [ "dispatch" ]);
  });

  it("a configured group outside the folders is skipped; a group outside `groups` never reaches the gate", async () => {
    const asked: any[] = [];
    const turn = context({ gate: gate(false, asked) });
    await handleInboundEvent(groupEvent, turn.ctx);
    assert.equal(asked.length, 1);
    assert.equal(asked[ 0 ].chatType, "group");
    assert.deepEqual(turn.dispatched, []);

    const foreign = { message: { id: 10, peerId: { chatId: 9999 }, senderId: 500, message: "статус?" } };
    await handleInboundEvent(foreign, turn.ctx);
    assert.equal(asked.length, 1, "the folders cannot widen `groups`, so they are not asked");
  });

  it("the folders never widen allowFrom: an admitted chat from a blocked sender is still blocked", async () => {
    const turn = context({ gate: gate(true), account: { allowFrom: [ "999" ] } });
    await handleInboundEvent(dmEvent, turn.ctx);
    assert.deepEqual(turn.dispatched, []);
  });

  it("outgoing messages and channel posts are not asked about", async () => {
    const asked: any[] = [];
    const turn = context({ gate: gate(true, asked) });
    await handleInboundEvent({ message: { id: 1, out: true, peerId: { userId: 5 }, message: "x" } }, turn.ctx);
    await handleInboundEvent({ message: { id: 2, post: true, peerId: { channelId: 77 }, message: "x" } }, turn.ctx);
    assert.deepEqual(asked, []);
  });

  it("without inboundFolders nothing changes", async () => {
    const turn = context({ gate: undefined });
    await handleInboundEvent(dmEvent, turn.ctx);
    assert.deepEqual(turn.dispatched, [ "dispatch" ]);
    assert.equal(turn.logged.some(([ m ]) => m.includes("inboundFolders")), false);
  });

  it("the channel builds the filter from the config and follows folder updates on the raw stream", () => {
    const src = readFileSync(path.resolve(__dirname, "..", "..", "src", "channel.ts"), "utf8");
    assert.match(src, /createInboundFolderFilter\(\{ cfg, accountId, client, log, selfId \}\)/);
    assert.match(src, /client\.addEventHandler\(folderEventHandler, folderEventBuilder\)/);
    assert.match(src, /client\.removeEventHandler\(folderEventHandler, folderEventBuilder\)/);
    assert.match(src, /inboundFolders\.stop\(\)/);
  });
});
