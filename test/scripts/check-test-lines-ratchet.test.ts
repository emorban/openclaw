import { execFileSync } from "node:child_process";
import { afterEach, expect, it, vi } from "vitest";
import { main } from "../../scripts/check-test-lines-ratchet.mts";
import { useAutoCleanupTempDirTracker } from "../helpers/temp-dir.js";
import { createNestedGitEnv } from "../helpers/temp-repo.js";
import { fixtureFiles } from "./script-fixture-files.test-support.js";

const temporary = useAutoCleanupTempDirTracker(afterEach);
afterEach(() => vi.restoreAllMocks());

it("counts tracked newline-terminated test lines and only prunes the ceiling downward", () => {
  const root = temporary.make("openclaw-test-lines-");
  const { write, read } = fixtureFiles(root);
  const baseline = "config/test-lines-baseline.txt";
  const git = (...args: string[]) =>
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {
      cwd: root,
      env: createNestedGitEnv(),
      stdio: "ignore",
    });
  const files = [
    "a.test.ts",
    "a.test.tsx",
    "a.test.mts",
    "a.test.mjs",
    "a.test.js",
    "a.test.cjs",
    "a.test-support.ts",
    "nested/test-support/test-helpers.test.js",
    "nested/test-support/data.txt",
  ];
  for (const file of files) {
    write(file, "x".repeat(65535) + "\r\ntwo\nunterminated");
  }
  write("production.ts", "ignored\n");
  write(baseline, "18\n");
  git("init");
  git("add", ".");
  git("commit", "-m", "base");
  write("untracked.test.ts", "ignored\n");
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const args = ["--base", "HEAD", "--no-merge-base"];
  expect(main(root, args)).toBe(0);
  expect(log).toHaveBeenLastCalledWith("Test lines OK: 18; ceiling: 18; slack: 0.");
  write("a.test.ts", "one\ntwo\nthree\n");
  expect(main(root, [...args, "--prune"])).toBe(1);
  expect(read(baseline)).toBe("18\n");
  expect(main(root, [...args, "--staged"])).toBe(0);
  write(baseline, "19\n");
  expect(main(root, args)).toBe(0);
  write("a.test.ts", "one\n");
  expect(main(root, args)).toBe(0);
  expect(log).toHaveBeenLastCalledWith("Test lines OK: 17; ceiling: 19; slack: 2.");
  expect(main(root, [...args, "--prune"])).toBe(0);
  expect(read(baseline)).toBe("17\n");
});
