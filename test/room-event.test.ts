import { strict as assert } from "node:assert";
import path from "node:path";
import { describe, it } from "node:test";

import { readAccountInboundAsRoomEvent } from "../src/helpers";
import { handleInboundEvent } from "../src/inbound-pipeline";
import { ownerSpeaker, roomEventContext, roomEventLine } from "../src/room-event";

/**
 * `inboundAsRoomEvent`: a person's account read by an agent as an inbox,
 * where silence is the usual outcome. Core treats a DM as a turn that owes a
 * reply — a silent model then ends in "empty response" or core's own
 * "produced no usable reply" notice. As a room event the turn is optional,
 * its final text private, and only the `message` tool speaks. The channel
 * must then put nothing into the chat on the turn's behalf: no delivered
 * text, no typing, no transcript fallback, no reaction.
 */

const PEER = "500000001";

describe("the room-event fields", () => {
  it("record the event as `#id speaker: text`", () => {
    assert.equal(roomEventLine({ messageId: "8", speaker: "Вася", text: "привет" }), "#8 Вася: привет");
    assert.equal(roomEventLine({ messageId: "8", speaker: undefined, text: "привет" }), "#8: привет");
    assert.equal(roomEventLine({ messageId: "", speaker: " ", text: "привет" }), "привет");
  });

  it("make the turn a room event in which no command is interpreted", () => {
    assert.deepEqual(roomEventContext({ messageId: "8", speaker: "Вася", text: "/reset" }), {
      InboundEventKind: "room_event",
      AmbientTranscriptBody: "#8 Вася: /reset",
      CommandAuthorized: false,
      CommandInterpretationSuppressed: true,
    });
  });

  it("name the owner as the owner", () => {
    assert.equal(ownerSpeaker("@owner"), "@owner (owner)");
    assert.equal(ownerSpeaker(undefined), "owner");
  });
});

describe("readAccountInboundAsRoomEvent", () => {
  const cfg = (account: Record<string, unknown>) => ({ channels: { clawgram: { accounts: { default: account } } } });

  it("is off unless the account sets it to true", () => {
    assert.equal(readAccountInboundAsRoomEvent(cfg({}), "default"), false);
    assert.equal(readAccountInboundAsRoomEvent(cfg({ inboundAsRoomEvent: "true" }), "default"), false);
    assert.equal(readAccountInboundAsRoomEvent(cfg({ inboundAsRoomEvent: true }), "default"), true);
    assert.equal(readAccountInboundAsRoomEvent(undefined, "default"), false);
  });
});

function turn(kind: "dm" | "group", account: Record<string, unknown>, opts: { text?: string; reply?: string } = {}) {
  const contexts: any[] = [];
  const sent: string[] = [];
  const shown: Array<Record<string, unknown>> = [];
  const reacted: unknown[] = [];
  const ctx: any = {
    accountId: "default",
    cfg: {
      channels: { clawgram: { accounts: { default: {
        allowFrom: [ PEER ],
        groups: { "-4242": { enabled: true, groupPolicy: "open", allowFrom: [ "*" ] } },
        ...account,
      } } } },
    },
    channelRuntime: {
      reply: Object.assign(() => {}, {
        resolveEnvelopeFormatOptions: () => ({}),
        formatAgentEnvelope: ({ body }: { body: string }) => body,
        finalizeInboundContext: (x: any) => { contexts.push(x); return x; },
        dispatchReplyWithBufferedBlockDispatcher: async (args: any) => {
          // The engine answers in words, the way a model that ignored the
          // room-event rule would; the channel must not carry them out.
          if (opts.reply) {
            await args.dispatcherOptions.deliver({ text: opts.reply });
            return { queuedFinal: true, counts: { final: 1 } };
          }
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
        shouldComputeCommandAuthorized: () => true,
        resolveCommandAuthorizedFromAuthorizers: () => true,
      },
      routing: {
        resolveAgentRoute: ({ peer }: any) => ({
          agentId: "inbox", accountId: "default", matchedBy: "binding.channel",
          sessionKey: `agent:inbox:clawgram:${peer.kind}:${peer.id}`,
        }),
      },
    },
    client: new Proxy({}, { get: () => async () => undefined }),
    gram: {
      sendText: async (args: { text: string }) => { sent.push(args.text); return { id: 1 }; },
      sendReaction: async (args: unknown) => { reacted.push(args); },
      withTyping: async (_t: unknown, fn: () => unknown, options: Record<string, unknown>) => {
        shown.push(options);
        return fn();
      },
      replyParseMode: undefined,
    },
    inboundFolders: undefined,
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pluginRuntime: { llm: { complete: async () => ({ text: "👍" }) } },
    runtimes: new Map(),
    selfId: "777",
    selfLabel: "@agent",
    selfUsername: "agent",
  };
  ctx.runtimes.set("default", ctx.gram);
  const text = opts.text ?? "привет";
  const message = kind === "dm"
    ? { id: 8, peerId: { userId: Number(PEER) }, senderId: Number(PEER), message: text }
    : { id: 11, peerId: { chatId: 4242 }, senderId: 500, message: text };
  const event = { message: { ...message, sender: { firstName: "Вася", username: "vasya" } } };
  return { run: () => handleInboundEvent(event, ctx), contexts, sent, shown, reacted };
}

describe("a direct message as a room event", () => {
  it("reaches core as a room event, recorded as `#id sender: text`, with commands off", async () => {
    const t = turn("dm", { inboundAsRoomEvent: true });
    await t.run();
    assert.equal(t.contexts.length, 1, "the DM never reached core");
    const c = t.contexts[ 0 ];
    assert.equal(c.InboundEventKind, "room_event");
    assert.equal(c.AmbientTranscriptBody, "#8 Вася: привет");
    assert.equal(c.CommandAuthorized, false);
    assert.equal(c.CommandInterpretationSuppressed, true);
    assert.equal(c.SessionKey, `agent:inbox:clawgram:direct:${PEER}`);
    assert.equal(c.OriginatingTo, PEER, "a `message` send must still find this conversation");
  });

  it("puts nothing into the chat: no delivered text, no typing", async () => {
    const t = turn("dm", { inboundAsRoomEvent: true }, { reply: "Сейчас отвечу!" });
    await t.run();
    assert.deepEqual(t.sent, []);
    assert.deepEqual(t.shown.map((o) => o.typing), [ false ]);
  });

  it("still honours readReceipts", async () => {
    const quiet = turn("dm", { inboundAsRoomEvent: true, readReceipts: false });
    await quiet.run();
    assert.deepEqual(quiet.shown.map((o) => o.read), [ false ]);
    const read = turn("dm", { inboundAsRoomEvent: true });
    await read.run();
    assert.deepEqual(read.shown.map((o) => o.read), [ true ]);
  });

  it("without the setting the DM is an ordinary turn, as before", async () => {
    const t = turn("dm", {}, { reply: "Сейчас отвечу!" });
    await t.run();
    assert.equal(t.contexts[ 0 ].InboundEventKind, undefined);
    assert.equal(t.contexts[ 0 ].AmbientTranscriptBody, undefined);
    assert.deepEqual(t.sent, [ "Сейчас отвечу!" ]);
    assert.deepEqual(t.shown.map((o) => o.typing), [ true ]);
  });
});

describe("a group message as a room event", () => {
  it("reaches core as a room event under the sender's address", async () => {
    const t = turn("group", { inboundAsRoomEvent: true });
    await t.run();
    const c = t.contexts[ 0 ];
    assert.equal(c.InboundEventKind, "room_event");
    assert.equal(c.AmbientTranscriptBody, "#11 @vasya: привет");
    assert.equal(c.CommandInterpretationSuppressed, true);
  });

  it("puts nothing into the chat even when addressed: no text, typing, fallback or reaction", async () => {
    const answered = turn("group", { inboundAsRoomEvent: true }, { text: "@agent статус?", reply: "Всё работает" });
    await answered.run();
    assert.deepEqual(answered.sent, []);
    assert.deepEqual(answered.shown.map((o) => o.typing), [ false ]);

    const silent = turn("group", { inboundAsRoomEvent: true }, { text: "@agent статус?" });
    await silent.run();
    assert.deepEqual(silent.sent, []);
    assert.deepEqual(silent.reacted, [], "a silent room event must not leave a reaction");
  });

  it("without the setting an addressed group message is answered, as before", async () => {
    const t = turn("group", {}, { text: "@agent статус?", reply: "Всё работает" });
    await t.run();
    assert.equal(t.contexts[ 0 ].InboundEventKind, undefined);
    assert.equal(t.sent.length, 1);
    assert.deepEqual(t.shown.map((o) => o.typing), [ true ]);
  });
});
