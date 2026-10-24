import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it } from "vitest";
import {
  collectHostedGateEvidence as collectRaw,
  HOSTED_GATE_MAX_AGE_HOURS,
  loadPullRequestCommitShas,
  main,
  notApplicableScheduledHostedWorkflows,
  parseArgs,
  parseWorkflowRunPage,
  SCHEDULED_HOSTED_WORKFLOWS,
  workflowRunQueryPaths,
  workflowRunPageCount,
} from "../../scripts/verify-pr-hosted-gates.mts";
import { resolveTestNodeExecPath } from "../../src/test-utils/node-process.js";

const sha = "773ffd87a1e1e34451ad6e38fda37380c2569a50";
const mainSha = "d".repeat(40);
const previousSha = "8d86c44c6144f8f726a460914cddb8c9c201f119";
const scheduledFallbackSha = "ad620a11e5d9ed3888b6afb3c35c4c30e8054f4e";
const pr = 100606;
const nowMs = Date.parse("2026-06-17T10:55:00Z");
const stale = "2026-06-16T10:54:59Z";
const ARM = "Blacksmith ARM Testbox";
const BOX = "Blacksmith Testbox";
const SANITY = "Workflow Sanity";
const ARTIFACTS = "Blacksmith Build Artifacts Testbox";
const queuedArtifactCoverage = [
  { name: ARTIFACTS, coveredBy: "CI release gate", reason: "scheduled workflow is queued" },
];
const requiredCliArgs = [
  "--repo",
  "openclaw/openclaw",
  "--sha",
  sha,
  "--pr",
  String(pr),
  "--output",
  ".local/gates-hosted-checks.json",
  "--main-sha",
  mainSha,
];
type Options = Parameters<typeof collectRaw>[0];
type Run = {
  id: number;
  run_number: number;
  run_attempt?: number;
  name: string;
  event: string;
  status: string;
  conclusion: string | null;
  head_sha: string;
  head_branch: string;
  head_repository: { full_name: string };
  pull_requests: Array<{ number: number }>;
  path: string;
  created_at: string;
  updated_at: string;
  html_url: string;
  display_title?: string;
};
type GitExec = (args: string[], options?: { input?: string }) => string;
type CollectOptions = Omit<Options, "nowMs" | "pr" | "mainSha" | "sha" | "workflowRuns">;

function makeRun(name: string, id: number, minute = 50, overrides: Partial<Run> = {}): Run {
  return {
    id,
    run_number: id,
    name,
    event: "pull_request",
    status: "completed",
    conclusion: "success",
    head_sha: sha,
    head_branch: "codex/clean-expanded-tool-calls",
    head_repository: { full_name: "openclaw/openclaw" },
    pull_requests: [{ number: pr }],
    path: ".github/workflows/ci.yml",
    created_at: "2026-06-17T10:46:24Z",
    updated_at: `2026-06-17T10:${String(minute).padStart(2, "0")}:00Z`,
    html_url: `https://github.com/openclaw/openclaw/actions/runs/${id}`,
    ...overrides,
  };
}
const ci = (id = 1, overrides: Partial<Run> = {}, minute = 50) =>
  makeRun("CI", id, minute, overrides);
const pending = (id: number, minute = 54, status = "queued") =>
  makeRun("CI", id, minute, { status, conclusion: null });
const releaseGate = (id: number, minute = 49, overrides: Partial<Run> = {}) =>
  makeRun(`CI release gate ${sha}`, id, minute, {
    event: "workflow_dispatch",
    display_title: `CI release gate ${sha}`,
    ...overrides,
  });
const priorCi = (overrides: Partial<Run> = {}) =>
  ci(101, { updated_at: "2026-06-17T09:55:00Z", head_sha: previousSha, ...overrides });
const collect = (workflowRuns: Run[], options: CollectOptions = {}) =>
  collectRaw({ nowMs, pr, mainSha, sha, workflowRuns, ...options });
function rejects(runs: Run[], options: CollectOptions = {}, workflow = "CI", head = sha) {
  expect(() => collect(runs, options)).toThrow(
    `Missing successful recent ${workflow} workflow for ${head}`,
  );
}
const matching = (fields: Record<string, unknown>) => expect.objectContaining(fields);
function exact(runs: Run[], workflows: Record<string, unknown>[], options: CollectOptions = {}) {
  expect(collect(runs, options)).toEqual({ headSha: sha, workflows: workflows.map(matching) });
}
function queuedArtifacts() {
  return [
    releaseGate(1),
    ci(3, {}, 51),
    makeRun(BOX, 4, 52),
    makeRun(ARM, 5, 53),
    makeRun(SANITY, 6, 54),
    makeRun(ARTIFACTS, 2, 50, { status: "queued", conclusion: null }),
  ];
}
type PatchOptions = {
  priorPatchId?: string;
  unfetchableShas?: Set<string>;
  failCommand?: string;
};
function patchExec({
  priorPatchId = "a".repeat(40),
  unfetchableShas = new Set<string>(),
  failCommand,
}: PatchOptions = {}) {
  const calls: string[] = [];
  const execGit: GitExec = (args, options = {}) => {
    const command = args.join(" ");
    calls.push(command);
    if (command === failCommand) {
      throw new Error(`mock failure: ${command}`);
    }
    switch (args[0]) {
      case "cat-file":
      case "fetch":
        if (unfetchableShas.has(args[2]?.replace(/\^\{commit\}$/u, "") ?? "")) {
          throw new Error("unavailable object");
        }
        return "";
      case "merge-base":
        return `${(args[2] === sha ? "b" : "c").repeat(40)}\n`;
      case "diff":
        return `diff:${args[2]}`;
      case "patch-id":
        return `${options.input === `diff:${sha}` ? "a".repeat(40) : priorPatchId} ${"0".repeat(40)}\n`;
      default:
        throw new Error(`unexpected git command: ${command}`);
    }
  };
  return { calls, execGit };
}
const reuse = (candidate = priorCi(), execGit = patchExec().execGit) => ({
  loadCiReuseCandidates: () => [candidate],
  execGit,
});
const reused = (id: number, fields: Record<string, unknown>) => ({
  headSha: sha,
  workflows: [matching({ id, ...fields })],
  reusedFromSha: previousSha,
  reusedRunId: id,
  patchIdMatched: true,
});
const fork = (overrides: Partial<Run>): Partial<Run> => ({
  head_branch: "fix/token-listener",
  head_repository: { full_name: "contributor/openclaw" },
  pull_requests: [],
  ...overrides,
});
const forkMembership = {
  pullRequestCommitShas: [previousSha, sha],
  pullRequestHeadBranch: "fix/token-listener",
  pullRequestHeadRepository: "contributor/openclaw",
};
function withGitRepository(check: (git: GitExec, root: string) => void) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "openclaw-hosted-gates-")));
  const git: GitExec = (args, options) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8", input: options?.input });
    expect(result.status, `git ${args.join(" ")}\n${result.stderr}`).toBe(0);
    return result.stdout;
  };
  try {
    git(["init", "-q", "-b", "main"]);
    for (const [key, value] of [
      ["user.name", "OpenClaw Test"],
      ["user.email", "test@example.invalid"],
      ["commit.gpgSign", "false"],
      ["core.hooksPath", "/dev/null"],
    ]) {
      git(["config", key, value]);
    }
    check(git, root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe("verify-pr-hosted-gates", () => {
  it("compares patch IDs against one main snapshot while the shared ref advances", () => {
    withGitRepository((git, root) => {
      writeFileSync(join(root, "subject.txt"), "base\n");
      git(["add", "."]);
      git(["commit", "-qm", "base"]);
      const snapshot = git(["rev-parse", "HEAD"]).trim();
      git(["update-ref", "refs/remotes/origin/main", snapshot]);
      writeFileSync(join(root, "subject.txt"), "reviewed\n");
      git(["commit", "-qam", "reviewed"]);
      const target = git(["rev-parse", "HEAD"]).trim();
      git(["commit", "--allow-empty", "-qm", "same tree, different commit"]);
      const candidate = git(["rev-parse", "HEAD"]).trim();
      let comparisons = 0;
      const evidence = collectRaw({
        sha: target,
        mainSha: snapshot,
        pr,
        nowMs,
        workflowRuns: [],
        loadCiReuseCandidates: () => [priorCi({ head_sha: candidate })],
        execGit: (args, options) => {
          const result = git(args, options);
          if (args[0] === "patch-id" && ++comparisons === 1) {
            git(["update-ref", "refs/remotes/origin/main", candidate]);
          }
          return result;
        },
      });
      expect(evidence).toMatchObject({ reusedFromSha: candidate, patchIdMatched: true });
      expect(comparisons).toBe(2);
      expect(git(["rev-parse", "refs/remotes/origin/main"]).trim()).toBe(candidate);
    });
  });

  it("starts from an older target cwd without current normalization helpers", () => {
    const root = mkdtempSync(join(tmpdir(), "openclaw-old-cwd-"));
    try {
      const normalization = join(root, "packages/normalization-core/src");
      mkdirSync(normalization, { recursive: true });
      writeFileSync(
        join(root, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            baseUrl: ".",
            paths: { "@openclaw/normalization-core/*": ["packages/normalization-core/src/*"] },
          },
        }),
      );
      writeFileSync(join(normalization, "number-coercion.ts"), "export const legacy = true;\n");
      writeFileSync(
        join(normalization, "record-coerce.ts"),
        [
          "export function isRecord(value: unknown): value is Record<string, unknown> {",
          '  return typeof value === "object" && value !== null && !Array.isArray(value);',
          "}",
          "export function readStringField(record: Record<string, unknown>, key: string) {",
          "  const value = record[key];",
          '  return typeof value === "string" ? value : undefined;',
          "}",
          "",
        ].join("\n"),
      );
      const result = spawnSync(
        resolveTestNodeExecPath(),
        [join(process.cwd(), "scripts/verify-pr-hosted-gates.mjs"), "--older-cwd-startup-probe"],
        { cwd: root, encoding: "utf8" },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("Unknown option: --older-cwd-startup-probe");
    } finally {
      rmSync(root, { force: true, recursive: true });
    }
  });

  it("derives hosted-gate applicability from declared workflow path filters", () => {
    for (const path of [".github/workflows/ci.yml", "test/e2e/qa-lab/runtime/script-evidence.ts"]) {
      expect(notApplicableScheduledHostedWorkflows([path])).toEqual([BOX, ARM, ARTIFACTS]);
    }
    expect(
      notApplicableScheduledHostedWorkflows([".github/actions/setup-node-env/action.yml"]),
    ).toEqual([]);
    expect(notApplicableScheduledHostedWorkflows(["CHANGELOG.md"])).toEqual(
      SCHEDULED_HOSTED_WORKFLOWS,
    );
  });
  it("requires an authoritative ARM run when declared workflow paths apply", () => {
    rejects(
      [ci(), makeRun(BOX, 2), makeRun(ARTIFACTS, 3), makeRun(SANITY, 4)],
      { notApplicableScheduledWorkflows: [] },
      ARM,
    );
  });
  it("records path-filtered hosted gates as not applicable for QA-only changes", () => {
    expect(
      collect([ci(), makeRun(SANITY, 2)], {
        notApplicableScheduledWorkflows: [BOX, ARM, ARTIFACTS],
      }),
    ).toEqual({
      headSha: sha,
      workflows: [matching({ name: "CI", id: 1 }), matching({ name: SANITY, id: 2 })],
      notApplicableWorkflows: [BOX, ARM, ARTIFACTS],
    });
  });
  it("does not require path-inapplicable ARM proof for queued artifact fallback", () => {
    expect(
      collect(
        queuedArtifacts().filter((run) => run.name !== ARM),
        {
          notApplicableScheduledWorkflows: [ARM],
        },
      ),
    ).toMatchObject({
      fallbackCoveredWorkflows: queuedArtifactCoverage,
      notApplicableWorkflows: [ARM],
    });
  });
  it.each([
    ["different patch", { priorPatchId: "d".repeat(40) }],
    ["unfetchable head", { unfetchableShas: new Set([previousSha]) }],
    ["failed patch proof", { failCommand: `merge-base ${mainSha} ${previousSha}` }],
  ] satisfies Array<[string, PatchOptions]>)("rejects CI reuse with %s", (name, options) => {
    const { calls, execGit } = patchExec(options);
    rejects([], reuse(priorCi(), execGit));
    if (name === "unfetchable head") {
      expect(calls).toContain(`fetch origin ${previousSha}`);
    }
  });
  it("filters prior runs by successful qualifying CI shape", () => {
    let gitCalled = false;
    rejects([], {
      loadCiReuseCandidates: () => [
        priorCi({ updated_at: stale }),
        priorCi({ conclusion: "failure" }),
        priorCi({ name: "Docs" }),
        priorCi({
          event: "workflow_dispatch",
          display_title: `CI release gate ${previousSha}`,
          path: ".github/workflows/not-ci.yml",
        }),
      ],
      execGit: () => {
        gitCalled = true;
        throw new Error("invalid candidates must be filtered before git");
      },
    });
    expect(gitCalled).toBe(false);
  });
  it("accepts a patch-identical prior release-gate run with the exact dispatch title", () => {
    expect(
      collect(
        [],
        reuse(
          priorCi({
            id: 102,
            event: "workflow_dispatch",
            display_title: `CI release gate ${previousSha}`,
          }),
        ),
      ),
    ).toEqual(reused(102, { event: "workflow_dispatch" }));
  });
  it("short-circuits reuse discovery when exact-head CI already succeeds", () => {
    let called = false;
    const unexpected = () => {
      called = true;
      throw new Error("exact-head success must not inspect reuse proof");
    };
    exact([ci()], [{ id: 1, headSha: sha }], {
      loadCiReuseCandidates: unexpected,
      execGit: unexpected,
    });
    expect(called).toBe(false);
  });
  it.each([false, true])(
    "accepts only current-attempt proof for pending CI (earlier failure: %s)",
    (earlierFailure) => {
      const attempt = earlierFailure ? 1 : 2;
      const failed = ci(40, { conclusion: "failure" }, 40);
      const inProgress = {
        ...pending(42, 52, "in_progress"),
        run_attempt: attempt,
        created_at: "2026-06-17T10:50:00Z",
      };
      const runs = earlierFailure ? [failed, inProgress] : [inProgress];
      const gate = {
        name: "openclaw/ci-gate",
        run_id: 42,
        run_attempt: attempt,
        status: "completed",
        conclusion: "success",
        completed_at: "2026-06-17T10:51:30Z",
      };
      expect(collect(runs, { ciGateJobs: [gate] }).workflows).toContainEqual(matching({ id: 42 }));
      for (const ciGateJobs of [
        [{ ...gate, run_attempt: attempt - 1 }],
        [{ ...gate, run_id: 41 }],
        [{ ...gate, conclusion: "failure" }],
        [],
      ]) {
        rejects(runs, { ciGateJobs });
      }
      if (earlierFailure) {
        rejects([failed], { ciGateJobs: [gate] });
        rejects([failed, { ...inProgress, created_at: "2026-06-17T10:40:00Z" }], {
          ciGateJobs: [gate],
        });
      }
    },
  );
  it("retains the newest non-skipped scheduled decision by creation order", () => {
    exact(
      [
        ci(),
        makeRun(ARM, 10, 54),
        makeRun(ARM, 20, 53),
        makeRun(ARM, 30, 50, { conclusion: "skipped" }),
      ],
      [
        { name: "CI", id: 1 },
        { name: ARM, id: 20 },
      ],
    );
  });
  it("covers queued artifacts after a skipped duplicate of a supporting gate", () => {
    const evidence = collect([
      ...queuedArtifacts(),
      makeRun(ARM, 30, 50, { conclusion: "skipped" }),
    ]);
    expect(evidence.workflows).toContainEqual(matching({ name: ARM, id: 5 }));
    expect(evidence.fallbackCoveredWorkflows).toEqual(queuedArtifactCoverage);
  });
  it("does not look past a non-skipped unsuccessful scheduled decision", () => {
    for (const [status, conclusion] of [
      ["completed", "failure"],
      ["completed", "cancelled"],
      ["completed", "timed_out"],
      ["completed", "action_required"],
      ["completed", "neutral"],
      ["completed", "unknown"],
      ["completed", null],
      ["queued", null],
      ["in_progress", null],
      ["unknown", "skipped"],
      ["in_progress", "skipped"],
    ] as const) {
      rejects(
        [
          ci(),
          makeRun(ARM, 10, 54),
          makeRun(ARM, 20, 53, { run_attempt: 2, status, conclusion }),
          makeRun(ARM, 30, 50, { conclusion: "skipped" }),
        ],
        {},
        ARM,
      );
    }
  });
  it("requires eligible recent scheduled success before a skipped duplicate", () => {
    const success = makeRun(ARM, 10, 54);
    const variants: Run[][] = [
      [],
      [{ ...success, updated_at: stale }],
      [{ ...success, updated_at: "2026-06-17T11:01:00Z" }],
      [{ ...success, event: "workflow_dispatch" }],
      [{ ...success, name: "Unrelated" }],
      [{ ...success, head_sha: previousSha, pull_requests: [{ number: pr + 1 }] }],
    ];
    for (const runs of variants) {
      rejects([ci(), ...runs, makeRun(ARM, 30, 50, { conclusion: "skipped" })], {}, ARM);
    }
  });
  it.each([
    [
      "scheduled CI at the age boundary",
      [ci(1, { updated_at: "2026-06-16T10:55:00Z" })],
      { name: "CI", id: 1 },
    ],
    ["changelog-only head without CI", [], undefined, true],
    [
      "manual CI at the age boundary",
      [
        releaseGate(1, 50, {
          updated_at: "2026-06-16T10:55:00Z",
          path: ".github/workflows/ci.yml@refs/heads/release-controls",
        }),
      ],
      { name: `CI release gate ${sha}`, id: 1 },
    ],
    [
      "later success after failure",
      [ci(1, { conclusion: "failure" }), ci(2, {}, 52)],
      { name: "CI", id: 2, headSha: sha },
    ],
    [
      "target success before obsolete-head failure",
      [ci(), ci(2, { head_sha: previousSha, conclusion: "failure" }, 54)],
      { name: "CI", id: 1, headSha: sha },
    ],
    ...(
      [
        ["stale", ci(1, { updated_at: stale })],
        ["cancelled", ci(1, { conclusion: "cancelled" })],
        ["skipped", ci(1, { conclusion: "skipped" })],
      ] satisfies Array<[string, Run]>
    ).map(([state, run]): [string, Run[], { name: string; id: number }] => [
      `manual fallback after ${state}`,
      [run, releaseGate(2)],
      { name: `CI release gate ${sha}`, id: 2 },
    ]),
    [
      "newer manual over older pending",
      [pending(1, 48, "in_progress"), releaseGate(2)],
      { name: `CI release gate ${sha}`, id: 2 },
    ],
  ] satisfies Array<[string, Run[], { name: string; id: number; headSha?: string }?, boolean?]>)(
    "selects %s",
    (_name, runs, selected, changelogOnly) =>
      exact(runs, selected ? [selected] : [], { changelogOnly }),
  );

  it.each([
    ["unlinked PR commit", [previousSha, sha], [], true],
    ["unlinked non-PR commit", [sha], [], false],
    ["PR commit explicitly linked to another PR", [previousSha, sha], [{ number: pr + 1 }], false],
  ] satisfies Array<[string, string[], Array<{ number: number }>, boolean]>)(
    "validates scheduled fallback membership for %s",
    (_name, commits, links, accepted) => {
      const runs = [
        ci(),
        makeRun(ARM, 2, 54, { status: "queued", conclusion: null }),
        makeRun(ARM, 3, 53, fork({ head_sha: previousSha, pull_requests: links })),
      ];
      const options = { ...forkMembership, pullRequestCommitShas: commits };
      if (accepted) {
        expect(collect(runs, options)).toEqual({
          headSha: sha,
          workflows: [
            matching({ name: "CI", id: 1, headSha: sha }),
            matching({ name: ARM, id: 3, headSha: previousSha }),
          ],
          evidenceHeadSha: previousSha,
        });
      } else {
        rejects(runs, options, ARM);
      }
    },
  );
  it("loads the complete PR commit set with one local rev-list command", () => {
    const baseSha = "a".repeat(40);
    const shas = Array.from({ length: 301 }, (_, index) =>
      (index + 1).toString(16).padStart(40, "0"),
    );
    const headSha = expectDefined(shas.at(-1), "generated head sha");
    const calls: string[][] = [];
    expect(
      loadPullRequestCommitShas({ baseSha, headSha }, (args) => {
        calls.push(args);
        return `${shas.join("\n")}\n`;
      }),
    ).toEqual(shas);
    expect(calls).toEqual([["rev-list", "--reverse", `${baseSha}..${headSha}`]]);
  });
  it.each([
    ["uppercase object id", `${"A".repeat(40)}\n`],
    ["blank line", `${"a".repeat(40)}\n\n${"b".repeat(40)}\n`],
    ["empty output", ""],
    [
      "missing head",
      `${"c".repeat(40)}\n`,
      `Expected pull request commit list to contain head ${"b".repeat(40)}.`,
    ],
    ["command failure", new Error("git rev-list failed")],
  ] satisfies Array<[string, string | Error, string?]>)(
    "rejects rev-list %s",
    (_name, output, error) => {
      expect(() =>
        loadPullRequestCommitShas({ baseSha: "a".repeat(40), headSha: "b".repeat(40) }, () => {
          if (output instanceof Error) {
            throw output;
          }
          return output;
        }),
      ).toThrow(
        output instanceof Error
          ? output
          : (error ?? "Expected pull request commit object ids from git rev-list."),
      );
    },
  );
  it("keeps complete membership when the PR head is behind the current base", () => {
    withGitRepository((git) => {
      const commit = (message: string) => {
        git(["commit", "-q", "--allow-empty", "-m", message]);
        return git(["rev-parse", "HEAD"]).trim();
      };
      commit("root");
      git(["branch", "feature"]);
      commit("main one");
      const baseSha = commit("main two");
      git(["switch", "-q", "feature"]);
      const first = commit("feature one");
      const headSha = commit("feature two");
      expect(loadPullRequestCommitShas({ baseSha, headSha }, (args) => git(args))).toEqual([
        first,
        headSha,
      ]);
      expect(Number(git(["rev-list", "--count", `${headSha}..${baseSha}`]).trim())).toBe(2);
    });
  });
  it("requires recent evidence for scheduled gates observed on the target head", () => {
    const prior = ci(1, { head_sha: previousSha });
    const runs = [
      prior,
      pending(2, 54, "in_progress"),
      makeRun(ARM, 3, 54, { status: "queued", conclusion: null }),
    ];
    const options = { recentSha: previousSha, ...reuse(prior) };
    rejects(runs, options, ARM, previousSha);
    expect(
      collect([...runs, makeRun(ARM, 4, 51, { head_sha: previousSha })], options),
    ).toMatchObject({
      workflows: [
        matching({ name: "CI", headSha: previousSha }),
        matching({ name: ARM, headSha: previousSha }),
      ],
      reusedFromSha: previousSha,
      reusedRunId: 1,
      patchIdMatched: true,
    });
  });
  it("keeps the existing scheduled-workflow fallback after CI reuses another head", () => {
    const prior = priorCi({ id: 1 });
    expect(
      collect(
        [
          prior,
          pending(2, 54, "in_progress"),
          makeRun(ARM, 3, 54, { status: "queued", conclusion: null }),
          makeRun(ARM, 4, 53, { head_sha: scheduledFallbackSha }),
        ],
        reuse(prior),
      ),
    ).toMatchObject({
      headSha: sha,
      workflows: [
        matching({ name: "CI", headSha: previousSha }),
        matching({ name: ARM, headSha: scheduledFallbackSha }),
      ],
      evidenceHeadSha: scheduledFallbackSha,
      reusedFromSha: previousSha,
      reusedRunId: 1,
      patchIdMatched: true,
    });
  });
  it.each([
    [
      "13-hour evidence with a pending run",
      [pending(2, 54, "in_progress")],
      "2026-06-16T21:55:00Z",
    ],
    ["failed scheduled run", [ci(2, { conclusion: "failure" })]],
  ] satisfies Array<[string, Run[], string?]>)(
    "reuses patch-identical CI after %s",
    (_name, runs, updated_at = "2026-06-17T10:50:00Z") => {
      const prior = priorCi({ id: 1, updated_at });
      expect(collect([prior, ...runs], { recentSha: previousSha, ...reuse(prior) })).toEqual(
        reused(1, { name: "CI", headSha: previousSha }),
      );
    },
  );
  it.each([{ conclusion: "failure" }, { updated_at: stale }])(
    "rejects an invalid gate in the recorded head's cohort: %j",
    (overrides) => {
      const prior = priorCi({ id: 1, updated_at: "2026-06-17T10:50:00Z" });
      rejects(
        [
          prior,
          makeRun(ARM, 2, 51, { head_sha: previousSha, ...overrides }),
          pending(3, 54, "in_progress"),
          makeRun(ARM, 4, 54, { status: "queued", conclusion: null }),
        ],
        { recentSha: previousSha, ...reuse(prior) },
        ARM,
        previousSha,
      );
    },
  );
  it("retains a recent scheduled success after cancellation, but not pending reruns", () => {
    const success = ci(1, {}, 47);
    exact([success, ci(2, { conclusion: "cancelled" }, 48)], [{ name: "CI", id: 1 }]);
    for (const status of ["queued", "in_progress"]) {
      rejects([success, pending(2, 48, status)]);
    }
  });
  it.each([
    ["missing CI", []],
    ["stale scheduled CI", [ci(1, { updated_at: stale })]],
    ["stale manual CI", [releaseGate(2, 50, { updated_at: stale })]],
    ["skipped-only scheduled CI", [ci(1, { conclusion: "skipped" })]],
    ["in-progress over older manual", [releaseGate(1), pending(2, 50, "in_progress")]],
    [
      "pending over neutral and manual",
      [ci(1, { conclusion: "skipped" }, 48), releaseGate(2), pending(3, 50)],
    ],
    [
      "newer failure despite inverted completion times",
      [makeRun("CI", 1, 54), makeRun("CI", 2, 49, { conclusion: "failure" })],
    ],
    [
      "scheduled failure before manual fallback",
      [ci(1, { updated_at: stale, conclusion: "failure" }), releaseGate(2)],
    ],
    [
      "scheduled failure before skipped run and fallback",
      [ci(1, { conclusion: "failure" }, 47), ci(2, { conclusion: "skipped" }, 48), releaseGate(3)],
    ],
    [
      "scheduled failure before pending rerun and fallback",
      [ci(1, { conclusion: "failure" }, 47), pending(2, 48, "in_progress"), releaseGate(3)],
    ],
    ["unmarked manual run", [releaseGate(1, 47, { display_title: "CI" })]],
    [
      "manual title on another workflow",
      [releaseGate(1, 47, { path: ".github/workflows/something-else.yml" })],
    ],
  ] satisfies Array<[string, Run[]]>)("rejects %s", (_name, runs) => rejects(runs));
  it("covers a queued artifact Testbox only with a completed exact CI fallback", () => {
    expect(collect(queuedArtifacts())).toEqual({
      headSha: sha,
      workflows: [
        matching({ name: "CI", id: 3 }),
        matching({ name: BOX, id: 4 }),
        matching({ name: ARM, id: 5 }),
        matching({ name: SANITY, id: 6 }),
      ],
      fallbackCoveredWorkflows: queuedArtifactCoverage,
    });
  });
  it.each([
    ...[0, 30].map(
      (id) =>
        [
          `skipped artifact history at run ${id}`,
          [...queuedArtifacts(), makeRun(ARTIFACTS, id, 50, { conclusion: "skipped" })],
        ] as const,
    ),
    ...(
      [
        ["release gate", 0],
        ["supporting gate", 4],
        ["queued artifact run", 5],
      ] satisfies Array<[string, number]>
    ).map(
      ([name, staleIndex]) =>
        [
          `stale ${name}`,
          queuedArtifacts().map((run, index) =>
            index === staleIndex ? Object.assign({}, run, { updated_at: stale }) : run,
          ),
        ] as const,
    ),
    [
      "an older failed artifact run",
      [
        ...queuedArtifacts(),
        makeRun(ARTIFACTS, 7, 50, { updated_at: stale, conclusion: "failure" }),
      ],
    ],
    [
      "missing supporting gates",
      [releaseGate(1), makeRun(ARTIFACTS, 2, 50, { status: "queued", conclusion: null })],
    ],
    ...[
      makeRun(ARTIFACTS, 2, 50, { status: "in_progress", conclusion: null }),
      makeRun(ARTIFACTS, 3, 51, { conclusion: "failure" }),
    ].map((run) => [`artifact ${run.status}/${run.conclusion}`, [releaseGate(1), run]] as const),
    [
      "failure before a queued artifact retry",
      [
        releaseGate(1),
        makeRun(ARTIFACTS, 4, 52, { conclusion: "failure" }),
        makeRun(ARTIFACTS, 5, 53, { status: "queued", conclusion: null }),
      ],
    ],
  ] satisfies ReadonlyArray<readonly [string, Run[]]>)(
    "rejects queued-artifact fallback with %s",
    (_name, runs) => rejects(runs, {}, ARTIFACTS),
  );

  it("parses required CLI arguments", () => {
    expect(parseArgs(requiredCliArgs)).toEqual({
      repo: "openclaw/openclaw",
      sha,
      mainSha,
      pr,
      recentSha: "",
      output: ".local/gates-hosted-checks.json",
      changelogOnly: false,
    });
    expect(() => parseArgs(["--repo", "openclaw/openclaw"])).toThrow("Usage:");
    for (const [index, flag] of [
      [1, "--repo"],
      [3, "--sha"],
      [5, "--pr"],
      [7, "--output"],
    ] as const) {
      expect(() => parseArgs(requiredCliArgs.with(index, "-h"))).toThrow(
        `Expected ${flag} <value>.`,
      );
    }
    for (const [value, expected] of [
      ["1", 1],
      ["001", 1],
      [String(Number.MAX_SAFE_INTEGER), Number.MAX_SAFE_INTEGER],
    ] as const) {
      expect(parseArgs(requiredCliArgs.with(5, value)).pr).toBe(expected);
    }
    for (const value of ["0", String(Number.MAX_SAFE_INTEGER + 1), "1e3"]) {
      expect(() => parseArgs(requiredCliArgs.with(5, value))).toThrow(
        "Expected --pr <positive-integer>.",
      );
    }
    expect(() => parseArgs(requiredCliArgs.with(9, "origin/main"))).toThrow("Usage:");
    for (const [flag, values] of [
      ["--repo", ["fork/openclaw"]],
      ["--recent-sha", ["one", "--recent-sha", "other"]],
      ["--changelog-only", ["--changelog-only"]],
    ] satisfies Array<[string, string[]]>) {
      expect(() => parseArgs([...requiredCliArgs, flag, ...values])).toThrow(
        `${flag} was provided more than once.`,
      );
    }
  });
  it("rejects malformed PR numbers before invoking GitHub", () => {
    const result = spawnSync(
      resolveTestNodeExecPath(),
      [
        join(process.cwd(), "scripts/verify-pr-hosted-gates.mjs"),
        ...requiredCliArgs.with(5, "1e3"),
      ],
      { encoding: "utf8", env: { ...process.env, PATH: "" } },
    );
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Expected --pr <positive-integer>.");
    expect(result.stderr).not.toContain("spawnSync gh");
  });
  it.each([
    [pr + 1, "openclaw/openclaw", sha, "does not identify"],
    [pr, "replacement/openclaw", sha, "does not identify"],
    [pr, "openclaw/openclaw", previousSha, "head changed"],
    [pr, "openclaw/openclaw", "", "missing head metadata"],
  ] as const)(
    "rejects carried observation drift before hosted discovery: %s/%s/%s",
    (number, repo, head, error) => {
      expect(() =>
        main(requiredCliArgs, {
          number,
          baseRepository: { nameWithOwner: repo },
          headRefName: "topic",
          headRefOid: head,
          headRepository: { nameWithOwner: "openclaw/openclaw" },
        }),
      ).toThrow(error);
    },
  );
  it("accepts one workflow-runs page emitted through a colorizing GitHub CLI shim", () => {
    expect(
      parseWorkflowRunPage(
        '\u001B[1;37m{"total_count":101,"workflow_runs":[{"id":1,"name":"CI"}]}\u001B[0m',
      ),
    ).toEqual({ totalCount: 101, workflowRuns: [{ id: 1, name: "CI" }] });
  });
  it.each([
    [
      "recorded pre-rebase SHA",
      previousSha,
      "",
      `repos/openclaw/openclaw/actions/runs?head_sha=${previousSha}&per_page=30&page=1`,
    ],
    [
      "encoded head branch",
      "",
      "codex/relax hosted gates",
      "repos/openclaw/openclaw/actions/runs?branch=codex%2Frelax%20hosted%20gates&event=pull_request&per_page=30&page=1",
    ],
  ])("queries the target and %s", (_name, recentSha, headBranch, extra) => {
    expect(workflowRunQueryPaths("openclaw/openclaw", { sha, recentSha, headBranch })).toEqual([
      `repos/openclaw/openclaw/actions/runs?head_sha=${sha}&per_page=30&page=1`,
      extra,
    ]);
    expect(HOSTED_GATE_MAX_AGE_HOURS).toBe(24);
  });
  it("uses relay-safe pages and bounds pagination to GitHub's search result limit", () => {
    expect([0, 101, 10_000].map(workflowRunPageCount)).toEqual([0, 4, 34]);
    expect(workflowRunQueryPaths("openclaw/openclaw", { sha, recentSha: "" }, 34)).toEqual([
      `repos/openclaw/openclaw/actions/runs?head_sha=${sha}&per_page=30&page=34`,
    ]);
  });
});
