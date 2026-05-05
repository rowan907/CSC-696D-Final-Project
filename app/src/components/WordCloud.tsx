import { useMemo, useRef, useState, useEffect } from "react";
import cloud from "d3-cloud";
import type { Word as CloudWord } from "d3-cloud";
import styled from "styled-components";
import { countBy, orderBy, words } from "lodash";
import type { Commit } from "../types/git";

const COLORS = ["#58a6ff", "#f78166", "#3fb950", "#d2a8ff", "#ffa657", "#79c0ff", "#ff7b72"];

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "is",
  "was",
  "are",
  "were",
  "be",
  "been",
  "has",
  "have",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "can",
  "could",
  "should",
  "may",
  "might",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "i",
  "we",
  "you",
  "he",
  "she",
  "they",
  "not",
  "no",
  "so",
  "if",
  "as",
  "up",
  "out",
  "into",
  "than",
  "more",
  "also",
  "when",
  "use",
  "using",
  "used",
  "add",
  "added",
  "adds",
  "fix",
  "fixed",
  "fixes",
  "update",
  "updated",
  "updates",
  "remove",
  "removed",
  "removes",
  "change",
  "changed",
  "changes",
  "make",
  "makes",
  "made",
  "move",
  "moves",
  "moved",
  "get",
  "gets",
  "set",
  "sets",
  "new",
  "old",
  "some",
  "all",
  "one",
  "two",
  "now",
  "just",
  "via",
  "per",
  "bump",
  // git-specific
  "merge",
  "merged",
  "merging",
  "branch",
  "branches",
  "commit",
  "commits",
  "pull",
  "push",
  "request",
  "rebase",
  "rebased",
  "revert",
  "reverted",
  "cherry",
  "pick",
  "tag",
  "release",
  "version",
  "hotfix",
  "patch",
  "master",
  "main",
  "head",
  "origin",
  "upstream",
  "checkout",
  "clone",
  "fetch",
  "stash",
  "pr",
  "ref",
  "refs",
  "sha",
  "repo",
  "repository",
  "index",
  "staging",
  "wip",
  "fix",
  "typo",
  "minor",
  "misc",
  "cleanup",
  "refactor",
  "refactoring",
  "todo",
  "test",
  "tests",
  "testing",
]);

interface WordEntry {
  text: string;
  value: number;
}
interface PlacedWord {
  text: string;
  size: number;
  x: number;
  y: number;
  rotate: number;
  color: string;
}

function tokenize(subject: string): string[] {
  return words(subject.toLowerCase()).filter(
    (w) => w.length > 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w),
  );
}

function buildCorpusIDF(allCommits: Commit[]): Map<string, number> {
  const N = allCommits.length;
  const df = new Map<string, number>();
  for (const c of allCommits) {
    for (const w of new Set(tokenize(c.subject))) {
      df.set(w, (df.get(w) ?? 0) + 1);
    }
  }
  const idf = new Map<string, number>();
  for (const [word, count] of df) {
    idf.set(word, Math.log(N / (1 + count)));
  }
  return idf;
}

function buildWords(commits: Commit[], allCommits: Commit[]): WordEntry[] {
  const tokens: string[] = [];
  for (const c of commits) tokenize(c.subject).forEach((w) => tokens.push(w));
  const counts = countBy(tokens);

  const idf = buildCorpusIDF(allCommits);

  return orderBy(
    Object.entries(counts)
      .map(([text, count]) => ({ text, value: count * (idf.get(text) ?? 0) }))
      .filter((d) => d.value > 0),
    "value",
    "desc",
  ).slice(0, 50);
}

const Outer = styled.div`
  width: 100%;
  height: 100%;
  background: #0d1117;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
`;
const Empty = styled.div`
  color: #6e7681;
  font-size: 13px;
  text-align: center;
  padding: 32px;
`;

interface Props {
  commits: Commit[];
  allCommits: Commit[];
}

export default function WordCloud({ commits, allCommits }: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState<[number, number] | null>(null);
  const [placed, setPlaced] = useState<PlacedWord[]>([]);

  const wordData = useMemo(() => buildWords(commits, allCommits), [commits, allCommits]);

  // Track container size
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const { width, height } = entries[0].contentRect;
      if (width > 0 && height > 0) setSize([Math.floor(width), Math.floor(height)]);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Run d3-cloud layout whenever words or size change
  useEffect(() => {
    if (!size || wordData.length === 0) {
      setPlaced([]);
      return;
    }
    const [w, h] = size;

    const maxVal = wordData[0]?.value ?? 1;
    const minVal = wordData[wordData.length - 1]?.value ?? 1;
    const minFont = 13;
    const maxFont = Math.min(w, h) / 7;
    const fontScale = (v: number) => {
      if (maxVal === minVal) return (minFont + maxFont) / 2;
      const t = Math.sqrt((v - minVal) / (maxVal - minVal));
      return minFont + t * (maxFont - minFont);
    };

    const layout = cloud<WordEntry>()
      .size([w, h])
      .words(wordData.map((d) => ({ ...d, text: d.text })))
      .padding(4)
      .rotate(() => (Math.random() > 0.7 ? 90 : 0))
      .font("ui-monospace, monospace")
      .fontSize((d: CloudWord) => fontScale((d as WordEntry).value ?? 1))
      .on("end", (output: CloudWord[]) => {
        const result: PlacedWord[] = output.map((d: CloudWord, i: number) => ({
          text: d.text ?? "",
          size: d.size ?? 13,
          x: d.x ?? 0,
          y: d.y ?? 0,
          rotate: d.rotate ?? 0,
          color: COLORS[i % COLORS.length],
        }));
        setPlaced(result);
      });

    layout.start();
    return () => {
      layout.stop();
    };
  }, [wordData, size]);

  return (
    <Outer ref={containerRef}>
      {placed.length === 0 && (
        <Empty>
          {commits.length === 0
            ? "Select a range of commits in the graph to see the word cloud"
            : "Calculating…"}
        </Empty>
      )}
      {placed.length > 0 && size && (
        <svg width={size[0]} height={size[1]}>
          <g transform={`translate(${size[0] / 2},${size[1] / 2})`}>
            {placed.map((w) => (
              <text
                key={w.text}
                textAnchor="middle"
                transform={`translate(${w.x},${w.y}) rotate(${w.rotate})`}
                style={{
                  fontSize: w.size,
                  fontFamily: "ui-monospace, monospace",
                  fill: w.color,
                  cursor: "default",
                  userSelect: "none",
                }}
              >
                {w.text}
              </text>
            ))}
          </g>
        </svg>
      )}
    </Outer>
  );
}
