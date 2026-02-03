const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const {
  parsePromptAttachments,
  inlineOverflowAttachments,
} = require("../dist/run/attachments.js");

function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-attachments-"));
  try {
    fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("parsePromptAttachments ignores non-file @ tokens", () => {
  const prompt = "Ping @john and email test@foo.com for details.";
  const parsed = parsePromptAttachments(prompt, process.cwd());
  assert.equal(parsed.prompt, prompt);
  assert.equal(parsed.attachments.length, 0);
});

test("parsePromptAttachments attaches file refs and preserves punctuation", () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, "note.txt");
    fs.writeFileSync(filePath, "hello");
    const prompt = "Review @note.txt, please.";
    const parsed = parsePromptAttachments(prompt, dir);
    assert.equal(parsed.attachments.length, 1);
    assert.equal(parsed.attachments[0].path, filePath);
    assert.equal(parsed.prompt, "Review [attached: note.txt], please.");
  });
});

test("parsePromptAttachments inlines quoted ranges with line numbers", () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, "my file.ts");
    fs.writeFileSync(filePath, "one\ntwo\nthree\n");
    const prompt = 'See @"my file.ts":2-3.';
    const parsed = parsePromptAttachments(prompt, dir);
    assert.equal(parsed.attachments.length, 0);
    const expected = "See ```ts\n2\ttwo\n3\tthree\n```.";
    assert.equal(parsed.prompt, expected);
  });
});

test("parsePromptAttachments preserves blank lines in inline content", () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, "note.md");
    fs.writeFileSync(filePath, "alpha\n\nbeta\n");
    const prompt = "Include @note.md:1-3";
    const parsed = parsePromptAttachments(prompt, dir);
    assert.equal(parsed.attachments.length, 0);
    const expected = "Include ```md\n1\talpha\n2\t\n3\tbeta\n```";
    assert.equal(parsed.prompt, expected);
  });
});

test("parsePromptAttachments de-dupes inline ranges", () => {
  withTempDir((dir) => {
    const filePath = path.join(dir, "sample.ts");
    fs.writeFileSync(filePath, "alpha\nbeta\n");
    const prompt = "@sample.ts:1-2 and again @sample.ts:1-2";
    const parsed = parsePromptAttachments(prompt, dir);
    assert.equal(parsed.attachments.length, 0);
    assert.ok(parsed.prompt.includes("```ts\n1\talpha\n2\tbeta\n```"));
    assert.ok(parsed.prompt.includes("[see sample.ts:L1-2 above]"));
  });
});

test("parsePromptAttachments ignores @org/repo-style tokens", () => {
  const prompt = "Check @org/repo and @team/project for updates.";
  const parsed = parsePromptAttachments(prompt, process.cwd());
  assert.equal(parsed.prompt, prompt);
  assert.equal(parsed.attachments.length, 0);
});

test("inlineOverflowAttachments replaces markers with code blocks", () => {
  withTempDir((dir) => {
    const f1 = path.join(dir, "extra.ts");
    fs.writeFileSync(f1, "const x = 1;\n");
    const prompt =
      "Review [attached: main.ts] and [attached: extra.ts] please.";
    const overflow = [{ path: f1, displayName: "extra.ts" }];
    const result = inlineOverflowAttachments(prompt, overflow);
    assert.ok(
      result.includes("[attached: main.ts]"),
      "non-overflow marker preserved",
    );
    assert.ok(
      !result.includes("[attached: extra.ts]"),
      "overflow marker replaced",
    );
    assert.ok(result.includes("**extra.ts:**"), "filename header present");
    assert.ok(
      result.includes("```ts\nconst x = 1;\n\n```"),
      "code block present",
    );
  });
});

test("inlineOverflowAttachments handles multiple overflow files", () => {
  withTempDir((dir) => {
    const f1 = path.join(dir, "a.ts");
    const f2 = path.join(dir, "b.md");
    fs.writeFileSync(f1, "line a\n");
    fs.writeFileSync(f2, "# heading\n");
    const prompt = "Files: [attached: a.ts] and [attached: b.md].";
    const overflow = [
      { path: f1, displayName: "a.ts" },
      { path: f2, displayName: "b.md" },
    ];
    const result = inlineOverflowAttachments(prompt, overflow);
    assert.ok(!result.includes("[attached: a.ts]"));
    assert.ok(!result.includes("[attached: b.md]"));
    assert.ok(result.includes("**a.ts:**"));
    assert.ok(result.includes("**b.md:**"));
    assert.ok(result.includes("```ts\nline a\n\n```"));
    assert.ok(result.includes("```md\n# heading\n\n```"));
  });
});

test("inlineOverflowAttachments skips missing markers gracefully", () => {
  withTempDir((dir) => {
    const f1 = path.join(dir, "orphan.ts");
    fs.writeFileSync(f1, "code\n");
    const prompt = "No markers here.";
    const overflow = [{ path: f1, displayName: "orphan.ts" }];
    const result = inlineOverflowAttachments(prompt, overflow);
    assert.equal(result, prompt, "prompt unchanged when no markers match");
  });
});

test("inlineOverflowAttachments replaces binary files with note", () => {
  withTempDir((dir) => {
    const f1 = path.join(dir, "image.png");
    fs.writeFileSync(f1, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const prompt = "See [attached: image.png] for details.";
    const overflow = [{ path: f1, displayName: "image.png" }];
    const result = inlineOverflowAttachments(prompt, overflow);
    assert.ok(
      result.includes("[image.png: binary file, not inlined]"),
      "binary note present",
    );
    assert.ok(!result.includes("```"), "no code block for binary file");
  });
});

test("inlineOverflowAttachments replaces large files with note", () => {
  withTempDir((dir) => {
    const f1 = path.join(dir, "big.ts");
    // 101KB of text
    fs.writeFileSync(f1, "x".repeat(101_000));
    const prompt = "Review [attached: big.ts] please.";
    const overflow = [{ path: f1, displayName: "big.ts" }];
    const result = inlineOverflowAttachments(prompt, overflow);
    assert.ok(
      result.includes("[big.ts: 101KB, too large to inline]"),
      "size note present",
    );
    assert.ok(!result.includes("```"), "no code block for large file");
  });
});
