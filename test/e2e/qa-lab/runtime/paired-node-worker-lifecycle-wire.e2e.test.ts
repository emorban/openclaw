import { createServer } from "node:http";
import { rawDataToString } from "@openclaw/gateway-client/websocket-data";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { WebSocket, WebSocketServer, type RawData } from "ws";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import type { WorkerInferenceTerminalFrame } from "../../../../packages/gateway-protocol/src/schema/worker-inference.js";
import {
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "../../../../src/infra/kysely-sync.js";
import {
  NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
  NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
} from "../../../../src/infra/node-commands.js";
import { withOpenClawStateDatabaseReadOnly } from "../../../../src/state/openclaw-state-db-readonly.js";
import type { DB as StateDatabase } from "../../../../src/state/openclaw-state-db.generated.js";
import { createDeferred } from "../../../helpers/promise.js";
import { runQaGatewayFixture, stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { useAutoCleanupTempDirTracker } from "../../../helpers/temp-dir.js";
import { PROOF_TIMEOUT_MS } from "./cloud-worker-midturn-loss-fixture.js";
import { startPairedNodeWorkerLifecycleProvider } from "./paired-node-worker-lifecycle-provider.js";
import {
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  startPairedNodeWorkerGateway,
  type PairedNodeWorkerHost,
  type PublishedWireWorkspace,
  type WireGateway,
} from "./paired-node-worker-wire-fixture.js";

const TEST_TIMEOUT_MS = PROOF_TIMEOUT_MS + 180_000;
const SESSION_PREFIX = "agent:qa:paired-node-worker-lifecycle";
const HOLD_REVOKED = "WIRE-HOLD-REVOKED";
const HOLD_UNCONFIRMED = "WIRE-HOLD-UNCONFIRMED";

type TurnResult = { runId?: string; status?: string; summary?: string };
type Placement = {
  activeOwnerEpoch?: number;
  environmentId?: string;
  generation?: number;
  state?: string;
};
const tempDirs = useAutoCleanupTempDirTracker(afterEach);

async function createSession(
  operator: GatewayClient,
  published: PublishedWireWorkspace,
  suffix: string,
): Promise<string> {
  const key = `${SESSION_PREFIX}:${suffix}`;
  await operator.request("sessions.create", {
    key,
    agentId: "qa",
    worktree: true,
    worktreeName: `paired-node-${suffix}`,
    worktreeBaseRef: "main",
    cwd: published.source,
  });
  return key;
}

async function dispatchNodeSession(
  gateway: WireGateway,
  key: string,
  nodeId: string,
): Promise<Placement> {
  const result = (await gateway.call(
    "sessions.dispatch",
    { key, deviceId: nodeId },
    { timeoutMs: PROOF_TIMEOUT_MS },
  )) as { placement?: Placement };
  expect(result.placement).toMatchObject({ state: "active" });
  return result.placement!;
}

async function startTurn(operator: GatewayClient, key: string, marker: string): Promise<string> {
  const runId = `${marker.toLowerCase()}-${Date.now()}`;
  const started = await operator.request<TurnResult>("chat.send", {
    sessionKey: key,
    message: `Reply exactly: ${marker}`,
    deliver: false,
    idempotencyKey: runId,
  });
  expect(started).toMatchObject({ runId, status: "started" });
  return runId;
}

async function waitForTurn(operator: GatewayClient, runId: string): Promise<TurnResult> {
  return await operator.request<TurnResult>(
    "agent.wait",
    { runId, timeoutMs: PROOF_TIMEOUT_MS },
    { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
  );
}

async function describePlacement(gateway: WireGateway, key: string): Promise<Placement> {
  const described = (await gateway.call("sessions.describe", { key })) as {
    session?: { placement?: Placement };
  };
  return described.session?.placement ?? {};
}

function readTurnClaim(gateway: WireGateway, key: string) {
  return withOpenClawStateDatabaseReadOnly(
    ({ db }) =>
      executeSqliteQueryTakeFirstSync(
        db,
        getNodeSqliteKysely<StateDatabase>(db)
          .selectFrom("worker_session_placements")
          .select(["turn_claim_owner", "turn_claim_run_id"])
          .where("session_key", "=", key),
      ),
    { env: gateway.runtimeEnv },
  );
}

function launchFrameForRun(host: PairedNodeWorkerHost, runId: string) {
  return host.frames.find((frame) => {
    if (frame.command !== NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND || !frame.paramsJSON) {
      return false;
    }
    const input = JSON.parse(frame.paramsJSON) as {
      descriptor?: { assignment?: { runId?: string } };
    };
    return input.descriptor?.assignment?.runId === runId;
  });
}

function requireLaunchId(host: PairedNodeWorkerHost, runId: string): string {
  const frame = launchFrameForRun(host, runId);
  if (!frame?.paramsJSON) {
    throw new Error(`node launch request missing for run ${runId}`);
  }
  const input = JSON.parse(frame.paramsJSON) as { launchId?: string };
  if (!input.launchId) {
    throw new Error(`node launch request omitted launch ID for run ${runId}`);
  }
  return input.launchId;
}

async function createWorkerCancellationGate(gatewayUrl: string) {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  const peers = new Set<{ upstream: WebSocket; downstream: WebSocket }>();
  let blockedRunId: string | undefined;
  sockets.on("connection", (downstream, request) => {
    const upstream = new WebSocket(new URL(request.url ?? "/", gatewayUrl));
    const peer = { upstream, downstream };
    peers.add(peer);
    const pending: RawData[] = [];
    downstream.on("message", (data) => {
      if (upstream.readyState === WebSocket.OPEN) {
        upstream.send(data);
      } else {
        pending.push(data);
      }
    });
    upstream.on("open", () => {
      for (const data of pending.splice(0)) {
        upstream.send(data);
      }
    });
    upstream.on("message", (data) => {
      const frame = JSON.parse(rawDataToString(data)) as WorkerInferenceTerminalFrame;
      if (
        frame.event === "worker.inference.terminal" &&
        frame.payload.runId === blockedRunId &&
        frame.payload.outcome.type === "error" &&
        frame.payload.outcome.reason === "cancelled"
      ) {
        return;
      }
      if (downstream.readyState === WebSocket.OPEN) {
        downstream.send(data);
      }
    });
    const close = () => {
      peers.delete(peer);
      upstream.terminate();
      downstream.terminate();
    };
    upstream.on("error", close);
    downstream.on("error", close);
    upstream.on("close", close);
    downstream.on("close", close);
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("worker cancellation gate did not bind");
  }
  return {
    url: `ws://127.0.0.1:${address.port}`,
    block(runId: string) {
      blockedRunId = runId;
    },
    async close() {
      for (const peer of peers) {
        peer.upstream.terminate();
        peer.downstream.terminate();
      }
      await new Promise<void>((resolve) => {
        sockets.close(() => resolve());
      });
      await closeWireServer(server);
    },
  };
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") {
      return false;
    }
    throw error;
  }
}

describe("paired node worker lifecycle wire", () => {
  const gatewayOwner = createQaGatewayChild();
  let provider: Awaited<ReturnType<typeof startPairedNodeWorkerLifecycleProvider>>;
  let gateway: WireGateway;
  let operator: GatewayClient;

  // Each case owns its node, workspace and sessions; Gateway startup is not under test.
  beforeAll(async () => {
    provider = await startPairedNodeWorkerLifecycleProvider([HOLD_REVOKED, HOLD_UNCONFIRMED]);
    gateway = await startPairedNodeWorkerGateway({
      owner: gatewayOwner,
      providerBaseUrl: provider.baseUrl,
      useRepoCli: false,
    });
    operator = await connectWireClient({
      gateway,
      role: "operator",
      identity: null,
    });
  });

  afterAll(async () => {
    provider?.releaseAll();
    const cleanup = await Promise.allSettled([
      operator?.stopAndWait({ timeoutMs: 2_000 }) ?? Promise.resolve(),
      stopQaGatewayFixture(gatewayOwner),
      provider?.stop() ?? Promise.resolve(),
    ]);
    const failures = cleanup.flatMap((result) =>
      result.status === "rejected" ? [result.reason] : [],
    );
    if (failures.length) {
      throw new AggregateError(failures, "paired node lifecycle Gateway cleanup failed");
    }
  });
  it(
    "fences revoked and unconfirmed turns before real node successor I/O",
    { timeout: TEST_TIMEOUT_MS },
    async () => {
      const root = tempDirs.make("openclaw-paired-node-worker-turn-fence-");
      const published = await createPublishedWireWorkspace(root);
      const cancellationGate = await createWorkerCancellationGate(gateway.wsUrl);
      let workerNode: PairedNodeWorkerHost | undefined;
      let releaseStopAcknowledgement: (() => void) | undefined;
      await runQaGatewayFixture(
        async () => {
          workerNode = await createPairedNodeWorkerHost({
            gateway,
            operator,
            root,
            workerGatewayUrl: cancellationGate.url,
          });
          const nodeId = workerNode.identity.deviceId;

          const revokedKey = await createSession(operator, published, "revoked");
          await dispatchNodeSession(gateway, revokedKey, nodeId);
          const heldRunId = await startTurn(operator, revokedKey, HOLD_REVOKED);
          await vi.waitFor(() => expect(provider.hasHeld(HOLD_REVOKED)).toBe(true), {
            timeout: PROOF_TIMEOUT_MS,
            interval: 100,
          });
          const revokedRunId = await startTurn(
            operator,
            revokedKey,
            "WIRE-REVOKED-BEFORE-DISPATCH",
          );
          await expect(
            operator.request("chat.abort", { sessionKey: revokedKey, runId: revokedRunId }),
          ).resolves.toMatchObject({ aborted: true });
          provider.release(HOLD_REVOKED);
          await expect(waitForTurn(operator, heldRunId)).resolves.toMatchObject({ status: "ok" });
          const revokedResult = await waitForTurn(operator, revokedRunId);
          expect(revokedResult.status).not.toBe("timeout");
          await workerNode.waitForInvokes();
          expect(launchFrameForRun(workerNode, revokedRunId)).toBeUndefined();

          const unconfirmedKey = await createSession(operator, published, "unconfirmed");
          const originalPlacement = await dispatchNodeSession(gateway, unconfirmedKey, nodeId);
          const unconfirmedRunId = await startTurn(operator, unconfirmedKey, HOLD_UNCONFIRMED);
          await vi.waitFor(() => expect(provider.hasHeld(HOLD_UNCONFIRMED)).toBe(true), {
            timeout: PROOF_TIMEOUT_MS,
            interval: 100,
          });
          const oldLaunchId = requireLaunchId(workerNode, unconfirmedRunId);
          const oldReceipt = await workerNode.supervisor.status(oldLaunchId);
          const oldPid = oldReceipt?.worker?.pid;
          if (oldReceipt?.state !== "running" || typeof oldPid !== "number") {
            throw new Error("held node worker did not expose its live child process");
          }
          expect(processIsAlive(oldPid)).toBe(true);

          // Lose both cancellation channels: the worker must remain unconfirmed
          // until the node's real environment stop proves physical cleanup.
          cancellationGate.block(unconfirmedRunId);
          const commandStart = workerNode.frames.length;
          const stopEntered = createDeferred();
          const stopCompleted = createDeferred();
          const stopAcknowledgement = createDeferred();
          releaseStopAcknowledgement = () => stopAcknowledgement.resolve();
          const originalStopEnvironment = workerNode.supervisor.stopEnvironment.bind(
            workerNode.supervisor,
          );
          vi.spyOn(workerNode.supervisor, "stopEnvironment").mockImplementation(
            async (identity) => {
              stopEntered.resolve();
              try {
                await originalStopEnvironment(identity);
                stopCompleted.resolve();
              } catch (error) {
                stopCompleted.reject(error);
                throw error;
              }
              await stopAcknowledgement.promise;
            },
          );
          const originalCancel = workerNode.supervisor.cancel.bind(workerNode.supervisor);
          vi.spyOn(workerNode.supervisor, "cancel").mockImplementation(async (identity) => {
            if (identity.launchId === oldLaunchId) {
              throw new Error("synthetic node cancellation acknowledgement loss");
            }
            return await originalCancel(identity);
          });
          await expect(
            operator.request("chat.abort", {
              sessionKey: unconfirmedKey,
              runId: unconfirmedRunId,
            }),
          ).resolves.toMatchObject({ aborted: true });
          const unconfirmedResult = await waitForTurn(operator, unconfirmedRunId);
          expect(unconfirmedResult.status).not.toBe("timeout");
          await stopEntered.promise;
          await stopCompleted.promise;
          expect(processIsAlive(oldPid)).toBe(false);
          expect(readTurnClaim(gateway, unconfirmedKey)).toMatchObject({
            turn_claim_owner: null,
            turn_claim_run_id: null,
          });

          const launchCountBeforeSuccessor = workerNode.frames.filter(
            (frame) => frame.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
          ).length;
          const fencedRunId = await startTurn(operator, unconfirmedKey, "WIRE-FENCED-DURING-STOP");
          await expect(
            operator.request("agent.wait", { runId: fencedRunId, timeoutMs: 0 }),
          ).resolves.toMatchObject({ status: "timeout" });
          expect(readTurnClaim(gateway, unconfirmedKey)).toMatchObject({
            turn_claim_owner: null,
            turn_claim_run_id: null,
          });
          expect(launchFrameForRun(workerNode, fencedRunId)).toBeUndefined();
          await expect(
            operator.request("chat.abort", { sessionKey: unconfirmedKey, runId: fencedRunId }),
          ).resolves.toMatchObject({ aborted: true });
          const fencedResult = await waitForTurn(operator, fencedRunId);
          expect(fencedResult.status).not.toBe("timeout");
          releaseStopAcknowledgement();
          releaseStopAcknowledgement = undefined;

          await vi.waitFor(
            async () =>
              expect(await describePlacement(gateway!, unconfirmedKey)).toMatchObject({
                state: "failed",
              }),
            { timeout: PROOF_TIMEOUT_MS, interval: 100 },
          );
          const failedPlacement = await describePlacement(gateway, unconfirmedKey);
          if (typeof failedPlacement.generation !== "number") {
            throw new Error("failed placement omitted its recovery generation");
          }

          const reclaimed = (await gateway.call(
            "sessions.reclaim",
            {
              key: unconfirmedKey,
              recoverToGateway: { expectedGeneration: failedPlacement.generation },
            },
            { timeoutMs: PROOF_TIMEOUT_MS },
          )) as { placement?: Placement };
          expect(reclaimed).toMatchObject({ placement: { state: "local" } });

          const replacementPlacement = await dispatchNodeSession(gateway, unconfirmedKey, nodeId);
          expect(replacementPlacement).toMatchObject({
            state: "active",
            environmentId: expect.any(String),
            activeOwnerEpoch: expect.any(Number),
          });
          expect(replacementPlacement.environmentId).not.toBe(originalPlacement.environmentId);

          const successorRunId = await startTurn(
            operator,
            unconfirmedKey,
            "WIRE-SUCCESSOR-AFTER-STOP",
          );
          const successorResult = waitForTurn(operator, successorRunId);
          await expect(successorResult).resolves.toMatchObject({
            status: "ok",
          });
          await workerNode.waitForInvokes();
          expect(
            workerNode.frames.filter(
              (frame) => frame.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
            ),
          ).toHaveLength(launchCountBeforeSuccessor + 1);
          const lifecycleFrames = workerNode.frames.slice(commandStart);
          const cancelIndex = lifecycleFrames.findIndex(
            (frame) => frame.command === NODE_WORKER_SUPERVISOR_CANCEL_COMMAND,
          );
          const stopIndex = lifecycleFrames.findIndex(
            (frame) => frame.command === NODE_WORKER_ENVIRONMENT_STOP_COMMAND,
          );
          const successorFrame = launchFrameForRun(workerNode, successorRunId);
          const successorIndex = successorFrame ? lifecycleFrames.indexOf(successorFrame) : -1;
          expect({ cancelIndex, stopIndex, successorIndex }).toSatisfy(
            (indexes) =>
              indexes.cancelIndex >= 0 &&
              indexes.stopIndex > indexes.cancelIndex &&
              indexes.successorIndex > indexes.stopIndex,
          );
          expect(workerNode.invokeErrors).toEqual([]);
        },
        () => {
          releaseStopAcknowledgement?.();
          provider.release(HOLD_REVOKED);
          provider.release(HOLD_UNCONFIRMED);
        },
        () => workerNode?.stop(),
        () => cancellationGate.close(),
        () => closeWireServer(published.server),
      );
    },
  );
});
