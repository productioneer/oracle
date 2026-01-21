import path from "path";
import { readFile, stat } from "fs/promises";
import type { Page } from "puppeteer";
import type { Attachment } from "../run/types.js";
import { sleep } from "../utils/time.js";

const MAX_FILE_SIZE_BYTES = 20 * 1024 * 1024; // 20MB

const FILE_INPUT_SELECTORS = [
  'input[type="file"]',
  '[data-testid*="file-upload"] input',
  '[data-testid*="attachment"] input',
];

const UPLOAD_INDICATORS = [
  // chatgpt attachment indicators (various ui versions)
  '[data-testid*="attachment"]',
  '[data-testid*="file"]',
  '[data-testid*="upload"]',
  // remove/delete buttons near attachments
  '[aria-label*="Remove"]',
  '[aria-label*="remove"]',
  '[aria-label*="Delete"]',
  '[aria-label*="delete"]',
  // attachment pill/chip containers
  '[class*="attachment"]',
  '[class*="Attachment"]',
  '[class*="upload"]',
  '[class*="Upload"]',
  '[class*="file-"]',
  '[class*="File"]',
  // composer area file indicators
  '#composer-background [class*="pill"]',
  '#composer-background [class*="chip"]',
  // generic close buttons that might indicate an attachment
  'button[aria-label*="close"]',
  'button[aria-label*="Close"]',
];

/**
 * Upload attachments to ChatGPT before submitting the prompt.
 * Prefers native uploadFile, falls back to DataTransfer injection.
 */
export async function uploadAttachments(
  page: Page,
  attachments: Attachment[],
): Promise<void> {
  for (const attachment of attachments) {
    await uploadSingleAttachment(page, attachment);
  }
}

async function uploadSingleAttachment(
  page: Page,
  attachment: Attachment,
): Promise<void> {
  const stats = await stat(attachment.path);
  if (stats.size > MAX_FILE_SIZE_BYTES) {
    throw new Error(
      `File ${attachment.displayName} is too large (${stats.size} bytes). Maximum: ${MAX_FILE_SIZE_BYTES} bytes.`,
    );
  }

  // Find file input element
  const fileInputSelector = await findFileInput(page);
  if (!fileInputSelector) {
    throw new Error("Could not find file input element for uploads");
  }

  let uploaded = false;
  let uploadError: string | null = null;

  const inputHandle = (await page.$(
    fileInputSelector,
  )) as import("puppeteer").ElementHandle<HTMLInputElement> | null;
  if (!inputHandle) {
    throw new Error("Could not find file input element for uploads");
  }
  try {
    await inputHandle.uploadFile(attachment.path);
    uploaded = true;
  } catch (error) {
    uploadError = error instanceof Error ? error.message : String(error);
  } finally {
    await inputHandle.dispose().catch(() => null);
  }

  if (!uploaded) {
    const fileContent = await readFile(attachment.path);
    const base64Content = fileContent.toString("base64");
    const mimeType = guessMimeType(attachment.displayName);

    // Inject file via DataTransfer API
    const result = await page.evaluate(
      (selector, base64, mime, fileName) => {
        const fileInput = document.querySelector(selector);
        if (
          !fileInput ||
          !(fileInput instanceof HTMLInputElement) ||
          fileInput.type !== "file"
        ) {
          return { success: false, error: "File input not found or invalid" };
        }

        try {
          const binaryString = atob(base64);
          const bytes = new Uint8Array(binaryString.length);
          for (let i = 0; i < binaryString.length; i++) {
            bytes[i] = binaryString.charCodeAt(i);
          }
          const blob = new Blob([bytes], { type: mime });
          const file = new File([blob], fileName, {
            type: mime,
            lastModified: Date.now(),
          });

          const dataTransfer = new DataTransfer();
          dataTransfer.items.add(file);

          // Try multiple approaches to set files
          let assigned = false;

          // Approach 1: Use property descriptor
          const proto = Object.getPrototypeOf(fileInput);
          const descriptor = proto
            ? Object.getOwnPropertyDescriptor(proto, "files")
            : null;
          if (descriptor?.set) {
            try {
              descriptor.set.call(fileInput, dataTransfer.files);
              assigned = true;
            } catch {
              assigned = false;
            }
          }

          // Approach 2: Define property
          if (!assigned) {
            try {
              Object.defineProperty(fileInput, "files", {
                configurable: true,
                get: () => dataTransfer.files,
              });
              assigned = true;
            } catch {
              assigned = false;
            }
          }

          // Approach 3: Direct assignment
          if (!assigned) {
            try {
              fileInput.files = dataTransfer.files;
              assigned = true;
            } catch {
              assigned = false;
            }
          }

          if (!assigned) {
            return { success: false, error: "Unable to assign files to input" };
          }

          // Dispatch change event to trigger UI update
          fileInput.dispatchEvent(new Event("change", { bubbles: true }));
          return { success: true };
        } catch (e) {
          return { success: false, error: String(e) };
        }
      },
      fileInputSelector,
      base64Content,
      mimeType,
      attachment.displayName,
    );

    if (!result.success) {
      const details = uploadError ? ` (uploadFile: ${uploadError})` : "";
      throw new Error(
        `Failed to upload ${attachment.displayName}: ${result.error}${details}`,
      );
    }
  }

  // Wait for upload indicator to appear
  await waitForUploadConfirmation(page, attachment.displayName, fileInputSelector);
}

async function findFileInput(page: Page): Promise<string | null> {
  for (const selector of FILE_INPUT_SELECTORS) {
    const exists = await page.$(selector);
    if (exists) return selector;
  }
  return null;
}

async function waitForUploadConfirmation(
  page: Page,
  fileName: string,
  fileInputSelector?: string | null,
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  const normalizedName = fileName.toLowerCase();
  // also check without extension for partial matches
  const baseName = normalizedName.replace(/\.[^.]+$/, "");
  const allowBaseMatch =
    baseName.length >= 3 && baseName !== normalizedName && !baseName.startsWith(".");

  while (Date.now() - start < timeoutMs) {
    const found = await page.evaluate(
      (
        indicatorSelectors,
        inputSelectors,
        specificInputSelector,
        name,
        base,
        allowBase,
      ) => {
        const matchesName = (value: string): boolean => {
          if (!value) return false;
          if (value.includes(name)) return true;
          if (allowBase && base && value.includes(base)) return true;
          return false;
        };

        const isVisible = (el: HTMLElement): boolean => {
          const style = window.getComputedStyle(el);
          return (
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            style.opacity !== "0"
          );
        };

        // Prefer composer area to avoid matching previous messages
        const composerArea =
          document.querySelector("#composer-background") ||
          document.querySelector('[data-testid*="composer"]') ||
          document.querySelector('form[class*="composer"]');
        const searchRoots = composerArea ? [composerArea] : [document];

        // strategy 0: check file inputs for matching files
        const inputRoot = document;
        const selectorList = [
          ...(specificInputSelector ? [specificInputSelector] : []),
          ...inputSelectors,
        ];
        const seenSelectors = new Set<string>();
        for (const selector of selectorList) {
          if (!selector || seenSelectors.has(selector)) continue;
          seenSelectors.add(selector);
          const inputs = Array.from(
            inputRoot.querySelectorAll(selector),
          ) as HTMLInputElement[];
          for (const input of inputs) {
            if (!(input instanceof HTMLInputElement)) continue;
            const value = (input.value || "").toLowerCase();
            if (matchesName(value)) {
              return { found: true, strategy: "file-input" };
            }
            const fileNames = Array.from(input.files ?? []).map((file) =>
              file.name.toLowerCase(),
            );
            if (fileNames.some((file) => matchesName(file))) {
              return { found: true, strategy: "file-input" };
            }
          }
        }

        // strategy 1: look for filename in indicator elements near composer
        for (const root of searchRoots) {
          for (const selector of indicatorSelectors) {
            const elements = Array.from(
              root.querySelectorAll(selector),
            ) as HTMLElement[];
            for (const el of elements) {
              if (!isVisible(el)) continue;
              const text = (el.textContent || "").toLowerCase();
              const aria = (el.getAttribute("aria-label") || "").toLowerCase();
              const title = (el.getAttribute("title") || "").toLowerCase();
              if (matchesName(text) || matchesName(aria) || matchesName(title)) {
                return { found: true, strategy: "name-match" };
              }
            }
          }
        }

        // strategy 2: look for remove/close buttons near the filename in composer
        if (composerArea) {
          const buttons = Array.from(
            composerArea.querySelectorAll("button[aria-label], button[title]"),
          ) as HTMLButtonElement[];
          for (const button of buttons) {
            const label = (
              button.getAttribute("aria-label") ||
              button.getAttribute("title") ||
              ""
            ).toLowerCase();
            if (!/remove|delete|close/.test(label)) continue;
            if (matchesName(label)) {
              return { found: true, strategy: "close-button" };
            }
            const container =
              button.closest(
                '[class*="chip"], [class*="pill"], [class*="attachment"], [class*="file"]',
              ) ?? button.parentElement;
            if (container) {
              const text = (container.textContent || "").toLowerCase();
              if (matchesName(text)) {
                return { found: true, strategy: "close-button" };
              }
            }
          }
        }

        // strategy 3: check for loading indicator that might precede confirmation
        const loadingIndicators = document.querySelectorAll(
          '[class*="loading"], [class*="spinner"], [class*="progress"]',
        );
        const hasActiveLoading = Array.from(loadingIndicators).some(
          (el) => (el as HTMLElement).offsetParent !== null,
        );
        if (hasActiveLoading) {
          return { found: false, loading: true };
        }

        return { found: false };
      },
      UPLOAD_INDICATORS,
      FILE_INPUT_SELECTORS,
      fileInputSelector ?? null,
      normalizedName,
      baseName,
      allowBaseMatch,
    );

    if (found.found) return;
    await sleep(300);
  }

  throw new Error(
    `Upload confirmation not detected for ${fileName} within ${timeoutMs}ms`,
  );
}

function guessMimeType(fileName: string): string {
  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes: Record<string, string> = {
    ".txt": "text/plain",
    ".md": "text/markdown",
    ".csv": "text/csv",
    ".json": "application/json",
    ".js": "text/javascript",
    ".ts": "text/typescript",
    ".jsx": "text/javascript",
    ".tsx": "text/typescript",
    ".py": "text/x-python",
    ".java": "text/x-java",
    ".c": "text/x-c",
    ".cpp": "text/x-c++",
    ".h": "text/x-c",
    ".hpp": "text/x-c++",
    ".sh": "text/x-sh",
    ".bash": "text/x-sh",
    ".html": "text/html",
    ".css": "text/css",
    ".xml": "text/xml",
    ".yaml": "text/yaml",
    ".yml": "text/yaml",
    ".pdf": "application/pdf",
    ".doc": "application/msword",
    ".docx":
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xls": "application/vnd.ms-excel",
    ".xlsx":
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg",
    ".gif": "image/gif",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
    ".zip": "application/zip",
    ".tar": "application/x-tar",
    ".gz": "application/gzip",
  };
  return mimeTypes[ext] || "application/octet-stream";
}
