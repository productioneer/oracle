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

  await openAttachmentMenu(page, logger);
  await page.getByText(SELECTORS.uploadMenuText).click();

  const inputSelector = await waitForSelectorPair(
    page,
    SELECTOR_PAIRS.fileInput,
    logger,
    {
      timeoutMs: 10_000,
      state: "attached",
    },
  );
  await page.locator(inputSelector).setInputFiles(attachment.path);
  logDebug(logger, `setInputFiles for ${attachment.displayName}`);

  await waitForRemoveButton(page, removeCount, attachment.displayName, logger);
  await waitForUploadComplete(page, attachment.displayName, logger);
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
  while (Date.now() - start < timeoutMs) {
    const state = (await page.evaluate(
      ({ containerSelector, name }) => {
        const container = document.querySelector(containerSelector);
        if (!container) {
          return { nameFound: false, uploading: false, complete: false };
        }
        const text = (container as HTMLElement).innerText || "";
        const nameFound = text.includes(name);
        const svgs = Array.from(
          container.querySelectorAll("svg"),
        ) as SVGSVGElement[];
        let hasCircle = false;
        let hasUse = false;
        for (const svg of svgs) {
          if (svg.querySelector("circle")) {
            hasCircle = true;
          }
          const use = svg.querySelector("use");
          if (use) {
            const href =
              use.getAttribute("href") || use.getAttribute("xlink:href") || "";
            if (href.includes("cdn") || href.includes("sprite")) {
              hasUse = true;
            }
          }
        }
        return {
          nameFound,
          uploading: hasCircle,
          complete: hasUse,
        };
      },
      {
        containerSelector: SELECTORS.threadBottom,
        name: fileName,
      },
    )) as { nameFound: boolean; uploading: boolean; complete: boolean };

    if (state.nameFound && state.complete && !state.uploading) {
      logDebug(logger, `upload complete for ${fileName}`);
      return;
    }
    await sleep(500);
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
