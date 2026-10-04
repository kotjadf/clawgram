import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { createChannelPlugin } from "../src/channel";
import { describeFolder, dialogFilterList, folderInventory, resolveInboundFolders } from "../src/inbound-folders";
import type { RuntimeMap } from "../src/types";
import { makeChannel, parseResult } from "./helpers";

/**
 * `folders` — the account's Telegram folders, for whoever picks the ones
 * `inboundFolders` names.
 *
 * Folders get renamed and their emoji change; their id does not. A picker
 * that lists the folders by title and stores the id survives that, and one
 * that can see what the configured entries resolve to can tell the owner
 * that a folder has gone instead of leaving an inbox that is silently empty.
 * The list is metadata: counts say how a folder is built, never who is in it.
 */

const user = (id: number) => ({ className: "InputPeerUser", userId: id, accessHash: 1 });
const channel = (id: number) => ({ className: "InputPeerChannel", channelId: id, accessHash: 1 });

const work = {
  className: "DialogFilter",
  id: 2,
  title: { className: "TextWithEntities", text: "❤️ Inbox", entities: [ { className: "MessageEntityCustomEmoji" } ] },
  emoticon: "❤",
  color: 3,
  contacts: true,
  groups: true,
  excludeMuted: true,
  excludeArchived: true,
  pinnedPeers: [ user(10) ],
  includePeers: [ user(11), channel(12) ],
  excludePeers: [ user(13) ],
};
const shared = {
  className: "DialogFilterChatlist",
  id: 5,
  title: "Project",
  pinnedPeers: [],
  includePeers: [ channel(20) ],
  // A chat list has no exclusions or categories; whatever a malformed one carries is ignored.
  excludePeers: [ user(21) ],
  groups: true,
};
const all = { className: "DialogFilterDefault" };

describe("describeFolder", () => {
  it("reports what picks a folder and how it is built — never the peers", () => {
    const folder = describeFolder(work);
    assert.deepEqual(folder, {
      id: 2,
      title: "❤️ Inbox",
      emoticon: "❤",
      color: 3,
      kind: "filter",
      pinnedCount: 1,
      includeCount: 2,
      excludeCount: 1,
      categories: [ "contacts", "groups" ],
      exclusions: [ "excludeMuted", "excludeArchived" ],
    });
    assert.ok(!JSON.stringify(folder).includes("userId"), "no peer ids in the summary");
  });

  it("a shared folder is a chatlist: chosen chats only", () => {
    assert.deepEqual(describeFolder(shared), {
      id: 5,
      title: "Project",
      kind: "chatlist",
      pinnedCount: 0,
      includeCount: 1,
      excludeCount: 0,
      categories: [],
      exclusions: [],
    });
  });

  it("skips \"All chats\" and anything that is not a folder", () => {
    assert.equal(describeFolder(all), undefined);
    assert.equal(describeFolder({ className: "DialogFilter" }), undefined, "no id");
    assert.equal(describeFolder(null), undefined);
  });

  it("a title with no text and a blank emoticon come out empty and absent", () => {
    const folder = describeFolder({ className: "DialogFilter", id: 7, title: {}, emoticon: " " });
    assert.equal(folder?.title, "");
    assert.equal("emoticon" in (folder ?? {}), false);
  });
});

describe("dialogFilterList", () => {
  it("takes the bare vector and the layer-176 wrapper; anything else is an error", () => {
    assert.deepEqual(dialogFilterList([ all ]), [ all ]);
    assert.deepEqual(dialogFilterList({ className: "messages.DialogFilters", filters: [ work ] }), [ work ]);
    assert.throws(() => dialogFilterList(undefined), /no folder list/);
  });
});

describe("resolveInboundFolders", () => {
  it("says what each entry names now, and which name nothing", () => {
    const renamed = { ...work, title: { text: "💼 Work" } };
    const state = resolveInboundFolders([ all, renamed, shared ], [ 2, "❤️ Inbox", "Project", 9 ]);
    assert.deepEqual(state, {
      configured: [ 2, "❤️ Inbox", "Project", 9 ],
      entries: [
        { selector: 2, folders: [ { id: 2, title: "💼 Work" } ] },
        { selector: "❤️ Inbox", folders: [] },
        { selector: "Project", folders: [ { id: 5, title: "Project" } ] },
        { selector: 9, folders: [] },
      ],
      unknown: [ "❤️ Inbox", 9 ],
      effective: [ { id: 2, title: "💼 Work" }, { id: 5, title: "Project" } ],
    });
  });

  it("no filter configured: nothing to resolve", () => {
    assert.equal(resolveInboundFolders([ work ], undefined), undefined);
    assert.equal(folderInventory([ work ], undefined).inboundFolders, null);
  });
});

describe("the folders action", () => {
  const makeGram = (filters: unknown[] | Error) => {
    let calls = 0;
    return {
      get calls() { return calls; },
      listFolders: async () => {
        calls += 1;
        if (filters instanceof Error) throw filters;
        return filters;
      },
    };
  };

  it("lists the folders and resolves the account's inboundFolders", async () => {
    const gram = makeGram([ all, work, shared ]);
    const { act } = makeChannel(gram, { inboundFolders: [ "❤️ Inbox", 4 ] });
    const payload = parseResult(await act("folders", {}));

    assert.equal(gram.calls, 1);
    assert.equal(payload.ok, true);
    assert.equal(payload.accountId, "default");
    assert.equal(payload.count, 2);
    assert.deepEqual(payload.folders.map((f: { id: number; kind: string }) => [ f.id, f.kind ]), [ [ 2, "filter" ], [ 5, "chatlist" ] ]);
    assert.deepEqual(payload.inboundFolders.unknown, [ 4 ]);
    assert.deepEqual(payload.inboundFolders.effective, [ { id: 2, title: "❤️ Inbox" } ]);
  });

  it("needs no scope: a folder list is the owner's own metadata", async () => {
    // No readChats, no discoverChats, no manageChats.
    const { act } = makeChannel(makeGram([ work ]), {});
    const payload = parseResult(await act("folders", {}));
    assert.equal(payload.count, 1);
    assert.equal(payload.inboundFolders, null);
  });

  it("answers to its other spellings", async () => {
    for (const name of [ "listFolders", "dialogFilters" ]) {
      const { act } = makeChannel(makeGram([ work ]), {});
      assert.equal(parseResult(await act(name, {})).count, 1, name);
    }
  });

  it("a failed read is an error, not an empty list", async () => {
    const { act } = makeChannel(makeGram(new Error("FLOOD_WAIT_3")), {});
    await assert.rejects(() => act("folders", {}), /FLOOD_WAIT_3/);
  });

  it("is never offered to the agent's message tool", () => {
    const plugin = createChannelPlugin(new Map([ [ "default", {} ] ]) as unknown as RuntimeMap) as any;
    const described = plugin.actions.describeMessageTool({
      cfg: { channels: { clawgram: { accounts: { default: {} } } } },
      accountId: "default",
    });
    for (const name of [ "folders", "listFolders", "dialogFilters" ]) {
      assert.ok(!described.actions.includes(name), `${name} must stay gateway-only`);
    }
    assert.ok(!plugin.agentPrompt.messageToolHints().some((hint: string) => /folders`/.test(hint)));
  });
});
