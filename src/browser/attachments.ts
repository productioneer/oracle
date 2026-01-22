import { stat } from "fs/promises";
import type { Page } from "playwright";
import type { Attachment } from "../run/types.js";
import { sleep } from "../utils/time.js";

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

const SELECTORS = {
  composerPlusPrimary: '[data-testid="composer-plus-btn"]',
  composerPlusSecondary: 'button[aria-label*="Add files"]',
  fileInputPrimary: 'div.pointer-events-auto input[type="file"]',
  fileInputSecondary: 'input[type="file"]',
  removeFileButton: 'button[aria-label="Remove file"]',
  threadBottom: '#thread-bottom-container',
  uploadMenuText: 'Add photos &',
};

type UploadStrategy = "menu-input" | "direct" | "filechooser";

type SelectorPair = {
  name: string;
  primary: string;
  secondary?: string;
};

type SelectorMatch = {
  selector: string | null;
  mismatch: boolean;
  primaryFound: boolean;
  secondaryFound: boolean;
  primaryCount: number;
  secondaryCount: number;
};

const SELECTOR_PAIRS = {
  composerPlus: {
    name: "composerPlus",
    primary: SELECTORS.composerPlusPrimary,
    secondary: SELECTORS.composerPlusSecondary,
  },
  fileInput: {
    name: "fileInput",
    primary: SELECTORS.fileInputPrimary,
    secondary: SELECTORS.fileInputSecondary,
  },
} satisfies Record<string, SelectorPair>;

const loggedSelectorMismatches = new Set<string>();

/**
 * Upload attachments to ChatGPT before submitting the prompt.
 */
export async function uploadAttachments(
  page: Page,
  attachments: Attachment[],
  logger?: (message: string) => void,
): Promise<void> {
  for (const attachment of attachments) {
    await uploadSingleAttachment(page, attachment, logger);
  }
}

async function uploadSingleAttachment(
  page: Page,
  attachment: Attachment,
  logger?: (message: string) => void,
): Promise<void> {
  const stats = await stat(attachment.path);
  if (stats.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `File ${attachment.displayName} is too large (${stats.size} bytes). Maximum: ${MAX_FILE_SIZE_BYTES} bytes.`,
    );
  }

  const removeCount = await page.locator(SELECTORS.removeFileButton).count();
  logDebug(logger, `starting upload for ${attachment.displayName}`);

  const strategy = resolveUploadStrategy();
  const strategyOrder = buildUploadStrategyOrder(strategy);
  logDebug(logger, `upload strategy=${strategy} order=${strategyOrder.join(",")}`);
  let lastError: unknown;
  for (const attempt of strategyOrder) {
    try {
      logDebug(logger, `upload attempt strategy=${attempt}`);
      if (attempt === "filechooser") {
        await uploadViaFileChooser(page, attachment, logger);
      } else if (attempt === "direct") {
        await uploadViaDirectInput(page, attachment, logger);
      } else {
        await uploadViaMenuInput(page, attachment, logger);
      }
      await waitForRemoveButton(page, removeCount, attachment.displayName, logger);
      await waitForUploadComplete(page, attachment.displayName, logger);
      await assertNoNativeDialogOpen(logger);
      return;
    } catch (error) {
      lastError = error;
      logDebug(
        logger,
        `upload attempt failed (${attempt}): ${error instanceof Error ? error.message : String(error)}`,
      );
      await assertNoNativeDialogOpen(logger).catch((closeError) => {
        logDebug(
          logger,
          `native dialog cleanup failed: ${closeError instanceof Error ? closeError.message : String(closeError)}`,
        );
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function openAttachmentMenu(
  page: Page,
  logger?: (message: string) => void,
): Promise<void> {
  logDebug(logger, "opening attachment menu");
  const selector = await waitForSelectorPair(
    page,
    SELECTOR_PAIRS.composerPlus,
    logger,
    {
      timeoutMs: 10_000,
      state: "visible",
    },
  );
  await page.locator(selector).click();
}

async function uploadViaMenuInput(
  page: Page,
  attachment: Attachment,
  logger?: (message: string) => void,
): Promise<void> {
  await openAttachmentMenu(page, logger);
  const directSelector = await resolveExistingInputSelector(page, logger);
  if (directSelector) {
    await page.locator(directSelector).setInputFiles(attachment.path);
    logDebug(logger, `setInputFiles (menu direct) for ${attachment.displayName}`);
    return;
  }
  await page
    .waitForSelector(SELECTORS.fileInputSecondary, { timeout: 2_000 })
    .catch(() => null);
  const waitedSelector = await resolveExistingInputSelector(page, logger);
  if (waitedSelector) {
    await page.locator(waitedSelector).setInputFiles(attachment.path);
    logDebug(logger, `setInputFiles (menu wait) for ${attachment.displayName}`);
    return;
  }
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10_000 }),
    page.getByText(SELECTORS.uploadMenuText).click(),
  ]);
  await chooser.setFiles(attachment.path);
  logDebug(logger, `filechooser setFiles (menu) for ${attachment.displayName}`);
}

async function uploadViaDirectInput(
  page: Page,
  attachment: Attachment,
  logger?: (message: string) => void,
): Promise<void> {
  let directSelector = await resolveExistingInputSelector(page, logger);
  if (!directSelector) {
    logDebug(logger, "file input missing; opening attachment menu");
    await openAttachmentMenu(page, logger);
    directSelector = await resolveExistingInputSelector(page, logger);
    if (!directSelector) {
      await page
        .waitForSelector(SELECTORS.fileInputSecondary, { timeout: 2_000 })
        .catch(() => null);
      directSelector = await resolveExistingInputSelector(page, logger);
    }
  }
  if (!directSelector) {
    const [chooser] = await Promise.all([
      page.waitForEvent("filechooser", { timeout: 10_000 }),
      page.getByText(SELECTORS.uploadMenuText).click(),
    ]);
    await chooser.setFiles(attachment.path);
    logDebug(
      logger,
      `filechooser setFiles (direct fallback) for ${attachment.displayName}`,
    );
    return;
  }
  await page.locator(directSelector).setInputFiles(attachment.path);
  logDebug(logger, `setInputFiles (direct) for ${attachment.displayName}`);
}

async function uploadViaFileChooser(
  page: Page,
  attachment: Attachment,
  logger?: (message: string) => void,
): Promise<void> {
  await openAttachmentMenu(page, logger);
  const [chooser] = await Promise.all([
    page.waitForEvent("filechooser", { timeout: 10_000 }),
    page.getByText(SELECTORS.uploadMenuText).click(),
  ]);
  await chooser.setFiles(attachment.path);
  logDebug(logger, `filechooser setFiles for ${attachment.displayName}`);
}

async function waitForRemoveButton(
  page: Page,
  previousCount: number,
  fileName: string,
  logger?: (message: string) => void,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const count = await page.locator(SELECTORS.removeFileButton).count();
    if (count > previousCount) {
      logDebug(logger, `remove button visible for ${fileName}`);
      return;
    }
    await sleep(300);
  }
  throw new Error(`Upload did not register for ${fileName}`);
}

async function waitForUploadComplete(
  page: Page,
  fileName: string,
  logger?: (message: string) => void,
  timeoutMs = 30_000,
): Promise<void> {
  const start = Date.now();
  let lastState:
    | {
        nameFound: boolean;
        uploading: boolean;
        complete: boolean;
        svgCount: number;
        circleCount: number;
        useCount: number;
      }
    | null = null;
  while (Date.now() - start < timeoutMs) {
    const state = (await page.evaluate(
      ({ containerSelector, name }) => {
        const container = document.querySelector(containerSelector);
        if (!container) {
          return {
            nameFound: false,
            uploading: false,
            complete: false,
            svgCount: 0,
            circleCount: 0,
            useCount: 0,
          };
        }
        const text = (container as HTMLElement).innerText || "";
        const nameFound = text.includes(name);
        const nodeContainingName = findNodeWithText(container, name);
        const scope = nodeContainingName ?? container;
        const svgs = Array.from(scope.querySelectorAll("svg")) as SVGSVGElement[];
        let hasCircle = false;
        let hasUse = false;
        let circleCount = 0;
        let useCount = 0;
        for (const svg of svgs) {
          if (svg.querySelector("circle")) {
            hasCircle = true;
            circleCount += 1;
          }
          const use = svg.querySelector("use");
          if (use) {
            const href =
              use.getAttribute("href") || use.getAttribute("xlink:href") || "";
            if (href.includes("cdn") || href.includes("sprite")) {
              hasUse = true;
              useCount += 1;
            }
          }
        }
        return {
          nameFound,
          uploading: hasCircle,
          complete: hasUse || (nameFound && !hasCircle),
          svgCount: svgs.length,
          circleCount,
          useCount,
        };

        function findNodeWithText(root: Element, needle: string): HTMLElement | null {
          const walker = document.createTreeWalker(
            root,
            NodeFilter.SHOW_ELEMENT,
          );
          let node = walker.nextNode() as HTMLElement | null;
          while (node) {
            const text = node.innerText || "";
            if (text.includes(needle)) {
              return node;
            }
            node = walker.nextNode() as HTMLElement | null;
          }
          return null;
        }
      },
      {
        containerSelector: SELECTORS.threadBottom,
        name: fileName,
      },
    )) as {
      nameFound: boolean;
      uploading: boolean;
      complete: boolean;
      svgCount: number;
      circleCount: number;
      useCount: number;
    };
    lastState = state;

    if (state.nameFound && state.complete && !state.uploading) {
      logDebug(logger, `upload complete for ${fileName}`);
      return;
    }
    await sleep(500);
  }

  if (lastState) {
    logger?.(
      `[attachments] upload confirmation timed out for ${fileName} (nameFound=${lastState.nameFound}, uploading=${lastState.uploading}, complete=${lastState.complete}, svgCount=${lastState.svgCount}, circleCount=${lastState.circleCount}, useCount=${lastState.useCount})`,
    );
  } else {
    logger?.(`[attachments] upload confirmation timed out for ${fileName}`);
  }
  throw new Error(
    `Upload confirmation not detected for ${fileName} within ${timeoutMs}ms`,
  );
}

async function waitForSelectorPair(
  page: Page,
  pair: SelectorPair,
  logger?: (message: string) => void,
  options: { timeoutMs?: number; state?: "attached" | "visible" } = {},
): Promise<string> {
  const combined = pair.secondary ? `${pair.primary}, ${pair.secondary}` : pair.primary;
  logDebug(
    logger,
    `waitForSelectorPair ${pair.name} combined="${combined}" state=${options.state ?? "attached"}`,
  );
  await page.waitForSelector(combined, {
    timeout: options.timeoutMs,
    state: options.state ?? "attached",
  });
  const resolved = await resolveSelectorPair(page, pair, logger);
  if (!resolved.selector) {
    throw new Error(`Selector not found for ${pair.name}`);
  }
  logDebug(
    logger,
    `selector resolved ${pair.name} -> ${resolved.selector} (primaryCount=${resolved.primaryCount}, secondaryCount=${resolved.secondaryCount})`,
  );
  return resolved.selector;
}

async function resolveExistingInputSelector(
  page: Page,
  logger?: (message: string) => void,
): Promise<string | null> {
  const primaryCount = await page.locator(SELECTORS.fileInputPrimary).count();
  const secondaryCount = await page.locator(SELECTORS.fileInputSecondary).count();
  logDebug(
    logger,
    `file input counts primary=${primaryCount} secondary=${secondaryCount}`,
  );
  if (primaryCount > 0) {
    logDebug(logger, "file input present (primary)");
    return SELECTORS.fileInputPrimary;
  }
  if (secondaryCount > 0) {
    logDebug(logger, "file input present (secondary)");
    return SELECTORS.fileInputSecondary;
  }
  return null;
}

async function resolveSelectorPair(
  page: Page,
  pair: SelectorPair,
  logger?: (message: string) => void,
): Promise<SelectorMatch> {
  const resolved = (await page.evaluate(
    ({
      primary,
      secondary,
    }: {
      primary: string;
      secondary: string | null;
    }) => {
      const primaryEls = Array.from(document.querySelectorAll(primary));
      const secondaryEls = secondary
        ? Array.from(document.querySelectorAll(secondary))
        : [];
      const primaryEl = primaryEls[0] ?? null;
      const secondaryEl = secondaryEls[0] ?? null;
      const mismatch = primaryEl && secondaryEl && primaryEl !== secondaryEl;
      return {
        selector: primaryEl ? primary : secondaryEl ? secondary : null,
        mismatch,
        primaryFound: Boolean(primaryEl),
        secondaryFound: Boolean(secondaryEl),
        primaryCount: primaryEls.length,
        secondaryCount: secondaryEls.length,
      };
    },
    {
      primary: pair.primary,
      secondary: pair.secondary ?? null,
    },
  )) as SelectorMatch;

  if (resolved.mismatch) {
    logSelectorMismatch(pair.name, logger);
  }

  return resolved;
}

function logSelectorMismatch(
  key: string,
  logger?: (message: string) => void,
): void {
  if (loggedSelectorMismatches.has(key)) return;
  loggedSelectorMismatches.add(key);
  logger?.(
    `[selectors] mismatch for ${key}; data-testid and aria selectors resolve to different elements. Please report this to the developer.`,
  );
}

function logDebug(
  logger: ((message: string) => void) | undefined,
  message: string,
): void {
  logger?.(`[attachments] ${message}`);
}

function resolveUploadStrategy(): UploadStrategy {
  const raw = process.env.ORACLE_UPLOAD_STRATEGY;
  if (!raw) return "menu-input";
  const normalized = raw.trim().toLowerCase();
  if (normalized === "direct") return "direct";
  if (normalized === "menu-input") return "menu-input";
  if (normalized === "filechooser") return "filechooser";
  return "menu-input";
}

function buildUploadStrategyOrder(primary: UploadStrategy): UploadStrategy[] {
  const all: UploadStrategy[] = ["menu-input", "direct", "filechooser"];
  return [primary, ...all.filter((entry) => entry !== primary)];
}

async function assertNoNativeDialogOpen(
  logger?: (message: string) => void,
): Promise<void> {
  if (!shouldCheckNativeDialog()) return;
  const counts = await getChromeDialogCounts(logger);
  if (!counts) return;
  if (counts.sheetCount > 0 || counts.dialogCount > 0) {
    logger?.(
      `[attachments] native dialog open (sheets=${counts.sheetCount}, dialogs=${counts.dialogCount})`,
    );
    await dismissNativeDialogs(logger);
    await sleep(200);
    const after = await getChromeDialogCounts(logger);
    if (!after) {
      throw new Error("Native file chooser dialog still open");
    }
    if (after.sheetCount > 0 || after.dialogCount > 0) {
      throw new Error("Native file chooser dialog still open");
    }
    logger?.("[attachments] native dialog dismissed");
  }
}

function shouldCheckNativeDialog(): boolean {
  if (process.platform !== "darwin") return false;
  const raw = process.env.ORACLE_CHECK_NATIVE_DIALOG;
  if (!raw) return true;
  return raw.trim() !== "0";
}

async function getChromeDialogCounts(
  logger?: (message: string) => void,
): Promise<{ sheetCount: number; dialogCount: number } | null> {
  const { execFile } = await import("child_process");
  const script = [
    'tell application "System Events"',
    'tell process "Google Chrome"',
    "set sheetTotal to 0",
    "set dialogTotal to 0",
    "repeat with w in windows",
    "set sheetTotal to sheetTotal + (count of sheets of w)",
    "try",
    "if subrole of w is \"AXDialog\" then set dialogTotal to dialogTotal + 1",
    "end try",
    "end repeat",
    "return (sheetTotal as string) & \",\" & (dialogTotal as string)",
    "end tell",
    "end tell",
  ].join("\n");
  return new Promise((resolve) => {
    execFile("osascript", ["-e", script], (err, stdout, stderr) => {
      if (err) {
        logger?.(`[attachments] sheet check failed: ${stderr || err.message}`);
        return resolve(null);
      }
      const raw = String(stdout).trim();
      const [sheetRaw, dialogRaw] = raw.split(",");
      const sheetCount = Number(sheetRaw);
      const dialogCount = Number(dialogRaw);
      if (!Number.isFinite(sheetCount) || !Number.isFinite(dialogCount)) {
        return resolve(null);
      }
      logger?.(
        `[attachments] sheet count=${sheetCount} dialog count=${dialogCount}`,
      );
      resolve({ sheetCount, dialogCount });
    });
  });
}

async function dismissNativeDialogs(
  logger?: (message: string) => void,
): Promise<void> {
  const { execFile } = await import("child_process");
  const script = [
    'tell application "System Events"',
    'tell process "Google Chrome"',
    "set closedCount to 0",
    "repeat with w in windows",
    "repeat with s in sheets of w",
    "try",
    "if exists (button \"Cancel\" of s) then",
    "click button \"Cancel\" of s",
    "set closedCount to closedCount + 1",
    "end if",
    "end try",
    "end repeat",
    "try",
    "if subrole of w is \"AXDialog\" then",
    "if exists (button \"Cancel\" of w) then",
    "click button \"Cancel\" of w",
    "set closedCount to closedCount + 1",
    "end if",
    "end if",
    "end try",
    "end repeat",
    "return closedCount as string",
    "end tell",
    "end tell",
  ].join("\n");
  await new Promise<void>((resolve) => {
    execFile("osascript", ["-e", script], (err, stdout, stderr) => {
      if (err) {
        logger?.(
          `[attachments] dialog dismiss failed: ${stderr || err.message}`,
        );
        return resolve();
      }
      const raw = String(stdout).trim();
      logger?.(`[attachments] dialog dismiss count=${raw || "0"}`);
      resolve();
    });
  });
}
