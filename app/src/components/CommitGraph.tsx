import { useMemo, useState, useRef, useCallback } from "react";
import styled from "styled-components";
import { keyBy, nth } from "lodash";
import type { Commit } from "../types/git";

const LANE_W = 18;
const ROW_H = 22;
const DOT_R = 3.5;
const COLORS = ["#58a6ff", "#f78166", "#3fb950", "#d2a8ff", "#ffa657", "#79c0ff", "#ff7b72"];

// ── Types ────────────────────────────────────────────────────────────────────
interface PlacedCommit extends Commit {
  lane: number;
  row: number;
  color: string;
}
interface LayoutResult {
  placed: PlacedCommit[];
  maxLanes: number;
}
export interface SelectionRange {
  startRow: number;
  endRow: number;
}

// ── Styled components ────────────────────────────────────────────────────────
const Wrapper = styled.div`
  overflow: auto;
  max-height: calc(100vh - 160px);
  position: relative;
  user-select: none;
`;
const GraphArea = styled.div`
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  position: relative;
`;
const GraphSvg = styled.svg`
  flex-shrink: 0;
  display: block;
  & circle {
    cursor: crosshair;
  }
`;
const Tooltip = styled.div<{ $x: number; $y: number }>`
  position: fixed;
  left: ${({ $x }) => $x + 14}px;
  top: ${({ $y }) => $y - 10}px;
  background: #161b22;
  border: 1px solid #30363d;
  border-radius: 6px;
  padding: 6px 10px;
  font-size: 11px;
  color: #c9d1d9;
  pointer-events: none;
  white-space: pre;
  z-index: 200;
  line-height: 1.7;
`;
const TextColumn = styled.div`
  flex: 1;
  min-width: 0;
`;
const TextRow = styled.div<{ $selected: boolean }>`
  display: flex;
  align-items: center;
  gap: 10px;
  height: ${ROW_H}px;
  padding: 0 12px 0 6px;
  border-bottom: 1px solid #161b22;
  white-space: nowrap;
  cursor: crosshair;
  background: ${({ $selected }) => ($selected ? "#1c2333" : "transparent")};
  &:hover {
    background: ${({ $selected }) => ($selected ? "#243046" : "#161b22")};
  }
`;
const Hash = styled.span`
  color: #79c0ff;
  font-size: 11px;
  width: 48px;
  flex-shrink: 0;
`;
const Subject = styled.span`
  color: #c9d1d9;
  font-size: 12px;
  overflow: hidden;
  text-overflow: ellipsis;
  flex: 1;
`;
const BranchPill = styled.span<{ $color: string }>`
  font-size: 10px;
  padding: 1px 5px;
  border-radius: 10px;
  border: 1px solid ${({ $color }) => $color};
  color: ${({ $color }) => $color};
  flex-shrink: 0;
`;
const SelectionOverlay = styled.div<{ $top: number; $height: number }>`
  position: absolute;
  left: 0;
  right: 0;
  top: ${({ $top }) => $top}px;
  height: ${({ $height }) => $height}px;
  background: rgba(88, 166, 255, 0.07);
  border-top: 1px solid rgba(88, 166, 255, 0.35);
  border-bottom: 1px solid rgba(88, 166, 255, 0.35);
  pointer-events: none;
  z-index: 10;
`;
const SelectionHint = styled.div`
  padding: 4px 12px;
  font-size: 10px;
  color: #6e7681;
  border-bottom: 1px solid #161b22;
  background: #0d1117;
  display: flex;
  align-items: center;
  gap: 8px;
`;

const BranchFilter = styled.span<{ $color: string }>`
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 10px;
  padding: 1px 7px;
  border-radius: 10px;
  border: 1px solid ${({ $color }) => $color};
  color: ${({ $color }) => $color};
  cursor: pointer;
  &:hover {
    opacity: 0.75;
  }
`;

// ── Lane assignment ──────────────────────────────────────────────────────────
// Dead simple: each branch name gets one fixed lane. Main is always lane 0.
// Every commit sits in its branch's lane. Lines connect to parents across lanes.
// Branches are assigned lanes in the order they first appear (top to bottom).

function buildLayout(commits: Commit[], mainBranch: string): LayoutResult {
  // 1. Assign a color and lane to each branch name
  const branchLane = new Map<string, number>();
  const branchColor = new Map<string, string>();
  let colorIdx = 0;
  let nextLane = 1; // 0 is reserved for main

  branchLane.set(mainBranch, 0);
  branchColor.set(mainBranch, COLORS[0]);
  colorIdx = 1;

  // First pass: discover branches in order of appearance
  for (const c of commits) {
    const branch = c.branch ?? mainBranch;
    if (!branchLane.has(branch)) {
      branchLane.set(branch, nextLane++);
      branchColor.set(branch, nth(COLORS, colorIdx++ % COLORS.length)!);
    }
  }

  // 2. Place every commit in its branch's lane
  const placed: PlacedCommit[] = commits.map((c, row) => {
    const branch = c.branch ?? mainBranch;
    return {
      ...c,
      lane: branchLane.get(branch)!,
      row,
      color: branchColor.get(branch)!,
    };
  });

  return { placed, maxLanes: nextLane };
}

// ── SVG helpers ───────────────────────────────────────────────────────────────
function cx(lane: number) {
  return lane * LANE_W + LANE_W / 2;
}
function cy(row: number) {
  return row * ROW_H + ROW_H / 2;
}
function curvePath(x1: number, y1: number, x2: number, y2: number): string {
  if (x1 === x2) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const dy = y2 - y1;
  return `M ${x1} ${y1} C ${x1} ${y1 + dy * 0.4}, ${x2} ${y2 - dy * 0.4}, ${x2} ${y2}`;
}

// ── Reachability filter ───────────────────────────────────────────────────────
// Only show commits reachable from main branch (includes merged feature branches)
function filterToMainBranch(commits: Commit[], mainBranch: string): Commit[] {
  const tip = commits.find((c) => c.branch === mainBranch);
  if (!tip) return commits;
  const byHash = keyBy(commits, "hash");
  const reachable = new Set<string>();
  const queue = [tip.hash];
  while (queue.length) {
    const hash = queue.shift()!;
    if (reachable.has(hash)) continue;
    reachable.add(hash);
    byHash[hash]?.parents.forEach((p) => queue.push(p));
  }
  return commits.filter((c) => reachable.has(c.hash));
}

// ── Component ────────────────────────────────────────────────────────────────
interface Props {
  commits: Commit[];
  mainBranch: string;
  onSelectionChange?: (commits: Commit[]) => void;
}

export default function CommitGraph({ commits, mainBranch, onSelectionChange }: Props) {
  // Filter to only commits reachable from main (includes merged feature branches)
  const filtered = useMemo(() => filterToMainBranch(commits, mainBranch), [commits, mainBranch]);
  const { placed, maxLanes } = useMemo(
    () => buildLayout(filtered, mainBranch),
    [filtered, mainBranch],
  );
  const byHash = useMemo(() => keyBy(placed, "hash"), [placed]);

  const [tooltip, setTooltip] = useState<{ x: number; y: number; c: PlacedCommit } | null>(null);
  const [selection, setSelection] = useState<SelectionRange | null>(null);
  const [activeBranch, setActiveBranch] = useState<{ name: string; color: string } | null>(null);
  const dragStart = useRef<number | null>(null);
  const dragMoved = useRef(false);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const rowFromY = useCallback(
    (clientY: number) => {
      const rect = wrapperRef.current?.getBoundingClientRect();
      if (!rect) return 0;
      const scrollTop = wrapperRef.current?.scrollTop ?? 0;
      return Math.max(
        0,
        Math.min(placed.length - 1, Math.floor((clientY - rect.top + scrollTop) / ROW_H)),
      );
    },
    [placed.length],
  );

  const fireSelection = useCallback(
    (range: SelectionRange) => {
      if (!onSelectionChange) return;
      const lo = Math.min(range.startRow, range.endRow);
      const hi = Math.max(range.startRow, range.endRow);
      onSelectionChange(placed.filter((c) => c.row >= lo && c.row <= hi));
    },
    [placed, onSelectionChange],
  );

  const onMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    const row = rowFromY(e.clientY);
    dragStart.current = row;
    dragMoved.current = false;
    setSelection({ startRow: row, endRow: row });
  };
  const onMouseMove = (e: React.MouseEvent) => {
    if (dragStart.current === null) return;
    dragMoved.current = true;
    setSelection({ startRow: dragStart.current, endRow: rowFromY(e.clientY) });
  };
  const onMouseUp = (e: React.MouseEvent) => {
    if (dragStart.current === null) return;
    const range = { startRow: dragStart.current, endRow: rowFromY(e.clientY) };
    dragStart.current = null;
    // Only treat as a drag-selection if the mouse actually moved
    if (dragMoved.current) {
      setSelection(range);
      fireSelection(range);
    }
    dragMoved.current = false;
  };

  const svgW = (maxLanes + 1) * LANE_W;
  const svgH = placed.length * ROW_H;
  const selTop = selection ? Math.min(selection.startRow, selection.endRow) * ROW_H : 0;
  const selH = selection ? (Math.abs(selection.endRow - selection.startRow) + 1) * ROW_H : 0;
  const isRowSelected = (row: number) =>
    !!selection &&
    row >= Math.min(selection.startRow, selection.endRow) &&
    row <= Math.max(selection.startRow, selection.endRow);

  return (
    <div>
      <SelectionHint>
        <span>
          Drag to select a range · {placed.length} commits
          {selection &&
            !activeBranch &&
            ` · ${Math.abs(selection.endRow - selection.startRow) + 1} selected`}
        </span>
        {activeBranch && (
          <BranchFilter
            $color={activeBranch.color}
            title="Click to clear branch filter"
            onClick={() => {
              setActiveBranch(null);
              setSelection(null);
              onSelectionChange?.(placed);
            }}
          >
            {activeBranch.name} ✕
          </BranchFilter>
        )}
      </SelectionHint>
      <Wrapper
        ref={wrapperRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={() => {
          dragStart.current = null;
        }}
      >
        {tooltip && (
          <Tooltip $x={tooltip.x} $y={tooltip.y}>
            {`${tooltip.c.hash.slice(0, 7)} · ${tooltip.c.branch ?? "—"}\n${tooltip.c.author} · ${new Date(tooltip.c.date).toLocaleDateString()}\n${tooltip.c.subject}`}
          </Tooltip>
        )}
        {selection && selH > 0 && !activeBranch && (
          <SelectionOverlay $top={selTop} $height={selH} />
        )}
        <GraphArea>
          <GraphSvg width={svgW} height={svgH}>
            {placed.map((c) =>
              c.parents.map((pHash) => {
                const parent = byHash[pHash];
                if (!parent) return null;
                const crossLane = c.lane !== parent.lane;

                // Determine line color (same logic as stroke)
                const lineColor = crossLane ? (c.lane > parent.lane ? c.color : parent.color) : c.color;

                // Only highlight lines that match the active branch's color
                const isActiveColor = activeBranch && lineColor === activeBranch.color;
                const dimmed = activeBranch && !isActiveColor;

                return (
                  <path
                    key={`${c.hash}-${pHash}`}
                    d={curvePath(cx(c.lane), cy(c.row), cx(parent.lane), cy(parent.row))}
                    stroke={lineColor}
                    strokeWidth={crossLane ? 2 : 1.5}
                    fill="none"
                    opacity={dimmed ? 0.08 : crossLane ? 0.9 : 0.6}
                  />
                );
              }),
            )}
            {placed.map((c) => {
              const isBranchMatch = !activeBranch || c.branch === activeBranch.name;
              return (
                <circle
                  key={c.hash}
                  cx={cx(c.lane)}
                  cy={cy(c.row)}
                  r={c.parents.length > 1 ? DOT_R + 1 : DOT_R}
                  fill={c.color}
                  stroke="#0d1117"
                  strokeWidth={1.5}
                  opacity={isBranchMatch ? 1 : 0.12}
                  style={{ cursor: "pointer" }}
                  onMouseEnter={(e) => setTooltip({ x: e.clientX, y: e.clientY, c })}
                  onMouseMove={(e) => setTooltip((t) => t && { ...t, x: e.clientX, y: e.clientY })}
                  onMouseLeave={() => setTooltip(null)}
                  onClick={(e) => {
                    e.stopPropagation();
                    const branch = c.branch ?? null;
                    if (!branch) return;
                    if (activeBranch?.name === branch) {
                      // toggle off
                      setActiveBranch(null);
                      setSelection(null);
                      onSelectionChange?.(placed);
                    } else {
                      const branchCommits = placed.filter((p) => p.branch === branch);
                      setActiveBranch({ name: branch, color: c.color });
                      setSelection(null);
                      onSelectionChange?.(branchCommits);
                    }
                  }}
                />
              );
            })}
          </GraphSvg>
          <TextColumn>
            {placed.map((c) => {
              const dimRow = activeBranch ? c.branch !== activeBranch.name : false;
              return (
                <TextRow
                  key={c.hash}
                  $selected={!activeBranch && isRowSelected(c.row)}
                  style={{ opacity: dimRow ? 0.3 : 1 }}
                >
                  <Hash>{c.hash.slice(0, 7)}</Hash>
                  {c.merge && c.merge !== c.branch && (
                    <BranchPill $color={c.color}>{c.merge}</BranchPill>
                  )}
                  <Subject>{c.subject}</Subject>
                </TextRow>
              );
            })}
          </TextColumn>
        </GraphArea>
      </Wrapper>
    </div>
  );
}
