import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { GatewayClient } from "openclaw/plugin-sdk/gateway-runtime";
import { redactSensitiveText } from "openclaw/plugin-sdk/logging-core";
import { describe, expect, it, onTestFailed } from "vitest";
import { createQaGatewayChild } from "../../../../extensions/qa-lab/api.js";
import {
  NODE_WORKER_BUNDLE_INSTALL_COMMAND,
  NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND,
  NODE_WORKER_SUPERVISOR_STATUS_COMMAND,
  NODE_WORKER_WORKSPACE_EXEC_COMMAND,
} from "../../../../src/infra/node-commands.js";
import { createDeferred, withinTest } from "../../../helpers/promise.js";
import { stopQaGatewayFixture } from "../../../helpers/qa-gateway-cleanup.js";
import { runQaGatewayTestFixture } from "../../../helpers/qa-gateway-test-lifetime.js";
import {
  BASELINE_PROMPT,
  BASELINE_REPLY,
  PROOF_TIMEOUT_MS,
  startMidturnProvider,
} from "./cloud-worker-midturn-loss-fixture.js";
import {
  closeWireServer,
  connectWireClient,
  createPairedNodeWorkerHost,
  createPublishedWireWorkspace,
  createWireWorkspaceSettlementWaiter,
  startPairedNodeWorkerGateway,
  type PairedNodeWorkerHost,
  type WireGateway,
  wireMessageText,
} from "./paired-node-worker-wire-fixture.js";

const execFileAsync = promisify(execFile);
const SESSION_KEY = "agent:qa:node-worker-launch-wire";
const TEST_TIMEOUT_MS = PROOF_TIMEOUT_MS + 60_000;
const CONTROL_PROBE_MAX_MS = 4_000;
const CONTROL_PROBE_P95_MS = 1_000;
const FINALIZATION_LOAD_CONCURRENCY = 12;
// One full-capacity wave covers readiness sampling and a fresh connection during finalization.
const FINALIZATION_LOAD_WAVES = 1;
const MIN_CONTROL_PROBE_SAMPLES = 12;
const WORKSPACE_INVENTORY_FILES = 4_096;

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    timeout: 20_000,
  });
  return stdout.trim();
}

function nearestRankPercentile(values: readonly number[], percentile: number): number {
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1);
  return sorted[index] ?? 0;
}

describe("node worker launch wire", () => {
  it(
    "transfers and reconciles a gateway-push workspace through a device runner",
    { timeout: TEST_TIMEOUT_MS },
    async (context) => {
      const testStartedAt = performance.now();
      let provider: Awaited<ReturnType<typeof startMidturnProvider>> | undefined;
      let publishedResource: Awaited<ReturnType<typeof createPublishedWireWorkspace>> | undefined;
      let gateway: WireGateway | undefined;
      let operator: GatewayClient | undefined;
      let workerNode: PairedNodeWorkerHost | undefined;
      let reconnected = false;
      let bundlePrewarm: unknown;
      let launchId: string | undefined;
      let observeFinalizationLoad = false;
      let finalizationStartedAt: number | undefined;
      let resolveWaveFinalizationStarted: ((startedAt: number) => void) | undefined;
      const baselineStatusObserved = createDeferred();
      const loadTerminals = new Map<string, (payload: Record<string, unknown>) => void>();
      let phase = "provider startup";
      const markPhase = (next: string) => {
        phase = next;
      };
      onTestFailed(() => {
        process.stderr.write(
          redactSensitiveText(
            JSON.stringify({
              phase,
              elapsedMs: Math.round(performance.now() - testStartedAt),
              providerRequestCount: provider?.requestCount,
              nodeCommands: workerNode?.commands.slice(-20),
              nodeErrors: workerNode?.invokeErrors.map(String),
            }),
          ).slice(0, 5_000) + "\n",
        );
        if (gateway) {
          process.stderr.write(redactSensitiveText(gateway.logs()).slice(-12_000) + "\n");
        }
      });

      const gatewayOwner = createQaGatewayChild();
      await runQaGatewayTestFixture(
        context,
        async ({ signal, createTempDir }) => {
          const root = createTempDir("openclaw-node-worker-launch-wire-");
          provider = await startMidturnProvider({
            beforeBaselineReply: async () => {
              if (launchId) {
                // Keep the launched turn running through reconnect until status crosses the wire.
                await baselineStatusObserved.promise;
              }
            },
          });
          markPhase("workspace publication");
          const published = (publishedResource = await createPublishedWireWorkspace(root));
          const settlement = createWireWorkspaceSettlementWaiter();
          markPhase("gateway startup");
          gateway = await startPairedNodeWorkerGateway({
            owner: gatewayOwner,
            providerBaseUrl: provider.baseUrl,
            useRepoCli: false,
          });
          markPhase("operator connection");
          operator = await connectWireClient({
            gateway,
            role: "operator",
            identity: null,
            onEvent: (event) => {
              const payload = event.payload;
              if (event.event === "sessions.changed" && isRecord(payload)) {
                // An older snapshot cannot prove this turn's workspace has settled.
                settlement.onEvent({
                  event: event.event,
                  payload: { sessionKey: payload.sessionKey },
                });
              }
              if (
                event.event === "chat" &&
                isRecord(payload) &&
                typeof payload.runId === "string" &&
                (payload.state === "final" ||
                  payload.state === "error" ||
                  payload.state === "aborted")
              ) {
                loadTerminals.get(payload.runId)?.(payload);
                loadTerminals.delete(payload.runId);
              }
            },
          });
          await operator.request("sessions.subscribe", {});
          markPhase("node connection");
          workerNode = await createPairedNodeWorkerHost({
            gateway,
            operator,
            root,
            capacity: FINALIZATION_LOAD_CONCURRENCY,
            bundlePrewarm: true,
            onInvoke: (frame) => {
              if (frame.command === NODE_WORKER_SUPERVISOR_STATUS_COMMAND) {
                baselineStatusObserved.resolve();
              }
              if (frame.command === NODE_WORKER_WORKSPACE_EXEC_COMMAND && frame.paramsJSON) {
                const workspaceCommand = JSON.parse(frame.paramsJSON) as {
                  transfer?: { direction?: unknown };
                };
                if (
                  observeFinalizationLoad &&
                  workspaceCommand.transfer?.direction === "upload" &&
                  resolveWaveFinalizationStarted
                ) {
                  const startedAt = performance.now();
                  finalizationStartedAt ??= startedAt;
                  resolveWaveFinalizationStarted(startedAt);
                  resolveWaveFinalizationStarted = undefined;
                }
              }
              if (frame.command === NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND && frame.paramsJSON) {
                launchId = (JSON.parse(frame.paramsJSON) as { launchId?: string }).launchId;
              }
              if (frame.command === NODE_WORKER_BUNDLE_INSTALL_COMMAND && frame.paramsJSON) {
                bundlePrewarm = (JSON.parse(frame.paramsJSON) as { bundlePrewarm?: unknown })
                  .bundlePrewarm;
              }
            },
            afterInvoke: async (frame, host) => {
              if (frame.command !== NODE_WORKER_SUPERVISOR_LAUNCH_COMMAND || reconnected) {
                return;
              }
              reconnected = true;
              await host.disconnect();
              await host.connect();
            },
          });
          markPhase("baseline workspace creation");
          await operator.request("sessions.create", {
            key: SESSION_KEY,
            agentId: "qa",
            worktree: true,
            // Worktree creation alone inherits tool policy; this probe needs explicit containment.
            permissionMode: "workspace",
            worktreeName: "node-worker-launch-wire",
            worktreeBaseRef: "main",
            cwd: published.source,
          });
          const created = (await gateway.call("sessions.describe", { key: SESSION_KEY })) as {
            session?: { execCwd?: string; spawnedCwd?: string; permissionMode?: string };
          };
          expect(created.session?.permissionMode).toBe("workspace");
          const localWorkspaceDir = created.session?.execCwd ?? created.session?.spawnedCwd;
          expect(localWorkspaceDir).toBeTruthy();
          await fs.writeFile(
            path.join(localWorkspaceDir!, "gateway-push.txt"),
            "dirty gateway workspace\n",
          );
          const inventoryRoot = path.join(localWorkspaceDir!, "inventory-load");
          await fs.mkdir(inventoryRoot);
          for (let start = 0; start < WORKSPACE_INVENTORY_FILES; start += 64) {
            await Promise.all(
              Array.from({ length: 64 }, (_, offset) =>
                fs.writeFile(
                  path.join(inventoryRoot, `file-${start + offset}.txt`),
                  "workspace inventory fixture\n",
                ),
              ),
            );
          }
          markPhase("baseline dispatch");
          const dispatched = await gateway.call(
            "sessions.dispatch",
            { key: SESSION_KEY, deviceId: workerNode.identity.deviceId },
            { timeoutMs: PROOF_TIMEOUT_MS },
          );
          const placement = (dispatched as { placement?: Record<string, unknown> }).placement;
          expect(placement).toMatchObject({
            state: "active",
            workerBundleHash: expect.stringMatching(/^[a-f0-9]{64}$/u),
          });
          const remoteWorkspaceDir = placement?.remoteWorkspaceDir;
          if (typeof remoteWorkspaceDir !== "string" || !remoteWorkspaceDir) {
            throw new Error("active worker placement did not expose a remote workspace directory");
          }
          const baseManifestRef = placement?.workspaceBaseManifestRef;
          if (typeof baseManifestRef !== "string" || !baseManifestRef) {
            throw new Error("Baseline workspace has no dispatched manifest reference");
          }
          await expect(
            fs.readFile(path.join(remoteWorkspaceDir, "gateway-push.txt"), "utf8"),
          ).resolves.toBe("dirty gateway workspace\n");
          await expect(
            fs.readFile(path.join(remoteWorkspaceDir, "nested", "tracked.txt"), "utf8"),
          ).resolves.toBe("nested tracked input\n");
          expect(await fs.readdir(path.join(remoteWorkspaceDir, "inventory-load"))).toHaveLength(
            WORKSPACE_INVENTORY_FILES,
          );
          await expect(
            fs.readFile(
              path.join(
                remoteWorkspaceDir,
                "inventory-load",
                `file-${WORKSPACE_INVENTORY_FILES - 1}.txt`,
              ),
              "utf8",
            ),
          ).resolves.toBe("workspace inventory fixture\n");
          await fs.writeFile(path.join(remoteWorkspaceDir, "node-result.txt"), "device result\n");

          markPhase("baseline turn");
          const runId = `node-worker-launch-wire-${Date.now()}`;
          const started = await operator.request<{ runId?: string; status?: string }>("chat.send", {
            sessionKey: SESSION_KEY,
            message: BASELINE_PROMPT,
            deliver: false,
            idempotencyKey: runId,
          });
          expect(started).toMatchObject({ runId, status: "started" });
          const completed = await operator.request<{ status?: string }>(
            "agent.wait",
            { runId, timeoutMs: PROOF_TIMEOUT_MS },
            { timeoutMs: PROOF_TIMEOUT_MS + 5_000 },
          );
          if (completed.status !== "ok") {
            throw new Error(
              `node worker turn failed: ${JSON.stringify(completed)}\n${gateway.logs().slice(-12_000)}`,
            );
          }
          await settlement.wait(operator, SESSION_KEY, signal, baseManifestRef);
          markPhase("baseline node invocations");
          await workerNode.waitForInvokes();
          expect(workerNode.invokeErrors).toEqual([]);
          expect(reconnected).toBe(true);
          expect(launchId).toBeTruthy();
          expect(bundlePrewarm).toBe(1);
          await expect(workerNode.supervisor.status(launchId!)).resolves.toMatchObject({
            state: "completed",
          });

          const history = await operator.request<{ messages?: unknown[] }>("chat.history", {
            sessionKey: SESSION_KEY,
            limit: 20,
          });
          expect(
            history.messages?.filter(
              (message) =>
                (message as { role?: unknown }).role === "assistant" &&
                wireMessageText(message).includes(BASELINE_REPLY),
            ),
          ).toHaveLength(1);
          markPhase("baseline workspace verification");
          const described = (await gateway.call("sessions.describe", { key: SESSION_KEY })) as {
            session?: {
              execCwd?: string;
              spawnedCwd?: string;
              placement?: { workspaceBaseManifestRef?: string };
            };
          };
          expect(described.session?.placement).toMatchObject({
            state: "active",
            remoteWorkspaceDir,
          });
          expect(described.session?.placement?.workspaceBaseManifestRef).not.toBe(baseManifestRef);
          const reconciledLocalDir = described.session?.execCwd ?? described.session?.spawnedCwd;
          expect(reconciledLocalDir).toBeTruthy();
          await expect(
            fs.readFile(path.join(reconciledLocalDir!, "node-result.txt"), "utf8"),
          ).resolves.toBe("device result\n");
          expect(await git(remoteWorkspaceDir, "rev-parse", "HEAD")).toBe(published.commit);
          expect(await fs.readFile(path.join(remoteWorkspaceDir, "node-result.txt"), "utf8")).toBe(
            "device result\n",
          );

          markPhase("load fixture setup");
          const loadSessions: string[] = [];
          for (let index = 0; index < FINALIZATION_LOAD_CONCURRENCY; index += 1) {
            markPhase(`load workspace creation ${index + 1}/${FINALIZATION_LOAD_CONCURRENCY}`);
            const sessionKey = `${SESSION_KEY}-load-${index}`;
            await operator.request("sessions.create", {
              key: sessionKey,
              agentId: "qa",
              worktree: true,
              worktreeName: `node-worker-launch-load-${index}`,
              worktreeBaseRef: "main",
              cwd: published.source,
            });
            loadSessions.push(sessionKey);
          }
          markPhase("load workspace dispatch");
          const loadGateway = gateway;
          const loadDeviceId = workerNode.identity.deviceId;
          // Worktree creation shares Git state; independent remote transfers can overlap.
          await Promise.all(
            loadSessions.map((key) =>
              loadGateway.call(
                "sessions.dispatch",
                { key, deviceId: loadDeviceId },
                { timeoutMs: PROOF_TIMEOUT_MS },
              ),
            ),
          );
          observeFinalizationLoad = true;
          const readyzSamples: Array<{ atMs: number; latencyMs: number; status: number }> = [];
          const samplerAbort = new AbortController();
          const httpOrigin = gateway.wsUrl.replace(/^ws/u, "http");
          const sampler = (async () => {
            while (!samplerAbort.signal.aborted) {
              const startedAt = performance.now();
              try {
                const response = await fetch(`${httpOrigin}/readyz`, {
                  signal: AbortSignal.timeout(CONTROL_PROBE_MAX_MS),
                });
                readyzSamples.push({
                  atMs: startedAt,
                  latencyMs: performance.now() - startedAt,
                  status: response.status,
                });
              } catch {
                readyzSamples.push({
                  atMs: startedAt,
                  latencyMs: performance.now() - startedAt,
                  status: 0,
                });
              }
              await delay(50);
            }
          })();
          const freshConnectionSamples: number[] = [];
          try {
            for (let wave = 0; wave < FINALIZATION_LOAD_WAVES; wave += 1) {
              markPhase(`load wave ${wave + 1}/${FINALIZATION_LOAD_WAVES} admission`);
              const waveFinalizationStarted = new Promise<number>((resolve) => {
                resolveWaveFinalizationStarted = resolve;
              });
              const loadRuns = await Promise.all(
                loadSessions.map(async (sessionKey, index) => {
                  const loadRunId = `node-worker-finalization-load-${wave}-${index}-${Date.now()}`;
                  const terminal = createDeferred<Record<string, unknown>>();
                  loadTerminals.set(loadRunId, terminal.resolve);
                  const loadStarted = await operator!.request<{ runId?: string; status?: string }>(
                    "chat.send",
                    {
                      sessionKey,
                      message: BASELINE_PROMPT,
                      deliver: false,
                      idempotencyKey: loadRunId,
                    },
                  );
                  expect(loadStarted).toMatchObject({ runId: loadRunId, status: "started" });
                  return { runId: loadRunId, terminal: terminal.promise };
                }),
              );
              const waveGateway = gateway;
              const waveOperator = operator;
              const waits = Promise.all(
                loadRuns.map(async ({ runId: loadRunId, terminal }) => {
                  // agent.wait reports queued turns immediately; chat publishes their completion.
                  const completedLoad = await withinTest(terminal, signal);
                  expect(
                    completedLoad,
                    `load run ${loadRunId} failed\n${redactSensitiveText(JSON.stringify(completedLoad)).slice(0, 4000)}\n${waveGateway.logs().slice(-12_000)}`,
                  ).toMatchObject({ state: "final" });
                }),
              );
              markPhase(`load wave ${wave + 1}/${FINALIZATION_LOAD_WAVES} finalization`);
              // Committed replies may precede workspace finalization; failures still stop the wait.
              await withinTest(
                Promise.race([waveFinalizationStarted, waits.then(() => waveFinalizationStarted)]),
                signal,
              );
              markPhase(`load wave ${wave + 1}/${FINALIZATION_LOAD_WAVES} control connection`);
              const freshConnectionStartedAt = performance.now();
              const freshClient = await connectWireClient({
                gateway,
                role: "operator",
                identity: null,
                timeoutMs: CONTROL_PROBE_MAX_MS,
              });
              freshConnectionSamples.push(performance.now() - freshConnectionStartedAt);
              await freshClient.stopAndWait({ timeoutMs: 2_000 });
              markPhase(`load wave ${wave + 1}/${FINALIZATION_LOAD_WAVES} completion`);
              await waits;
              await Promise.all(
                loadSessions.map((sessionKey) => settlement.wait(waveOperator, sessionKey, signal)),
              );
            }
          } finally {
            samplerAbort.abort();
            await Promise.allSettled([sampler]);
          }
          const finalizationSamples = readyzSamples.filter(
            (sample) => sample.atMs >= (finalizationStartedAt ?? Number.POSITIVE_INFINITY),
          );
          expect(finalizationSamples.length).toBeGreaterThanOrEqual(MIN_CONTROL_PROBE_SAMPLES);
          expect(finalizationSamples.every((sample) => sample.status === 200)).toBe(true);
          const readyzLatencies = finalizationSamples.map((sample) => sample.latencyMs);
          expect(nearestRankPercentile(readyzLatencies, 95)).toBeLessThan(CONTROL_PROBE_P95_MS);
          expect(Math.max(...readyzLatencies)).toBeLessThan(CONTROL_PROBE_MAX_MS);
          expect(Math.max(...freshConnectionSamples)).toBeLessThan(CONTROL_PROBE_MAX_MS);
          expect(freshConnectionSamples).toHaveLength(FINALIZATION_LOAD_WAVES);

          markPhase("workspace settlement before node shutdown");
          const settlementOperator = operator;
          await Promise.all(
            [SESSION_KEY, ...loadSessions].map((key) =>
              settlement.wait(settlementOperator, key, signal),
            ),
          );
          markPhase("node shutdown");
          await workerNode.stop();
          workerNode = undefined;
          await operator.stopAndWait({ timeoutMs: 2_000 });
          operator = undefined;
          markPhase("fixture cleanup");
        },
        async () => {
          baselineStatusObserved.resolve();
          markPhase("fixture cleanup start");
          const cleanup = await Promise.allSettled([
            workerNode?.stop(),
            operator?.stopAndWait({ timeoutMs: 2_000 }),
            stopQaGatewayFixture(gatewayOwner),
            provider?.stop(),
            publishedResource ? closeWireServer(publishedResource.server) : undefined,
          ]);
          const failures = cleanup.flatMap((result) =>
            result.status === "rejected" ? [result.reason] : [],
          );
          if (failures.length === 1) {
            throw failures[0];
          }
          if (failures.length > 1) {
            throw new AggregateError(failures, "Node worker launch wire cleanup failed");
          }
        },
      );
    },
  );
});
