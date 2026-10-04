import { strict as assert } from "node:assert";
import path from "node:path";
import { describe, it } from "node:test";

import { isBotSender, readAccountIgnoreBots } from "../src/helpers";
import { handleInboundEvent } from "../src/inbound-pipeline";

/**
 * `ignoreBots`: a person's own account receives a bot's messages like anyone
 * else's — notifications, and the owner's own control bot answering them.
 * Read as an inbox, each is a turn spent on a message no person wrote. With
 * the setting on they stop after the gates that cost nothing; a sender that
 * cannot be looked up is taken for a person, because losing a person's
 * message is the worse mistake.
 */

describe("isBotSender", () => {
  it("the sender GramJS already holds answers, without a lookup", async () => {
    let asked = 0;
    const getSender = async () => { asked += 1; return { bot: false }; };
    assert.equal(await isBotSender({ _sender: { bot: true }, getSender }), true);
    assert.equal(await isBotSender({ sender: { bot: true }, getSender }), true);
    assert.equal(await isBotSender({ _sender: { bot: false, firstName: "Вася" }, getSender }), false);
    assert.equal(await isBotSender({ sender: { firstName: "Вася" }, getSender }), false);
    assert.equal(asked, 0, "a cached sender should not be looked up again");
  });

  it("without a cached sender, getSender decides", async () => {
    assert.equal(await isBotSender({ getSender: async () => ({ bot: true }) }), true);
    assert.equal(await isBotSender({ getSender: async () => ({ bot: false }) }), false);
  });

  it("a lookup that fails, throws, returns nothing or is missing counts as a person", async () => {
    assert.equal(await isBotSender({ getSender: async () => { throw new Error("FLOOD_WAIT"); } }), false);
    assert.equal(await isBotSender({ getSender: () => { throw new Error("sync"); } }), false);
    assert.equal(await isBotSender({ getSender: async () => undefined }), false);
    assert.equal(await isBotSender({}), false);
    assert.equal(await isBotSender(undefined), false);
  });

  it("a lookup that hangs gives up and counts as a person", async () => {
    const started = Date.now();
    const result = await isBotSender({ getSender: () => new Promise(() => {}) }, 50);
    assert.equal(result, false);
    assert.ok(Date.now() - started < 1000, "the lookup should have been abandoned at its timeout");
  });

  it("a lookup that rejects after the timeout leaves no unhandled rejection", async () => {
    const result = await isBotSender({
      getSender: () => new Promise((_resolve, reject) => setTimeout(() => reject(new Error("late")), 30)),
    }, 5);
    assert.equal(result, false);
    await new Promise((r) => setTimeout(r, 60));
  });
});

describe("readAccountIgnoreBots", () => {
  const cfg = (account: Record<string, unknown>) => ({ channels: { clawgram: { accounts: { default: account } } } });

  it("is off unless the account sets it to true", () => {
    assert.equal(readAccountIgnoreBots(cfg({}), "default"), false);
    assert.equal(readAccountIgnoreBots(cfg({ ignoreBots: false }), "default"), false);
    assert.equal(readAccountIgnoreBots(cfg({ ignoreBots: "true" }), "default"), false);
    assert.equal(readAccountIgnoreBots(cfg({ ignoreBots: true }), "default"), true);
    assert.equal(readAccountIgnoreBots(undefined, "default"), false);
  });
});

describe("the bot gate in the inbound pipeline", () => {
  const PEER = "500000001";

  function context(account: Record<string, unknown> = {}, gate?: { asked: unknown[] }) {
    const touched: string[] = [];
    const logged: Array<[ string, any ]> = [];
    const dispatched: string[] = [];
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
          return async () => undefined;
        },
      }),
      gram: {
        sendText: async () => ({ id: 1 }),
        withTyping: async (_t: unknown, fn: () => unknown) => fn(),
        replyParseMode: undefined,
      },
      inboundFolders: gate
        ? { decide: async (q: unknown) => { gate.asked.push(q); return { admit: true, reason: "include", folderId: 2 }; } }
        : undefined,
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

  const dm = (sender: Record<string, unknown> | undefined, extra: Record<string, unknown> = {}) =>
    ({ message: { id: 8, peerId: { userId: Number(PEER) }, senderId: Number(PEER), message: "привет", _sender: sender, ...extra } });
  const group = (sender: Record<string, unknown>) =>
    ({ message: { id: 9, peerId: { chatId: 4242 }, senderId: 500000002, message: "статус?", _sender: sender } });
  const BOT = { bot: true, firstName: "Control", username: "control_bot" };
  const PERSON = { bot: false, firstName: "Вася", username: "vasya" };

  it("a bot's DM is skipped before the folder filter and the client, and the skip is logged", async () => {
    const gate = { asked: [] as unknown[] };
    const turn = context({ ignoreBots: true }, gate);
    await handleInboundEvent(dm(BOT), turn.ctx);
    assert.deepEqual(turn.dispatched, []);
    assert.deepEqual(gate.asked, [], "the folder filter should not be asked about a bot");
    assert.deepEqual(turn.touched, [], `a skipped bot message touched the client: ${turn.touched.join(", ")}`);
    const skip = turn.logged.find(([ m ]) => m === "clawgram skipping bot sender");
    assert.ok(skip, "the skip is not logged");
    assert.deepEqual(skip[ 1 ], { accountId: "default", chatId: PEER, messageId: "8", senderId: PEER });
  });

  it("a bot's message in a configured group is skipped too", async () => {
    const turn = context({ ignoreBots: true });
    await handleInboundEvent(group(BOT), turn.ctx);
    assert.deepEqual(turn.dispatched, []);
    assert.ok(turn.logged.some(([ m ]) => m === "clawgram skipping bot sender"));
  });

  it("a person's DM goes on exactly as before", async () => {
    const turn = context({ ignoreBots: true });
    await handleInboundEvent(dm(PERSON), turn.ctx);
    assert.deepEqual(turn.dispatched, [ "dispatch" ]);
    assert.equal(turn.logged.some(([ m ]) => m === "clawgram skipping bot sender"), false);
  });

  it("a sender that cannot be looked up is taken for a person", async () => {
    const turn = context({ ignoreBots: true });
    await handleInboundEvent(dm(undefined, { getSender: async () => { throw new Error("FLOOD_WAIT"); } }), turn.ctx);
    assert.deepEqual(turn.dispatched, [ "dispatch" ]);
  });

  it("an uncached bot is found through getSender", async () => {
    const turn = context({ ignoreBots: true });
    await handleInboundEvent(dm(undefined, { getSender: async () => BOT }), turn.ctx);
    assert.deepEqual(turn.dispatched, []);
    assert.ok(turn.logged.some(([ m ]) => m === "clawgram skipping bot sender"));
  });

  it("without ignoreBots a bot is handled like anyone else", async () => {
    const turn = context({});
    await handleInboundEvent(dm(BOT), turn.ctx);
    assert.deepEqual(turn.dispatched, [ "dispatch" ]);
    assert.equal(turn.logged.some(([ m ]) => m === "clawgram skipping bot sender"), false);
  });
});
