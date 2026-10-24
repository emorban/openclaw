import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { runBarnacleAutoResponse } from "../../scripts/github/barnacle-auto-response.mjs";

type Concurrency = { group: string; "cancel-in-progress": string | boolean };
type Workflow = {
  name: string;
  on: Record<string, unknown>;
  concurrency: Concurrency;
  jobs: Record<
    string,
    { if?: string; concurrency?: Concurrency; uses?: string; with?: Record<string, unknown> }
  >;
};
type Github = {
  workflow: string;
  event_name: string;
  run_id: number;
  sha: string;
  ref: string;
  event: {
    action?: string;
    pull_request?: { number: number; draft: boolean; author_association?: string };
    issue?: { number: number; author_association?: string };
  };
};
type Policy = {
  name: string;
  manual: "absent" | "isolated" | "sha" | "ref";
  converts?: boolean;
  push?: boolean;
};
const policies: Policy[] = [
  ...["ci-check-testbox", "ci-check-arm-testbox", "ci-build-artifacts-testbox"].map((name) => ({
    name,
    manual: "isolated" as const,
  })),
  ...["ios-periphery", "macos-periphery", "linux-app", "node-runtime-conformance"].map((name) => ({
    name,
    manual: "sha" as const,
    converts: true,
  })),
  { name: "website-installer-sync", manual: "isolated", converts: true },
  { name: "opengrep-precise", manual: "absent" },
  { name: "sandbox-common-smoke", manual: "ref", converts: true, push: true },
  { name: "plugin-init-scaffold-validation", manual: "ref", push: false },
];
const readWorkflow = (name: string) =>
  parse(readFileSync(`.github/workflows/${name}.yml`, "utf8")) as Workflow;
function event(
  workflow: Workflow,
  eventName: string,
  run = 1,
  sha = "a",
  ref = "refs/heads/main",
): Github {
  return {
    workflow: workflow.name,
    event_name: eventName,
    run_id: run,
    sha: sha.repeat(40),
    ref,
    event: {},
  };
}
function pr(workflow: Workflow, run: number, action = "opened", draft = false, number = 123) {
  return {
    ...event(workflow, "pull_request", run, "e", `refs/pull/${number}/merge`),
    event: { action, pull_request: { number, draft } },
  };
}

// Scope selection has executable owner suites; retain the lane's exemption
// regression alongside the concurrency inputs GitHub uses for queue scheduling.
function evaluate(value: string | boolean, github: Github): unknown {
  if (typeof value === "boolean") {
    return value;
  }
  const expression = (source: string) =>
    runInNewContext(
      source.replace(
        /\bgithub(?:\.[A-Za-z_][\w-]*)+/gu,
        (reference) => `lookup(${JSON.stringify(reference)})`,
      ),
      {
        lookup: (reference: string) =>
          reference
            .split(".")
            .slice(1)
            .reduce<unknown>(
              (current, key) =>
                current !== null && typeof current === "object"
                  ? ((current as Record<string, unknown>)[key] ?? "")
                  : "",
              github,
            ),
        format: (template: string, ...values: unknown[]) =>
          template.replace(/\{(\d+)\}/gu, (_match, index: string) => String(values[Number(index)])),
        fromJSON: JSON.parse,
        contains: (values: string[], candidate: string) =>
          values.some((item) => item.toLowerCase() === candidate.toLowerCase()),
      },
    );
  const match = /\$\{\{([\s\S]*?)\}\}/u.exec(value);
  return match?.[0] === value.trim()
    ? expression(match[1]!)
    : value.replace(/\$\{\{([\s\S]*?)\}\}/gu, (_match, body: string) => String(expression(body)));
}
function admission(workflow: Workflow, github: Github, policy = workflow.concurrency) {
  const group = String(evaluate(policy.group, github));
  expect(group).not.toBe("");
  return { group, cancel: Boolean(evaluate(policy["cancel-in-progress"], github)) };
}
const unique = (groups: string[]) => new Set(groups.map((group) => group.toLowerCase())).size;

it.each(["OWNER", "MEMBER", "COLLABORATOR"])(
  "rejects the owner's known %s exemption before allocation",
  async (association) => {
    const workflow = readWorkflow("auto-response");
    for (const eventName of ["issues", "pull_request_target"] as const) {
      const github = {
        ...pr(workflow, 100),
        repository: "openclaw/openclaw",
        actor: "contributor",
        event_name: eventName,
        event:
          eventName === "issues"
            ? { action: "opened", issue: { number: 123, author_association: association } }
            : {
                action: "opened",
                pull_request: {
                  number: 123,
                  draft: false,
                  head: { sha: "a".repeat(40) },
                  user: { login: "contributor", type: "User" },
                  author_association: association,
                },
              },
      };
      expect(evaluate(workflow.jobs["auto-response"]!.if!, github)).toBe(false);
      await expect(
        runBarnacleAutoResponse({
          expectedAppId: 2729701,
          github: {
            rest: {
              issues: {
                get: async () => ({
                  data: { number: 123, state: "open", author_association: association },
                }),
              },
            },
          },
          context: { payload: github.event },
          core: { info() {} },
        }),
      ).resolves.toBeUndefined();
    }
  },
);

describe.each(policies)("ancillary concurrency: $name", ({ name, manual, converts, push }) => {
  const workflow = readWorkflow(name);
  it("coalesces useful PR changes and isolates passive drafts and other PRs", () => {
    const ready = admission(workflow, pr(workflow, 1, "ready_for_review"));
    expect(ready.cancel).toBe(true);
    expect(admission(workflow, pr(workflow, 2, "synchronize"))).toEqual(ready);
    const other = admission(workflow, pr(workflow, 3, "opened", false, 124));
    expect(other.cancel).toBe(true);
    const passive = ["opened", "opened", "reopened", "synchronize"].map(
      (action, index) => admission(workflow, pr(workflow, index + 4, action, true)).group,
    );
    expect(unique([ready.group, other.group, ...passive])).toBe(6);
    if (converts) {
      expect(admission(workflow, pr(workflow, 9, "converted_to_draft", true))).toEqual(ready);
    }
  });
  it("keeps its manual cancellation and grouping contract", () => {
    expect(Object.hasOwn(workflow.on, "workflow_dispatch")).toBe(manual !== "absent");
    if (manual === "absent") {
      return;
    }
    const runs = [
      event(workflow, "workflow_dispatch", 1),
      event(workflow, "workflow_dispatch", 2),
      event(workflow, "workflow_dispatch", 3, "b"),
      event(workflow, "workflow_dispatch", 4, "a", "refs/heads/release"),
    ].map((github) => admission(workflow, github));
    expect(runs.map((run) => run.cancel)).toEqual(Array(4).fill(manual === "sha"));
    const prGroup = admission(workflow, pr(workflow, 1)).group;
    expect(runs.every((run) => run.group !== prGroup)).toBe(true);
    expect(unique(runs.slice(0, 3).map((run) => run.group))).toBe(
      manual === "ref" ? 1 : manual === "sha" ? 2 : 3,
    );
    if (manual === "ref") {
      expect(runs[3]!.group).not.toBe(runs[0]!.group);
    }
  });
  if (push !== undefined) {
    it("isolates push, scheduled, manual and PR groups", () => {
      const first = admission(workflow, event(workflow, "push", 1));
      expect(first.cancel).toBe(push);
      expect(admission(workflow, event(workflow, "push", 2, "b"))).toEqual(first);
      const scheduled = admission(workflow, event(workflow, "schedule", 3));
      expect(scheduled.cancel).toBe(false);
      expect(admission(workflow, event(workflow, "schedule", 4, "b"))).toEqual(scheduled);
      expect(
        unique([
          first.group,
          scheduled.group,
          admission(workflow, event(workflow, "workflow_dispatch", 5)).group,
          admission(workflow, pr(workflow, 6)).group,
        ]),
      ).toBe(4);
    });
  }
});

it.each([
  ["backfill-pr-labels", "workflow_dispatch", false],
  ["label-issues", "issues", true],
] as const)("isolates Labeler %s work", (job, eventName, cancel) => {
  const workflow = readWorkflow("labeler");
  const policy = workflow.jobs[job]!.concurrency!;
  const firstEvent = { ...event(workflow, eventName), event: { issue: { number: 1 } } };
  const first = admission(workflow, firstEvent, policy);
  expect(first.cancel).toBe(cancel);
  expect(admission(workflow, { ...firstEvent, run_id: 2 }, policy)).toEqual(first);
  const other =
    eventName === "issues"
      ? { ...firstEvent, event: { issue: { number: 2 } } }
      : { ...firstEvent, ref: "refs/heads/release" };
  expect(admission(workflow, other, policy).group).not.toBe(first.group);
  expect(first.group).not.toBe(
    admission(workflow, pr(workflow, 1), workflow.jobs.label!.concurrency!).group,
  );
});

it("keeps the shared manual entrypoint in the canonical graph without self-cancellation", () => {
  const wrapper = readWorkflow("shared-openclawkit-periphery");
  const canonical = readWorkflow("macos-periphery");
  expect(wrapper.on.pull_request).toBeUndefined();
  expect(Object.hasOwn(wrapper.on, "workflow_dispatch")).toBe(true);
  expect(wrapper.concurrency).toBeUndefined();
  expect(wrapper.jobs.scan).toMatchObject({
    uses: "./.github/workflows/macos-periphery.yml",
    with: { shared_only: true },
  });
  expect(admission(canonical, event(canonical, "workflow_dispatch")).group).not.toBe(
    admission(canonical, event(wrapper, "workflow_dispatch")).group,
  );
});

it("isolates tracked workflows for each supported event", () => {
  for (const eventName of ["ready_for_review", "opened", "workflow_dispatch", "push"]) {
    const groups = policies.flatMap(({ name }) => {
      const workflow = readWorkflow(name);
      const isPr = eventName === "opened" || eventName === "ready_for_review";
      if (!Object.hasOwn(workflow.on, isPr ? "pull_request" : eventName)) {
        return [];
      }
      return [
        admission(
          workflow,
          isPr ? pr(workflow, 1, eventName, eventName === "opened") : event(workflow, eventName),
        ).group,
      ];
    });
    expect(unique(groups)).toBe(groups.length);
  }
});

it.each([
  ["labeler", "label", true],
  ["real-behavior-proof", "real-behavior-proof", true],
  ["auto-response", "auto-response", false],
] as const)("coalesces %s PR updates without cancelling another PR", (name, job, cancelsOpened) => {
  const workflow = readWorkflow(name);
  const policy = workflow.jobs[job]!.concurrency!;
  const opened = { ...pr(workflow, 1), event_name: "pull_request_target" };
  const first = admission(workflow, opened, policy);
  expect(first.cancel).toBe(cancelsOpened);
  expect(admission(workflow, { ...opened, run_id: 2 }, policy)).toEqual(first);
  expect(
    admission(
      workflow,
      { ...pr(workflow, 3, "opened", false, 124), event_name: "pull_request_target" },
      policy,
    ).group,
  ).not.toBe(first.group);
  expect(
    admission(workflow, { ...opened, event: { ...opened.event, action: "synchronize" } }, policy)
      .cancel,
  ).toBe(true);
});
