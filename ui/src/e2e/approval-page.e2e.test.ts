import type { BrowserContext, Page } from "playwright";
import { afterEach, expect, it } from "vitest";
import type {
  AllowedApprovalSnapshot,
  PendingApprovalSnapshot,
} from "../../../packages/gateway-protocol/src/index.js";
import {
  controlUiE2eWaitTimeoutMs,
  installMockGateway,
  type MockGatewayControls,
} from "../test-helpers/control-ui-e2e.ts";
import { layoutBox } from "./chat-presentation.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({
  name: "Control UI standalone approval page",
  startServerBeforeBrowser: true,
  unavailableMessage: (executablePath) => `Playwright Chromium is unavailable at ${executablePath}`,
});

const APPROVAL_ID = "Approval:Mobile/東京 100% 🦞";
const APPROVAL_NOW_MS = Date.UTC(2026, 6, 10, 18, 0, 0);
const MOBILE_VIEWPORT = { height: 844, width: 390 } as const;
const DESKTOP_VIEWPORT = { height: 800, width: 1200 } as const;

type ApprovalSurface = {
  context: BrowserContext;
  gateway: MockGatewayControls;
  page: Page;
  pageErrors: string[];
};

const openContexts = new Set<BrowserContext>();

function approvalPath(basePath: string): string {
  return `${basePath}/approve/${encodeURIComponent(APPROVAL_ID)}`;
}

function approvalUrl(basePath: string): string {
  return new URL(approvalPath(basePath), suite.server?.baseUrl ?? "http://127.0.0.1/").href;
}

function pendingApproval(basePath: string) {
  const commandLines = Array.from(
    { length: 14 },
    (_value, index) =>
      `step-${String(index + 1).padStart(2, "0")}: curl --header "Authorization: <redacted>" https://example.invalid/review`,
  );
  return {
    id: APPROVAL_ID,
    status: "pending",
    urlPath: approvalPath(basePath),
    createdAtMs: APPROVAL_NOW_MS - 30_000,
    expiresAtMs: APPROVAL_NOW_MS + 5 * 60_000,
    presentation: {
      kind: "exec",
      commandText: commandLines.join("\n"),
      commandPreview: 'curl --header "Authorization: <redacted>" …',
      warningText: "This command requests external network access.",
      host: "gateway",
      nodeId: "runner-1",
      agentId: "main",
      allowedDecisions: ["allow-once", "deny"],
    },
  } satisfies PendingApprovalSnapshot;
}

function pendingPluginApproval(basePath: string): PendingApprovalSnapshot {
  return {
    ...pendingApproval(basePath),
    presentation: {
      kind: "plugin",
      title: "Codex workspace command",
      description: "Run the requested workspace command after operator review.",
      detail: "pnpm test ui/src/pages/approval",
      severity: "critical",
      pluginId: "codex",
      toolName: "workspace.exec",
      agentId: "main",
      allowedDecisions: ["allow-once", "deny"],
    },
  };
}

async function createSurface(
  params: {
    basePath?: string;
    deferredMethods?: string[];
    pending?: PendingApprovalSnapshot;
    viewport?: { height: number; width: number };
  } = {},
): Promise<ApprovalSurface> {
  const { basePath = "", viewport = MOBILE_VIEWPORT, pending = pendingApproval(basePath) } = params;
  const context = await suite.browser.newContext({
    colorScheme: "dark",
    hasTouch: viewport.width <= MOBILE_VIEWPORT.width,
    isMobile: viewport.width <= MOBILE_VIEWPORT.width,
    locale: "en-US",
    reducedMotion: "reduce",
    serviceWorkers: "block",
    viewport,
  });
  openContexts.add(context);
  const page = await context.newPage();
  page.setDefaultTimeout(controlUiE2eWaitTimeoutMs);
  await page.clock.setFixedTime(new Date(APPROVAL_NOW_MS));
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(String(error)));
  const gateway = await installMockGateway(page, {
    basePath,
    deferredMethods: params.deferredMethods,
    methodResponses: {
      "approval.get": { approval: pending },
    },
  });
  return { context, gateway, page, pageErrors };
}

async function waitForApprovalPage(page: Page): Promise<void> {
  await page.locator("openclaw-approval-page").waitFor();
  await page.getByText("Waiting for your decision", { exact: true }).waitFor();
}

async function visitApproval({ page }: ApprovalSurface, url = approvalUrl("")) {
  const response = await page.goto(url);
  await waitForApprovalPage(page);
  return response;
}

async function expectLoadedApproval({ page, gateway }: ApprovalSurface): Promise<void> {
  expect((await gateway.waitForRequest("approval.get")).params).toEqual({ id: APPROVAL_ID });
  await expectStandaloneApprovalPage(page);
}

async function expectIdentity(
  page: Page,
  severity: string,
  chips: Record<string, string[]>,
  meta: string[],
): Promise<void> {
  expect(await page.locator(".approval-page__card").getAttribute("class")).toContain(
    `approval-page__card--severity-${severity}`,
  );
  for (const [kind, values] of Object.entries(chips)) {
    expect(await page.locator(`[data-approval-chip="${kind}"]`).allTextContents()).toEqual(values);
  }
  expect(await page.locator(".approval-page__meta-row dt").allTextContents()).toEqual(meta);
}

async function expectStandaloneApprovalPage(page: Page): Promise<void> {
  expect(await page.locator("openclaw-approval-page").count()).toBe(1);
  expect(await page.locator(".approval-page").count()).toBe(1);
  expect(await page.locator("openclaw-app-shell, .shell").count()).toBe(0);
  expect(await page.locator("openclaw-app-topbar, openclaw-app-sidebar").count()).toBe(0);
  expect(await page.locator("openclaw-exec-approval").count()).toBe(0);
}

async function expectNoDecisionButtons(page: Page): Promise<void> {
  const decisions = page
    .getByRole("button", { name: "Allow once" })
    .or(page.getByRole("button", { name: "Deny" }));
  await expect.poll(() => decisions.count()).toBe(0);
}

async function expectMobilePendingLayout(page: Page): Promise<void> {
  for (const name of ["Allow once", "Deny"]) {
    const bounds = await layoutBox(page.getByRole("button", { name }));
    expect(bounds.height).toBeGreaterThanOrEqual(44);
  }

  const metrics = await page.evaluate(() => {
    const element = (selector: string) => {
      const found = document.querySelector<HTMLElement>(selector);
      if (!found) {
        throw new Error(`Missing approval layout element: ${selector}`);
      }
      return found;
    };
    const root = element(".approval-page").getBoundingClientRect();
    const card = element(".approval-page__card").getBoundingClientRect();
    const preview = element(".approval-page__preview");
    const previewBounds = preview.getBoundingClientRect();
    return {
      cardLeft: card.left,
      cardRight: card.right,
      cardWidth: card.width,
      backLinkGap: element(".approval-page__back-link").getBoundingClientRect().top - card.bottom,
      documentOverflow: document.documentElement.scrollWidth - window.innerWidth,
      previewOverflow: preview.scrollHeight - preview.clientHeight,
      left: Math.min(root.left, card.left),
      rightOverflow: Math.max(root.right, card.right, previewBounds.right) - window.innerWidth,
    };
  });
  expect(metrics.cardLeft).toBeGreaterThanOrEqual(10);
  expect(metrics.cardRight).toBeLessThanOrEqual(380);
  expect(metrics.cardWidth).toBeGreaterThanOrEqual(350);
  expect(metrics.documentOverflow).toBeLessThanOrEqual(0);
  expect(metrics.left).toBeGreaterThanOrEqual(0);
  expect(metrics.rightOverflow).toBeLessThanOrEqual(0);
  expect(metrics.previewOverflow).toBeGreaterThanOrEqual(0);
  expect(metrics.backLinkGap).toBeGreaterThanOrEqual(10);
}

suite.define(() => {
  afterEach(async () => {
    await Promise.all([...openContexts].map((context) => context.close().catch(() => {})));
    openContexts.clear();
  });

  it("keeps one canonical winner across conflicting surfaces and terminal reload", async () => {
    const pending = pendingApproval("");
    const terminal: AllowedApprovalSnapshot = {
      ...pending,
      status: "allowed",
      decision: "allow-once",
      reason: "user",
      resolvedAtMs: APPROVAL_NOW_MS,
    };
    const mobile = await createSurface({
      deferredMethods: ["approval.resolve"],
      pending,
    });
    const desktop = await createSurface({
      deferredMethods: ["approval.resolve"],
      pending,
      viewport: DESKTOP_VIEWPORT,
    });
    const surfaces = [mobile, desktop];

    try {
      await Promise.all(
        surfaces.map(async (surface) => {
          expect((await visitApproval(surface))?.status()).toBe(200);
          await expectLoadedApproval(surface);
        }),
      );
      expect(new URL(mobile.page.url()).pathname).toBe(approvalPath(""));
      await expectMobilePendingLayout(mobile.page);
      expect(await mobile.page.title()).toBe("Command approval — OpenClaw");
      await expectIdentity(mobile.page, "warning", { agent: ["main"], plugin: [], tool: [] }, [
        "Host",
        "Node",
      ]);
      await mobile.page.getByRole("button", { name: "Allow once" }).scrollIntoViewIfNeeded();

      await Promise.all([
        mobile.page.getByRole("button", { name: "Allow once" }).click(),
        desktop.page.getByRole("button", { name: "Deny" }).click(),
      ]);
      const [mobileResolve, desktopResolve] = await Promise.all([
        mobile.gateway.waitForRequest("approval.resolve"),
        desktop.gateway.waitForRequest("approval.resolve"),
      ]);
      expect(mobileResolve.params).toEqual({
        id: APPROVAL_ID,
        kind: "exec",
        decision: "allow-once",
      });
      expect(desktopResolve.params).toEqual({ id: APPROVAL_ID, kind: "exec", decision: "deny" });

      await Promise.all(
        surfaces.map(({ gateway }) =>
          gateway.setMethodResponse("approval.get", { approval: terminal }),
        ),
      );
      await Promise.all(
        surfaces.map(({ gateway }, index) =>
          gateway.resolveDeferred("approval.resolve", {
            applied: index === 0,
            approval: terminal,
          }),
        ),
      );

      await Promise.all([
        mobile.page.getByRole("heading", { name: "Approved here", exact: true }).waitFor(),
        desktop.page.getByRole("heading", { name: "Resolved elsewhere", exact: true }).waitFor(),
      ]);
      await Promise.all(surfaces.map(({ page }) => expectNoDecisionButtons(page)));
      const terminalFocus = await mobile.page.evaluate(() => {
        const active = document.activeElement;
        const bounds = active?.getBoundingClientRect();
        return {
          id: active?.id ?? null,
          inViewport: Boolean(bounds && bounds.top >= 0 && bounds.bottom <= window.innerHeight),
        };
      });
      expect(terminalFocus).toEqual({ id: "approval-page-title", inViewport: true });
      expect(await mobile.page.title()).toBe("Approved here — OpenClaw");

      const terminalReload = await mobile.page.reload();
      expect(terminalReload?.status()).toBe(200);
      await mobile.gateway.waitForRequest("approval.get");
      await mobile.page.getByRole("heading", { name: "Approved", exact: true }).waitFor();
      expect(await mobile.page.title()).toBe("Approved — OpenClaw");
      expect(new URL(mobile.page.url()).pathname).toBe(approvalPath(""));
      await expectStandaloneApprovalPage(mobile.page);
      await expectNoDecisionButtons(mobile.page);

      expect(mobile.pageErrors).toEqual([]);
      expect(desktop.pageErrors).toEqual([]);
    } finally {
      await mobile.context.close();
      openContexts.delete(mobile.context);
    }
  });

  it("renders plugin identity as chips with a severity accent", async () => {
    const pending = pendingPluginApproval("");
    const surface = await createSurface({ pending, viewport: DESKTOP_VIEWPORT });

    expect((await visitApproval(surface))?.status()).toBe(200);
    await expectLoadedApproval(surface);
    expect(
      await surface.page.locator(".approval-page__heading > .approval-page__chips").count(),
    ).toBe(1);
    await expectIdentity(
      surface.page,
      "danger",
      { plugin: ["codex"], tool: ["workspace.exec"], agent: ["main"] },
      [],
    );
    expect(surface.pageErrors).toEqual([]);
  });

  it("preserves a mounted deep link across the authentication gate", async () => {
    const basePath = "/openclaw";
    const surface = await createSurface({ basePath, deferredMethods: ["connect"] });

    const response = await surface.page.goto(approvalUrl(basePath));
    expect(response?.status()).toBe(200);
    await surface.gateway.waitForRequest("connect");
    await surface.page.locator("openclaw-login-gate").waitFor();
    expect(new URL(surface.page.url()).pathname).toBe(approvalPath(basePath));
    expect(await surface.gateway.getRequests("approval.get")).toHaveLength(0);

    await surface.gateway.resolveDeferred("connect");
    await waitForApprovalPage(surface.page);
    await expectLoadedApproval(surface);
    expect(new URL(surface.page.url()).pathname).toBe(approvalPath(basePath));
    expect(surface.pageErrors).toEqual([]);
  });

  it("confirms the owning Gateway before opening a remote approval notification", async () => {
    const basePath = "";
    const surface = await createSurface({ basePath });
    const remoteGatewayUrl = "wss://remote-gateway.example/mobile";
    const url = new URL(approvalUrl(basePath));
    url.hash = new URLSearchParams({ gatewayUrl: remoteGatewayUrl }).toString();

    try {
      const response = await surface.page.goto(url.href);
      expect(response?.status()).toBe(200);
      const confirmation = surface.page.locator("openclaw-gateway-url-confirmation");
      await confirmation.getByText(remoteGatewayUrl, { exact: true }).waitFor();
      expect(await confirmation.getByText(remoteGatewayUrl, { exact: true }).count()).toBe(1);
      expect(await surface.gateway.getRequests("approval.get")).toHaveLength(0);

      await confirmation
        .getByRole("button", { name: "Switch to remote-gateway.example", exact: true })
        .click();
      await waitForApprovalPage(surface.page);
      await expectLoadedApproval(surface);
      expect((await surface.gateway.getSocketUrls()).at(-1)).toBe(remoteGatewayUrl);
      expect(new URL(surface.page.url()).hash).toBe("");
      expect(surface.pageErrors).toEqual([]);
    } finally {
      await surface.context.close();
      openContexts.delete(surface.context);
    }
  });

  it("uses the page Gateway without replacing a saved remote selection", async () => {
    const surface = await createSurface();
    const appUrl = new URL(suite.server?.baseUrl ?? "http://127.0.0.1/");
    const pageGatewayScope = `ws://${appUrl.host}`;
    const selectionKey = `openclaw.control.currentGateway.v1:${pageGatewayScope}`;
    const pageGateway = pageGatewayScope;
    const pageSettingsKey = `openclaw.control.settings.v1:${pageGateway}`;
    const pageSettings = JSON.stringify({
      gatewayUrl: pageGateway,
      theme: "claw",
      sessionKey: "agent:page:saved",
    });
    const remoteGateway = "wss://saved-remote.example.test";
    const remoteSettingsKey = `openclaw.control.settings.v1:${remoteGateway}`;
    await surface.page.addInitScript(
      (entries: Array<[string, string]>) => {
        for (const [key, value] of entries) {
          localStorage.setItem(key, value);
        }
      },
      [
        [pageSettingsKey, pageSettings],
        [remoteSettingsKey, JSON.stringify({ gatewayUrl: remoteGateway })],
        [selectionKey, remoteGateway],
      ] satisfies Array<[string, string]>,
    );

    await visitApproval(
      surface,
      `${approvalUrl("")}#token=approval-document-token&session=agent%3Aapproval%3Atemporary`,
    );
    const startupHash = new URLSearchParams(new URL(surface.page.url()).hash.slice(1));
    expect(startupHash.has("token")).toBe(false);
    expect(startupHash.get("session")).toBe("agent:approval:temporary");
    const socketUrls = await surface.gateway.getSocketUrls();
    expect(socketUrls.length).toBeGreaterThan(0);
    expect(new URL(socketUrls.at(-1) ?? "ws://invalid").origin).toBe(pageGateway);
    expect(await surface.page.evaluate((key) => localStorage.getItem(key), selectionKey)).toBe(
      remoteGateway,
    );
    expect(await surface.page.evaluate((key) => localStorage.getItem(key), pageSettingsKey)).toBe(
      pageSettings,
    );
    expect(surface.pageErrors).toEqual([]);
  });

  it("keeps the approval document and final actions inside app-owned safe areas", async () => {
    const surface = await createSurface({ viewport: { width: 375, height: 500 } });
    try {
      await visitApproval(surface);
      const bounds = await surface.page.evaluate(() => {
        const root = document.documentElement;
        root.style.setProperty("--safe-area-top", "34px");
        root.style.setProperty("--safe-area-right", "20px");
        root.style.setProperty("--safe-area-bottom", "21px");
        root.style.setProperty("--safe-area-left", "18px");
        const page = document.querySelector(".approval-page")!.getBoundingClientRect();
        return { top: page.top, bottom: page.bottom, left: page.left, right: page.right };
      });
      expect(bounds).toEqual({ top: 34, bottom: 479, left: 18, right: 355 });
      const allow = surface.page.getByRole("button", { name: "Allow once", exact: true });
      await allow.scrollIntoViewIfNeeded();
      const action = await allow.boundingBox();
      expect(action!.y).toBeGreaterThanOrEqual(34);
      expect(action!.y + action!.height).toBeLessThanOrEqual(479);
      const back = surface.page.locator(".approval-page__back-link");
      await back.scrollIntoViewIfNeeded();
      const link = await back.boundingBox();
      expect(link!.y + link!.height).toBeLessThanOrEqual(479);
      expect(surface.pageErrors).toEqual([]);
    } finally {
      await surface.context.close();
      openContexts.delete(surface.context);
    }
  });
});
