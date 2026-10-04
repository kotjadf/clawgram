import { strict as assert } from "node:assert";
import path from "node:path";
import { describe, it } from "node:test";

import { resolveAgentRoute } from "openclaw/plugin-sdk/routing";

import { readAccountRecordOutgoing } from "../src/helpers";
import { handleInboundEvent } from "../src/inbound-pipeline";
import { OwnSendTracker } from "../src/own-sends";

/**
 * `recordOutgoing`: what the owner writes from their own Telegram goes into
 * the session the other side's messages go to, as a silent room event, so an
 * inbox holds both sides of a conversation. Three things have to hold:
 *
 * - **the same session** — the session key of the owner's message to a
 *   contact is the key of that contact's message to the owner, by core's own
 *   router, not by a fake that would agree with anything;
 * - **the conversation's gates** — allowFrom, ignoreBots and inboundFolders
 *   judge the peer, since the sender is always the owner;
 * - **no output** — nothing the turn produces reaches the chat.
 */

const PEER = "500000001";
const OTHER = "500000009";
const SELF = "777";

function setup(account: Record<string, unknown> = {}, over: Record<string, any> = {}) {
  const contexts: any[] = [];
  const dispatched: string[] = [];
  const sent: string[] = [];
  const typed: unknown[] = [];
  const logged: Array<[ string, any ]> = [];
  const touched: string[] = [];
  const cfg = {
    session: { dmScope: "per-channel-peer" },
    agents: { list: [ { id: "main", default: true }, { id: "inbox" } ] },
    bindings: [ { agentId: "inbox", match: { channel: "clawgram" } } ],
    channels: { clawgram: { accounts: { default: {
      allowFrom: [ "*" ],
      groups: {
        "-4242": { enabled: true, groupPolicy: "open", allowFrom: [ "*" ] },
        "-4343": { enabled: true, groupPolicy: "mention", allowFrom: [ "*" ] },
      },
      recordOutgoing: true,
      ...account,
    } } } },
  };
  const ctx: any = {
    accountId: "default",
    cfg,
    channelRuntime: {
      reply: Object.assign(() => {}, {
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        finalizeInboundContext: (x: any) => { contexts.push(x); return x; },
        dispatchReplyWithBufferedBlockDispatcher: async (args: any) => {
          dispatched.push("dispatch");
          // A model that ignores the room-event rule and answers in words.
          await args.dispatcherOptions.deliver({ text: "Принято!" });
          return { queuedFinal: true, counts: { final: 1 } };
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
      // Core's own router: the claim is about the key it produces.
      routing: { resolveAgentRoute },
    },
    client: new Proxy({}, {
      get: (_t, k) => {
        if (typeof k !== "string") return undefined;
        touched.push(k);
        return async () => undefined;
      },
    }),
    gram: {
      sendText: async (args: { text: string }) => { sent.push(args.text); return { id: 1 }; },
      withTyping: async (_t: unknown, fn: () => unknown, options: unknown) => { typed.push(options); return fn(); },
      replyParseMode: undefined,
      isOwnSend: async () => false,
      ...over.gram,
    },
    inboundFolders: over.inboundFolders,
    log: {
      info: (m: string, meta: any) => { logged.push([ m, meta ]); },
      warn: () => {}, error: () => {},
    },
    pluginRuntime: undefined,
    runtimes: new Map(),
    selfId: SELF,
    selfLabel: "@owner",
    selfUsername: "owner",
  };
  return { ctx, contexts, dispatched, sent, typed, logged, touched };
}

const VASYA = { className: "User", id: PEER, firstName: "Вася", username: "vasya" };
const inboundDm = (peer = PEER) => ({ message: {
  id: 8, peerId: { userId: Number(peer) }, senderId: Number(peer), message: "Привет, ты где?",
  sender: { firstName: "Вася", username: "vasya" },
} });
const outgoingDm = (extra: Record<string, unknown> = {}, peer = PEER) => ({ message: {
  id: 9, out: true, peerId: { userId: Number(peer) }, senderId: Number(SELF), message: "Буду через час",
  _sender: { className: "User", id: SELF, firstName: "Owner" }, _chat: { ...VASYA, id: peer }, ...extra,
} });
const inboundGroup = (chat = 4242) => ({ message: {
  id: 11, peerId: { chatId: chat }, senderId: Number(PEER), message: "Кто идёт?",
  sender: { firstName: "Вася", username: "vasya" },
} });
const outgoingGroup = (chat = 4242) => ({ message: {
  id: 12, out: true, peerId: { chatId: chat }, senderId: Number(SELF), message: "Я иду",
  _sender: { className: "User", id: SELF, firstName: "Owner" },
} });
const skipReason = (logged: Array<[ string, any ]>) =>
  logged.find(([ m ]) => m === "clawgram not recording outgoing message")?.[ 1 ]?.reason;

describe("readAccountRecordOutgoing", () => {
  const cfg = (account: Record<string, unknown>) => ({ channels: { clawgram: { accounts: { default: account } } } });

  it("is off unless the account sets it to true", () => {
    assert.equal(readAccountRecordOutgoing(cfg({}), "default"), false);
    assert.equal(readAccountRecordOutgoing(cfg({ recordOutgoing: 1 }), "default"), false);
    assert.equal(readAccountRecordOutgoing(cfg({ recordOutgoing: true }), "default"), true);
  });
});

describe("the owner's message lands in the contact's session", () => {
  it("a direct message: the same session key as the contact's own messages, by core's router", async () => {
    const inbound = setup();
    await handleInboundEvent(inboundDm(), inbound.ctx);
    const outgoing = setup();
    await handleInboundEvent(outgoingDm(), outgoing.ctx);

    assert.equal(inbound.contexts.length, 1);
    assert.equal(outgoing.contexts.length, 1, "the owner's message never reached core");
    const key = inbound.contexts[ 0 ].SessionKey;
    assert.match(key, new RegExp(`^agent:inbox:.*${PEER}$`), `unexpected key ${key}`);
    assert.equal(outgoing.contexts[ 0 ].SessionKey, key);

    const other = setup();
    await handleInboundEvent(outgoingDm({}, OTHER), other.ctx);
    assert.notEqual(other.contexts[ 0 ].SessionKey, key, "a different contact must get a different session");
  });

  it("a direct message carries everything an inbound one from that peer would — and the owner as the speaker", async () => {
    const inbound = setup();
    await handleInboundEvent(inboundDm(), inbound.ctx);
    const outgoing = setup();
    await handleInboundEvent(outgoingDm(), outgoing.ctx);
    const i = inbound.contexts[ 0 ];
    const o = outgoing.contexts[ 0 ];
    for (const field of [ "From", "To", "OriginatingChannel", "OriginatingTo", "ConversationLabel", "ChatType", "AccountId" ]) {
      assert.equal(o[ field ], i[ field ], `${field} differs between the two sides`);
    }
    assert.equal(o.InboundEventKind, "room_event");
    assert.equal(o.AmbientTranscriptBody, "#9 @owner (owner): Буду через час");
    assert.equal(o.SenderName, "@owner (owner)");
    assert.equal(o.SenderId, undefined, "the owner's id must not make the turn owner-authorized");
    assert.equal(o.CommandAuthorized, false);
    assert.equal(o.CommandInterpretationSuppressed, true);
  });

  it("a group message: the same session key as the group's other messages", async () => {
    const inbound = setup();
    await handleInboundEvent(inboundGroup(), inbound.ctx);
    const outgoing = setup();
    await handleInboundEvent(outgoingGroup(), outgoing.ctx);
    assert.equal(outgoing.contexts.length, 1, "the owner's group message never reached core");
    assert.equal(outgoing.contexts[ 0 ].SessionKey, inbound.contexts[ 0 ].SessionKey);
    assert.equal(outgoing.contexts[ 0 ].InboundEventKind, "room_event");
    assert.equal(outgoing.contexts[ 0 ].AmbientTranscriptBody, "#12 @owner (owner): Я иду");
    assert.equal(outgoing.contexts[ 0 ].OriginatingTo, inbound.contexts[ 0 ].OriginatingTo);
  });
});

describe("nothing goes out", () => {
  it("whatever the turn produces, the chat receives nothing and sees no typing or read receipt", async () => {
    for (const event of [ outgoingDm(), outgoingGroup() ]) {
      const t = setup();
      await handleInboundEvent(event, t.ctx);
      assert.deepEqual(t.dispatched, [ "dispatch" ], "the turn never ran — the test proves nothing");
      assert.deepEqual(t.sent, []);
      assert.deepEqual(t.typed, []);
      assert.ok(t.logged.some(([ m ]) => m === "clawgram suppressing room-event delivery"));
    }
  });
});

describe("the gates judge the conversation", () => {
  it("off by default: the owner's message is skipped exactly as before", async () => {
    const t = setup({ recordOutgoing: undefined });
    await handleInboundEvent(outgoingDm(), t.ctx);
    assert.deepEqual(t.contexts, []);
    assert.ok(t.logged.some(([ m ]) => m === "clawgram skipping outgoing direct event"));
    const g = setup({ recordOutgoing: undefined });
    await handleInboundEvent(outgoingGroup(), g.ctx);
    assert.deepEqual(g.contexts, []);
  });

  it("a peer allowFrom does not admit is not recorded, and costs no call", async () => {
    const t = setup({ allowFrom: [ OTHER ] });
    await handleInboundEvent(outgoingDm({ _chat: undefined }), t.ctx);
    assert.deepEqual(t.contexts, []);
    assert.equal(skipReason(t.logged), "peer-not-in-allowFrom");
    assert.deepEqual(t.touched, []);
  });

  it("allowFrom by handle matches the peer's handle, not the owner's", async () => {
    const admitted = setup({ allowFrom: [ "@vasya" ] });
    await handleInboundEvent(outgoingDm(), admitted.ctx);
    assert.equal(admitted.contexts.length, 1);

    const ownHandle = setup({ allowFrom: [ "@owner" ] });
    await handleInboundEvent(outgoingDm(), ownHandle.ctx);
    assert.deepEqual(ownHandle.contexts, []);
  });

  it("under ignoreBots a conversation with a bot is not recorded; the owner being a person does not matter", async () => {
    const bot = setup({ ignoreBots: true });
    await handleInboundEvent(outgoingDm({ _chat: { ...VASYA, bot: true } }), bot.ctx);
    assert.deepEqual(bot.contexts, []);
    assert.equal(skipReason(bot.logged), "peer-is-bot");

    const person = setup({ ignoreBots: true });
    await handleInboundEvent(outgoingDm(), person.ctx);
    assert.equal(person.contexts.length, 1);

    const uncached = setup({ ignoreBots: true });
    await handleInboundEvent(outgoingDm({ _chat: undefined, getChat: async () => ({ ...VASYA, bot: true }) }), uncached.ctx);
    assert.deepEqual(uncached.contexts, [], "an uncached bot peer should be found through getChat");
  });

  it("inboundFolders is asked about the peer's chat", async () => {
    const asked: any[] = [];
    const t = setup({}, { inboundFolders: { decide: async (q: any) => { asked.push(q); return { admit: false, reason: "not-in-folder" }; } } });
    await handleInboundEvent(outgoingDm(), t.ctx);
    assert.deepEqual(asked.map((q) => [ q.chatId, q.chatType ]), [ [ PEER, "direct" ] ]);
    assert.deepEqual(t.contexts, []);
    assert.equal(skipReason(t.logged), "outside-inboundFolders:not-in-folder");

    const g = setup({}, { inboundFolders: { decide: async (q: any) => { asked.push(q); return { admit: true, reason: "include" }; } } });
    await handleInboundEvent(outgoingGroup(), g.ctx);
    assert.equal(asked.at(-1).chatId, "-4242");
    assert.equal(g.contexts.length, 1);
  });

  it("a group is recorded only when configured, enabled and open", async () => {
    const mention = setup();
    await handleInboundEvent(outgoingGroup(4343), mention.ctx);
    assert.deepEqual(mention.contexts, []);
    assert.equal(skipReason(mention.logged), "group-not-open");

    const foreign = setup();
    await handleInboundEvent(outgoingGroup(9999), foreign.ctx);
    assert.equal(skipReason(foreign.logged), "group-not-configured");

    const disabled = setup({ groups: { "-4242": { enabled: false, groupPolicy: "open" } } });
    await handleInboundEvent(outgoingGroup(), disabled.ctx);
    assert.equal(skipReason(disabled.logged), "group-disabled");
  });

  it("Saved Messages and the Telegram service chat are never recorded", async () => {
    const saved = setup();
    await handleInboundEvent(outgoingDm({}, SELF), saved.ctx);
    assert.equal(skipReason(saved.logged), "saved-messages");
    const service = setup();
    await handleInboundEvent(outgoingDm({}, "777000"), service.ctx);
    assert.equal(skipReason(service.logged), "service-chat");
  });

  it("the agent's own sends are not recorded as the owner's words", async () => {
    const asked: Array<[ string, string ]> = [];
    const t = setup({}, { gram: { isOwnSend: async (chatId: string, messageId: string) => { asked.push([ chatId, messageId ]); return true; } } });
    await handleInboundEvent(outgoingDm(), t.ctx);
    assert.deepEqual(asked, [ [ PEER, "9" ] ]);
    assert.deepEqual(t.contexts, []);
    assert.equal(skipReason(t.logged), "own-send");
  });
});

describe("OwnSendTracker", () => {
  it("remembers what a send produced, an album included", async () => {
    const tracker = new OwnSendTracker();
    await tracker.track(async () => ({ id: 41, chatId: PEER }));
    await tracker.track(async () => [ { id: 42, chatId: "-4242" }, { id: 43, chatId: "-4242" } ]);
    assert.equal(await tracker.isOwnSend(PEER, "41"), true);
    assert.equal(await tracker.isOwnSend("-4242", "43"), true);
    assert.equal(await tracker.isOwnSend(PEER, "42"), false, "same id in another chat is someone else's");
    assert.equal(await tracker.isOwnSend(PEER, "44"), false);
  });

  it("an update that overtakes its send waits for the send to finish", async () => {
    const tracker = new OwnSendTracker();
    let finish!: () => void;
    const sending = tracker.track(() => new Promise<{ id: number; chatId: string }>((resolve) => {
      finish = () => resolve({ id: 50, chatId: PEER });
    }));
    const verdict = tracker.isOwnSend(PEER, "50", 5_000);
    setTimeout(() => finish(), 20);
    assert.equal(await verdict, true);
    await sending;
  });

  it("a send that fails or hangs does not hold the answer forever", async () => {
    const tracker = new OwnSendTracker();
    await assert.rejects(tracker.track(async () => { throw new Error("FLOOD_WAIT"); }));
    assert.equal(await tracker.isOwnSend(PEER, "1"), false);
    void tracker.track(() => new Promise(() => {}));
    const started = Date.now();
    assert.equal(await tracker.isOwnSend(PEER, "1", 30), false);
    assert.ok(Date.now() - started < 1000);
  });
});
