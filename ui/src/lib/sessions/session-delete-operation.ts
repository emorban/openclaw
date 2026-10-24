import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayRequestError } from "../../api/gateway.ts";
import type { GatewaySessionRow } from "../../api/types.ts";
import { t } from "../../i18n/index.ts";
import { formatUiError } from "../format-error.ts";
import type { requestSessionDelete } from "./session-requests.ts";
import type {
  SessionConnectionScope,
  SessionDeleteOutcome,
  SessionDeleteTarget,
} from "./session-types.ts";

export async function settleSessionDelete(
  responsePromise: Promise<
    { result: Awaited<ReturnType<typeof requestSessionDelete>> } | { error: unknown }
  >,
  target: SessionDeleteTarget,
  scope: SessionConnectionScope,
  allowAbsent: boolean,
  host: {
    isCurrent: () => boolean;
    owns: () => boolean;
    confirmed: () => boolean;
    confirm: () => void;
    rollback: () => void;
    reportError: (message: string) => void;
  },
): Promise<SessionDeleteOutcome> {
  const confirmAbsent = async () => {
    if (!allowAbsent || !host.isCurrent()) {
      return false;
    }
    try {
      const result = await scope.client.request<{ session: GatewaySessionRow | null }>(
        "sessions.describe",
        { key: target.key, agentId: target.agentId },
      );
      if (result.session !== null || !host.isCurrent() || !host.owns()) {
        return false;
      }
      host.confirm();
      return true;
    } catch {
      // A failed read is not proof that the target is gone.
      return false;
    }
  };
  try {
    const outcome = await responsePromise;
    if ("error" in outcome) {
      throw outcome.error;
    }
    const response = outcome.result;
    if (!host.owns()) {
      return { deleted: false };
    }
    if (!response.deleted && !host.confirmed()) {
      if (await confirmAbsent()) {
        return { deleted: true };
      }
      if (!host.owns()) {
        return { deleted: false };
      }
      host.rollback();
      if (allowAbsent) {
        host.reportError(t("sessionsView.deleteSessionStale", { session: target.key }));
      }
      return { deleted: false };
    }
    host.confirm();
    return {
      deleted: true,
      ...(response.worktreePreserved ? { worktreePreserved: response.worktreePreserved } : {}),
    };
  } catch (error) {
    if (!host.owns()) {
      return { deleted: false };
    }
    // A missing expected incarnation (or missing archived row) can reject
    // before deletion. Permission and other failures must still roll back.
    if (
      error instanceof GatewayRequestError &&
      error.gatewayCode === "INVALID_REQUEST" &&
      ((isRecord(error.details) && error.details.reason === "session-changed") ||
        error.message ===
          `Session ${target.key} is not archived. Archive it first, then delete it.`) &&
      (await confirmAbsent())
    ) {
      return { deleted: true };
    }
    if (!host.owns()) {
      return { deleted: false };
    }
    host.rollback();
    host.reportError(formatUiError(error));
    throw error;
  }
}
