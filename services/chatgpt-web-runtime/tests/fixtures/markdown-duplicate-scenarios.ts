import type { ChatGptMarkdownSegment } from "../../src/adapters/chatgpt-web/markdown";

export interface DuplicateScenario {
  name: string;
  observations: ChatGptMarkdownSegment[][];
  deltas: string[];
  final: { markdown: string; delta: string };
}

export const duplicateScenarios: DuplicateScenario[] = [
  {
    name: "same snapshot keeps a committed first occurrence and exact pending second occurrence",
    observations: [
      [
        { key: "first", tag: "p", html: "<p>Same</p>", text: "Same", streamable: true },
        { key: "second", tag: "p", html: "<p>Same</p>", text: "Same", streamable: false },
      ],
      [
        { key: "first", tag: "p", html: "<p>Same</p>", text: "Same", streamable: true },
        { key: "second", tag: "p", html: "<p>Same</p>", text: "Same", streamable: false },
      ],
    ],
    deltas: ["Same", ""],
    final: { markdown: "Same\n\nSame", delta: "\n\nSame" },
  },
  {
    name: "virtualizing the first duplicate preserves the exact pending occurrence",
    observations: [
      [
        { key: "first", tag: "p", html: "<p>Same</p>", text: "Same", streamable: true },
        { key: "second", tag: "p", html: "<p>Same</p>", text: "Same", streamable: false },
      ],
      [{ key: "second", tag: "p", html: "<p>Same</p>", text: "Same", streamable: false }],
      [
        { key: "second", tag: "p", html: "<p>Same</p>", text: "Same", streamable: true },
        { key: "tail", tag: "p", html: "<p>Tail</p>", text: "Tail", streamable: false },
      ],
    ],
    deltas: ["Same", "", "\n\nSame"],
    final: { markdown: "Same\n\nSame\n\nTail", delta: "\n\nTail" },
  },
  {
    name: "a new duplicate after a visible committed tail is appended exactly once",
    observations: [
      [{ key: "first", tag: "p", html: "<p>Same</p>", text: "Same", streamable: true }],
      [
        { key: "first", tag: "p", html: "<p>Same</p>", text: "Same", streamable: true },
        { key: "second", tag: "p", html: "<p>Same</p>", text: "Same", streamable: true },
        { key: "tail", tag: "p", html: "<p>Tail</p>", text: "Tail", streamable: false },
      ],
      [
        { key: "first", tag: "p", html: "<p>Same</p>", text: "Same", streamable: true },
        { key: "second", tag: "p", html: "<p>Same</p>", text: "Same", streamable: true },
        { key: "tail", tag: "p", html: "<p>Tail</p>", text: "Tail", streamable: false },
      ],
    ],
    deltas: ["Same", "\n\nSame", ""],
    final: { markdown: "Same\n\nSame\n\nTail", delta: "\n\nTail" },
  },
];
