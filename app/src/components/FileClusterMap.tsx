import React, { useEffect, useRef, useMemo, useState, useCallback } from "react";
import * as d3Force from "d3-force";
import * as d3Drag from "d3-drag";
import * as d3Zoom from "d3-zoom";
import { scaleLinear, scaleSqrt } from "d3-scale";
import { select } from "d3-selection";
import type { Commit } from "../types/git";

interface Props {
  commits: Commit[];
  allCommits: Commit[];
  repoKey: string;
}

interface Node extends d3Force.SimulationNodeDatum {
  id: string;
  label: string;
  isDir: boolean;
  count: number;
  linesOfCode: number;
  dir: string;
}

interface Link extends d3Force.SimulationLinkDatum<Node> {
  source: string | Node;
  target: string | Node;
  weight: number;
}

const DIR_COLORS = [
  "#ff3333", // red
  "#0077ff", // blue
  "#ffee00", // yellow
  "#cc00ff", // purple
  "#00ff55", // green
  "#ff0099", // magenta
  "#00ffdd", // cyan
  "#ff7700", // orange
  "#5500ff", // indigo
  "#99ff00", // chartreuse
  "#ff5533", // red-orange
  "#00aaff", // sky blue
  "#ffcc00", // amber
  "#8833ff", // violet
  "#33ff77", // mint
  "#ff33bb", // pink
  "#00ffbb", // seafoam
  "#3344ff", // royal blue
  "#ccff00", // lime
  "#ff0044", // crimson
  "#ffaa44", // peach
  "#44ffaa", // light seafoam
  "#aa44ff", // medium purple
  "#ddff44", // yellow-green
  "#ff44aa", // hot pink
  "#44ddff", // powder blue
  "#ff8866", // coral
  "#66ff88", // light green
  "#88aaff", // periwinkle
  "#ffaacc", // rose pink
];

function topDir(path: string): string {
  const parts = path.split("/");
  return parts.length > 1 ? parts[0] : "(root)";
}

function normalizeFilePath(path: string): string {
  // Full rename: "old/file.py => new/file.py" — keep only the new path
  if (!path.includes("{") && path.includes(" => ")) {
    return path.split(" => ").pop()!.trim();
  }
  // Brace notation: "{old_dir => new_dir}/file.py" or "dir/{old.py => new.py}"
  if (path.includes("{") && path.includes(" => ")) {
    return path.replace(/\{[^}]* => ([^}]*)\}/g, "$1").replace(/\/+/g, "/");
  }
  return path;
}

function isHidden(path: string): boolean {
  return path.split("/").some((part) => part.startsWith("."));
}

function buildGraph(
  commits: Commit[],
  expanded: Set<string>,
  excludeHidden: boolean,
  maxChildNodes: number,
): { nodes: Node[]; links: Link[]; maxExpandedDirFiles: number } {
  // Pass 1: accumulate per-file LoC so we can rank files within each expanded directory
  const fileLoC = new Map<string, number>();
  for (const commit of commits) {
    if (!commit.files) continue;
    for (const f of commit.files) {
      const p = normalizeFilePath(f.path);
      if (excludeHidden && isHidden(p)) continue;
      fileLoC.set(p, (fileLoC.get(p) ?? 0) + f.additions + f.deletions);
    }
  }

  // For each expanded directory: rank its files by LoC, keep top maxChildNodes
  const allowedFiles = new Set<string>();
  let maxExpandedDirFiles = 0;
  for (const dir of expanded) {
    const filesInDir = [...fileLoC.entries()]
      .filter(([p]) => topDir(p) === dir)
      .sort((a, b) => b[1] - a[1]);
    maxExpandedDirFiles = Math.max(maxExpandedDirFiles, filesInDir.length);
    filesInDir.slice(0, maxChildNodes).forEach(([p]) => allowedFiles.add(p));
  }

  // Pass 2: build graph — files outside allowedFiles are collapsed back to their directory
  const nodeCount = new Map<string, number>();
  const locSum = new Map<string, number>();
  const coCount = new Map<string, number>();
  const fileNodeKeys = new Set<string>();

  const pathToKey = (p: string): string | null => {
    const dir = topDir(p);
    if (expanded.has(dir)) {
      if (!allowedFiles.has(p)) return null; // beyond the per-dir cap
      fileNodeKeys.add(p);
      return p;
    }
    return dir;
  };

  for (const commit of commits) {
    if (!commit.files || commit.files.length === 0) continue;
    const validFiles = commit.files
      .map((f) => ({ ...f, path: normalizeFilePath(f.path) }))
      .filter((f) => !excludeHidden || !isHidden(f.path));

    for (const f of validFiles) {
      const key = pathToKey(f.path);
      if (key === null) continue;
      locSum.set(key, (locSum.get(key) ?? 0) + f.additions + f.deletions);
    }

    const paths = [...new Set(validFiles.map((f) => f.path))];
    const nodeKeys = [
      ...new Set(paths.map(pathToKey).filter((k): k is string => k !== null)),
    ];

    for (const key of nodeKeys) {
      nodeCount.set(key, (nodeCount.get(key) ?? 0) + 1);
    }

    if (nodeKeys.length > 50) continue;
    for (let i = 0; i < nodeKeys.length; i++) {
      for (let j = i + 1; j < nodeKeys.length; j++) {
        const a = nodeKeys[i],
          b = nodeKeys[j];
        if (a === b) continue;
        const key = a < b ? `${a}|||${b}` : `${b}|||${a}`;
        coCount.set(key, (coCount.get(key) ?? 0) + 1);
      }
    }
  }

  const nodes: Node[] = [...nodeCount.entries()].map(([id, count]) => {
    const isDir = !fileNodeKeys.has(id);
    const dir = fileNodeKeys.has(id) ? (id.includes("/") ? id.split("/")[0] : "(root)") : id;
    return {
      id,
      label: isDir ? id : (id.split("/").pop() ?? id),
      isDir,
      count,
      linesOfCode: locSum.get(id) ?? 0,
      dir,
    };
  });

  const nodeSet = new Set(nodes.map((n) => n.id));
  const links: Link[] = [];
  for (const [key, weight] of coCount.entries()) {
    if (weight < 2) continue;
    const [a, b] = key.split("|||");
    if (nodeSet.has(a) && nodeSet.has(b)) links.push({ source: a, target: b, weight });
  }

  return { nodes, links, maxExpandedDirFiles };
}

export default function FileClusterMap({ commits, allCommits, repoKey }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  // Stable node objects that D3 simulation mutates (x, y, vx, vy)
  const nodeMapRef = useRef<Map<string, Node>>(new Map());
  const simRef = useRef<d3Force.Simulation<Node, Link> | null>(null);
  const initializedRef = useRef(false);

  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [excludeHidden, setExcludeHidden] = useState(false);
  const [maxNodes, setMaxNodes] = useState(20);

  // Reset on repo change
  useEffect(() => {
    setExpanded(new Set());
    setMaxNodes(20);
    nodeMapRef.current.clear();
    simRef.current?.stop();
    simRef.current = null;
    initializedRef.current = false;
    // Clear SVG
    if (svgRef.current) select(svgRef.current).selectAll("*").remove();
  }, [repoKey]);

  const { nodes: nextNodes, links: nextLinks, maxExpandedDirFiles } = useMemo(
    () => buildGraph(commits, expanded, excludeHidden, maxNodes),
    [commits, expanded, excludeHidden, maxNodes],
  );

  // Stable dir list derived from the full dataset — keeps colors consistent across timeline brushes
  const stableDirs = useMemo(() => {
    const dirs = new Set<string>();
    for (const c of allCommits) {
      if (!c.files) continue;
      for (const f of c.files) dirs.add(topDir(f.path));
    }
    return [...dirs].sort();
  }, [allCommits]);

  const dirColorMap = useMemo(() => {
    const map = new Map<string, string>();
    stableDirs.forEach((dir, i) => {
      map.set(dir, DIR_COLORS[i % DIR_COLORS.length] ?? "#8b949e");
    });
    return map;
  }, [stableDirs]);

  const handleDblClick = useCallback((id: string, isDir: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (isDir) {
        next.add(id);
      } else {
        next.delete(id.includes("/") ? id.split("/")[0] : "(root)");
      }
      return next;
    });
  }, []);

  useEffect(() => {
    const svg = svgRef.current;
    const container = containerRef.current;
    if (!svg || !container || nextNodes.length === 0) return;

    const W = container.clientWidth || 800;
    const H = container.clientHeight || 600;

    const root = select(svg).attr("width", W).attr("height", H);

    // ── One-time SVG structure setup ─────────────────────────────────────────
    if (!initializedRef.current) {
      initializedRef.current = true;
      const g = root.append("g").attr("class", "main");
      g.append("g").attr("class", "links");
      g.append("g").attr("class", "nodes");
      root.append("g").attr("class", "legend").attr("transform", "translate(12,12)");
      root
        .append("text")
        .attr("class", "hint")
        .attr("x", W - 12)
        .attr("y", H - 10)
        .attr("text-anchor", "end")
        .attr("font-size", 9)
        .attr("fill", "#6e7681")
        .text("double-click directory to expand · double-click file to collapse");

      const zoom = d3Zoom
        .zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.15, 6])
        .filter((event) => event.type !== "dblclick")
        .on("zoom", (event) => root.select("g.main").attr("transform", event.transform));
      root.call(zoom);

      // Create simulation once
      simRef.current = d3Force
        .forceSimulation<Node>([])
        .force("charge", d3Force.forceManyBody().strength(-180))
        .force("center", d3Force.forceCenter(W / 2, H / 2))
        .stop();
    }

    const sim = simRef.current!;
    const g = root.select("g.main");
    const nodeMap = nodeMapRef.current;

    // ── Sync stable node objects ─────────────────────────────────────────────
    // Remove stale nodes
    const nextNodeIds = new Set(nextNodes.map((n) => n.id));
    for (const id of nodeMap.keys()) {
      if (!nextNodeIds.has(id)) nodeMap.delete(id);
    }
    // Add new / update existing
    for (const n of nextNodes) {
      if (nodeMap.has(n.id)) {
        const existing = nodeMap.get(n.id)!;
        existing.label = n.label;
        existing.isDir = n.isDir;
        existing.count = n.count;
        existing.linesOfCode = n.linesOfCode;
        existing.dir = n.dir;
      } else {
        // Initialize new nodes at their parent dir's position (smooth expansion)
        const parent = nodeMap.get(n.dir);
        nodeMap.set(n.id, {
          ...n,
          x: parent?.x ?? W / 2 + (Math.random() - 0.5) * 80,
          y: parent?.y ?? H / 2 + (Math.random() - 0.5) * 80,
          vx: 0,
          vy: 0,
        });
      }
    }

    const simNodes = nextNodes.map((n) => nodeMap.get(n.id)!);
    const simLinks: Link[] = nextLinks
      .map((l) => ({
        source: nodeMap.get(l.source as string)!,
        target: nodeMap.get(l.target as string)!,
        weight: l.weight,
      }))
      .filter((l) => l.source && l.target);

    // ── Scales ───────────────────────────────────────────────────────────────
    const maxLoc = Math.max(...simNodes.map((n) => n.linesOfCode), 1);
    const maxWeight = Math.max(...simLinks.map((l) => l.weight), 1);
    const nodeRadius = scaleSqrt().domain([0, maxLoc]).range([5, 28]);
    const linkWidth = scaleLinear().domain([1, maxWeight]).range([0.5, 4]);
    const linkStrength = scaleLinear().domain([1, maxWeight]).range([0.02, 0.5]);

    // ── Update simulation forces & nodes ─────────────────────────────────────
    sim
      .nodes(simNodes)
      .force(
        "link",
        d3Force
          .forceLink<Node, Link>(simLinks)
          .id((d) => d.id)
          .distance(90)
          .strength((d) => linkStrength((d as Link & { weight: number }).weight)),
      )
      .force(
        "collision",
        d3Force.forceCollide<Node>().radius((d) => nodeRadius(d.linesOfCode) + 5),
      )
      .alpha(0.3)
      .restart();

    // ── D3 join — Links ──────────────────────────────────────────────────────
    const linkEl = g
      .select<SVGGElement>("g.links")
      .selectAll<SVGLineElement, Link>("line")
      .data(simLinks, (d) => `${(d.source as Node).id}|||${(d.target as Node).id}`)
      .join("line")
      .attr("stroke", (d) =>
        (d.source as Node).isDir || (d.target as Node).isDir ? "#c9d1d9" : "#30363d",
      )
      .attr("stroke-opacity", 0.6)
      .attr("stroke-width", (d) => linkWidth((d as Link & { weight: number }).weight));

    // ── D3 join — Nodes ──────────────────────────────────────────────────────
    const nodeEl = g
      .select<SVGGElement>("g.nodes")
      .selectAll<SVGGElement, Node>("g.node")
      .data(simNodes, (d) => d.id)
      .join((enter) => {
        const ge = enter.append("g").attr("class", "node").attr("cursor", "pointer");
        ge.append("circle");
        ge.append("text").attr("pointer-events", "none");
        ge.append("title");
        return ge;
      });

    nodeEl
      .select("circle")
      .attr("r", (d) => nodeRadius(d.linesOfCode))
      .attr("fill", (d) => (d.isDir ? (dirColorMap.get(d.dir) ?? "#8b949e") : "transparent"))
      .attr("fill-opacity", (d) => (d.isDir ? 1 : 0))
      .attr("stroke", (d) => dirColorMap.get(d.dir) ?? "#8b949e")
      .attr("stroke-width", (d) => (d.isDir ? 1.5 : 2.5))
      .attr("stroke-dasharray", (d) => (d.isDir ? "none" : "5,3"));

    nodeEl
      .select("text")
      .text((d) => (d.isDir ? `${d.label}/` : d.label))
      .attr("text-anchor", "middle")
      .attr("dy", (d) => nodeRadius(d.linesOfCode) + 11)
      .attr("font-size", (d) => (d.isDir ? 11 : 9))
      .attr("font-weight", (d) => (d.isDir ? "600" : "normal"))
      .attr("fill", (d) => (d.isDir ? (dirColorMap.get(d.dir) ?? "#8b949e") : "#8b949e"));

    nodeEl
      .select("title")
      .text((d) =>
        d.isDir
          ? `${d.id}/\n${d.count} commits · ${d.linesOfCode.toLocaleString()} lines\nDouble-click to expand`
          : `${d.id}\n${d.count} commits · ${d.linesOfCode.toLocaleString()} lines\nDouble-click to collapse`,
      );

    // Drag
    const drag = d3Drag
      .drag<SVGGElement, Node>()
      .on("start", (event, d) => {
        if (!event.active) sim.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on("drag", (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on("end", (event, d) => {
        if (!event.active) sim.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
    nodeEl.call(drag);

    nodeEl.on("dblclick", (event, d) => {
      event.stopPropagation();
      handleDblClick(d.id, d.isDir);
    });

    // ── Tick ─────────────────────────────────────────────────────────────────
    sim.on("tick.render", () => {
      linkEl
        .attr("x1", (d) => (d.source as Node).x!)
        .attr("y1", (d) => (d.source as Node).y!)
        .attr("x2", (d) => (d.target as Node).x!)
        .attr("y2", (d) => (d.target as Node).y!);
      nodeEl.attr("transform", (d) => `translate(${d.x},${d.y})`);
    });

    // ── Legend ────────────────────────────────────────────────────────────────
    const legendEl = root
      .select<SVGGElement>("g.legend")
      .selectAll<SVGGElement, string>("g.legend-item")
      .data(stableDirs.slice(0, 12))
      .join((enter) => {
        const ge = enter.append("g").attr("class", "legend-item");
        ge.append("circle").attr("cx", 5).attr("cy", 0).attr("r", 5);
        ge.append("text")
          .attr("x", 14)
          .attr("dy", "0.35em")
          .attr("font-size", 10)
          .attr("fill", "#8b949e");
        return ge;
      });
    legendEl.attr("transform", (_, i) => `translate(0,${i * 16})`);
    legendEl.select("circle").attr("fill", (d) => dirColorMap.get(d) ?? "#8b949e");
    legendEl.select("text").text((d) => d);

    // Overflow indicator
    root.select("g.legend").select("text.legend-overflow").remove();
    if (stableDirs.length > 12) {
      root.select<SVGGElement>("g.legend")
        .append("text")
        .attr("class", "legend-overflow")
        .attr("transform", `translate(0,${12 * 16})`)
        .attr("font-size", 9)
        .attr("fill", "#6e7681")
        .text(`+${stableDirs.length - 12} more…`);
    }
  }, [nextNodes, nextLinks, handleDblClick, stableDirs, dirColorMap]);

  // Cleanup on unmount
  useEffect(
    () => () => {
      simRef.current?.stop();
    },
    [],
  );

  if (commits.length === 0)
    return <p style={{ padding: 32, color: "#8b949e" }}>No commits selected.</p>;
  if (!commits.some((c) => c.files && c.files.length > 0))
    return <p style={{ padding: 32, color: "#8b949e" }}>No file data available.</p>;

  const sliderMax = Math.max(maxExpandedDirFiles, 1);
  const noExpanded = maxExpandedDirFiles === 0;

  const controlsStyle: React.CSSProperties = {
    position: "absolute",
    top: 8,
    right: 8,
    zIndex: 10,
    display: "flex",
    alignItems: "center",
    gap: 8,
    background: "rgba(13,17,23,0.88)",
    border: "1px solid #30363d",
    borderRadius: 6,
    padding: "4px 10px",
  };

  const btnStyle: React.CSSProperties = {
    background: excludeHidden ? "#388bfd" : "#21262d",
    color: "#f0f6fc",
    border: "1px solid #30363d",
    borderRadius: 4,
    padding: "3px 10px",
    fontSize: 11,
    cursor: "pointer",
    fontFamily: "ui-monospace, 'Cascadia Code', monospace",
    lineHeight: 1.6,
  };

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}
    >
      <div style={controlsStyle}>
        <button style={btnStyle} onClick={() => setExcludeHidden((v) => !v)}>
          {excludeHidden ? "showing dotfiles" : "hide dotfiles"}
        </button>
        <label
          style={{
            fontSize: 11,
            color: "#8b949e",
            display: "flex",
            alignItems: "center",
            gap: 6,
          }}
        >
          <span style={{ color: noExpanded ? "#3d444d" : "#8b949e" }}>files/dir:</span>
          <input
            type="range"
            min={1}
            max={sliderMax}
            value={Math.min(maxNodes, sliderMax)}
            onChange={(e) => setMaxNodes(Number(e.target.value))}
            style={{ width: 80, accentColor: "#388bfd", opacity: noExpanded ? 0.3 : 1 }}
            disabled={noExpanded}
          />
          <span style={{ color: noExpanded ? "#3d444d" : "#f0f6fc", minWidth: 36, fontVariantNumeric: "tabular-nums" }}>
            {noExpanded ? "—" : `${Math.min(maxNodes, sliderMax)}/${sliderMax}`}
          </span>
        </label>
      </div>
      <svg ref={svgRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
