import TurndownService from "turndown";
import { gfm } from "turndown-plugin-gfm";

const turndown = new TurndownService({
  headingStyle: "atx",
  bulletListMarker: "-",
  codeBlockStyle: "fenced",
  fence: "```",
  emDelimiter: "*",
  strongDelimiter: "**",
  linkStyle: "inlined",
});

turndown.use(gfm);
turndown.remove(["button", "script", "style"]);
turndown.addRule("removeImages", {
  filter: node => ["IMG", "PICTURE", "SOURCE"].includes(node.nodeName),
  replacement: () => "",
});
turndown.addRule("removeSvg", {
  filter: node => node.nodeName === "SVG",
  replacement: () => "",
});
turndown.addRule("preserveCodexPlanBlockTags", {
  filter: "p",
  replacement: content => {
    // Codex recognizes these standalone control lines verbatim. Restore only paragraph text:
    // a post-conversion replacement would also rewrite literal escapes in fenced code.
    const paragraph = content.replace(/^([ \t]*)<(\/?)proposed\\_plan>([ \t]*)$/gm, "$1<$2proposed_plan>$3");
    return `\n\n${paragraph}\n\n`;
  },
});
turndown.addRule("linkInlineFilePaths", {
  filter: node => inlineFilePath(node) !== undefined,
  replacement: (_content, node) => {
    const path = node.textContent!;
    const target = path.replaceAll("\\", "/");
    // Code text becomes a plain link label, where backslashes and emphasis must be escaped.
    return `[${turndown.escape(path)}](<${target}>)`;
  },
});
turndown.addRule("compactListItem", {
  filter: "li",
  replacement: (content, node, options) => {
    const parent = node.parentNode as HTMLElement | null;
    let prefix = `${options.bulletListMarker} `;
    if (parent?.nodeName === "OL") {
      const start = Number(parent.getAttribute("start") ?? "1");
      const index = Array.prototype.indexOf.call(parent.children, node) as number;
      prefix = `${start + index}. `;
    }
    const normalized = content
      .replace(/^\n+|\n+$/g, "")
      .replace(/\n/g, `\n${" ".repeat(prefix.length)}`);
    return `${prefix}${normalized}${node.nextSibling ? "\n" : ""}`;
  },
});

function inlineFilePath(node: Node): string | undefined {
  if (node.nodeName !== "CODE") return undefined;
  for (let ancestor = node.parentNode; ancestor; ancestor = ancestor.parentNode) {
    if (["A", "PRE"].includes(ancestor.nodeName)) return undefined;
  }

  const path = node.textContent ?? "";
  if (path !== path.trim() || /[\s`<>()[\]]/.test(path)) return undefined;
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(path)) return undefined;

  const withoutLocation = path.replace(/:\d+(?::\d+)?$/, "");
  const separator = Math.max(withoutLocation.lastIndexOf("/"), withoutLocation.lastIndexOf("\\"));
  if (separator < 0) return undefined;

  const basename = withoutLocation.slice(separator + 1);
  if (!/\.[a-z\d][a-z\d._-]*$/i.test(basename)) return undefined;
  return path;
}

function preserveObsidianWikiLinks(markdown: string): string {
  // Turndown escapes literal brackets, but Codex interprets the resulting `\[` as LaTeX.
  // Restore the source syntax before converting it into a regular Markdown file link.
  return markdown.replace(/\\\[\\\[([^\r\n]*?)\\\]\\\]/g, "[[$1]]");
}

function obsidianWikiLink(value: string): string | undefined {
  const separator = value.indexOf("|");
  const target = (separator >= 0 ? value.slice(0, separator) : value).trim();
  const label = (separator >= 0 ? value.slice(separator + 1) : value).trim();
  if (!target || !label || /[<>]/.test(target)) return undefined;

  const fragmentAt = target.indexOf("#");
  const note = fragmentAt >= 0 ? target.slice(0, fragmentAt) : target;
  const fragment = fragmentAt >= 0 ? target.slice(fragmentAt) : "";
  const extension = note.slice(note.lastIndexOf("/") + 1).includes(".");
  const path = note && !extension ? `${note}.md` : note;
  return `[${label}](<${path}${fragment}>)`;
}

function linkObsidianWikiLinks(markdown: string): string {
  let fence: { marker: "`" | "~"; length: number } | undefined;
  return markdown.split("\n").map(line => {
    const fenceRun = line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1];
    if (fence) {
      const closingRun = line.match(/^ {0,3}(`{3,}|~{3,})[ \t]*$/)?.[1];
      if (closingRun?.[0] === fence.marker && closingRun.length >= fence.length) fence = undefined;
      return line;
    }
    if (fenceRun) {
      fence = { marker: fenceRun[0] as "`" | "~", length: fenceRun.length };
      return line;
    }

    let result = "";
    let inlineCodeTicks = 0;
    for (let index = 0; index < line.length;) {
      if (line[index] === "`") {
        let end = index + 1;
        while (line[end] === "`") end += 1;
        const ticks = end - index;
        inlineCodeTicks = inlineCodeTicks === 0 ? ticks : ticks === inlineCodeTicks ? 0 : inlineCodeTicks;
        result += line.slice(index, end);
        index = end;
        continue;
      }
      if (inlineCodeTicks === 0 && line.startsWith("[[", index) && line[index - 1] !== "!") {
        const end = line.indexOf("]]", index + 2);
        if (end >= 0) {
          const linked = obsidianWikiLink(line.slice(index + 2, end));
          if (linked) {
            result += linked;
            index = end + 2;
            continue;
          }
        }
      }
      result += line[index];
      index += 1;
    }
    return result;
  }).join("\n");
}

export function chatGptHtmlToMarkdown(html: string): string {
  if (!html.trim()) return "";
  return linkObsidianWikiLinks(preserveObsidianWikiLinks(turndown.turndown(html))).trim();
}

export interface ChatGptMarkdownSegment {
  key: string;
  tag?: string;
  html: string;
  text: string;
  linkTargets?: string[];
  group?: string;
  sourceStart?: number;
  sourceEnd?: number;
  streamable: boolean;
}

interface ChatGptMarkdownCandidate extends ChatGptMarkdownSegment {
  changedAt: number;
  streamableAt?: number;
}

interface CommittedChatGptMarkdownSegment {
  key: string;
  tag?: string;
  text: string;
  linkTargets?: string[];
  sourceStart?: number;
  sourceEnd?: number;
}

export class ChatGptMarkdownConsistencyError extends Error {
  constructor(message: string, readonly diagnostic?: {
    reason: "text_changed" | "link_target_changed" | "block_order_changed" | "source_range_overlap"
      | "alignment_ambiguous" | "alignment_unavailable";
    observedIndex?: number;
    ledgerIndex?: number;
    keyMode?: "source" | "key" | "semantic";
    matchCount?: number;
    observedStart?: number;
    observedEnd?: number;
    committedStart?: number;
    committedEnd?: number;
    observedTextChars: number;
    committedTextChars: number;
  }) {
    super(message);
    this.name = "ChatGptMarkdownConsistencyError";
  }
}

/**
 * Converts structurally completed ChatGPT DOM blocks into an append-only Markdown stream.
 *
 * ChatGPT can rewrite old HTML while hydrating citations and controls, so a character prefix is
 * not a safe commit boundary. It can also virtualize an already-rendered prefix, so later DOM
 * snapshots are partial observations rather than the response ledger. The browser supplies source
 * ranges for semantic blocks and marks a block streamable only after a following block exists.
 * Once committed, a missing prefix is harmless; changing text at a committed source range remains
 * an explicit protocol error because Responses deltas cannot be retracted.
 */
export class ChatGptMarkdownBuffer {
  private readonly candidates = new Map<string, ChatGptMarkdownCandidate>();
  private readonly committed: CommittedChatGptMarkdownSegment[] = [];
  private latest: ChatGptMarkdownSegment[] = [];
  private markdown = "";
  private lastGroup: string | undefined;
  private consistencyError: ChatGptMarkdownConsistencyError | undefined;

  constructor(
    private readonly transform: (markdown: string) => string = markdown => markdown,
    private readonly stabilityMs = 750,
  ) {
    if (!Number.isFinite(stabilityMs) || stabilityMs < 0) {
      throw new Error("ChatGPT Markdown stability window must be a non-negative finite number");
    }
  }

  observe(segments: ChatGptMarkdownSegment[], now = Date.now()): string {
    const reconciled = this.reconcile(segments);
    if (reconciled instanceof ChatGptMarkdownConsistencyError) {
      this.consistencyError = reconciled;
      return "";
    }
    this.consistencyError = undefined;
    this.latest = reconciled.map(segment => ({ ...segment }));

    const visibleCandidates = new Set<string>();
    for (const segment of reconciled) {
      const candidateId = this.candidateId(segment);
      visibleCandidates.add(candidateId);
      const previous = this.candidates.get(candidateId);
      const unchanged = previous
        && previous.key === segment.key
        && previous.tag === segment.tag
        && previous.html === segment.html
        && previous.text === segment.text
        && previous.group === segment.group
        && previous.sourceStart === segment.sourceStart
        && previous.sourceEnd === segment.sourceEnd;
      this.candidates.set(candidateId, {
        ...segment,
        changedAt: unchanged ? previous.changedAt : now,
        ...(segment.streamable ? {
          streamableAt: unchanged && previous.streamableAt !== undefined
            ? previous.streamableAt
            : now,
        } : {}),
      });
    }
    for (const candidateId of this.candidates.keys()) {
      if (!visibleCandidates.has(candidateId)) this.candidates.delete(candidateId);
    }

    let delta = "";
    let committedCount = 0;
    while (committedCount < reconciled.length) {
      const segment = reconciled[committedCount]!;
      const candidateId = this.candidateId(segment);
      const candidate = this.candidates.get(candidateId);
      if (!candidate?.streamable || candidate.streamableAt === undefined) break;
      if (now - Math.max(candidate.changedAt, candidate.streamableAt) < this.stabilityMs) break;
      delta += this.commit(candidate);
      this.committed.push(this.committedSegment(candidate));
      this.candidates.delete(candidateId);
      committedCount += 1;
    }
    this.latest = this.latest.slice(committedCount);
    return delta;
  }

  finish(): { markdown: string; delta: string } {
    if (this.consistencyError) throw this.consistencyError;
    let delta = "";
    for (const segment of this.latest) {
      delta += this.commit(segment);
      this.committed.push(this.committedSegment(segment));
    }
    this.candidates.clear();
    this.latest = [];
    return { markdown: this.markdown, delta };
  }

  currentSnapshotIsConsistent(): boolean {
    return this.consistencyError === undefined;
  }

  private reconcile(
    segments: ChatGptMarkdownSegment[],
  ): ChatGptMarkdownSegment[] | ChatGptMarkdownConsistencyError {
    const ledger = [...this.committed, ...this.latest];
    const committedCount = this.committed.length;
    const lastRangedCommitted = this.committed.findLast(segment => segment.sourceEnd !== undefined);
    let previousRanged: ChatGptMarkdownSegment | undefined;
    const options: number[][] = [];
    const anchored: boolean[] = [];
    let previousAnchor = -1;

    for (const [observedIndex, segment] of segments.entries()) {
      if (segment.sourceStart !== undefined) {
        if (previousRanged?.sourceStart !== undefined && segment.sourceStart <= previousRanged.sourceStart) {
          return new ChatGptMarkdownConsistencyError("ChatGPT final DOM exposed non-monotonic source ranges", {
            reason: "block_order_changed", observedIndex, keyMode: "source",
            observedStart: segment.sourceStart, observedEnd: segment.sourceEnd,
            committedStart: previousRanged.sourceStart, committedEnd: previousRanged.sourceEnd,
            observedTextChars: segment.text.length, committedTextChars: previousRanged.text.length,
          });
        }
        if (previousRanged?.sourceEnd !== undefined && segment.sourceStart <= previousRanged.sourceEnd) {
          return this.changedCommittedBlockError("source_range_overlap", segment, previousRanged);
        }
        previousRanged = segment;
      }

      // Search the entire ledger before considering semantics. In particular, an exact
      // pending identity must never be rebound to an earlier committed duplicate.
      const ranged = ledger.flatMap((entry, index) => (
        segment.sourceStart !== undefined && entry.sourceStart === segment.sourceStart && entry.tag === segment.tag
          ? [index] : []
      ));
      const keyed = ranged.length ? [] : ledger.flatMap((entry, index) => (
        entry.key === segment.key
          && !(segment.sourceStart !== undefined && entry.sourceStart !== undefined)
          ? [index] : []
      ));
      const exact = ranged.length ? ranged : keyed;
      if (exact.length === 1) {
        const ledgerIndex = exact[0]!;
        const entry = ledger[ledgerIndex]!;
        if (ledgerIndex <= previousAnchor) {
          return this.changedCommittedBlockError("block_order_changed", segment, entry);
        }
        previousAnchor = ledgerIndex;
        if (ledgerIndex < committedCount) {
          if (entry.text !== segment.text) return this.changedCommittedBlockError("text_changed", segment, entry);
          if (JSON.stringify(entry.linkTargets ?? []) !== JSON.stringify(segment.linkTargets ?? [])) {
            return this.changedCommittedBlockError("link_target_changed", segment, entry);
          }
        }
      }
      if (exact.length) {
        options.push(exact);
        anchored.push(true);
        continue;
      }
      if (segment.sourceStart !== undefined && lastRangedCommitted?.sourceEnd !== undefined
        && segment.sourceStart <= lastRangedCommitted.sourceEnd) {
        return this.changedCommittedBlockError("source_range_overlap", segment, lastRangedCommitted);
      }
      // Ledger indices are stable occurrence identities, even when a virtualized
      // snapshot starts halfway through repeated paragraphs. Empty text is not identity.
      options.push(segment.sourceStart === undefined && segment.tag && segment.text.trim()
        ? ledger.flatMap((entry, index) => (
          entry.tag === segment.tag && entry.text === segment.text ? [index] : []
        )) : []);
      anchored.push(false);
    }

    type Alignment = { index: number; previous?: Alignment };
    type State = { count: number; alignment?: Alignment };
    let states = new Map<number, State>([[-1, { count: 1 }]]);
    for (const [observedIndex, segment] of segments.entries()) {
      const next = new Map<number, State>();
      const add = (index: number, state: State) => {
        const existing = next.get(index);
        if (existing) existing.count = Math.min(2, existing.count + state.count);
        else next.set(index, {
          count: state.count,
          alignment: { index, previous: state.alignment },
        });
      };
      for (const [previousIndex, state] of states) {
        let matched = false;
        for (const ledgerIndex of options[observedIndex]!) {
          if (ledgerIndex <= previousIndex) continue;
          matched = true;
          add(ledgerIndex, state);
        }
        // A new occurrence is an append, never an alternative to an available
        // ledger occurrence. Range evidence or a visible tail proves the boundary.
        if (!matched && !anchored[observedIndex] && (
          committedCount === 0 || previousIndex >= committedCount - 1
          || (segment.sourceStart !== undefined && lastRangedCommitted?.sourceEnd !== undefined
            && segment.sourceStart > lastRangedCommitted.sourceEnd)
        )) add(ledger.length + observedIndex, state);
      }
      states = next;
      if (!states.size) return this.alignmentError("alignment_unavailable", observedIndex, 0);
    }
    const matchCount = Math.min(2, [...states.values()].reduce((sum, state) => sum + state.count, 0));
    if (matchCount !== 1) return this.alignmentError("alignment_ambiguous", undefined, matchCount);
    const indices: number[] = [];
    let alignment = states.values().next().value!.alignment;
    while (alignment) {
      indices.push(alignment.index);
      alignment = alignment.previous;
    }
    indices.reverse();
    const pending: ChatGptMarkdownSegment[] = [];
    for (const [observedIndex, segment] of segments.entries()) {
      const ledgerIndex = indices[observedIndex]!;
      if (ledgerIndex >= committedCount) pending.push(segment);
      else {
        const entry = this.committed[ledgerIndex]!;
        if (JSON.stringify(entry.linkTargets ?? []) !== JSON.stringify(segment.linkTargets ?? [])) {
          return this.changedCommittedBlockError("link_target_changed", segment, entry);
        }
      }
    }
    return pending;
  }

  private alignmentError(
    reason: "alignment_ambiguous" | "alignment_unavailable",
    observedIndex: number | undefined,
    matchCount: number,
  ): ChatGptMarkdownConsistencyError {
    return new ChatGptMarkdownConsistencyError(
      "ChatGPT final DOM could not be uniquely aligned with text already streamed to Codex",
      { reason, observedIndex, keyMode: "semantic", matchCount, observedTextChars: 0, committedTextChars: 0 },
    );
  }

  private candidateId(segment: ChatGptMarkdownSegment): string {
    return segment.sourceStart !== undefined
      ? `source:${segment.sourceStart}:${segment.tag ?? ""}`
      : `key:${segment.key}`;
  }

  private committedSegment(segment: ChatGptMarkdownSegment): CommittedChatGptMarkdownSegment {
    return {
      key: segment.key,
      ...(segment.tag ? { tag: segment.tag } : {}),
      text: segment.text,
      ...(segment.linkTargets ? { linkTargets: [...segment.linkTargets] } : {}),
      ...(segment.sourceStart !== undefined ? { sourceStart: segment.sourceStart } : {}),
      ...(segment.sourceEnd !== undefined ? { sourceEnd: segment.sourceEnd } : {}),
    };
  }

  private changedCommittedBlockError(
    reason: NonNullable<ChatGptMarkdownConsistencyError["diagnostic"]>["reason"],
    observed: ChatGptMarkdownSegment,
    committed: CommittedChatGptMarkdownSegment,
  ): ChatGptMarkdownConsistencyError {
    return new ChatGptMarkdownConsistencyError(
      "ChatGPT changed a completed text block that was already streamed to Codex",
      {
        reason,
        observedStart: observed.sourceStart,
        observedEnd: observed.sourceEnd,
        committedStart: committed.sourceStart,
        committedEnd: committed.sourceEnd,
        observedTextChars: observed.text.length,
        committedTextChars: committed.text.length,
      },
    );
  }

  private commit(segment: ChatGptMarkdownSegment): string {
    const block = this.transform(chatGptHtmlToMarkdown(segment.html));
    if (!block) return "";
    const separator = this.markdown
      ? segment.group !== undefined && segment.group === this.lastGroup ? "\n" : "\n\n"
      : "";
    const delta = `${separator}${block}`;
    this.markdown += delta;
    this.lastGroup = segment.group;
    return delta;
  }
}
