import { useRef, useMemo, useEffect, useState } from "react";
import { select, pointer } from "d3-selection";
import { stack, stackOffsetWiggle, stackOrderInsideOut, area, curveBasis, line } from "d3-shape";
import { scaleTime, scaleLinear } from "d3-scale";
import { axisBottom } from "d3-axis";
import "d3-transition";
import type { Commit } from "../types/git";

const NUM_COHORTS = 32;
const NUM_SAMPLES = 200;
const STREAM_SPLIT = 0.62;
const MAX_AUTHORS = 50;

interface Snapshot {
  date: Date;
  values: number[];
}

interface StreamData {
  snapshots: Snapshot[];
  labels: string[];
  maxTime: number;
  mode: "era" | "author" | "author-commits";
}

function buildEraStreamData(
  commits: Commit[],
  numCohorts: number,
  numSamples: number,
): StreamData | null {
  const sorted = commits
    .filter((c) => c.files && c.files.length > 0)
    .sort((a, b) => +new Date(a.date) - +new Date(b.date));

  if (sorted.length < 2) return null;

  const minTime = +new Date(sorted[0].date);
  const maxTime = +new Date(sorted[sorted.length - 1].date);
  if (maxTime === minTime) return null;

  const cohortMs = (maxTime - minTime) / numCohorts;
  const sampleMs = (maxTime - minTime) / (numSamples - 1);

  // Additions credited to the commit's era; deletions erode the file's birth era.
  const fileOwner = new Map<string, number>();
  const cohortLines = new Array(numCohorts).fill(0);
  const snapshots: Snapshot[] = [];

  let commitIdx = 0;
  for (let s = 0; s < numSamples; s++) {
    const t = s === numSamples - 1 ? maxTime : minTime + s * sampleMs;

    while (commitIdx < sorted.length && +new Date(sorted[commitIdx].date) <= t) {
      const commit = sorted[commitIdx++];
      const ci = Math.min(
        Math.floor((+new Date(commit.date) - minTime) / cohortMs),
        numCohorts - 1,
      );
      for (const f of commit.files!) {
        if (!fileOwner.has(f.path)) fileOwner.set(f.path, ci);
        const owner = fileOwner.get(f.path)!;
        cohortLines[ci] += f.additions;
        cohortLines[owner] = Math.max(0, cohortLines[owner] - f.deletions);
      }
    }

    snapshots.push({ date: new Date(t), values: [...cohortLines] });
  }

  const cohortDates = Array.from(
    { length: numCohorts },
    (_, i) => new Date(minTime + i * cohortMs),
  );
  const fmt = (dt: Date) => dt.toLocaleDateString(undefined, { year: "numeric", month: "short" });
  const labels = cohortDates.map((date, i) => {
    const end = i < numCohorts - 1 ? cohortDates[i + 1] : new Date(maxTime);
    return `${fmt(date)} – ${fmt(end)}`;
  });

  return { snapshots, labels, maxTime, mode: "era" };
}

function buildAuthorStreamData(commits: Commit[], numSamples: number): StreamData | null {
  const sorted = commits
    .filter((c) => c.files && c.files.length > 0)
    .sort((a, b) => +new Date(a.date) - +new Date(b.date));

  if (sorted.length < 2) return null;

  const minTime = +new Date(sorted[0].date);
  const maxTime = +new Date(sorted[sorted.length - 1].date);
  if (maxTime === minTime) return null;

  // Rank authors by total additions, keep top MAX_AUTHORS
  const authorTotals = new Map<string, number>();
  for (const c of sorted) {
    const total = c.files!.reduce((sum, f) => sum + f.additions, 0);
    authorTotals.set(c.author, (authorTotals.get(c.author) ?? 0) + total);
  }
  const authors = Array.from(authorTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_AUTHORS)
    .map(([name]) => name);
  const authorIndex = new Map(authors.map((a, i) => [a, i]));
  const numAuthors = authors.length;

  const sampleMs = (maxTime - minTime) / (numSamples - 1);
  // fileOwner tracks which top-author "owns" each file path
  const fileOwner = new Map<string, number>();
  const authorLines = new Array(numAuthors).fill(0);
  const snapshots: Snapshot[] = [];

  let commitIdx = 0;
  for (let s = 0; s < numSamples; s++) {
    const t = s === numSamples - 1 ? maxTime : minTime + s * sampleMs;

    while (commitIdx < sorted.length && +new Date(sorted[commitIdx].date) <= t) {
      const commit = sorted[commitIdx++];
      const ai = authorIndex.get(commit.author); // undefined if not in top-N

      for (const f of commit.files!) {
        const currentOwner = fileOwner.get(f.path);
        if (currentOwner === undefined) {
          // First time seeing this file — claim it if author is tracked
          if (ai !== undefined) {
            fileOwner.set(f.path, ai);
            authorLines[ai] += f.additions;
          }
        } else {
          // Existing file — only deletions erode the owner's surviving count.
          // Additions to existing files are not credited to anyone: they represent
          // edits to lines already owned, not new authorship.
          authorLines[currentOwner] = Math.max(0, authorLines[currentOwner] - f.deletions);
        }
      }
    }

    snapshots.push({ date: new Date(t), values: [...authorLines] });
  }

  if (authors.length === 0) return null;

  return { snapshots, labels: authors, maxTime, mode: "author" };
}

function buildAuthorCommitStreamData(commits: Commit[], numSamples: number): StreamData | null {
  const sorted = [...commits].sort((a, b) => +new Date(a.date) - +new Date(b.date));

  if (sorted.length < 2) return null;

  const minTime = +new Date(sorted[0].date);
  const maxTime = +new Date(sorted[sorted.length - 1].date);
  if (maxTime === minTime) return null;

  // Rank authors by total commit count, keep top MAX_AUTHORS
  const authorTotals = new Map<string, number>();
  for (const c of sorted) {
    authorTotals.set(c.author, (authorTotals.get(c.author) ?? 0) + 1);
  }
  const authors = Array.from(authorTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_AUTHORS)
    .map(([name]) => name);

  if (authors.length === 0) return null;

  const authorIndex = new Map(authors.map((a, i) => [a, i]));
  const numAuthors = authors.length;
  const sampleMs = (maxTime - minTime) / (numSamples - 1);
  const authorCommits = new Array(numAuthors).fill(0);
  const snapshots: Snapshot[] = [];

  let commitIdx = 0;
  for (let s = 0; s < numSamples; s++) {
    const t = s === numSamples - 1 ? maxTime : minTime + s * sampleMs;
    while (commitIdx < sorted.length && +new Date(sorted[commitIdx].date) <= t) {
      const ai = authorIndex.get(sorted[commitIdx++].author);
      if (ai !== undefined) authorCommits[ai]++;
    }
    snapshots.push({ date: new Date(t), values: [...authorCommits] });
  }

  return { snapshots, labels: authors, maxTime, mode: "author-commits" };
}

function cohortColor(i: number, total: number): string {
  const t = i / Math.max(total - 1, 1);
  const hue = Math.round(230 - t * 210);
  const sat = Math.round(65 + t * 20);
  const lit = Math.round(42 + t * 14);
  return `hsl(${hue}, ${sat}%, ${lit}%)`;
}

interface Props {
  commits: Commit[];
}

export default function StreamGraph({ commits }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);
  const modeRef = useRef<"era" | "author" | "author-commits">("era");
  const labelsRef = useRef<string[]>([]);
  const [excludedCohorts, setExcludedCohorts] = useState<Set<number>>(new Set());
  const [groupBy, setGroupBy] = useState<"era" | "author" | "author-commits">("era");

  const streamData = useMemo(() => {
    if (groupBy === "era") return buildEraStreamData(commits, NUM_COHORTS, NUM_SAMPLES);
    if (groupBy === "author-commits") return buildAuthorCommitStreamData(commits, NUM_SAMPLES);
    return buildAuthorStreamData(commits, NUM_SAMPLES);
  }, [commits, groupBy]);

  // Reset on mode switch or repo change (commits is a new reference per repo)
  useEffect(() => {
    setExcludedCohorts(new Set());
    // Clear persistent SVG groups so the next draw starts fresh
    if (svgRef.current)
      select(svgRef.current).selectAll("g.sg-paths,g.sg-decor,g.sg-legend,g.sg-linepanel").remove();
  }, [groupBy, commits]);

  useEffect(() => {
    const svg = svgRef.current;
    const container = containerRef.current;
    const tooltip = tooltipRef.current;
    if (!svg || !container || !tooltip || !streamData) return;

    const { snapshots, labels, mode } = streamData;
    const numGroups = labels.length;
    // Guard against stale indices from a previous repo/mode that haven't been
    // cleared yet (the reset effect fires after the draw effect on the same render).
    const safeExcluded = new Set(Array.from(excludedCohorts).filter((i) => i < numGroups));
    const hasLinePanel = safeExcluded.size > 0;

    function draw() {
      const W = container!.clientWidth || 800;
      const H = container!.clientHeight || 500;
      const margin = { top: 24, right: 160, bottom: 36, left: 16 };
      const innerW = W - margin.left - margin.right;

      const splitY = Math.round(H * STREAM_SPLIT);
      const streamInnerH = hasLinePanel ? splitY - margin.top - 8 : H - margin.top - margin.bottom;
      const linePanelY = splitY + 8;
      const lineInnerH = H - linePanelY - margin.bottom;

      // ── Stack data ──────────────────────────────────────────────────────
      type StackRow = { date: Date } & Record<number, number>;
      const stackData: StackRow[] = snapshots.map((s) => {
        const row: StackRow = { date: s.date } as StackRow;
        for (let i = 0; i < numGroups; i++) row[i] = s.values[i];
        return row;
      });

      const keys = Array.from({ length: numGroups }, (_, i) => i);
      const activeKeys = keys.filter((k) => !safeExcluded.has(k));

      const stackGen = stack<StackRow, number>()
        .keys(activeKeys)
        .value((d, key) => d[key] ?? 0)
        .offset(stackOffsetWiggle)
        .order(stackOrderInsideOut);

      const series = stackGen(stackData);

      // ── Scales ──────────────────────────────────────────────────────────
      const xScale = scaleTime()
        .domain([snapshots[0].date, snapshots[snapshots.length - 1].date])
        .range([0, innerW]);

      const allY = series.flatMap((s) => s.flatMap((d) => [d[0], d[1]]));
      const absMax =
        series.length > 0 ? Math.max(Math.abs(Math.min(...allY)), Math.abs(Math.max(...allY))) : 1;
      const yScale = scaleLinear().domain([-absMax, absMax]).range([streamInnerH, 0]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const areaGen = area<any>()
        .x((d) => xScale(d.data.date))
        .y0((d) => yScale(d[0]))
        .y1((d) => yScale(d[1]))
        .curve(curveBasis);

      // Update refs so event handlers always read the current mode/labels (fix 5)
      modeRef.current = mode;
      labelsRef.current = labels;

      const root = select(svg!).attr("width", W).attr("height", H);

      // Initialize named groups once — avoids full SVG teardown on every draw (fix 2)
      if (root.select("g.sg-paths").empty()) {
        root.append("g").attr("class", "sg-paths");
        root.append("g").attr("class", "sg-decor");
        root.append("g").attr("class", "sg-legend");
        root.append("g").attr("class", "sg-linepanel");
      }

      const g = root
        .select<SVGGElement>("g.sg-paths")
        .attr("transform", `translate(${margin.left},${margin.top})`);

      // Clear non-path decorations; paths are handled by D3 join below
      root.select("g.sg-decor").selectAll("*").remove();
      root.select("g.sg-legend").selectAll("*").remove();
      root.select("g.sg-linepanel").selectAll("*").remove();

      const decorG = root
        .select<SVGGElement>("g.sg-decor")
        .attr("transform", `translate(${margin.left},${margin.top})`);

      // ── Stream paths — joined so transitions animate from previous state ─
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const paths: any = g
        .selectAll<SVGPathElement, any>("path.stream")
        .data(series, (d: any) => d.key as number)
        .join(
          (enter) => enter.append("path").attr("class", "stream").attr("fill-opacity", 0),
          (update) => update,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          (exit) => (exit as any).transition().duration(300).attr("fill-opacity", 0).remove(),
        )
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .attr("fill", (d: any) => cohortColor(d.key as number, numGroups))
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .attr("d", (d: any) => areaGen(d))
        .style("cursor", "pointer");

      paths
        .on("mouseenter", function (this: SVGPathElement) {
          paths.interrupt().attr("fill-opacity", 0.3);
          select(this).attr("fill-opacity", 1);
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .on("mousemove", function (event: MouseEvent, d: any) {
          const [mx, my] = pointer(event, container!);
          const adjustedX = Math.max(0, Math.min(innerW, mx - margin.left));
          const hoverDate = xScale.invert(adjustedX);
          const closestIdx = snapshots.reduce(
            (best, s, i) =>
              Math.abs(+s.date - +hoverDate) < Math.abs(+snapshots[best].date - +hoverDate)
                ? i
                : best,
            0,
          );
          const groupIdx = d.key as number;
          const netLines = snapshots[closestIdx].values[groupIdx];
          const label = labelsRef.current[groupIdx];

          tooltip!.style.display = "block";
          tooltip!.style.left = `${mx + 14}px`;
          tooltip!.style.top = `${my - 16}px`;
          tooltip!.innerHTML = [
            `<div style="color:${cohortColor(groupIdx, numGroups)};font-weight:600;margin-bottom:2px">${label}</div>`,
            modeRef.current === "era"
              ? `<div style="color:#6e7681;font-size:9px;margin-bottom:2px">Era ${groupIdx + 1} of ${numGroups}</div>`
              : "",
            modeRef.current === "author-commits"
              ? `<div>${netLines.toLocaleString()} commits</div>`
              : `<div>${netLines.toLocaleString()} net LOC</div>`,
            `<div style="margin-top:6px;color:#6e7681;font-size:10px">click to extract</div>`,
          ].join("");
        })
        .on("mouseleave", function () {
          tooltip!.style.display = "none";
          paths.interrupt().attr("fill-opacity", 0.88);
        })
        .on("click", (_: MouseEvent, d: unknown) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const groupIdx = (d as any).key as number;
          tooltip!.style.display = "none";
          setExcludedCohorts((prev) => {
            const next = new Set(prev);
            next.add(groupIdx);
            return next;
          });
        });

      paths.interrupt().transition().duration(500).attr("fill-opacity", 0.88);

      // ── Decorations (axis, labels) ───────────────────────────────────────
      decorG
        .append("line")
        .attr("x1", 0)
        .attr("x2", innerW)
        .attr("y1", yScale(0))
        .attr("y2", yScale(0))
        .attr("stroke", "#8b949e")
        .attr("stroke-width", 1)
        .attr("stroke-dasharray", "4,3");

      if (!hasLinePanel) {
        decorG
          .append("g")
          .attr("transform", `translate(0,${streamInnerH})`)
          .call(axisBottom(xScale).ticks(6).tickSize(-streamInnerH))
          .call((ax) => {
            ax.select(".domain").remove();
            ax.selectAll(".tick line").attr("stroke", "#21262d").attr("stroke-dasharray", "3,3");
            ax.selectAll(".tick text")
              .attr("fill", "#6e7681")
              .attr("font-size", 10)
              .attr("dy", "1.2em");
          });
      }

      // Peak LOC labels on the top 5 widest bands
      series
        .map((s) => {
          let maxHeight = 0;
          let maxIdx = 0;
          s.forEach((d, i) => {
            const h = d[1] - d[0];
            if (h > maxHeight) {
              maxHeight = h;
              maxIdx = i;
            }
          });
          return { s, groupIdx: s.key as number, maxHeight, maxIdx };
        })
        .filter(({ maxHeight }) => Math.abs(yScale(0) - yScale(maxHeight)) > 20)
        .sort((a, b) => b.maxHeight - a.maxHeight)
        .slice(0, 5)
        .forEach(({ s, groupIdx, maxIdx }) => {
          const d = s[maxIdx];
          const peakLoc = snapshots[maxIdx].values[groupIdx];
          const locLabel = peakLoc >= 1000 ? `${(peakLoc / 1000).toFixed(1)}k` : `${peakLoc}`;
          decorG
            .append("text")
            .attr("x", xScale(snapshots[maxIdx].date))
            .attr("y", yScale((d[0] + d[1]) / 2))
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "middle")
            .attr("fill", "#c9d1d9")
            .attr("font-size", 9)
            .attr("pointer-events", "none")
            .text(locLabel);
        });

      // ── Legend ──────────────────────────────────────────────────────────
      const legendG = root
        .select<SVGGElement>("g.sg-legend")
        .attr("transform", `translate(${margin.left + innerW + 16}, ${margin.top})`);

      legendG
        .append("text")
        .attr("fill", "#6e7681")
        .attr("font-size", 9)
        .attr("letter-spacing", "0.06em")
        .attr("dy", "-0.4em")
        .text(
          mode === "era"
            ? "ERA (OLDEST → NEWEST)"
            : mode === "author-commits"
              ? "AUTHOR (MOST → FEWEST COMMITS)"
              : "AUTHOR (MOST → FEWEST LOC)",
        );

      const step = numGroups > 20 ? 2 : 1;
      const allLegendItems = labels
        .map((label, i) => ({ label, i }))
        .filter(({ i }) => i % step === 0 || i === numGroups - 1);

      const legendMaxH = hasLinePanel ? splitY - margin.top - 12 : H - margin.top;
      const legendItems = allLegendItems.filter((_, li) => li * 18 + 8 < legendMaxH);

      legendItems.forEach(({ label, i }, li) => {
        const isExtracted = safeExcluded.has(i);
        const row = legendG
          .append("g")
          .attr("transform", `translate(0, ${li * 18 + 8})`)
          .style("cursor", "pointer")
          .on("click", () => {
            setExcludedCohorts((prev) => {
              const next = new Set(prev);
              if (next.has(i)) next.delete(i);
              else next.add(i);
              return next;
            });
          });
        row
          .append("rect")
          .attr("width", 10)
          .attr("height", 10)
          .attr("y", -5)
          .attr("rx", 2)
          .attr("fill", isExtracted ? "#21262d" : cohortColor(i, numGroups))
          .attr("stroke", isExtracted ? cohortColor(i, numGroups) : "none")
          .attr("stroke-width", 1);

        const displayLabel = mode !== "era" && label.length > 14 ? label.slice(0, 13) + "…" : label;
        row
          .append("text")
          .attr("x", 14)
          .attr("fill", isExtracted ? "#3d444d" : "#8b949e")
          .attr("font-size", 9)
          .attr("dy", "0.35em")
          .text(displayLabel);
      });

      if (!hasLinePanel) {
        decorG
          .append("text")
          .attr("x", innerW / 2)
          .attr("y", streamInnerH + margin.bottom - 4)
          .attr("text-anchor", "middle")
          .attr("fill", "#3d444d")
          .attr("font-size", 9)
          .text(
            mode === "era"
              ? "band width = net lines of code · each file is charged to the era that introduced it"
              : mode === "author-commits"
                ? "band width = cumulative commits · each commit charged to its author"
                : "band width = net lines of code · each file is charged to the author who introduced it",
          );
      }

      // ── Line panel ──────────────────────────────────────────────────────
      if (!hasLinePanel) return;

      const lineG = root
        .select<SVGGElement>("g.sg-linepanel")
        .attr("transform", `translate(${margin.left},${linePanelY})`);

      // Divider
      root
        .select("g.sg-linepanel")
        .append("line")
        .attr("x1", -margin.left)
        .attr("x2", W - margin.left)
        .attr("y1", splitY - linePanelY)
        .attr("y2", splitY - linePanelY)
        .attr("stroke", "#30363d")
        .attr("stroke-width", 1);

      lineG
        .append("rect")
        .attr("width", innerW)
        .attr("height", lineInnerH)
        .attr("fill", "transparent")
        .style("cursor", "pointer")
        .on("dblclick", () => {
          tooltip!.style.display = "none";
          setExcludedCohorts(new Set());
        });

      lineG
        .append("text")
        .attr("fill", "#6e7681")
        .attr("font-size", 9)
        .attr("letter-spacing", "0.06em")
        .attr("y", -4)
        .text("EXTRACTED · click to restore · double-click to restore all");

      const maxLocValue = Math.max(
        1,
        ...Array.from(safeExcluded).flatMap((ci) => snapshots.map((s) => s.values[ci])),
      );
      const lineYScale = scaleLinear()
        .domain([0, maxLocValue * 1.05])
        .range([lineInnerH, 0]);

      lineG
        .append("g")
        .attr("transform", `translate(0,${lineInnerH})`)
        .call(axisBottom(xScale).ticks(6).tickSize(-lineInnerH))
        .call((ax) => {
          ax.select(".domain").remove();
          ax.selectAll(".tick line").attr("stroke", "#21262d").attr("stroke-dasharray", "3,3");
          ax.selectAll(".tick text")
            .attr("fill", "#6e7681")
            .attr("font-size", 10)
            .attr("dy", "1.2em");
        });

      Array.from(safeExcluded)
        .sort((a, b) => a - b)
        .forEach((groupIdx) => {
          const color = cohortColor(groupIdx, numGroups);
          const label = labels[groupIdx];

          const lineGen = line<Snapshot>()
            .x((s) => xScale(s.date))
            .y((s) => lineYScale(s.values[groupIdx]))
            .curve(curveBasis);

          lineG
            .append("path")
            .datum(snapshots)
            .attr("fill", "none")
            .attr("stroke", color)
            .attr("stroke-width", 2.5)
            .attr("d", lineGen)
            .style("cursor", "pointer")
            .on("mouseenter", function () {
              // eslint-disable-next-line @typescript-eslint/no-invalid-this
              select(this).attr("stroke-width", 3.5);
            })
            .on("mousemove", function (event: MouseEvent) {
              const [mx, my] = pointer(event, container!);
              const adjustedX = Math.max(0, Math.min(innerW, mx - margin.left));
              const hoverDate = xScale.invert(adjustedX);
              const closestIdx = snapshots.reduce(
                (best, s, i) =>
                  Math.abs(+s.date - +hoverDate) < Math.abs(+snapshots[best].date - +hoverDate)
                    ? i
                    : best,
                0,
              );
              const netLines = snapshots[closestIdx].values[groupIdx];

              tooltip!.style.display = "block";
              tooltip!.style.left = `${mx + 14}px`;
              tooltip!.style.top = `${my - 16}px`;
              tooltip!.innerHTML = [
                `<div style="color:${color};font-weight:600;margin-bottom:2px">${label}</div>`,
                modeRef.current === "era"
                  ? `<div style="color:#6e7681;font-size:9px;margin-bottom:2px">Era ${groupIdx + 1} of ${numGroups}</div>`
                  : "",
                modeRef.current === "author-commits"
                  ? `<div>${netLines.toLocaleString()} commits</div>`
                  : `<div>${netLines.toLocaleString()} net LOC</div>`,
                `<div style="margin-top:6px;color:#6e7681;font-size:10px">click to restore</div>`,
              ].join("");
            })
            .on("mouseleave", function () {
              tooltip!.style.display = "none";
              // eslint-disable-next-line @typescript-eslint/no-invalid-this
              select(this).attr("stroke-width", 2.5);
            })
            .on("click", () => {
              tooltip!.style.display = "none";
              setExcludedCohorts((prev) => {
                const next = new Set(prev);
                next.delete(groupIdx);
                return next;
              });
            });

          const lastVal = snapshots[snapshots.length - 1].values[groupIdx];
          const shortLabel =
            modeRef.current === "era" ? `C${groupIdx + 1}` : label.split(/[\s<@]/)[0].slice(0, 10);
          const valStr = lastVal >= 1000 ? `${(lastVal / 1000).toFixed(1)}k` : `${lastVal}`;
          lineG
            .append("text")
            .attr("x", innerW + 6)
            .attr("y", lineYScale(lastVal))
            .attr("dominant-baseline", "middle")
            .attr("fill", color)
            .attr("font-size", 9)
            .attr("pointer-events", "none")
            .text(`${shortLabel} ${valStr}`);
        });
    }

    draw();

    let rafId: number | null = null;
    const observer = new ResizeObserver(() => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => draw());
    });
    observer.observe(container);
    return () => {
      if (rafId !== null) cancelAnimationFrame(rafId);
      observer.disconnect();
    };
  }, [streamData, excludedCohorts]);

  if (commits.length === 0)
    return <p style={{ padding: 32, color: "#8b949e" }}>No commits selected.</p>;
  if (!commits.some((c) => c.files && c.files.length > 0))
    return <p style={{ padding: 32, color: "#8b949e" }}>No file data available.</p>;
  if (!streamData) return <p style={{ padding: 32, color: "#8b949e" }}>Not enough data.</p>;

  const btnBase = {
    background: "transparent",
    border: "1px solid transparent",
    borderRadius: 4,
    color: "#8b949e",
    cursor: "pointer",
    fontFamily: "inherit",
    fontSize: 10,
    letterSpacing: "0.06em",
    padding: "2px 8px",
    textTransform: "uppercase" as const,
  };

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}
    >
      <div style={{ position: "absolute", top: 4, left: 16, zIndex: 10, display: "flex", gap: 4 }}>
        <button
          style={
            groupBy === "era"
              ? { ...btnBase, background: "#21262d", border: "1px solid #30363d", color: "#f0f6fc" }
              : btnBase
          }
          onClick={() => setGroupBy("era")}
        >
          By Era
        </button>
        <button
          style={
            groupBy === "author"
              ? { ...btnBase, background: "#21262d", border: "1px solid #30363d", color: "#f0f6fc" }
              : btnBase
          }
          onClick={() => setGroupBy("author")}
        >
          By Author (LOC)
        </button>
        <button
          style={
            groupBy === "author-commits"
              ? { ...btnBase, background: "#21262d", border: "1px solid #30363d", color: "#f0f6fc" }
              : btnBase
          }
          onClick={() => setGroupBy("author-commits")}
        >
          By Author (Commits)
        </button>
      </div>
      <svg ref={svgRef} style={{ width: "100%", height: "100%" }} />
      <div
        ref={tooltipRef}
        style={{
          position: "absolute",
          pointerEvents: "none",
          display: "none",
          background: "#161b22",
          border: "1px solid #30363d",
          borderRadius: 4,
          padding: "6px 10px",
          color: "#c9d1d9",
          fontSize: 11,
          lineHeight: 1.5,
          whiteSpace: "nowrap",
        }}
      />
    </div>
  );
}
