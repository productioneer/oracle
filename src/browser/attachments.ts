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
  '[data-testid*="attachment"]',
  '[data-testid*="file"]',
  '[aria-label*="Remove"]',
  '[aria-label*="remove"]',
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
  await waitForUploadConfirmation(page, attachment.displayName);
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
  timeoutMs = 10_000,
): Promise<void> {
  const start = Date.now();
  const normalizedName = fileName.toLowerCase();

  while (Date.now() - start < timeoutMs) {
    const found = await page.evaluate(
      (selectors, name) => {
        for (const selector of selectors) {
          const elements = Array.from(
            document.querySelectorAll(selector),
          ) as HTMLElement[];
          for (const el of elements) {
            const text = (el.textContent || "").toLowerCase();
            const aria = (el.getAttribute("aria-label") || "").toLowerCase();
            const title = (el.getAttribute("title") || "").toLowerCase();
            if (
              text.includes(name) ||
              aria.includes(name) ||
              title.includes(name)
            ) {
              return true;
            }
          }
        }
        return false;
      },
      UPLOAD_INDICATORS,
      normalizedName,
    );

    if (found) return;
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
