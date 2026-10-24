import { expect, it } from "vitest";
import type { GatewaySessionRow } from "../api/types.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";
import { sessionsListResponse } from "./session-management.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Chat waiting on subagents" });

suite.define(() => {
  it("streams inline narration without opening children and uses the available title width", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1000, height: 900 } },
      async ({ page }) => {
        const now = Date.now();
        await page.clock.setFixedTime(now);
        await page.addInitScript(
          ({ key }) => {
            localStorage.setItem(key, JSON.stringify({ themeMode: "dark", navCollapsed: true }));
          },
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
        );
        const parent = {
          key: "agent:main:dependency-update",
          sessionId: "dependency-update",
          kind: "direct",
          label: "Update dependencies",
          status: "running",
          hasActiveRun: true,
          activeRunIds: ["parent-run"],
          hasActiveSubagentRun: true,
          startedAt: now - 60_000,
        } satisfies GatewaySessionRow;
        const titles = [
          "Update Apple Android and Ruby dependencies",
          "Update Rust and Go dependencies",
          "Update standalone npm and CI dependency pins",
          "Migrate upgraded TypeScript native API imports",
        ];
        const children = titles.map(
          (label, index) =>
            ({
              key: "agent:main:subagent:dependency-" + index,
              sessionId: "dependency-" + index,
              kind: "direct",
              classification: "subagent",
              label,
              status: "running",
              hasActiveRun: true,
              activeRunIds: ["child-run-" + index],
              parentSessionKey: parent.key,
              spawnedBy: parent.key,
              createdAt: now - 50_000 + index,
              startedAt: now - 50_000 + index,
            }) satisfies GatewaySessionRow,
        );
        const gateway = await installMockGateway(page, {
          sessionKey: parent.key,
          sessions: [{ ...parent, childSessions: children.map((child) => child.key) }, ...children],
          historyMessages: [
            {
              role: "user",
              content: "Update the dependencies and verify compatibility.",
              timestamp: now - 60_000,
            },
            {
              role: "assistant",
              content: "I am checking each dependency group in parallel.",
              timestamp: now - 55_000,
              __openclaw: { id: "delegation", seq: 2, runId: "parent-run" },
            },
          ],
          inFlightRun: { runId: "parent-run", startedAt: parent.startedAt },
        });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        const pane = page.locator(".chat-pane-cache__pane--active");
        const activity = pane.locator(".chat-subagent-activity").first();
        const rows = activity.locator(".chat-subagent-activity__row");
        await expect.poll(() => rows.count()).toBe(4);
        const untruncatedTitles = () =>
          rows
            .locator(".chat-subagent-activity__name")
            .evaluateAll((names) =>
              names.every((name) => name.scrollWidth <= name.clientWidth + 1),
            );
        expect(await untruncatedTitles()).toBe(true);
        await gateway.waitForRequest("sessions.messages.subscribe", {
          match: { key: children[0]!.key, mode: "narration" },
        });
        const emit = (text: string, runId = "child-run-0") =>
          gateway.emitGatewayEvent("session.narration", {
            sessionKey: children[0]!.key,
            agentId: "main",
            runId,
            text,
          });
        await emit("Checking manifests. Verifying the Android dependency graph.");
        await rows
          .first()
          .getByText("Verifying the Android dependency graph.", { exact: true })
          .waitFor();
        await emit("This is from an obsolete run.", "old-run");
        expect(await rows.first().textContent()).not.toContain("obsolete");
        await emit("Checking CocoaPods and Gradle compatibility.");
        await rows
          .first()
          .getByText("Checking CocoaPods and Gradle compatibility.", { exact: true })
          .waitFor();
        expect(await untruncatedTitles()).toBe(true);
        await page.setViewportSize({ width: 390, height: 900 });
        await page.locator(".shell--mobile-nav").waitFor();
        const oneLine = () =>
          rows.evaluateAll((elements) =>
            elements.every((row) => {
              const name = row.querySelector(".chat-subagent-activity__name");
              const status = row.querySelector(".chat-subagent-activity__status");
              if (!name || !status) {
                return false;
              }
              return (
                Math.abs(name.getBoundingClientRect().top - status.getBoundingClientRect().top) <
                  2 &&
                row.scrollWidth <= row.clientWidth + 1 &&
                row.getBoundingClientRect().right <= window.innerWidth
              );
            }),
          );
        await expect.poll(oneLine).toBe(true);
        for (const child of children) {
          expect(await gateway.getRequests("chat.history", { sessionKey: child.key })).toHaveLength(
            0,
          );
        }
      },
    );
  });

  it("keeps child activity above working status and aligns the waiting clock", async () => {
    await suite.withPage(
      { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
      async ({ page }) => {
        const now = Date.now();
        await page.clock.setFixedTime(now);
        await page.addInitScript(
          ({ key }) => {
            localStorage.setItem(key, JSON.stringify({ themeMode: "light" }));
          },
          { key: controlUiBundledSettingsStorageKey(suite.server.baseUrl) },
        );
        const runId = "parent-delegation-run";
        const parent = {
          key: "agent:main:implementation-parent",
          sessionId: "implementation-parent",
          kind: "direct",
          label: "Build the implementation",
          status: "running",
          hasActiveRun: true,
          hasActiveSubagentRun: true,
          childSessions: ["agent:main:implementation-child"],
          activeRunIds: [runId],
          startedAt: now - 10_000,
          updatedAt: now,
          snapshotAt: now,
        } satisfies GatewaySessionRow;
        const child = {
          key: "agent:main:implementation-child",
          sessionId: "implementation-child",
          kind: "direct",
          classification: "subagent",
          label: "Backend implementation",
          spawnedBy: parent.key,
          parentSessionKey: parent.key,
          status: "running",
          hasActiveRun: true,
          activeRunIds: ["backend-run"],
          startedAt: now,
          updatedAt: now,
          snapshotAt: now,
        } satisfies GatewaySessionRow;
        const history = [
          {
            role: "user",
            content: "Implement the backend and report the result.",
            timestamp: now - 10_000,
            __openclaw: { id: "request", seq: 1, idempotencyKey: `${runId}:user` },
          },
          {
            role: "assistant",
            content: "I am delegating the backend implementation.",
            timestamp: now - 9_000,
            __openclaw: { id: "delegation", seq: 2, runId },
          },
        ];
        const gateway = await installMockGateway(page, {
          sessionKey: parent.key,
          sessions: [parent, child],
          historyMessages: history,
          inFlightRun: { runId, startedAt: parent.startedAt },
        });
        const observeChild = (revision: number, offset: number, headline: string) =>
          gateway.emitGatewayEvent("session.observer", {
            sessionKey: child.key,
            agentId: "main",
            sessionId: child.sessionId,
            runId: "backend-run",
            revision,
            updatedAt: now + offset,
            health: "on-track",
            headline,
          });
        await page.goto(controlUiSessionUrl(suite.server.baseUrl, parent.key));
        await page
          .getByText("I am delegating the backend implementation.", { exact: true })
          .waitFor();
        const activePane = page.locator(".chat-pane-cache__pane--active");
        const indicator = activePane.locator(".chat-working-indicator");
        await indicator.waitFor();
        expect(await indicator.textContent()).not.toContain("Waiting on subagents");

        // While the parent still works, its own line counts the running subagents.
        await indicator
          .locator(".chat-working-indicator__subagents")
          .getByText("1 subagent running", { exact: true })
          .waitFor();
        expect(await indicator.textContent()).not.toContain("Waiting on");
        const activityRow = activePane.locator(`[data-subagent-session-key="${child.key}"]`);
        await activityRow.getByText("Backend implementation", { exact: true }).waitFor();
        const activityBounds = await activityRow.boundingBox();
        const statusBounds = await indicator.boundingBox();
        expect(activityBounds).not.toBeNull();
        expect(statusBounds).not.toBeNull();
        expect(activityBounds!.y + activityBounds!.height).toBeLessThanOrEqual(statusBounds!.y);
        expect(await indicator.locator(".chat-reading-indicator").count()).toBe(0);
        const yieldCall = {
          role: "assistant",
          content: [
            { type: "text", text: "Backend work is now delegated." },
            { type: "toolCall", id: "handoff", name: "sessions_yield", arguments: {} },
          ],
          timestamp: now + 1,
          __openclaw: { id: "yield-call", seq: 3, runId },
        };
        const yieldResult = {
          role: "toolResult",
          toolCallId: "handoff",
          toolName: "sessions_yield",
          content: [{ type: "text", text: '{"status":"yielded"}' }],
          timestamp: now + 2,
          __openclaw: { id: "yield-result", seq: 4, runId },
        };
        const yieldedHistory = [...history, yieldCall, yieldResult];
        const waitingParent = {
          ...parent,
          hasActiveRun: false,
          activeRunIds: [],
          endedAt: now + 2,
          updatedAt: now + 2,
          snapshotAt: now + 2,
        };
        await gateway.setSessionsListResponse(sessionsListResponse([waitingParent, child]));
        await gateway.setMethodResponse("chat.history", {
          messages: yieldedHistory,
          sessionId: parent.sessionId,
          sessionInfo: waitingParent,
          inFlightRun: null,
        });
        await gateway.emitGatewayEvent("session.message", {
          sessionKey: parent.key,
          message: yieldResult,
          messageId: "yield-result",
          messageSeq: 4,
          hasActiveRun: true,
          session: parent,
        });
        const historyReads = (await gateway.getRequests("chat.history")).length;
        await page.clock.setFixedTime(now + 63_000);
        await gateway.emitGatewayEvent("chat", {
          sessionKey: parent.key,
          runId,
          state: "final",
          yielded: true,
        });
        await gateway.waitForRequest("chat.history", { after: historyReads });
        await page
          .locator(".chat-thread p")
          .getByText("Backend work is now delegated.", { exact: true })
          .waitFor();
        const checkWaitingLayout = async (mode: "light" | "dark", width: number) => {
          await page.setViewportSize({ width, height: 900 });
          await page.evaluate((themeMode) => {
            document.documentElement.dataset.themeMode = themeMode;
            document.documentElement.style.colorScheme = themeMode;
          }, mode);
          await expect
            .poll(() =>
              turnTimer.evaluate((element) => {
                const column = element.closest(".chat-group-messages");
                if (!column) {
                  throw new Error("Missing assistant message column");
                }
                return Math.abs(
                  column.getBoundingClientRect().right - element.getBoundingClientRect().right,
                );
              }),
            )
            .toBeLessThanOrEqual(1);
        };
        await activityRow.getByRole("button").waitFor();
        expect(await indicator.count()).toBe(0);
        expect(await activePane.locator(".agent-chat__composer-run-status--waiting").count()).toBe(
          0,
        );
        const turnTimer = activePane.locator(".chat-subagent-activity__elapsed");
        await expect
          .poll(async () =>
            (await turnTimer.locator("openclaw-elapsed-time").textContent())?.trim(),
          )
          .toBe("1m 13s");
        expect(await turnTimer.count()).toBe(1);
        // Child activity stays in the handed-off reply, not in a duplicate composer line.
        expect(
          await activePane
            .locator(".chat-group.assistant", { hasText: "Backend work is now delegated." })
            .locator(".chat-subagent-activity")
            .count(),
        ).toBe(1);
        await observeChild(2, 63_001, "Running backend regression tests");
        await activityRow.getByText("Running backend regression tests", { exact: true }).waitFor();
        expect(await activePane.locator(".chat-notice").count()).toBe(0);
        await checkWaitingLayout("light", 1280);
        await checkWaitingLayout("dark", 1280);
        await checkWaitingLayout("dark", 390);
        expect(
          await activityRow.evaluate((element) => element.scrollWidth <= element.clientWidth),
        ).toBe(true);
      },
    );
  });
});
