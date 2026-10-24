import { Buffer } from "node:buffer";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import {
  createControlUiE2eContextOptions,
  tooltipTitleText,
} from "./control-ui-e2e-suite.test-support.ts";
import {
  ONE_PIXEL_PNG_B64,
  LOCAL_GIT_WORKSPACE_RESPONSES,
  controlUiSessionPath,
  createNewSessionPageE2eSuite,
  createdSessionListResult,
  expectDecodedThumbnail,
  installMockGateway,
  pastePng,
  pollCount,
  pollAttribute,
  pollLocatorText,
} from "./new-session-page.test-support.ts";
import { sessionList } from "./new-session-shard.test-support.ts";

const suite = createNewSessionPageE2eSuite();
const pngAttachment = { fileName: "pixel.png", content: ONE_PIXEL_PNG_B64 };

function initialPromptResponses(sessionKey: string, runId: string, sessionId: string) {
  return {
    "sessions.create": { key: sessionKey, runId, runStarted: true, messageSeq: 1 },
    "sessions.list": createdSessionListResult(sessionKey),
    "chat.startup": {
      messages: [],
      sessionId,
      sessionInfo: { hasActiveRun: true, key: sessionKey, status: "running" },
    },
  };
}

async function expectRejectedTurn(page: Page, message: string, error: string) {
  const group = page.locator(".chat-group.user", { hasText: message });
  const status = group.locator(".chat-send-status");
  await group.waitFor({ state: "visible", timeout: 30_000 });
  expect(await status.textContent()).toContain("Not sent");
  await expect.poll(() => tooltipTitleText(status)).toBe(error);
}

async function withNewSessionPage(run: (page: Page) => Promise<void>): Promise<void> {
  await suite.withPage(createControlUiE2eContextOptions(), ({ page }) => run(page));
}

suite.define(() => {
  it("grows the first prompt downward without moving the identity, then caps at ten lines", async () => {
    await withNewSessionPage(async (page) => {
      const gateway = await installMockGateway(page);
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.goto(`${suite.server.baseUrl}new`);
      const message = page.locator(".new-session-page__message");
      await message.waitFor();

      const identity = page.locator(
        ".agent-chat__welcome-clawd, .agent-chat__welcome-avatar, .agent-chat__avatar--text",
      );
      const triggers = page.locator(".new-session-page__triggers");
      const composer = page.locator(".new-session-page__composer");
      const [identityBox, triggersBox, composerBox] = await Promise.all([
        identity.boundingBox(),
        triggers.boundingBox(),
        composer.boundingBox(),
      ]);
      expect([identityBox, triggersBox, composerBox]).not.toContain(null);

      const initial = await message.evaluate((element) => ({
        height: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
      }));
      await message.fill(Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n"));
      const tenLines = await message.evaluate((element) => {
        const style = getComputedStyle(element);
        return {
          height: element.clientHeight,
          lineHeight: Number.parseFloat(style.lineHeight),
          overflowY: style.overflowY,
          padding: Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom),
          scrollbarWidth: style.scrollbarWidth,
          webkitScrollbarWidth: getComputedStyle(element, "::-webkit-scrollbar").width,
          webkitThumbInset: getComputedStyle(element, "::-webkit-scrollbar-thumb").borderLeftWidth,
        };
      });

      expect(tenLines.height).toBeGreaterThan(initial.height);
      expect(tenLines.height).toBeGreaterThanOrEqual(
        Math.floor(tenLines.lineHeight * 10 + tenLines.padding) - 1,
      );
      expect(tenLines).toMatchObject({ overflowY: "hidden", scrollbarWidth: "thin" });
      // Preserve a 12px drag target around the 6px painted thumb.
      const composerScrollbar = Number.parseFloat(tenLines.webkitScrollbarWidth);
      const composerThumbInset = Number.parseFloat(tenLines.webkitThumbInset);
      expect(composerScrollbar).toBe(12);
      expect(composerScrollbar - composerThumbInset * 2).toBe(6);

      const longPrompt = Array.from({ length: 14 }, (_, index) => `line ${index + 1}`).join("\n");
      await message.fill(longPrompt);
      const capped = await message.evaluate((element) => ({
        clientHeight: element.clientHeight,
        overflowY: getComputedStyle(element).overflowY,
        scrollHeight: element.scrollHeight,
      }));
      const [expandedIdentityBox, expandedTriggersBox, expandedComposerBox] = await Promise.all([
        identity.boundingBox(),
        triggers.boundingBox(),
        composer.boundingBox(),
      ]);
      expect(capped.clientHeight).toBeLessThan(capped.scrollHeight);
      expect(capped.overflowY).toBe("auto");
      // Browser subpixel rounding may shift stable blocks by a pixel; larger movement is visible.
      for (const [before, after] of [
        [identityBox, expandedIdentityBox],
        [triggersBox, expandedTriggersBox],
        [composerBox, expandedComposerBox],
      ]) {
        expect(Math.abs((after?.y ?? 0) - (before?.y ?? 0))).toBeLessThanOrEqual(2);
      }
      const start = page.getByRole("button", { name: "Start session" });
      await expect(start.isVisible()).resolves.toBe(true);
      await expect(start.isEnabled()).resolves.toBe(true);
      await start.focus();
      await expect(start.evaluate((element) => document.activeElement === element)).resolves.toBe(
        true,
      );
      await start.press("Enter");
      await expect(gateway.waitForRequest("sessions.create")).resolves.toMatchObject({
        params: { message: longPrompt },
      });
    });
  });

  it("keeps blob-backed SVG previews out of original-document navigation", async () => {
    await withNewSessionPage(async (page) => {
      await installMockGateway(page);
      await page.goto(`${suite.server.baseUrl}new`);

      await page.locator(".agent-chat__photo-input").setInputFiles({
        name: "untrusted.svg",
        mimeType: "image/svg+xml",
        buffer: Buffer.from(
          "<svg xmlns='http://www.w3.org/2000/svg'><rect width='1' height='1'/></svg>",
        ),
      });

      const previewButton = page.getByRole("button", { name: "Open image untrusted.svg" });
      await pollAttribute(previewButton.locator("img"), "src").toMatch(/^blob:/u);
      await previewButton.click();
      await page.getByRole("dialog", { name: "Image preview: untrusted.svg" }).waitFor();
      await expect(page.getByRole("link", { name: "Open in new tab" }).count()).resolves.toBe(0);
    });
  });

  it("keeps an initial image visible through worktree hydration and canonical history", async () => {
    await withNewSessionPage(async (page) => {
      const sessionKey = "agent:main:single-image-prompt";
      const runId = "initial-image-send";
      const message = "testing if dual prompts show";
      const source = "media://inbound/initial-prompt.png";
      const imageBytes = await readFile(path.join(process.cwd(), "ui/public/apple-touch-icon.png"));
      let releaseMedia!: () => void;
      const mediaGate = new Promise<void>((resolve) => {
        releaseMedia = resolve;
      });
      let metadataRequested = false;
      await page.route("**/__openclaw__/assistant-media?**", async (route) => {
        const url = new URL(route.request().url());
        expect(url.searchParams.get("source")).toBe(source);
        const metadata = url.searchParams.get("meta") === "1";
        metadataRequested ||= metadata;
        await mediaGate;
        await route.fulfill(
          metadata
            ? {
                json: {
                  available: true,
                  mediaTicket: "initial-prompt-ticket",
                  mediaTicketExpiresAt: new Date(Date.now() + 5 * 60_000).toISOString(),
                },
              }
            : { contentType: "image/png", body: imageBytes },
        );
      });
      const authoritative = {
        role: "user",
        content: [{ type: "text", text: message }],
        timestamp: Date.now(),
        __openclaw: {
          id: "persisted-image-prompt",
          idempotencyKey: `${runId}:user`,
          seq: 1,
          media: [{ path: source, contentType: "image/png", fileName: "pixel.png" }],
          mediaImageLayout: { slots: [{ kind: "inline", factIndex: 0 }] },
        },
      };
      const responses = initialPromptResponses(sessionKey, runId, "single-image-prompt");
      const gateway = await installMockGateway(page, {
        deferredMethods: ["chat.startup"],
        methodResponses: {
          ...responses,
          "sessions.create": {
            ...responses["sessions.create"],
            entry: { sessionId: "single-image-prompt" },
          },
          "chat.startup": {
            ...responses["chat.startup"],
            messages: [authoritative],
            sessionInfo: {
              ...responses["chat.startup"].sessionInfo,
              activeRunIds: [runId],
            },
          },
        },
      });
      try {
        await page.goto(`${suite.server.baseUrl}new`);
        const composer = page.locator(".new-session-page__message");
        await composer.fill(message);
        await page.locator(".agent-chat__file-input").setInputFiles({
          name: "pixel.png",
          mimeType: "image/png",
          buffer: imageBytes,
        });
        await page.getByRole("button", { name: "Start session" }).click();
        await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey), {
          timeout: 30_000,
        });
        await gateway.waitForRequest("chat.startup");

        const userRow = page.locator(".chat-group.user");
        const userImage = userRow.locator("img.chat-message-image");
        await pollCount(userRow).toBe(1);
        await pollCount(userImage).toBe(1);
        await pollAttribute(userImage, "src").toMatch(/^data:image\/png;base64,/u);
        await expectDecodedThumbnail(userImage, 180);
        const initialImageSrc = await userImage.getAttribute("src");
        const initialImageAlt = await userImage.getAttribute("alt");
        const captureThumbnail = () => userImage.screenshot({ animations: "disabled" });
        const initialPixels = await captureThumbnail();
        await userImage.evaluate((image) => image.setAttribute("data-initial-image-node", "true"));
        const expectStablePixels = async () => {
          expect((await captureThumbnail()).equals(initialPixels)).toBe(true);
          expect(await userRow.locator('[aria-busy="true"]').count()).toBe(0);
        };
        await pollLocatorText(userRow).toContain(message);
        await pollLocatorText(userRow).not.toContain("Attached image");

        const promptBubbles = page.locator(".chat-bubble").filter({ hasText: message });
        const durableBubble = page.locator('.chat-bubble[data-entry-id="persisted-image-prompt"]');
        await pollCount(promptBubbles).toBe(1);
        await gateway.emitGatewayEvent("session.message", {
          activeRunIds: [runId],
          clientRunId: runId,
          hasActiveRun: true,
          message: authoritative,
          messageId: "persisted-image-prompt",
          messageSeq: 1,
          session: {
            activeRunIds: [runId],
            hasActiveRun: true,
            key: sessionKey,
            kind: "direct",
            status: "running",
            updatedAt: Date.now(),
          },
          sessionKey,
        });
        await durableBubble.waitFor({ timeout: 10_000 });
        await pollCount(durableBubble).toBe(1);
        await pollCount(promptBubbles).toBe(1);
        await expect.poll(() => metadataRequested).toBe(true);
        await pollAttribute(userImage, "data-initial-image-node").toBe("true");
        await pollAttribute(userImage, "src").toBe(initialImageSrc);
        await expectStablePixels();

        const worktreeSession = {
          key: sessionKey,
          sessionId: "single-image-prompt",
          displayName: "Image handoff worktree",
          kind: "direct",
          updatedAt: Date.now(),
          activeRunIds: [runId],
          hasActiveRun: true,
          status: "running",
          permissionMode: "workspace",
          sessionRoot: "/workspace/image-handoff",
          spawnedCwd: "/workspace/image-handoff",
          worktree: {
            id: "image-handoff-worktree",
            branch: "image-handoff",
            repoRoot: "/workspace/project",
          },
        };
        await gateway.setMethodResponse("sessions.list", {
          ...createdSessionListResult(sessionKey),
          sessions: [worktreeSession],
        });
        await gateway.emitGatewayEvent("sessions.changed", {
          sessionKey,
          sessionId: worktreeSession.sessionId,
          reason: "project",
          session: worktreeSession,
        });
        await pollLocatorText(page.locator(".chat-pane__session-title-text")).toBe(
          worktreeSession.displayName,
        );
        expect(await userImage.getAttribute("data-initial-image-node")).toBe("true");
        expect(await userImage.getAttribute("src")).toBe(initialImageSrc);
        await expectStablePixels();

        await gateway.resolveDeferred("chat.startup");

        await pollCount(userRow).toBe(1);
        await pollCount(userImage).toBe(1);
        await pollAttribute(userImage, "data-initial-image-node").toBe("true");
        await pollAttribute(userImage, "src").toBe(initialImageSrc);
        await pollCount(promptBubbles).toBe(1);
        await pollCount(durableBubble).toBe(1);
        await pollLocatorText(userRow).toContain(message);
        await pollLocatorText(userRow).not.toContain("Attached image");
        releaseMedia();
        await pollAttribute(userImage, "src").toContain("initial-prompt-ticket");
        await expectDecodedThumbnail(userImage, 180);
        expect(await userImage.getAttribute("data-initial-image-node")).toBe("true");
        expect((await captureThumbnail()).equals(initialPixels)).toBe(true);
        await userRow.locator(".chat-message-image-button").click();
        const lightbox = page.locator("openclaw-image-lightbox");
        const dialog = lightbox.getByRole("dialog");
        await dialog.waitFor({ state: "visible" });
        expect(initialImageAlt).toBe("pixel.png");
        expect(await userImage.getAttribute("alt")).toBe("pixel.png");
        expect(await dialog.getAttribute("aria-label")).toBe("Image preview: pixel.png");
      } finally {
        releaseMedia();
      }
    });
  });

  it.each(["reload", "quota"] as const)(
    "keeps a rejected first message retryable after %s",
    async (recovery) => {
      await withNewSessionPage(async (page) => {
        const quota = recovery === "quota";
        if (quota) {
          await page.addInitScript(() => {
            const setItem = Object.getOwnPropertyDescriptor(Storage.prototype, "setItem")
              ?.value as Storage["setItem"];
            Storage.prototype.setItem = function (key: string, value: string) {
              if (key.startsWith("openclaw.control.chatComposer.v2:")) {
                throw new DOMException("Quota exceeded", "QuotaExceededError");
              }
              return setItem.call(this, key, value);
            };
          });
        }
        const sessionId = quota ? "storage-failed-initial-turn" : "rejected-first-message";
        const sessionKey = `agent:main:${sessionId}`;
        const message = "Keep this rejected message";
        const runError = "send blocked by session policy";
        const gateway = await installMockGateway(page, {
          methodResponses: {
            ...(quota ? {} : LOCAL_GIT_WORKSPACE_RESPONSES),
            "sessions.list": quota
              ? createdSessionListResult(sessionKey)
              : sessionList({
                  hasActiveRun: false,
                  key: sessionKey,
                  kind: "direct",
                  status: "done",
                  updatedAt: Date.now(),
                }),
            "sessions.create": {
              key: sessionKey,
              runStarted: false,
              runError: { code: "INVALID_REQUEST", message: runError },
            },
            "chat.history": {
              messages: [],
              sessionId,
              sessionInfo: { hasActiveRun: false, key: sessionKey, status: "done" },
            },
            "chat.send": { runId: "retry-run", status: "started" },
          },
        });
        await page.goto(`${suite.server.baseUrl}new`);
        const composer = page.locator(".new-session-page__message");
        await composer.fill(message);
        await pastePng(composer);
        await page.getByRole("button", { name: "Start session" }).click();
        const create = await gateway.waitForRequest("sessions.create");
        expect(create.params).toMatchObject({ message, attachments: [pngAttachment] });
        await page.waitForURL((url) => url.pathname === controlUiSessionPath(sessionKey), {
          timeout: 30_000,
        });
        await expectRejectedTurn(page, message, runError);
        if (!quota) {
          await page.reload();
          await expectRejectedTurn(page, message, runError);
        }
        await page.getByRole("button", { name: "Retry queued message" }).click();
        const retry = await gateway.waitForRequest("chat.send");
        expect(retry.params).toMatchObject({ sessionKey, message, attachments: [pngAttachment] });
        expect(await gateway.getRequests("sessions.create")).toHaveLength(quota ? 1 : 0);
      });
    },
  );
});
