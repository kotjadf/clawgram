import { CHANNEL_ID } from "./constants";
import { resolveConfiguredAccountId } from "./helpers";
import type { RuntimeMap } from "./types";

/**
 * `clawgram.folders` — the `folders` action as a gateway method of its own.
 *
 * `message.action` reaches a channel's action only when core knows the
 * action's name: core keeps a fixed list of the actions it will prepare a
 * read context for, and refuses everything else with "Message action …
 * not supported for channel clawgram" before the channel is asked. A
 * plugin-only read such as `folders` (or `joins`) is unreachable that way,
 * so the folder picker gets a method of its own. It answers exactly what the
 * action answers — it runs the action — and is never offered to the agent:
 * a gateway method is operator RPC, not a tool.
 *
 * Params: `{ accountId?: string }`; without one, the first enabled
 * configured account. Errors: INVALID_REQUEST for bad params or an account
 * the config does not name, UNAVAILABLE for an account that is configured
 * but not connected, or a Telegram read that failed.
 */

export const FOLDERS_GATEWAY_METHOD = "clawgram.folders";

/** A folder list is the owner's own metadata: read scope, never write. */
export const FOLDERS_GATEWAY_SCOPE = "operator.read";

type GatewayError = { code: string; message: string };
type Respond = (ok: boolean, payload?: unknown, error?: GatewayError) => void;

type FoldersGatewayDeps = {
  runtimes: RuntimeMap;
  /** The channel plugin's action handler: the method runs the `folders` action through it. */
  handleAction: (input: { action: string; params: Record<string, unknown>; cfg: any; accountId: string }) => Promise<unknown>;
  /** The gateway's config as it is now, not as it was at registration. */
  currentConfig: () => any;
};

const invalid = (message: string): GatewayError => ({ code: "INVALID_REQUEST", message });
const unavailable = (message: string): GatewayError => ({ code: "UNAVAILABLE", message });

/** The action's payload: `details` of core's `jsonResult`, or its text when a host gives only that. */
function actionPayload(result: unknown): unknown {
  const details = (result as { details?: unknown } | undefined)?.details;
  if (details && typeof details === "object") {
    return details;
  }
  const text = (result as { content?: Array<{ text?: string }> } | undefined)?.content?.[ 0 ]?.text;
  return typeof text === "string" ? JSON.parse(text) : result;
}

export function createFoldersGatewayHandler(deps: FoldersGatewayDeps) {
  return async ({ params, respond }: { params?: unknown; respond: Respond }): Promise<void> => {
    const p = (params ?? {}) as Record<string, unknown>;
    if (typeof p !== "object" || Array.isArray(p) || Object.keys(p).some((key) => key !== "accountId")) {
      respond(false, undefined, invalid("clawgram.folders takes only { accountId?: string }"));
      return;
    }
    if (p.accountId !== undefined && (typeof p.accountId !== "string" || !p.accountId.trim())) {
      respond(false, undefined, invalid("clawgram.folders: accountId must be a non-empty string"));
      return;
    }

    const cfg = deps.currentConfig();
    const accounts = cfg?.channels?.[ CHANNEL_ID ]?.accounts;
    const requested = typeof p.accountId === "string" ? p.accountId.trim() : undefined;
    const accountId = requested ?? resolveConfiguredAccountId(cfg);
    if (!accountId) {
      respond(false, undefined, invalid("clawgram: no configured account found"));
      return;
    }
    if (!accounts || typeof accounts !== "object" || !Object.prototype.hasOwnProperty.call(accounts, accountId)) {
      respond(false, undefined, invalid(`clawgram: unknown account ${accountId}`));
      return;
    }
    if (!deps.runtimes.has(accountId)) {
      respond(false, undefined, unavailable(`clawgram: account ${accountId} is not connected`));
      return;
    }

    try {
      const result = await deps.handleAction({ action: "folders", params: {}, cfg, accountId });
      respond(true, actionPayload(result));
    } catch (error) {
      respond(false, undefined, unavailable(error instanceof Error ? error.message : String(error)));
    }
  };
}

/** Registers the method when the host has gateway methods (setup and CLI loads may not). */
export function registerFoldersGatewayMethod(api: any, deps: FoldersGatewayDeps): void {
  if (typeof api?.registerGatewayMethod !== "function") {
    return;
  }
  api.registerGatewayMethod(FOLDERS_GATEWAY_METHOD, createFoldersGatewayHandler(deps), { scope: FOLDERS_GATEWAY_SCOPE });
}
