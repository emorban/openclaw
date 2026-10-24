import { expect, it } from "vitest";
import type { SessionProcessSummary } from "../../../packages/gateway-protocol/src/schema/session-processes.js";
import type { GatewaySessionRow } from "../api/types.ts";
import { defaultControlUiFeatureMethods } from "../test-helpers/control-ui-e2e-defaults.ts";
import {
  controlUiBundledSettingsStorageKey,
  controlUiSessionUrl,
  installMockGateway,
} from "../test-helpers/control-ui-e2e.ts";
import { openChatDetails } from "./chat-details.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Session Details background work" });
const now = 1_800_000_000_000;
const parentKey = "agent:main:details-background";

// The mock Gateway's fixture rows always carry a numeric updatedAt.
type SessionFixture = GatewaySessionRow & { updatedAt: number };

const children: SessionFixture[] = Array.from({ length: 6 }, (_, index) => ({
  key: `agent:main:subagent:child-${index}`,
  sessionId: `child-${index}`,
  kind: "direct",
  classification: "subagent",
  label: `Child ${index}`,
  spawnedBy: parentKey,
  parentSessionKey: parentKey,
  updatedAt: now - 1_000,
  status: index < 2 ? "running" : index === 2 ? "failed" : "done",
  hasActiveRun: index < 2,
  activeRunIds: index < 2 ? [`run-${index}`] : [],
}));

function processRow(
  processId: string,
  name: string,
  status: SessionProcessSummary["status"] = "running",
): SessionProcessSummary {
  return {
    processId,
    instanceId: processId + "-1",
    name,
    status,
    startedAt: now - 1_000,
    tail: "",
    truncated: false,
    canStop: status === "running",
  };
}
const processes = [
  processRow("dev-server", "Background terminal"),
  processRow(
    "watch-tests",
    "/workspace/openclaw/projects/desktop-details/background-process-verification",
  ),
  processRow("build", "pnpm ui:build", "completed"),
  processRow("typecheck", "pnpm tsgo:ui", "failed"),
];

suite.define(() => {
  it("visualizes subagents and background processes in Details", async () => {
    for (const colorScheme of ["light", "dark"] as const) {
      await suite.withPage(
        { colorScheme, locale: "en-US", viewport: { width: 1728, height: 1100 } },
        async ({ page }) => {
          await page.clock.setFixedTime(now);
          await page.addInitScript(
            ([key, themeMode]) => localStorage.setItem(key, JSON.stringify({ themeMode })),
            [controlUiBundledSettingsStorageKey(suite.server.baseUrl), colorScheme] as const,
          );
          const parent: SessionFixture = {
            key: parentKey,
            sessionId: "details-background",
            kind: "direct",
            sharingRole: "owner",
            label: "Visualize background work",
            status: "running",
            hasActiveRun: true,
            hasActiveSubagentRun: true,
            activeRunIds: ["parent-run"],
            startedAt: now - 300_000,
            updatedAt: now - 1_000,
            childSessions: children.map((row) => row.key),
          };
          const gateway = await installMockGateway(page, {
            sessionKey: parentKey,
            deferredMethods: ["sessions.processes.list"],
            sessions: [parent, ...children],
            historyMessages: [
              {
                role: "assistant",
                content: "Delegating the review and starting the dev server.",
                timestamp: now - 290_000,
                __openclaw: { id: "delegating", seq: 1 },
              },
            ],
            featureMethods: [
              ...defaultControlUiFeatureMethods,
              "sessions.processes.list",
              "sessions.processes.stop",
            ],
            methodResponses: {
              "sessions.processes.list": {
                sessionId: "details-background",
                processes,
                truncated: false,
              },
            },
          });
          await page.goto(controlUiSessionUrl(suite.server.baseUrl, parentKey));
          const pane = page.locator(".chat-pane-cache__pane--active");
          for (const width of [1728, 1100, 390]) {
            await page.setViewportSize({ width, height: 1100 });
            await pane
              .locator(width === 390 ? ".agent-chat__header--mobile" : ".chat-details-toggle")
              .waitFor();
            if (width !== 390) {
              await expect
                .poll(() => pane.locator(".chat-details").getAttribute("role"))
                .toBe(width === 1728 ? "complementary" : "dialog");
            }
            const details = await openChatDetails(pane);
            if (width === 1728) {
              const loading = details.locator('[data-details-group="processes"]');
              await gateway.waitForRequest("sessions.processes.list");
              expect(await loading.count()).toBe(0);
              await gateway.resolveDeferred("sessions.processes.list", {
                sessionId: "details-background",
                processes,
                truncated: false,
              });
            }
            if (width === 390) {
              await details
                .locator(".chat-mobile-host__header")
                .getByRole("button", {
                  name: "Expand Side panel",
                  exact: true,
                })
                .click();
              await pane.locator('.chat-mobile-host[data-mode="expanded"]').waitFor();
            }
            const subagents = details.locator('[data-details-group="subagents"]');
            const summary = subagents.getByRole("button", {
              name: "All subagents. 2 Working, 4 Done",
              exact: true,
            });
            await summary.waitFor();
            expect(await subagents.locator("[data-subagent-session-key]").count()).toBe(0);
            if (width !== 390) {
              const heading = subagents.locator(":scope > summary");
              await heading.click();
              await subagents
                .getByRole("img", { name: "2 subagents running", exact: true })
                .waitFor();
              expect(await summary.isVisible()).toBe(false);
              await heading.click();
              await summary.waitFor();
            }
            // The whole summary remains a hit target, including its leading inset.
            await summary.hover({ position: { x: 2, y: 10 } });
            expect(
              await summary.evaluate((row) => {
                const bounds = row.getBoundingClientRect();
                return row.contains(document.elementFromPoint(bounds.left + 2, bounds.top + 10));
              }),
            ).toBe(true);
            const processGroup = details.locator('[data-details-group="processes"]');
            if (width === 390) {
              await processGroup.locator("[data-process-id]").first().waitFor();
              expect(
                await processGroup
                  .locator("[data-process-id]")
                  .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-process-id"))),
              ).toEqual(["dev-server", "watch-tests"]);
              await processGroup.getByRole("button", { name: "Show all", exact: true }).waitFor();
            } else {
              await processGroup.locator("[data-process-id]").first().waitFor();
              expect(await processGroup.locator("[data-process-id]").count()).toBe(4);
              expect(
                await processGroup.evaluate((element) =>
                  element.previousElementSibling?.getAttribute("data-details-group"),
                ),
              ).toBe("subagents");
              const first = processGroup.locator('[data-process-id="dev-server"]');
              const stop = first.getByRole("button", {
                name: "Stop Background terminal",
                exact: true,
              });
              await page.mouse.move(0, 0);
              await expect
                .poll(() => stop.evaluate((element) => getComputedStyle(element).opacity))
                .toBe("0");
              await first.hover();
              await expect
                .poll(() => stop.evaluate((element) => getComputedStyle(element).opacity))
                .toBe("1");
              const badge = first.locator(".chat-details-processes__badge");
              expect(await badge.isVisible()).toBe(true);
              const bounds = await first.locator(".chat-details-processes__icon").boundingBox();
              const statusBounds = await badge.boundingBox();
              expect(statusBounds!.x).toBeGreaterThan(bounds!.x + bounds!.width / 2);
              expect(statusBounds!.y).toBeGreaterThan(bounds!.y + bounds!.height / 2);
              await page.mouse.move(0, 0);
              await first.locator(".chat-details-processes__open").focus();
              await page.keyboard.press("Tab");
              expect(await stop.evaluate((element) => element === document.activeElement)).toBe(
                true,
              );
              expect(await stop.evaluate((element) => getComputedStyle(element).opacity)).toBe("1");
              const longName = processGroup.locator(
                '[data-process-id="watch-tests"] .chat-details-processes__name',
              );
              expect(
                await longName.evaluate((element) => element.scrollWidth > element.clientWidth),
              ).toBe(true);
              expect(await longName.textContent()).toBe(processes[1]!.name);
              await expect
                .poll(() => longName.evaluate((element) => getComputedStyle(element).maskImage))
                .not.toBe("none");
              const restBounds = (await longName.boundingBox())!;
              const rowBounds = (await longName.locator("..").boundingBox())!;
              expect(restBounds.x + restBounds.width).toBe(rowBounds.x + rowBounds.width - 4);
              const restFade = await longName.evaluate(
                (element) => getComputedStyle(element).maskImage,
              );
              await longName.hover();
              const hoverBounds = (await longName.boundingBox())!;
              expect(hoverBounds.width).toBe(restBounds.width);
              expect(hoverBounds.height).toBe(restBounds.height);
              // Hover can round a coordinate by one browser layout unit (1/64 CSS px).
              expect(Math.abs(hoverBounds.x - restBounds.x)).toBeLessThanOrEqual(1 / 64);
              expect(Math.abs(hoverBounds.y - restBounds.y)).toBeLessThanOrEqual(1 / 64);
              expect(
                await longName.evaluate((element) => getComputedStyle(element).maskImage),
              ).not.toBe(restFade);
              expect(await longName.locator("..").getAttribute("aria-label")).toContain(
                processes[1]!.name,
              );
              await first
                .locator(".chat-details-processes__open")
                .evaluate((element) => (element as HTMLElement).blur());
              await page.mouse.move(0, 0);
            }
            if (width === 390) {
              await processGroup.getByRole("button", { name: "Show all", exact: true }).click();
              const panel = pane.locator("openclaw-chat-processes-panel");
              await panel.getByRole("button", { name: processes[0]!.name, exact: true }).waitFor();
              await panel.getByRole("button", { name: /Finished/ }).click();
              await expect.poll(() => panel.locator("[data-process-id]").count()).toBe(4);
              await pane
                .locator(".chat-mobile-host__header")
                .getByRole("button", {
                  name: "Close",
                  exact: true,
                })
                .click();
            }
          }
          expect(await gateway.getRequests("chat.send")).toHaveLength(0);
        },
      );
    }
  });
});
