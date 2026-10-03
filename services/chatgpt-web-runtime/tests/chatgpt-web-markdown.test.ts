import { expect, test } from "bun:test";
import { chatGptHtmlToMarkdown, ChatGptMarkdownBuffer, ChatGptMarkdownConsistencyError } from "../src/adapters/chatgpt-web/markdown";
import type { ChatGptMarkdownSegment } from "../src/adapters/chatgpt-web/markdown";

test("turns observed inline file path formats into Markdown links", () => {
  const cases = [
    {
      path: "output/path-format-probe/alpha-notes.md",
      target: "output/path-format-probe/alpha-notes.md",
    },
    {
      path: "output/path-format-probe/beta-report.json",
      target: "output/path-format-probe/beta-report.json",
    },
    {
      path: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
      target: "/Users/example/codex-chatgpt-web/src/path-format-probe/gamma-helper.ts",
    },
    {
      path: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
      target: "/Users/example/codex-chatgpt-web/output/path-format-probe/epsilon-report.pdf",
    },
    {
      path: String.raw`C:\Users\Dev\Documents\Codex\path-format-probe\zeta-result.pdf`,
      target: "C:/Users/Dev/Documents/Codex/path-format-probe/zeta-result.pdf",
    },
    {
      path: String.raw`C:\Codex_Project_Unity\_Editor\file.cs`,
      target: "C:/Codex_Project_Unity/_Editor/file.cs",
    },
    {
      path: String.raw`C:\Codex_Project_Unity\_file.cs`,
      target: "C:/Codex_Project_Unity/_file.cs",
    },
    {
      path: String.raw`\\server\share_name\_Editor\file.cs`,
      target: "//server/share_name/_Editor/file.cs",
    },
    {
      path: "src/_private_/file_name.ts",
      target: "src/_private_/file_name.ts",
    },
    {
      path: "src/adapters/chatgpt-web/markdown.ts:47:3",
      target: "src/adapters/chatgpt-web/markdown.ts:47:3",
    },
  ];

  for (const { path, target } of cases) {
    const markdown = chatGptHtmlToMarkdown(`<p>Created <code>${path}</code>.</p>`);
    expect(markdown).toContain(`](<${target}>)`);
    expect(Bun.markdown.html(markdown))
      .toBe(`<p>Created <a href="${target}">${path}</a>.</p>\n`);
  }
});

test("preserves inline code that is not an unambiguous file path", () => {
  const html = [
    "<p>",
    "Run <code>bun test tests/example.test.ts</code>, inspect <code>FileChangeItem</code>, ",
    "and retain <code>turn/diff/updated</code>, <code>https://example.com/report.pdf</code>, ",
    "and <code>src/path without-extension</code>, <code>src/.</code>, and <code>src/..</code>.",
    "</p>",
    "<pre><code>src/example.ts</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe([
    "Run `bun test tests/example.test.ts`, inspect `FileChangeItem`, and retain `turn/diff/updated`, `https://example.com/report.pdf`, and `src/path without-extension`, `src/.`, and `src/..`.",
    "",
    "```",
    "src/example.ts",
    "```",
  ].join("\n"));
});

test("does not nest a generated file link inside an existing link", () => {
  expect(chatGptHtmlToMarkdown(
    '<p>Open <a href="https://example.com/source"><code>src/example.ts</code></a>.</p>',
  )).toBe("Open [`src/example.ts`](https://example.com/source).");
});

test("converts Obsidian aliases and headings but preserves code examples and embeds", () => {
  const html = [
    "<p>Open [[Notes/weekly-review|review]] and [[Projects/sample#Status]].</p>",
    "<p>Keep <code>[[wiki/example]]</code> and ![[image.png]] literal.</p>",
    "<pre><code>\`\`\`not a closing fence\n[[wiki/fenced]]</code></pre>",
  ].join("");

  expect(chatGptHtmlToMarkdown(html)).toBe([
    "Open [review](<Notes/weekly-review.md>) and [Projects/sample#Status](<Projects/sample.md#Status>).",
    "",
    "Keep `[[wiki/example]]` and ![[image.png]] literal.",
    "",
    "````",
    "```not a closing fence",
    "[[wiki/fenced]]",
    "````",
  ].join("\n"));
});

test("preserves standalone Codex plan markers in paragraphs and list continuations", () => {
  expect(chatGptHtmlToMarkdown([
    "<p>&lt;proposed_plan&gt;</p>",
    "<h2>Plan</h2>",
    "<ul><li><p>Keep snake_case.</p><p>&lt;/proposed_plan&gt;</p></li></ul>",
  ].join(""))).toBe([
    "<proposed_plan>", "", "## Plan", "", "- Keep snake\\_case.", "  ", "  </proposed_plan>",
  ].join("\n"));
  expect(chatGptHtmlToMarkdown("<p>&lt;proposed_plan&gt;<br>Step<br>&lt;/proposed_plan&gt;</p>"))
    .toBe("<proposed_plan>  \nStep  \n</proposed_plan>");
});

test("preserving plan markers does not rewrite mentions or literal code", () => {
  expect(chatGptHtmlToMarkdown([
    "<p>Mention &lt;proposed_plan&gt; and &lt;/proposed_plan&gt; inline.</p>",
    "<p><code>&lt;proposed_plan&gt;</code> <code>&lt;/proposed_plan&gt;</code></p>",
    "<pre><code>&lt;proposed\\_plan&gt;\n&lt;/proposed\\_plan&gt;</code></pre>",
  ].join(""))).toBe([
    "Mention <proposed\\_plan> and </proposed\\_plan> inline.", "",
    "`<proposed_plan>` `</proposed_plan>`", "",
    "```", "<proposed\\_plan>", "</proposed\\_plan>", "```",
  ].join("\n"));
});

import { duplicateScenarios } from "./fixtures/markdown-duplicate-scenarios";

for (const scenario of duplicateScenarios) {
  test(scenario.name, () => {
    const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
    for (const [index, observation] of scenario.observations.entries()) {
      expect(buffer.observe(observation, index)).toBe(scenario.deltas[index]!);
      expect(buffer.currentSnapshotIsConsistent()).toBe(true);
    }
    expect(buffer.finish()).toEqual(scenario.final);
    expect(buffer.finish()).toEqual({ markdown: scenario.final.markdown, delta: "" });
  });
}

function paragraph(key: string, text: string, options: Partial<ChatGptMarkdownSegment> = {}): ChatGptMarkdownSegment {
  return { key, tag: "p", html: `<p>${text}</p>`, text, streamable: false, ...options };
}

test("shifted pending duplicates use a unique ordered alignment between exact anchors", () => {
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  const first = paragraph("first", "Same", { streamable: true });
  const tail = paragraph("tail", "Tail");
  expect(buffer.observe([first, paragraph("second", "Same"), paragraph("third", "Same"), tail], 0)).toBe("Same");
  const shifted = [
    first,
    paragraph("remounted-second", "Same", { streamable: true }),
    paragraph("remounted-third", "Same", { streamable: true }),
    tail,
  ];
  expect(buffer.observe(shifted, 1)).toBe("\n\nSame\n\nSame");
  expect(buffer.observe(shifted, 2)).toBe("");
  expect(buffer.finish()).toEqual({ markdown: "Same\n\nSame\n\nSame\n\nTail", delta: "\n\nTail" });
});

test("a virtualized semantic duplicate with two possible ledger occurrences waits for exact evidence", () => {
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  const first = paragraph("first", "Private repeated text", { streamable: true });
  const second = paragraph("second", "Private repeated text");
  const tail = paragraph("tail", "Tail");
  expect(buffer.observe([first, second, tail], 0)).toBe("Private repeated text");
  expect(buffer.observe([paragraph("remounted", second.text), tail], 1)).toBe("");
  expect(buffer.currentSnapshotIsConsistent()).toBe(false);
  let failure: ChatGptMarkdownConsistencyError | undefined;
  try { buffer.finish(); } catch (error) { failure = error as ChatGptMarkdownConsistencyError; }
  expect(failure).toBeInstanceOf(ChatGptMarkdownConsistencyError);
  expect(failure?.diagnostic).toMatchObject({ reason: "alignment_ambiguous", matchCount: 2 });
  expect(JSON.stringify(failure?.diagnostic)).not.toContain(second.text);
  expect(buffer.observe([second, tail], 2)).toBe("");
  expect(buffer.currentSnapshotIsConsistent()).toBe(true);
  expect(buffer.finish()).toEqual({ markdown: "Private repeated text\n\nPrivate repeated text\n\nTail", delta: "\n\nPrivate repeated text\n\nTail" });
});

test("range evidence wins over a recycled DOM key and preserves the pending duplicate", () => {
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  const first = paragraph("0:p", "Same", { sourceStart: 0, sourceEnd: 4, streamable: true });
  const second = paragraph("6:p", "Same", { sourceStart: 6, sourceEnd: 10 });
  expect(buffer.observe([first, second], 0)).toBe("Same");
  expect(buffer.observe([{ ...second, key: first.key }], 1)).toBe("");
  expect(buffer.finish()).toEqual({ markdown: "Same\n\nSame", delta: "\n\nSame" });
});

test("repeated ranged paragraphs remain incremental after virtualizing the first occurrence", () => {
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 100);
  const first = paragraph("old-root:0", "Same", { sourceStart: 0, sourceEnd: 4, streamable: true });
  const second = paragraph("old-root:6", "Same", { sourceStart: 6, sourceEnd: 10 });
  expect(buffer.observe([first, second], 0)).toBe("");
  expect(buffer.observe([first, second], 100)).toBe("Same");
  const remounted = { ...second, key: "new-root:6", streamable: true };
  const tail = paragraph("tail", "Tail", { sourceStart: 12, sourceEnd: 16 });
  expect(buffer.observe([remounted, tail], 150)).toBe("");
  expect(buffer.observe([remounted, tail], 250)).toBe("\n\nSame");
  expect(buffer.finish()).toEqual({ markdown: "Same\n\nSame\n\nTail", delta: "\n\nTail" });
});

test("semantic occurrence identity includes the tag", () => {
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  expect(buffer.observe([paragraph("paragraph", "Same", { streamable: true })], 0)).toBe("Same");
  expect(buffer.observe([
    paragraph("paragraph", "Same", { streamable: true }),
    { key: "heading", tag: "h2", text: "Same", html: "<h2>Same</h2>", streamable: false },
  ], 1)).toBe("");
  expect(buffer.finish()).toEqual({ markdown: "Same\n\n## Same", delta: "\n\n## Same" });
});

test("empty blocks never acquire a semantic identity", () => {
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  const rule = { key: "rule-one", tag: "hr", html: "<hr>", text: "", streamable: true };
  const first = paragraph("first", "First", { streamable: true });
  expect(buffer.observe([first, rule], 0)).toBe("First\n\n* * *");
  expect(buffer.observe([first, rule, { ...rule, key: "rule-two", streamable: false }], 1)).toBe("");
  expect(buffer.finish()).toEqual({ markdown: "First\n\n* * *\n\n* * *", delta: "\n\n* * *" });
});

for (const identity of ["key", "range"] as const) {
  test(`committed text and link target rewrites fail under ${identity} identity`, () => {
    for (const mutation of ["text", "link"] as const) {
      const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
      const original = paragraph("original", "Source", {
        html: '<p><a href="https://example.com/one">Source</a></p>',
        linkTargets: ["https://example.com/one"], streamable: true,
        ...(identity === "range" ? { sourceStart: 0, sourceEnd: 6 } : {}),
      });
      expect(buffer.observe([original], 0)).toBe("[Source](https://example.com/one)");
      const changed = {
        ...original,
        ...(identity === "range" ? { key: "remounted" } : {}),
        ...(mutation === "text" ? { text: "Changed", html: "<p>Changed</p>" } : {
          html: '<p><a href="https://example.com/two">Source</a></p>', linkTargets: ["https://example.com/two"],
        }),
      };
      expect(buffer.observe([changed], 1)).toBe("");
      expect(buffer.currentSnapshotIsConsistent()).toBe(false);
      expect(() => buffer.finish()).toThrow("changed a completed text block");
    }
  });
}

test("markup-only hydration cannot retract a committed block or duplicate its output", () => {
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  const source = paragraph("source", "Stable", { streamable: true });
  expect(buffer.observe([source], 0)).toBe("Stable");
  expect(buffer.observe([{ ...source, html: "<p><strong>Stable</strong><button>Copy</button></p>" }], 1)).toBe("");
  expect(buffer.finish()).toEqual({ markdown: "Stable", delta: "" });
});

test("reordered exact ledger anchors remain a consistency error", () => {
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  const first = paragraph("first", "First", { streamable: true });
  const second = paragraph("second", "Second", { streamable: true });
  expect(buffer.observe([first, second], 0)).toBe("First\n\nSecond");
  expect(buffer.observe([second, first], 1)).toBe("");
  expect(() => buffer.finish()).toThrow("changed a completed text block");
});

test("overlapping and reversed source ranges remain consistency errors", () => {
  for (const range of [{ sourceStart: 5, sourceEnd: 12 }, { sourceStart: -1, sourceEnd: 2 }]) {
    const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
    const first = paragraph("first", "First", { sourceStart: 0, sourceEnd: 8, streamable: true });
    expect(buffer.observe([first], 0)).toBe("First");
    expect(buffer.observe([first, paragraph("next", "Next", range)], 1)).toBe("");
    expect(() => buffer.finish()).toThrow(ChatGptMarkdownConsistencyError);
  }
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 0);
  const first = paragraph("first", "First", { sourceStart: 0, sourceEnd: 8, streamable: true });
  expect(buffer.observe([first], 0)).toBe("First");
  expect(buffer.observe([paragraph("overlap", "Overlap", { sourceStart: 4, sourceEnd: 12 })], 1)).toBe("");
  expect(() => buffer.finish()).toThrow("changed a completed text block");
});

test("pending markup hydration resets stability and keeps grouped list deltas", () => {
  const buffer = new ChatGptMarkdownBuffer(markdown => markdown, 100);
  const alpha = paragraph("alpha", "alpha", { html: "<ul><li>alpha</li></ul>", group: "list", streamable: true });
  const beta = paragraph("beta", "beta", { html: "<ul><li>beta</li></ul>", group: "list" });
  expect(buffer.observe([alpha, beta], 0)).toBe("");
  const hydrated = { ...alpha, html: "<ul><li><strong>alpha</strong></li></ul>" };
  expect(buffer.observe([hydrated, beta], 50)).toBe("");
  expect(buffer.observe([hydrated, beta], 149)).toBe("");
  expect(buffer.observe([hydrated, beta], 150)).toBe("- **alpha**");
  expect(buffer.finish()).toEqual({ markdown: "- **alpha**\n- beta", delta: "\n- beta" });
});
