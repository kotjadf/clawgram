import assert from "node:assert/strict";
import { describe, it } from "node:test";

import plugin from "../src/index";
import { createChannelPlugin } from "../src/channel";
import { FOLDERS_GATEWAY_METHOD, FOLDERS_GATEWAY_SCOPE, createFoldersGatewayHandler } from "../src/folders-gateway";
import type { RuntimeMap } from "../src/types";

/**
 * `clawgram.folders` — the folder list as a gateway method of its own.
 *
 * `message.action` refuses an action core has no name for before the channel
 * is asked, so the `folders` action was unreachable from outside: the panel's
 * folder picker got "Message action folders not supported for channel
 * clawgram". The method answers what the action answers, reads the config as
 * it is when called, and tells an account the config does not name apart from
 * one that is configured but not connected.
 */

const work = { className: "DialogFilter", id: 2, title: { text: "❤️ Inbox" }, emoticon: "❤", contacts: true, includePeers: [], pinnedPeers: [], excludePeers: [] };
const shared = { className: "DialogFilterChatlist", id: 5, title: "Project", includePeers: [], pinnedPeers: [] };

type Answer = { ok: boolean; payload?: any; error?: { code: string; message: string } };

const call = async (handler: (opts: any) => Promise<void>, params: unknown): Promise<Answer> => {
  let answer: Answer | undefined;
  await handler({ params, respond: (ok: boolean, payload?: unknown, error?: any) => { answer = { ok, payload, error }; } });
  assert.ok(answer, "the handler answered");
  return answer;
};

const makeHandler = (opts: { cfg: any; runtimes: Array<[ string, unknown ]> }) => {
  const runtimes = new Map(opts.runtimes) as unknown as RuntimeMap;
  const channel = createChannelPlugin(runtimes) as any;
  let cfg = opts.cfg;
  const handler = createFoldersGatewayHandler({
    runtimes,
    handleAction: (input) => channel.actions.handleAction(input),
    currentConfig: () => cfg,
  });
  return { handler, setConfig: (next: any) => { cfg = next; } };
};

const configWith = (accounts: Record<string, unknown>) => ({ channels: { clawgram: { accounts } } });
const gramWith = (filters: unknown[] | Error) => ({
  listFolders: async () => {
    if (filters instanceof Error) throw filters;
    return filters;
  },
});

describe("registration", () => {
  const register = (current: any) => {
    const methods = new Map<string, { handler: (opts: any) => Promise<void>; opts: any }>();
    plugin.register({
      registerCli: () => {},
      registerChannel: () => {},
      registerGatewayMethod: (name: string, handler: any, opts: any) => { methods.set(name, { handler, opts }); },
      runtime: { config: { current: () => current } },
    });
    return methods;
  };

  it("registers clawgram.folders with the read scope", () => {
    const methods = register(configWith({ default: {} }));
    assert.deepEqual([ ...methods.keys() ], [ FOLDERS_GATEWAY_METHOD ]);
    assert.equal(FOLDERS_GATEWAY_METHOD, "clawgram.folders");
    assert.deepEqual(methods.get(FOLDERS_GATEWAY_METHOD)?.opts, { scope: FOLDERS_GATEWAY_SCOPE });
    assert.equal(FOLDERS_GATEWAY_SCOPE, "operator.read");
  });

  it("the registered method answers from the plugin's own runtimes: none connected yet", async () => {
    const methods = register(configWith({ default: {} }));
    const answer = await call(methods.get(FOLDERS_GATEWAY_METHOD)!.handler, {});
    assert.equal(answer.ok, false);
    assert.deepEqual(answer.error, { code: "UNAVAILABLE", message: "clawgram: account default is not connected" });
  });

  it("a host without gateway methods still loads the plugin", () => {
    assert.doesNotThrow(() => plugin.register({ registerCli: () => {}, registerChannel: () => {} }));
  });
});

describe("clawgram.folders", () => {
  it("answers what the folders action answers", async () => {
    const { handler } = makeHandler({
      cfg: configWith({ default: { inboundFolders: [ "❤️ Inbox", 4 ] } }),
      runtimes: [ [ "default", gramWith([ { className: "DialogFilterDefault" }, work, shared ]) ] ],
    });
    const answer = await call(handler, { accountId: "default" });

    assert.equal(answer.ok, true);
    assert.equal(answer.payload.ok, true);
    assert.equal(answer.payload.accountId, "default");
    assert.equal(answer.payload.count, 2);
    assert.deepEqual(answer.payload.folders.map((f: { id: number; kind: string }) => [ f.id, f.kind ]), [ [ 2, "filter" ], [ 5, "chatlist" ] ]);
    assert.deepEqual(answer.payload.inboundFolders.unknown, [ 4 ]);
    assert.deepEqual(answer.payload.inboundFolders.effective, [ { id: 2, title: "❤️ Inbox" } ]);
  });

  it("without accountId, the first enabled configured account", async () => {
    const { handler } = makeHandler({
      cfg: configWith({ off: { enabled: false }, main: {} }),
      runtimes: [ [ "main", gramWith([ work ]) ] ],
    });
    const answer = await call(handler, {});
    assert.equal(answer.ok, true);
    assert.equal(answer.payload.accountId, "main");
    assert.equal(answer.payload.inboundFolders, null);
  });

  it("reads the config as it is now, not as it was at registration", async () => {
    const { handler, setConfig } = makeHandler({ cfg: configWith({ default: {} }), runtimes: [ [ "default", gramWith([ work ]) ] ] });
    setConfig(configWith({ default: { inboundFolders: [ 2 ] } }));
    const answer = await call(handler, {});
    assert.deepEqual(answer.payload.inboundFolders.effective, [ { id: 2, title: "❤️ Inbox" } ]);
  });

  it("an account the config does not name is an invalid request", async () => {
    const { handler } = makeHandler({ cfg: configWith({ default: {} }), runtimes: [ [ "default", gramWith([ work ]) ] ] });
    const answer = await call(handler, { accountId: "other" });
    assert.equal(answer.ok, false);
    assert.deepEqual(answer.error, { code: "INVALID_REQUEST", message: "clawgram: unknown account other" });
  });

  it("no configured account at all is an invalid request", async () => {
    const { handler } = makeHandler({ cfg: {}, runtimes: [] });
    const answer = await call(handler, {});
    assert.deepEqual(answer.error, { code: "INVALID_REQUEST", message: "clawgram: no configured account found" });
  });

  it("a configured account that is not connected is unavailable", async () => {
    const { handler } = makeHandler({ cfg: configWith({ default: {}, second: {} }), runtimes: [ [ "default", gramWith([ work ]) ] ] });
    const answer = await call(handler, { accountId: "second" });
    assert.equal(answer.ok, false);
    assert.deepEqual(answer.error, { code: "UNAVAILABLE", message: "clawgram: account second is not connected" });
  });

  it("a failed Telegram read is an error with Telegram's words, not an empty list", async () => {
    const { handler } = makeHandler({ cfg: configWith({ default: {} }), runtimes: [ [ "default", gramWith(new Error("FLOOD_WAIT_3")) ] ] });
    const answer = await call(handler, {});
    assert.equal(answer.ok, false);
    assert.equal(answer.error?.code, "UNAVAILABLE");
    assert.match(answer.error?.message ?? "", /FLOOD_WAIT_3/);
  });

  it("takes only { accountId?: string }", async () => {
    const { handler } = makeHandler({ cfg: configWith({ default: {} }), runtimes: [ [ "default", gramWith([ work ]) ] ] });
    for (const params of [ { accountId: 3 }, { accountId: " " }, { channel: "clawgram" }, [ "default" ], "default" ]) {
      const answer = await call(handler, params);
      assert.equal(answer.ok, false, JSON.stringify(params));
      assert.equal(answer.error?.code, "INVALID_REQUEST", JSON.stringify(params));
    }
  });
});
