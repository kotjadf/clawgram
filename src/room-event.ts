/**
 * The context fields that turn a turn into a core room event.
 *
 * `InboundEventKind: "room_event"` is core's shape for "something happened in
 * this conversation; speak only if you mean to" (OpenClaw 2026.9): the turn
 * runs, the reply is optional instead of owed, the final text stays out of
 * the chat and out of the transcript, and anything visible has to go out
 * through the `message` tool. Core records the event itself as one line —
 * `AmbientTranscriptBody`, written here so both sides of a conversation read
 * the same way: `#<message id> <speaker>: <text>`.
 *
 * Commands are never interpreted on such a turn: neither a contact nor the
 * owner talking to a contact is controlling the gateway.
 */
export type RoomEventContext = {
  InboundEventKind: "room_event";
  AmbientTranscriptBody: string;
  CommandAuthorized: false;
  CommandInterpretationSuppressed: true;
};

export function roomEventContext(input: {
  messageId: string;
  speaker: string | undefined;
  text: string;
}): RoomEventContext {
  return {
    InboundEventKind: "room_event",
    AmbientTranscriptBody: roomEventLine(input),
    CommandAuthorized: false,
    CommandInterpretationSuppressed: true,
  };
}

/** `#<id> <speaker>: <text>`; a part that is unknown is left out. */
export function roomEventLine(input: { messageId: string; speaker: string | undefined; text: string }): string {
  const prefix = [
    input.messageId ? `#${input.messageId}` : undefined,
    input.speaker?.trim() || undefined,
  ].filter(Boolean).join(" ");
  return prefix ? `${prefix}: ${input.text}` : input.text;
}

/** How the account's owner is named in a recorded line: `<label> (owner)`. */
export function ownerSpeaker(selfLabel: string | undefined): string {
  const label = selfLabel?.trim();
  return label ? `${label} (owner)` : "owner";
}
