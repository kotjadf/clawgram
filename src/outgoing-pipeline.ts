// What the owner writes from their own Telegram, recorded into the
// conversation's session (`recordOutgoing`).
//
// A person's account read by an agent as an inbox used to hold one side of
// every conversation: Telegram reports the owner's own messages as outgoing,
// and the pipeline skipped them. With `recordOutgoing` each one becomes a
// core room event in the session the other side's messages already go to —
// same route peer, so the same session key — spoken by the owner, silent by
// construction: delivery is suppressed here whatever the turn produces.
//
// The gates are the inbound ones, applied to the conversation rather than to
// the sender (the sender is always the owner): a direct chat needs its peer
// admitted by `allowFrom`, not a bot under `ignoreBots`, and inside
// `inboundFolders`; a group needs its `groups` entry, enabled, under
// `groupPolicy: "open"` — the only rung where the others' unaddressed
// messages are read too — and inside `inboundFolders`. Saved Messages, the
// Telegram service chat, channels and messages this process sent itself (the
// agent's own sends) are never recorded.
import {
  dispatchInboundDirectDmWithRuntime,
} from "openclaw/plugin-sdk/channel-inbound";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import { CHANNEL_ID, TELEGRAM_SERVICE_CHAT_ID } from "./constants";
import {
  buildConversationTarget,
  buildScopedGroupPeerId,
  isSenderAllowed,
  readAccountIgnoreBots,
  resolveAccountScopes,
  resolveDirectPeer,
  resolveGroupConfig,
  resolveReplyParent,
} from "./helpers";
import { readInboundAttachment } from "./attachments";
import { ownerSpeaker, roomEventContext } from "./room-event";
import type { InboundContext } from "./inbound-pipeline";
import type { NormalizedInbound } from "./types";

export async function recordOutgoingEvent(
  event: unknown,
  normalized: NormalizedInbound,
  context: InboundContext,
): Promise<void> {
  const accountId = context.accountId;
  const cfg = context.cfg;
  const log = context.log;
  const rawMessage = (event as any)?.message;
  const chatId = normalized.chatId;
  const messageId = normalized.messageId;
  const base = { accountId, chatId, messageId };
  const skip = (reason: string) => log?.info?.("clawgram not recording outgoing message", { ...base, reason });

  const selfId = context.selfId;
  if (chatId === TELEGRAM_SERVICE_CHAT_ID || (selfId && chatId === selfId)) {
    skip(chatId === TELEGRAM_SERVICE_CHAT_ID ? "service-chat" : "saved-messages");
    return;
  }

  const scopes = resolveAccountScopes(cfg, accountId);
  const groupConfig = normalized.chatType === "group" ? resolveGroupConfig(scopes.groups, chatId) : undefined;
  if (normalized.chatType === "group") {
    if (!groupConfig) { skip("group-not-configured"); return; }
    if (groupConfig.enabled === false) { skip("group-disabled"); return; }
    if (groupConfig.groupPolicy !== "open") { skip("group-not-open"); return; }
  } else if (!scopes.allowFrom.includes("*")
    && !scopes.allowFrom.some((entry) => String(entry).trim().startsWith("@"))
    && !isSenderAllowed({ allowFrom: scopes.allowFrom, senderId: chatId })) {
    // Numeric ids only: decided without a single call.
    skip("peer-not-in-allowFrom");
    return;
  }

  // The agent's own sends come back as outgoing updates too. They are in the
  // session that made them already; recorded here they would read as the
  // owner's words and start a turn on the agent's own output.
  if (typeof context.gram?.isOwnSend === "function" && await context.gram.isOwnSend(chatId, messageId)) {
    skip("own-send");
    return;
  }

  let peerLabel: string | undefined;
  if (normalized.chatType === "direct") {
    const peer = await resolveDirectPeer(rawMessage, chatId);
    if (readAccountIgnoreBots(cfg, accountId) && peer.bot) {
      skip("peer-is-bot");
      return;
    }
    if (!isSenderAllowed({ allowFrom: scopes.allowFrom, senderId: chatId, senderUsername: peer.username })) {
      skip("peer-not-in-allowFrom");
      return;
    }
    // The same label an inbound message from this peer gives the session.
    peerLabel = peer.display || peer.username || chatId;
  }

  if (context.inboundFolders) {
    const decision = await context.inboundFolders.decide({
      chatId,
      chatType: normalized.chatType,
      message: rawMessage,
    });
    if (!decision.admit) {
      skip(`outside-inboundFolders:${decision.reason}`);
      return;
    }
  }

  let text = normalized.text?.trim();
  const attachment = await readInboundAttachment({
    gram: context.gram,
    event,
    cfg,
    runtime: context.pluginRuntime,
    log,
    accountId,
    chatId,
    messageId,
  });
  if (attachment) {
    const marker = attachment.understanding === "transcript" ? "голосовое" : "изображение";
    const read = `[${marker}] ${attachment.text}`;
    text = text ? `${text}\n\n${read}` : read;
  }
  if (!text) {
    skip("empty");
    return;
  }

  const speaker = ownerSpeaker(context.selfLabel);
  const replyParent = await resolveReplyParent(rawMessage, { selfId, selfLabel: context.selfLabel });
  const roomEvent = roomEventContext({ messageId, speaker, text });
  // Whatever the turn produces stays out of the chat: the owner already said
  // what they said. The `message` tool is the only door out, as for every
  // room event, and the inbox instructions keep it shut for these.
  const suppress = async () => {
    log?.info?.("clawgram suppressing room-event delivery", base);
  };
  // No SenderId: an `ownerAllowFrom` that names the owner's Telegram id must
  // not turn a recorded message into an owner-authorized turn. The speaker is
  // named in SenderName and in the recorded line.
  const speakerFields = { SenderId: undefined, SenderUsername: undefined, SenderName: speaker };

  if (normalized.chatType === "direct") {
    log?.info?.("clawgram recording outgoing direct message", base);
    // Everything that places the turn is what an inbound message from this
    // peer would carry — the peer, From/To, the originating target — so the
    // route resolves to the very same session.
    await dispatchInboundDirectDmWithRuntime({
      cfg,
      runtime: { channel: context.channelRuntime },
      channel: "clawgram",
      channelLabel: "Telegram",
      accountId,
      peer: { kind: "direct", id: chatId },
      senderId: chatId,
      senderAddress: `telegram:${chatId}`,
      recipientAddress: selfId ? `telegram:${selfId}` : `telegram:${accountId}`,
      conversationLabel: peerLabel ?? chatId,
      rawBody: text,
      messageId,
      timestamp: normalized.timestamp,
      commandAuthorized: false,
      provider: "telegram",
      surface: "clawgram",
      originatingChannel: "clawgram",
      originatingTo: chatId,
      extraContext: {
        ...speakerFields,
        ReplyToId: normalized.replyToMessageId,
        ReplyToQuoteText: normalized.replyQuoteText,
        ReplyToIsQuote: normalized.replyIsQuote,
        ReplyToBody: replyParent.body,
        ReplyToSender: replyParent.sender,
        NativeChannelId: chatId,
        ...roomEvent,
      },
      deliver: suppress,
      onRecordError: (err: unknown) => {
        log?.info?.("clawgram failed to record outgoing session", { ...base, error: String(err) });
      },
      onDispatchError: (err: unknown, info: { kind: string }) => {
        log?.info?.("clawgram failed to dispatch outgoing record", { ...base, kind: info.kind, error: String(err) });
      },
    });
    return;
  }

  // A group: the same scoped peer the group's inbound turns route by.
  const channelRuntime = context.channelRuntime;
  const { route: groupRoute, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg,
    channel: "clawgram",
    accountId,
    peer: { kind: "group", id: buildScopedGroupPeerId(accountId, chatId) },
    runtime: channelRuntime,
    sessionStore: cfg?.session?.store,
  });
  const route = groupRoute as ResolvedAgentRoute;
  const { storePath, body } = buildEnvelope({
    channel: "Telegram",
    from: speaker,
    body: text,
    timestamp: normalized.timestamp,
  });
  const conversationRouteTarget = buildConversationTarget(chatId);
  const ctxPayload = channelRuntime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: `${speaker}: ${text}`,
    RawBody: text,
    CommandBody: text,
    From: conversationRouteTarget,
    To: conversationRouteTarget,
    SessionKey: route.sessionKey,
    AccountId: route.accountId ?? accountId,
    ChatType: "group",
    ConversationLabel: speaker,
    ...speakerFields,
    GroupId: chatId,
    GroupSubject: chatId,
    WasMentioned: false,
    WasReplyToSelf: false,
    Provider: "telegram",
    Surface: "clawgram",
    MessageSid: messageId,
    MessageSidFull: messageId,
    Timestamp: normalized.timestamp,
    ReplyToId: normalized.replyToMessageId,
    ReplyToQuoteText: normalized.replyQuoteText,
    ReplyToIsQuote: normalized.replyIsQuote,
    ReplyToBody: replyParent.body,
    ReplyToSender: replyParent.sender,
    MessageThreadId: normalized.messageThreadId,
    NativeChannelId: chatId,
    GroupSystemPrompt: groupConfig?.systemPrompt,
    OriginatingChannel: "clawgram",
    OriginatingTo: conversationRouteTarget,
    ...roomEvent,
  });

  log?.info?.("clawgram recording outgoing group message", { ...base, routeSessionKey: route.sessionKey });
  await channelRuntime.session.recordInboundSession({
    storePath,
    sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
    ctx: ctxPayload,
    updateLastRoute: {
      sessionKey: route.sessionKey,
      channel: CHANNEL_ID,
      to: conversationRouteTarget,
      accountId: route.accountId ?? accountId,
    },
    onRecordError: (err: unknown) => {
      log?.info?.("clawgram failed to record outgoing session", { ...base, error: String(err) });
    },
  });

  const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
    cfg,
    agentId: route.agentId,
    channel: "clawgram",
    accountId: route.accountId ?? accountId,
  });
  await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      ...replyPipeline,
      deliver: suppress,
      onError: (err: unknown, info: { kind: string }) => {
        log?.error?.("clawgram failed to dispatch outgoing record", { ...base, kind: info.kind, error: String(err) });
      },
    },
    replyOptions: {
      onModelSelected,
      skillFilter: groupConfig?.skillFilter,
    },
  });
}
