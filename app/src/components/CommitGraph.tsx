import { useMemo, useState, useRef, useCallback } from "react";
import styled from "styled-components";
import { keyBy, nth } from "lodash";
import type { Commit } from "../types/git";

const LANE_W = 18;
const ROW_H = 22;
const DOT_R = 3.5;
const COLORS = [
  "#58a6ff", // blue
  "#f78166", // coral
  "#3fb950", // green
  "#d2a8ff", // purple
  "#ffa657", // orange
  "#79c0ff", // light blue
  "#ff7b72", // red
  "#56d364", // bright green
  "#f778ba", // pink
  "#ffd700", // gold
  "#bc8cff", // lavender
  "#ff9492", // salmon
  "#7ee787", // mint
  "#ffbc6f", // peach
];

// ── Types ────────────────────────────────────────────────────────────────────
interface PlacedCommit extends Commit {
  lane: number;
  row: number;
  color: string;
  currentMaxLane: number; // Maximum lane active at this row
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
  padding: 0 12px 0 64px;
  border-bottom: 1px solid #161b22;
  white-space: nowrap;
  cursor: crosshair;
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
  max-width: 200px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  &:hover {
    opacity: 0.75;
  }
`;

const AuthorBar = styled.div`
  padding: 4px 12px;
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  color: #6e7681;
  border-bottom: 1px solid #161b22;
  background: #0d1117;
`;

const AuthorSelect = styled.select`
  background: #21262d;
  color: #c9d1d9;
  border: 1px solid #30363d;
  border-radius: 4px;
  padding: 2px 6px;
  font-size: 10px;
  font-family: ui-monospace, "Cascadia Code", monospace;
  cursor: pointer;
  max-width: 220px;
`;

// ── Lane assignment ──────────────────────────────────────────────────────────
// Strategy: Main branch ALWAYS gets lane 0 (leftmost position).
// Other branches get lanes dynamically allocated as needed.
// Once a branch is merged and has no future commits, its lane is freed for reuse.

function buildLayout(commits: Commit[], mainBranch: string): LayoutResult {
  const branchLane = new Map<string, number>();
  const branchColor = new Map<string, string>();

  // Main branch always gets lane 0
  branchLane.set(mainBranch, 0);
  branchColor.set(mainBranch, COLORS[0]);

  let colorIdx = 1;

  // Track which lanes are currently in use
  const activeLanes = new Set<number>([0]); // Lane 0 is always active (main)
  const laneForBranch = new Map<string, number>(); // Current lane assignments
  laneForBranch.set(mainBranch, 0);

  // Find the last row each branch appears at
  const lastRowPerBranch = new Map<string, number>();
  commits.forEach((c, row) => {
    const branch = c.branch ?? mainBranch;
    if (!lastRowPerBranch.has(branch) || lastRowPerBranch.get(branch)! < row) {
      lastRowPerBranch.set(branch, row);
    }
  });

  // Assign lanes dynamically, row by row
  const placed: PlacedCommit[] = [];
  let maxLanes = 1; // Track the maximum number of concurrent lanes

  for (let row = 0; row < commits.length; row++) {
    const c = commits[row];
    const branch = c.branch ?? mainBranch;

    // Get or assign a lane for this branch
    let lane: number;
    if (laneForBranch.has(branch)) {
      lane = laneForBranch.get(branch)!;
    } else {
      // Find the first available lane (reuse freed lanes)
      lane = 1;
      while (activeLanes.has(lane)) {
        lane++;
      }

      laneForBranch.set(branch, lane);
      activeLanes.add(lane);

      // Assign a color
      if (!branchColor.has(branch)) {
        branchColor.set(branch, nth(COLORS, colorIdx++ % COLORS.length)!);
      }
    }

    // Store the lane assignment for this branch
    branchLane.set(branch, lane);

    // Track the maximum number of concurrent lanes globally
    maxLanes = Math.max(maxLanes, activeLanes.size);

    // Find the current maximum lane number in use at this row
    const currentMaxLane = Math.max(...Array.from(activeLanes));

    placed.push({
      ...c,
      lane,
      row,
      color: branchColor.get(branch)!,
      currentMaxLane, // Store the max lane at this row
    });

    // If this is the last row for this branch, free its lane (unless it's main)
    if (branch !== mainBranch && lastRowPerBranch.get(branch) === row) {
      activeLanes.delete(lane);
      laneForBranch.delete(branch);
    }
  }

  return { placed, maxLanes };
}

// ── SVG helpers ───────────────────────────────────────────────────────────────
function cx(lane: number) {
  return lane * LANE_W + LANE_W / 2;
}
function cy(row: number) {
  return row * ROW_H + ROW_H / 2;
}
function curvePath(x1: number, y1: number, x2: number, y2: number): string {
  // Straight vertical line (same lane)
  if (x1 === x2) {
    return `M ${x1} ${y1} L ${x2} ${y2}`;
  }

  // Lines connecting different lanes - use rounded 90-degree turns
  const radius = Math.min(8, Math.abs(x2 - x1) / 2, Math.abs(y2 - y1) / 2);
  const midY = y1 + (y2 - y1) / 2;

  // Determine direction
  const goingRight = x2 > x1;

  // Path: vertical down -> rounded turn -> horizontal -> rounded turn -> vertical down
  if (Math.abs(y2 - y1) > radius * 2) {
    // Enough vertical space for two turns
    const turn1Y = midY - radius;
    const turn2Y = midY + radius;

    if (goingRight) {
      // Moving right: turn clockwise at top, counter-clockwise at bottom
      return `M ${x1} ${y1} 
              L ${x1} ${turn1Y} 
              Q ${x1} ${midY} ${x1 + radius} ${midY}
              L ${x2 - radius} ${midY}
              Q ${x2} ${midY} ${x2} ${turn2Y}
              L ${x2} ${y2}`;
    } else {
      // Moving left: turn counter-clockwise at top, clockwise at bottom
      return `M ${x1} ${y1} 
              L ${x1} ${turn1Y} 
              Q ${x1} ${midY} ${x1 - radius} ${midY}
              L ${x2 + radius} ${midY}
              Q ${x2} ${midY} ${x2} ${turn2Y}
              L ${x2} ${y2}`;
    }
  } else {
    // Not enough space - simple rounded corner
    if (goingRight) {
      return `M ${x1} ${y1} 
              L ${x1} ${y2 - radius}
              Q ${x1} ${y2} ${x1 + radius} ${y2}
              L ${x2} ${y2}`;
    } else {
      return `M ${x1} ${y1} 
              L ${x1} ${y2 - radius}
              Q ${x1} ${y2} ${x1 - radius} ${y2}
              L ${x2} ${y2}`;
    }
  }
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
    byHash[hash]?.parents.forEach((p) => queue.push(p.hash));
  }
  return commits.filter((c) => reachable.has(c.hash));
}

// ── Component ────────────────────────────────────────────────────────────────
interface Props {
  commits: Commit[];
  mainBranch: string;
  onSelectionChange?: (commits: Commit[]) => void;
  skipBranchFilter?: boolean;
}

export default function CommitGraph({
  commits,
  mainBranch,
  onSelectionChange,
  skipBranchFilter,
}: Props) {
  // Filter to only commits reachable from main (includes merged feature branches)
  // Skip when commits are already pre-filtered (e.g. by timeline), since parent links may be broken
  const filtered = useMemo(
    () => (skipBranchFilter ? commits : filterToMainBranch(commits, mainBranch)),
    [commits, mainBranch, skipBranchFilter],
  );
  const { placed, maxLanes } = useMemo(
    () => buildLayout(filtered, mainBranch),
    [filtered, mainBranch],
  );
  const byHash = useMemo(() => keyBy(placed, "hash"), [placed]);

  const [tooltip, setTooltip] = useState<{ x: number; y: number; c: PlacedCommit } | null>(null);
  const [selection, setSelection] = useState<SelectionRange | null>(null);
  const [activeBranch, setActiveBranch] = useState<{ name: string; color: string } | null>(null);
  const [activeAuthor, setActiveAuthor] = useState<string | null>(null);
  const dragStart = useRef<number | null>(null);

  const authors = useMemo(() => {
    const set = new Set(placed.map((c) => c.author));
    return [...set].sort();
  }, [placed]);
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
    if (dragMoved.current) {
      setSelection(range);
      fireSelection(range);
    } else {
      // Single click on empty space clears the selection (circles handle their own clicks)
      const tag = (e.target as Element).tagName.toLowerCase();
      if (tag !== "circle") {
        setSelection(null);
        setActiveBranch(null);
        onSelectionChange?.(placed);
      }
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
      <AuthorBar>
        <span>Author:</span>
        <AuthorSelect
          value={activeAuthor ?? ""}
          onChange={(e) => {
            const author = e.target.value || null;
            setActiveAuthor(author);
            setActiveBranch(null);
            setSelection(null);
            if (author) {
              onSelectionChange?.(placed.filter((c) => c.author === author));
            } else {
              onSelectionChange?.(placed);
            }
          }}
        >
          <option value="">All authors</option>
          {authors.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </AuthorSelect>
      </AuthorBar>
      <SelectionHint>
        <span>
          Drag to select a range · {placed.length} commits
          {selection &&
            !activeBranch &&
            !activeAuthor &&
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
        {activeAuthor && (
          <BranchFilter
            $color="#58a6ff"
            title={`Click to clear author filter: ${activeAuthor}`}
            onClick={() => {
              setActiveAuthor(null);
              setSelection(null);
              onSelectionChange?.(placed);
            }}
          >
            {activeAuthor.length > 22 ? `${activeAuthor.slice(0, 22)}…` : activeAuthor} ✕
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
            {/* Draw continuous lines for each lane */}
            {placed.map((c, idx) => {
              const nextInLane = placed.slice(idx + 1).find((n) => n.lane === c.lane);
              if (!nextInLane) return null;

              // Draw vertical line to next commit in same lane
              const isActiveBranch = activeBranch && c.branch === activeBranch.name;
              const dimmed = activeBranch && !isActiveBranch;

              return (
                <line
                  key={`lane-${c.hash}-${nextInLane.hash}`}
                  x1={cx(c.lane)}
                  y1={cy(c.row)}
                  x2={cx(nextInLane.lane)}
                  y2={cy(nextInLane.row)}
                  stroke={c.color}
                  strokeWidth={1.5}
                  opacity={dimmed ? 0.08 : 0.6}
                />
              );
            })}

            {/* Draw parent connections (for merges and cross-lane connections) */}
            {placed.map((c) =>
              c.parents.map((parent) => {
                const parentPlaced = byHash[parent.hash];
                if (!parentPlaced) return null;

                // Skip if this is just connecting to the next commit in the same lane
                // (already drawn above)
                const nextInLane = placed.find(
                  (n, idx) => idx > c.row && n.lane === c.lane && n.row > c.row,
                );
                if (nextInLane && parentPlaced.hash === nextInLane.hash) {
                  return null;
                }

                const crossLane = c.lane !== parentPlaced.lane;

                // Determine line color (same logic as stroke)
                const lineColor = crossLane
                  ? c.lane > parentPlaced.lane
                    ? c.color
                    : parentPlaced.color
                  : c.color;

                // Only highlight lines where BOTH commits belong to the active branch
                const isActiveBranch =
                  activeBranch &&
                  c.branch === activeBranch.name &&
                  parentPlaced.branch === activeBranch.name;
                const dimmed = activeBranch && !isActiveBranch;

                return (
                  <path
                    key={`${c.hash}-${parent.hash}`}
                    d={curvePath(
                      cx(c.lane),
                      cy(c.row),
                      cx(parentPlaced.lane),
                      cy(parentPlaced.row),
                    )}
                    stroke={lineColor}
                    strokeWidth={crossLane ? 2 : 1.5}
                    fill="none"
                    opacity={dimmed ? 0.08 : crossLane ? 0.9 : 0.6}
                  />
                );
              }),
            )}
            {placed.map((c) => {
              const isBranchMatch =
                (!activeBranch || c.branch === activeBranch.name) &&
                (!activeAuthor || c.author === activeAuthor);
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
                      setActiveAuthor(null);
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
              const dimRow =
                (activeBranch ? c.branch !== activeBranch.name : false) ||
                (activeAuthor ? c.author !== activeAuthor : false);
              // Pull text left by the number of unused lanes
              const unusedLanes = maxLanes - c.currentMaxLane;
              const pullLeft = unusedLanes * LANE_W;
              return (
                <TextRow
                  key={c.hash}
                  $selected={!activeBranch && isRowSelected(c.row)}
                  style={{
                    opacity: dimRow ? 0.3 : 1,
                    marginLeft: `-${pullLeft}px`,
                  }}
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
