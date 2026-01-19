import path from "path";
import { existsSync, statSync, readFileSync } from "fs";
import type { Attachment } from "./types.js";

const KNOWN_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "csv",
  "json",
  "js",
  "ts",
  "jsx",
  "tsx",
  "py",
  "java",
  "c",
  "cpp",
  "h",
  "hpp",
  "go",
  "rs",
  "swift",
  "kt",
  "kts",
  "m",
  "mm",
  "php",
  "rb",
  "cs",
  "fs",
  "fsx",
  "scala",
  "sc",
  "sql",
  "toml",
  "ini",
  "conf",
  "xml",
  "yaml",
  "yml",
  "html",
  "css",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "svg",
  "webp",
  "zip",
  "tar",
  "gz",
  "proto",
  "graphql",
  "gql",
]);

const KNOWN_FILENAMES = new Set([
  "makefile",
  "dockerfile",
  "readme",
  "readme.md",
  "readme.txt",
  "license",
  "license.md",
  "license.txt",
]);

export type ParsedPrompt = {
  /** Prompt with @file references replaced by [attached: filename] */
  prompt: string;
  /** Original prompt before replacement */
  originalPrompt: string;
  /** Parsed attachments */
  attachments: Attachment[];
};

/**
 * Parse @file references from prompt text.
 *
 * Supports:
 * - @relative/path/to/file.ts (resolved from cwd) → uploaded as attachment
 * - @/absolute/path/to/file.ts → uploaded as attachment
 * - @"path with spaces/file.ts" (quoted paths) → uploaded as attachment
 * - @file.ts:23 (single line) → inlined as code block
 * - @file.ts:23-90 (line range, 1-indexed, inclusive) → inlined as code block
 *
 * Files without line ranges: replaced with [attached: filename.ext] and uploaded.
 * Files with line ranges: inlined as markdown code blocks with line numbers.
 * Throws if any referenced file doesn't exist.
 */
export function parsePromptAttachments(
  prompt: string,
  cwd: string = process.cwd(),
): ParsedPrompt {
  const attachments: Attachment[] = [];
  const seenAttachments = new Map<string, Attachment>();
  const seenInlines = new Set<string>();

  // Match @path or @"quoted path" patterns, optionally followed by :linespec
  // Unquoted: @followed by non-whitespace until whitespace or end
  // Quoted: @"..." or @'...'
  const pattern =
    /@(?:"([^"]+)"|'([^']+)'|(\S+))(?:\:(\d+)(?:-(\d+))?)?/g;

  const replaced = prompt.replace(
    pattern,
    (match, quoted1, quoted2, unquoted, rangeStart, rangeEnd, offset) => {
      const rawPath = quoted1 ?? quoted2 ?? unquoted;
      if (!rawPath) return match;
      const rangeSuffix = rangeStart
        ? `:${rangeStart}${rangeEnd ? `-${rangeEnd}` : ""}`
        : "";
      const rawRef = `${rawPath}${rangeSuffix}`;
      const { ref: trimmedRef, trailing } = splitTrailingPunctuation(rawRef);

      if (
        !looksLikeFileRef(trimmedRef, {
          quoted: Boolean(quoted1 || quoted2),
          prompt,
          offset,
        })
      ) {
        return match;
      }

      // Parse line range from the reference (e.g., "file.ts:23-90" or "file.ts:50")
      const { filePath, lineRange } = parseLineRange(trimmedRef);

      const resolved = resolvePath(filePath, cwd);

      // Check file exists
      if (!existsSync(resolved)) {
        throw new Error(`File not found: ${filePath} (resolved to ${resolved})`);
      }

      // Check it's a file, not a directory
      const stat = statSync(resolved);
      if (!stat.isFile()) {
        throw new Error(`Not a file: ${filePath} (resolved to ${resolved})`);
      }

      const displayName = path.basename(resolved);

      // If line range specified, inline as code block (no attachment)
      if (lineRange) {
        const inlineKey = `${resolved}:${lineRange.start}-${lineRange.end}`;
        if (seenInlines.has(inlineKey)) {
          // Already inlined this exact range, just reference it
          return `[see ${displayName}:L${lineRange.start}-${lineRange.end} above]${trailing}`;
        }
        seenInlines.add(inlineKey);

        return `${inlineFileContent(resolved, displayName, lineRange)}${trailing}`;
      }

      // No line range - create attachment
      if (seenAttachments.has(resolved)) {
        const existing = seenAttachments.get(resolved)!;
        return `[attached: ${existing.displayName}]${trailing}`;
      }

      const attachment: Attachment = { path: resolved, displayName };
      attachments.push(attachment);
      seenAttachments.set(resolved, attachment);

      return `[attached: ${displayName}]${trailing}`;
    },
  );

  return {
    prompt: replaced,
    originalPrompt: prompt,
    attachments,
  };
}

function splitTrailingPunctuation(ref: string): { ref: string; trailing: string } {
  const match = ref.match(/^(.*?)([),.;!?:\]}]+)$/);
  if (!match) return { ref, trailing: "" };
  return { ref: match[1], trailing: match[2] };
}

function looksLikeFileRef(
  rawPath: string,
  input: { quoted: boolean; prompt: string; offset: number },
): boolean {
  if (input.quoted) return true;
  if (!rawPath) return false;

  const sanitized = rawPath.replace(/:(\d+)(?:-(\d+))?$/, "");

  const prevChar = input.offset > 0 ? input.prompt[input.offset - 1] : "";
  if (prevChar && /[A-Za-z0-9._%+-]/.test(prevChar)) return false;

  if (sanitized.includes("@")) return false;
  if (/^https?:\/\//i.test(sanitized)) return false;

  if (!/^[A-Za-z0-9._~\\/:-]+$/.test(sanitized)) return false;

  const isExplicitPrefix = /^(~|\/|\.\/|\.\.\/|[A-Za-z]:[\\/])/.test(
    sanitized,
  );
  if (isExplicitPrefix) return true;

  const parts = sanitized.split(/[\\/]/);
  const base = parts[parts.length - 1] ?? sanitized;
  const baseLower = base.toLowerCase();
  const hasSeparator = sanitized.includes("/") || sanitized.includes("\\");
  const isDotFile = base.startsWith(".");
  const ext = path.extname(base).slice(1).toLowerCase();
  const hasExt = Boolean(ext);

  if (isDotFile) return true;
  if (KNOWN_FILENAMES.has(baseLower)) return true;

  if (hasSeparator) {
    return hasExt;
  }

  return hasExt && KNOWN_EXTENSIONS.has(ext);
}

/**
 * Read file and format as markdown code block with line numbers.
 */
function inlineFileContent(
  filePath: string,
  displayName: string,
  lineRange: { start: number; end: number },
): string {
  const content = readFileSync(filePath, "utf-8");
  const allLines = content.split("\n");
  const { start, end } = lineRange;

  if (start > allLines.length) {
    throw new Error(
      `Line ${start} exceeds file length (${allLines.length} lines): ${displayName}`,
    );
  }

  // Extract lines (1-indexed, inclusive), clamp end to file length
  const actualEnd = Math.min(end, allLines.length);
  const selectedLines = allLines.slice(start - 1, actualEnd);

  // Format with line numbers: <lineno><tab><content>
  const formatted = selectedLines
    .map((line, idx) => `${start + idx}\t${line}`)
    .join("\n");

  // Detect language from extension for syntax highlighting
  const ext = path.extname(displayName).slice(1);
  const lang = ext || "";

  return `\`\`\`${lang}\n${formatted}\n\`\`\``;
}

function parseLineRange(ref: string): {
  filePath: string;
  lineRange?: { start: number; end: number };
} {
  // Match :N or :N-M at the end of the reference
  const lineMatch = ref.match(/:(\d+)(?:-(\d+))?$/);
  if (!lineMatch) {
    return { filePath: ref };
  }

  const filePath = ref.slice(0, lineMatch.index);
  const start = parseInt(lineMatch[1], 10);
  const end = lineMatch[2] ? parseInt(lineMatch[2], 10) : start;

  if (start < 1 || end < start) {
    throw new Error(
      `Invalid line range: ${lineMatch[0]} (must be positive, end >= start)`,
    );
  }

  return { filePath, lineRange: { start, end } };
}

function resolvePath(filePath: string, cwd: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  return path.resolve(cwd, filePath);
}
