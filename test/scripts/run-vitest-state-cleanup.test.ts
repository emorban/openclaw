import { execFile, type ExecException } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import packageJson from "../../package.json" with { type: "json" };
import { runManagedCommand } from "../../scripts/lib/managed-child-process.mts";
import { resolveVitestHomeSelection } from "../../scripts/lib/vitest-home-selection.mts";
import { spawnOwnedVitestProcess } from "../../scripts/lib/vitest-process.mts";
import { createVitestResourceOwner } from "../../scripts/lib/vitest-resource-ownership.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";
import { createFixtureLifetime } from "../helpers/fixture-lifetime.js";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { proveNestedRetention } from "./nested-retention.test-support.js";
import { captureOutput, repoRoot, scriptFiles } from "./run-vitest.test-support.js";
import { createPreparedWorkerCompiler } from "./vitest-worker-artifacts.prepared.test-support.js";

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
const nestedLifetime = createFixtureLifetime();
afterEach(() => nestedLifetime.cleanup());
const posixIt = process.platform === "win32" ? it.skip : it;
const testNodeExecPath = resolveTestNodeExecPath();
const preparedCompiler = process.platform === "win32" ? undefined : createPreparedWorkerCompiler();
beforeAll(() => preparedCompiler?.prepare());
afterAll(() => preparedCompiler?.cleanup());
function homeEnv(home: string, tmp: string) {
  return { HOME: home, USERPROFILE: home, TMPDIR: tmp, TMP: tmp, TEMP: tmp };
}

function prepareVitestFixture(root: string, homeName = "home") {
  const files = scriptFiles(root);
  const tmp = path.join(root, "tmp");
  const home = path.join(root, homeName);
  fs.mkdirSync(tmp);
  fs.mkdirSync(home);
  files.write(
    "package.json",
    JSON.stringify({ private: true, type: "module", packageManager: packageJson.packageManager }),
  );
  // Keep pnpm's pinned toolchain record without sharing lockfile writes.
  fs.copyFileSync(path.join(repoRoot, "pnpm-lock.yaml"), path.join(root, "pnpm-lock.yaml"));
  files.linkModules();
  return { tmp, home };
}

posixIt.each([
  { pool: "threads", failAt: undefined },
  { pool: "forks", failAt: 0 },
  { pool: "forks", failAt: 1 },
])(
  "retires SQLite between files and removes the invocation namespace ($pool, failure=$failAt)",
  async ({ pool, failAt }) => {
    const root = tempDirs.make("oc-vt-state-");
    const { home, tmp } = prepareVitestFixture(root);
    const files = scriptFiles(root);
    const databaseModule = JSON.stringify(path.join(repoRoot, "src/state/openclaw-state-db.ts"));
    const receipt = files.path("receipt.json");
    files.write(
      "a.test.ts",
      `import { expect, it } from "vitest";
import { openOpenClawStateDatabase } from ${databaseModule};
it("allocates state", () => {
  const database = openOpenClawStateDatabase({ env: {} });
  database.db.exec("CREATE TABLE sentinel(value TEXT); INSERT INTO sentinel VALUES ('retained')");
  globalThis[Symbol.for("state-fixture")] = database;
  ${failAt === 0 ? 'expect.fail("intentional first-file failure");' : ""}
});`,
    );
    files.write(
      "b.test.ts",
      `import fs from "node:fs";
import { expect, it, vi } from "vitest";
const previous = globalThis[Symbol.for("state-fixture")];
vi.resetModules();
const { openOpenClawStateDatabase } = await import(${databaseModule});
it("reopens retained state", () => {
  expect(previous.db.isOpen).toBe(false);
  const current = openOpenClawStateDatabase({ env: {} });
  expect(current.path).toBe(previous.path);
  expect(current.db).not.toBe(previous.db);
  expect(current.db.prepare("SELECT value FROM sentinel").get().value).toBe("retained");
  fs.writeFileSync(${JSON.stringify(receipt)}, JSON.stringify({ path: current.path }));
  ${failAt === 1 ? 'expect.fail("intentional second-file failure");' : ""}
});`,
    );
    const configPath = files.path("test/vitest/vitest.unit.config.ts");
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    files.write(
      "test/vitest/vitest.unit.config.ts",
      `import { BaseSequencer } from "vitest/node";
const { sharedVitestConfig } = await import(${JSON.stringify(path.join(repoRoot, "test/vitest/vitest.shared.config.ts"))});
class Ordered extends BaseSequencer {
  async sort(files) { return [...files].sort((a, b) => a.moduleId.localeCompare(b.moduleId)); }
}
export default { resolve: sharedVitestConfig.resolve, plugins: sharedVitestConfig.plugins, test: {
  include: ["*.test.ts"], pool: ${JSON.stringify(pool)}, isolate: false, fileParallelism: false, maxWorkers: 1,
  sequence: { sequencer: Ordered }, reporters: ["json"], outputFile: "report.json",
  runner: ${JSON.stringify(path.join(repoRoot, "test/non-isolated-runner.ts"))},
  setupFiles: [${JSON.stringify(path.join(repoRoot, "test/setup.ts"))}],
} };`,
    );
    const env = {
      PATH: process.env.PATH,
      COREPACK_HOME: process.env.COREPACK_HOME,
      ...homeEnv(home, tmp),
      CI: "1",
      LIVE: "0",
      OPENCLAW_LIVE_TEST: "0",
      OPENCLAW_LIVE_GATEWAY: "0",
      OPENCLAW_LIVE_USE_REAL_HOME: "0",
    };
    const result = await new Promise<{ code: ExecException["code"]; output: string }>((resolve) => {
      execFile(
        testNodeExecPath,
        [
          path.join(repoRoot, "scripts/run-vitest.mjs"),
          "run",
          "--config",
          configPath,
          "--root",
          root,
          "--configLoader",
          "native",
        ],
        {
          cwd: root,
          env: preparedCompiler ? preparedCompiler.env(env, "node") : env,
        },
        (error, stdout, stderr) => {
          resolve({ code: error ? error.code : 0, output: stdout + stderr });
        },
      );
    });
    expect(result.code, result.output).toBe(failAt === undefined ? 0 : 1);
    const report = files.json("report.json");
    expect(report).toMatchObject({
      numTotalTests: 2,
      numFailedTests: failAt === undefined ? 0 : 1,
    });
    expect(report.testResults.map((file: { status: string }) => file.status)).toEqual(
      [0, 1].map((index) => (index === failAt ? "failed" : "passed")),
    );
    if (failAt !== undefined) {
      expect(report.testResults[failAt].assertionResults[0].failureMessages.join("\n")).toContain(
        `intentional ${failAt === 0 ? "first" : "second"}-file failure`,
      );
    }
    expect(fs.existsSync(path.dirname(path.dirname(files.json("receipt.json").path)))).toBe(false);
    expect(fs.existsSync(home)).toBe(true);
  },
);

posixIt.each(["0", "1"])(
  "loads only the selected profile at shell level %s",
  async (shellLevel) => {
    const root = tempDirs.make("oc-vt-profile-");
    const { home, tmp } = prepareVitestFixture(root, "home-$source");
    fs.writeFileSync(path.join(home, "profile-marker"), "synthetic-profile");
    fs.writeFileSync(
      path.join(home, ".profile"),
      'export VITEST_HOME_SOURCE_MARKER=$(cat "$HOME/profile-marker")\n',
    );
    const startup = "export VITEST_UNREQUESTED_PROFILE=ambient\n";
    fs.writeFileSync(path.join(home, ".bashrc"), startup);
    const bashEnv = path.join(root, "ambient-profile.sh");
    fs.writeFileSync(bashEnv, startup);
    const { child, completion } = spawnOwnedVitestProcess({
      command: testNodeExecPath,
      args: [
        "--import",
        path.join(repoRoot, "scripts/tsx.mjs"),
        "--input-type=module",
        "-e",
        `
const { installTestEnv } = await import(${JSON.stringify(path.join(repoRoot, "test/test-env.ts"))});
const testEnv = installTestEnv();
console.log(JSON.stringify({
  marker: process.env.VITEST_HOME_SOURCE_MARKER,
  unrequested: process.env.VITEST_UNREQUESTED_PROFILE,
  home: process.env.HOME,
}));
testEnv.cleanup();
`,
      ],
      homeMode: "live-aware",
      options: {
        env: {
          PATH: process.env.PATH,
          ...homeEnv(home, tmp),
          SHLVL: shellLevel,
          BASH_ENV: bashEnv,
          OPENCLAW_LIVE_TEST: "0",
          OPENCLAW_LIVE_USE_REAL_HOME: "1",
          OPENCLAW_LIVE_TEST_QUIET: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    });
    const output = captureOutput(child.stdout!);
    child.stderr!.resume();
    expect((await completion).code).toBe(0);
    const observed = JSON.parse(output.text);
    expect(observed).toMatchObject({ marker: "synthetic-profile" });
    expect(observed.unrequested).toBeUndefined();
    expect(observed.home).not.toBe(home);
  },
);

const config = (name: string) => `test/vitest/vitest.${name}.config.ts`;
function selection(args: string[], expected: string, defaultConfig?: string) {
  return { args: ["run", ...args], expected, defaultConfig };
}

it.each([
  selection(["--config", config("unit-fast")], "hermetic"),
  selection([`--config=${config("full-core-unit-fast")}`], "hermetic"),
  selection(["--project=unit-fast", "--project=unit-fast-isolated"], "hermetic"),
  selection(["--project=unit"], "live-aware"),
  selection(["--config", config("live")], "live-aware"),
  selection(["--config", config("package-contract")], "live-aware"),
  selection(["--config", config("full-core-runtime"), "--project=*"], "live-aware"),
  selection(["--project=unit", "--project=unit-fast"], "mixed"),
  ...["--silent", "--update", "-u", "--coverage.enabled"].map((option) =>
    selection(["--project=unit", option, "--project=unit-fast"], "mixed"),
  ),
  selection(["--silent", "--config", config("live")], "live-aware"),
  selection([`--c=${config("unit-fast")}`], "hermetic", config("unit")),
  selection(["--r=custom-root"], "unknown", config("unit")),
  ...[
    ["-uc", config("unit-fast")],
    [`---c=${config("unit-fast")}`],
    [`--config=${config("unit")}`, `--c=${config("unit-fast")}`],
    ["--project=unit", "--no-project"],
    ["--project=unit", "--project.1=unit-fast"],
    ["--project=unit", "--project.length=0"],
    [`--config=${config("unit")}`, "--c.root=custom-root"],
  ].map((args) => selection(args, "unknown", config("unit"))),
  selection([], "mixed"),
  selection(["--config", config("full-agentic")], "mixed"),
  selection(["--project=unit*"], "unknown"),
  selection(["--config", "custom.config.ts"], "unknown"),
  selection(
    ["--root", "custom-root", "--config", path.join(repoRoot, config("ui-e2e"))],
    "unknown",
  ),
  selection(
    [
      "--root",
      "custom-root",
      "--config",
      path.join(repoRoot, "vitest.config.ts"),
      "--project=unit-fast",
    ],
    "unknown",
  ),
])(
  "enforces $expected selection before admitting an explicit real-home child: $args",
  async ({ args, expected, defaultConfig }) => {
    const root = tempDirs.make("oc-vt-home-selection-");
    const home = path.join(root, "caller-home");
    const tmp = path.join(root, "tmp");
    fs.mkdirSync(home);
    fs.mkdirSync(tmp);
    const marker = path.join(root, "child-started");
    // Resolving a config must never evaluate its contents in the caller process.
    fs.writeFileSync(
      path.join(root, "custom.config.ts"),
      `throw new Error("config evaluated before admission");`,
    );
    const env = {
      ...homeEnv(home, tmp),
      LIVE: "1",
      OPENCLAW_LIVE_TEST: "1",
      OPENCLAW_LIVE_GATEWAY: "1",
      OPENCLAW_LIVE_USE_REAL_HOME: "yes",
    };
    const selectionArgs = args.map((arg) =>
      arg === "custom.config.ts" ? path.join(root, arg) : arg,
    );
    const homeMode = resolveVitestHomeSelection(selectionArgs, {
      cwd: repoRoot,
      env,
      ...(defaultConfig ? { defaultConfig } : {}),
    });
    expect(homeMode).toBe(expected);
    const spec = {
      command: testNodeExecPath,
      args: [
        "--input-type=module",
        "-e",
        `
import fs from "node:fs";
import os, { homedir } from "node:os";
import { Worker } from "node:worker_threads";
fs.writeFileSync(${JSON.stringify(marker)}, "started");
const captured = homedir;
const worker = new Worker('const {parentPort} = require("node:worker_threads"); parentPort.postMessage(require("node:os").homedir());', {
  eval: true, execArgv: [], env: { ...process.env, HOME: "worker-only-home", USERPROFILE: "worker-only-home" },
});
const workerHome = await new Promise((resolve, reject) => { worker.once("message", resolve); worker.once("error", reject); });
await worker.terminate();
console.log(JSON.stringify({ namespace: os.tmpdir(), homes: [os.homedir(), homedir(), captured(), workerHome], live: process.env.LIVE }));
`,
      ],
      homeMode,
      options: { env, stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"] },
    };
    if (expected === "mixed" || expected === "unknown") {
      expect(() => spawnOwnedVitestProcess(spec)).toThrow("known wholly live-aware selection");
      expect(fs.existsSync(marker)).toBe(false);
      expect(fs.readdirSync(tmp)).toEqual([]);
      return;
    }
    const { child, completion } = spawnOwnedVitestProcess(spec);
    const output = captureOutput(child.stdout!);
    child.stderr!.resume();
    expect((await completion).code).toBe(0);
    const observed = JSON.parse(output.text);
    expect(observed.homes).toEqual(
      Array(4).fill(expected === "hermetic" ? path.join(observed.namespace, "home") : home),
    );
    expect(observed.live).toBe(expected === "hermetic" ? undefined : "1");
    expect(fs.existsSync(home)).toBe(true);
    expect(fs.existsSync(observed.namespace)).toBe(process.platform === "win32");
  },
);

it("retains native home after child and pipes close when descendants cannot be verified", async () => {
  const root = tempDirs.make("oc-vt-home-retained-");
  const parent = createVitestResourceOwner(root);
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const { child, completion } = spawnOwnedVitestProcess({
    command: testNodeExecPath,
    args: [
      "--input-type=module",
      "-e",
      'import os from "node:os"; console.log(JSON.stringify({ home: os.homedir(), namespace: os.tmpdir() }));',
    ],
    homeMode: "hermetic",
    options: { detached: false, env: { TMPDIR: root }, stdio: ["ignore", "pipe", "pipe"] },
  });
  const output = captureOutput(child.stdout!);
  child.stderr!.resume();
  try {
    expect((await completion).code).toBe(0);
    const observed = JSON.parse(output.text);
    expect(observed.home).toBe(path.join(observed.namespace, "home"));
    expect(path.dirname(observed.namespace)).toBe(root);
    expect(fs.existsSync(observed.home)).toBe(true);
    expect(() => parent.assertReleased()).toThrow("Unreleased Vitest resource claim");
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining(`retained temporary namespace ${observed.namespace}`),
    );
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining("descendant completion is unverified"),
    );
  } finally {
    log.mockRestore();
  }
});

posixIt.for([
  { pool: "threads", mode: "failure" },
  { pool: "forks", mode: "failure" },
  { pool: "threads", mode: "swallowed" },
  { pool: "threads", mode: "crash" },
  { pool: "forks", mode: "crash" },
] as const)(
  "preserves nested managed-child retention after outer $pool completion ($mode)",
  { timeout: 80_000 },
  async ({ pool, mode }, { signal }) =>
    nestedLifetime.run(async () => {
      const evidence = path.join(repoRoot, ".artifacts/nested-retention");
      fs.mkdirSync(evidence, { recursive: true });
      const root = fs.mkdtempSync(path.join(evidence, `${pool}-${mode}-`));
      prepareVitestFixture(root);
      await proveNestedRetention(root, pool, signal, mode);
      expect(fs.existsSync(root), "successful joined fixture must be removed").toBe(false);
    }),
);

it("removes only its namespace when spawning fails before acquiring a PID", async () => {
  const root = tempDirs.make("oc-vt-spawn-");
  const sentinel = path.join(root, "caller");
  fs.writeFileSync(sentinel, "keep");
  const options = { env: { TMPDIR: root }, stdio: "ignore" as const };
  expect(() => spawnOwnedVitestProcess({ command: "", args: [], options })).toThrow();
  const { child, completion } = spawnOwnedVitestProcess({
    command: testNodeExecPath,
    args: [],
    options: { ...options, cwd: path.join(root, "missing") },
  });
  await expect(completion).rejects.toMatchObject({ code: "ENOENT" });
  expect(child.pid).toBeUndefined();
  expect(fs.readdirSync(root)).toEqual(["caller"]);
  expect(fs.readFileSync(sentinel, "utf8")).toBe("keep");
});

posixIt.each([
  "released",
  "pending",
  "missing receipt",
  "corrupt receipt",
  "unreadable receipt",
  "missing owner",
  "missing registry",
  "missing parent registry",
])("requires positive nested release evidence: %s", async (mode) => {
  const root = tempDirs.make("oc-vt-receipt-");
  const parent = createVitestResourceOwner(root);
  const receipt = path.join(root, "namespace");
  const { completion } = spawnOwnedVitestProcess({
    command: testNodeExecPath,
    args: [
      "--input-type=module",
      "-e",
      `
      import fs from 'node:fs';
      import path from 'node:path';
      import os from 'node:os';
      import { findVitestResourceOwner } from ${JSON.stringify(path.join(repoRoot, "scripts/lib/vitest-resource-ownership.mts"))};
      const root = os.tmpdir(), mode = ${JSON.stringify(mode)};
      fs.writeFileSync(${JSON.stringify(receipt)}, root);
      const release = findVitestResourceOwner().claim();
      const metadata = path.join(root, '.vitest-resource-owner');
      const claims = path.join(metadata, 'claims');
      const released = path.join(claims, fs.readdirSync(claims)[0], 'released');
      if (mode !== 'pending') release();
      if (mode === 'missing receipt' || mode === 'unreadable receipt') fs.unlinkSync(released);
      if (mode === 'unreadable receipt') fs.mkdirSync(released);
      if (mode === 'corrupt receipt') fs.writeFileSync(released, 'not a completion receipt');
      if (mode === 'missing owner') fs.unlinkSync(path.join(metadata, 'owner'));
      if (mode === 'missing registry') fs.rmSync(claims, { recursive: true });
      if (mode === 'missing parent registry') fs.rmSync(path.join(path.dirname(root), '.vitest-resource-owner', 'claims'), { recursive: true });
    `,
    ],
    options: { env: { TMPDIR: root }, stdio: "ignore" },
  });
  if (mode === "released") {
    await expect(completion).resolves.toMatchObject({ code: 0 });
    expect(() => parent.assertReleased()).not.toThrow();
  } else {
    await expect(completion).rejects.toThrow("retained temporary namespace");
    if (mode === "missing parent registry") {
      await expect(completion).rejects.toThrow(`retained temporary namespace ${root};`);
      expect(() => parent.assertReleased()).toThrow(/ENOENT/);
    } else {
      expect(() => parent.assertReleased()).toThrow("Unreleased Vitest resource claim");
    }
  }
  const namespace = fs.readFileSync(receipt, "utf8");
  expect(fs.existsSync(namespace)).toBe(!["released", "missing parent registry"].includes(mode));
});

posixIt("rejects resource registration before allocating inputs or launching work", async () => {
  const root = tempDirs.make("oc-vt-admission-");
  createVitestResourceOwner(root);
  const claims = path.join(root, ".vitest-resource-owner", "claims");
  fs.rmdirSync(claims);
  fs.writeFileSync(claims, "registry unavailable");
  const launched = path.join(root, "launched");
  const args = ["-e", `require('node:fs').writeFileSync(${JSON.stringify(launched)}, 'launched')`];
  const env = { TMPDIR: root, TMP: root, TEMP: root };
  expect(() =>
    spawnOwnedVitestProcess({ command: testNodeExecPath, args, options: { env } }),
  ).toThrow();
  await expect(runManagedCommand({ bin: testNodeExecPath, args, env })).rejects.toThrow();
  for (const [key, value] of Object.entries(env)) {
    vi.stubEnv(key, value);
  }
  try {
    const lifetime = createFixtureLifetime();
    const body = vi.fn(async () => {});
    expect(() => lifetime.run(body)).toThrow();
    expect(() => lifetime.createTempDir("unadmitted-")).toThrow();
    await Promise.resolve();
    expect(body).not.toHaveBeenCalled();
    expect(fs.existsSync(launched)).toBe(false);
    expect(fs.readdirSync(root)).toEqual([".vitest-resource-owner"]);
  } finally {
    vi.unstubAllEnvs();
  }
});

posixIt(
  "retains the exact namespace with recovery guidance when group verification fails",
  async () => {
    const root = tempDirs.make("oc-vt-unverified-");
    createVitestResourceOwner(root);
    const receipt = path.join(root, "namespace");
    const { child, completion } = spawnOwnedVitestProcess({
      command: testNodeExecPath,
      args: [
        "-e",
        `require("node:fs").writeFileSync(${JSON.stringify(receipt)}, require("node:os").tmpdir())`,
      ],
      options: { env: { TMPDIR: root }, stdio: "ignore" },
    });
    const closed = new Promise<void>((resolve) => {
      child.once("close", () => resolve());
    });
    const nativeKill = process.kill.bind(process);
    const failure = Object.assign(new Error("injected group probe failure"), { code: "EIO" });
    const kill = vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === -child.pid! && signal === 0) {
        throw failure;
      }
      return nativeKill(pid, signal);
    });
    try {
      await expect(completion).rejects.toMatchObject({
        message: expect.stringContaining(
          "Stop the remaining writers before removing this exact directory",
        ),
        cause: failure,
      });
      await closed;
      const namespace = fs.readFileSync(receipt, "utf8");
      expect(path.dirname(namespace)).toBe(root);
      expect(fs.existsSync(namespace)).toBe(true);
    } finally {
      kill.mockRestore();
      await closed;
    }
  },
);
