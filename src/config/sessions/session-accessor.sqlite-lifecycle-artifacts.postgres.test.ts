import { describe, expect, it } from "vitest";
import { withEngineStoreAdmission as admit } from "../../infra/database-engine/admission-scope.js";
import {
  mixedAgentConnection,
  useMixedAgentPair,
} from "../../infra/database-engine/mixed-agent.conformance.test-support.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { cleanupSessionLifecycleArtifactsCore } from "./session-accessor.sqlite-artifact-cleanup.js";
import { writeSessionEntry } from "./session-accessor.sqlite-entry-store.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";

describe.skipIf(!mixedAgentConnection)("PostgreSQL lifecycle artifact cleanup", () => {
  useMixedAgentPair("postgres", "postgres");

  it("cleans old marked historical windows while retaining fresh and unrelated history", async () => {
    const agentId = "main";
    const now = Date.now();
    const old = now - 600_000;
    const marker = "lifecycle-pg-marker";
    const options = { agentId, env: process.env };
    const database = admit(() => openOpenClawAgentDatabase(options));
    admit(() =>
      runOpenClawAgentWriteTransaction((writer) => {
        for (const id of ["marked", "fresh", "unrelated"]) {
          const sessionKey = `agent:main:${id}`;
          // Public rollover retains lineage; seed genuinely unreferenced history.
          writeSessionEntry(writer, sessionKey, { sessionId: id, updatedAt: old });
          appendTranscriptEventsInTransaction(writer, { ...options, sessionKey, sessionId: id }, [
            {
              type: "metadata",
              timestamp: new Date(old).toISOString(),
              marker: id === "unrelated" ? "unrelated" : marker,
            },
            ...(id === "fresh"
              ? [{ type: "metadata", timestamp: new Date(now).toISOString() }]
              : []),
          ]);
          writeSessionEntry(writer, sessionKey, { sessionId: `${id}-current`, updatedAt: now });
        }
      }, options),
    );

    await expect(
      cleanupSessionLifecycleArtifactsCore({
        ...options,
        storePath: database.path,
        sessionKeySegmentPrefix: "unused-",
        transcriptContentMarker: marker,
        orphanTranscriptMinAgeMs: 300_000,
        archiveRemovedEntryTranscripts: false,
        nowMs: now,
      }),
    ).resolves.toEqual({ removedEntries: 0, archivedTranscriptArtifacts: 0 });
    expect(
      admit(() =>
        database.db
          .prepare("SELECT DISTINCT session_id FROM transcript_events ORDER BY session_id")
          .all(),
      ),
    ).toEqual([{ session_id: "fresh" }, { session_id: "unrelated" }]);
  });
});
