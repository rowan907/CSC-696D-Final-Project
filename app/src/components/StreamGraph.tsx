import { useRef, useMemo, useEffect, useState } from "react";
import { select, pointer } from "d3-selection";
import {
  stack,
  stackOffsetWiggle,
  stackOrderInsideOut,
  area,
  curveBasis,
  line,
} from "d3-shape";
import { scaleTime, scaleLinear } from "d3-scale";
import { axisBottom } from "d3-axis";
import type { Commit } from "../types/git";

const NUM_COHORTS = 64;
const NUM_SAMPLES = 200;
// Fraction of total height given to the stream graph when the line panel is visible
const STREAM_SPLIT = 0.62;

interface Snapshot {
  date: Date;
  values: number[];
}

function buildStreamData(commits: Commit[], numCohorts: number, numSamples: number) {
  const sorted = commits
    .filter((c) => c.files && c.files.length > 0)
    .sort((a, b) => +new Date(a.date) - +new Date(b.date));

  if (sorted.length < 2) return null;

  const minTime = +new Date(sorted[0].date);
  const maxTime = +new Date(sorted[sorted.length - 1].date);
  if (maxTime === minTime) return null;

  const cohortMs = (maxTime - minTime) / numCohorts;
  const sampleMs = (maxTime - minTime) / (numSamples - 1);

  // Additions are credited to the cohort of the commit that wrote them —
  // new code belongs to the era it was written in.
  // Deletions erode the birth cohort of the file being modified —
  // old code is removed from the era that originally introduced it.
  // This means cohort bands only grow during their own time window and
  // then monotonically shrink as their code is deleted later.
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

  return { snapshots, cohortDates, maxTime };
}

function cohortColor(i: number, total: number): string {
  const t = i / Math.max(total - 1, 1);
  // older (i=0) → cool blue; newer (i=max) → warm orange-red
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
  const [excludedCohorts, setExcludedCohorts] = useState<Set<number>>(new Set());

  const streamData = useMemo(() => buildStreamData(commits, NUM_COHORTS, NUM_SAMPLES), [commits]);

  useEffect(() => {
    const svg = svgRef.current;
    const container = containerRef.current;
    const tooltip = tooltipRef.current;
    if (!svg || !container || !tooltip || !streamData) return;

    const { snapshots, cohortDates, maxTime } = streamData;
    const numCohorts = cohortDates.length;
    const hasLinePanel = excludedCohorts.size > 0;

    function draw() {
      const W = container!.clientWidth || 800;
      const H = container!.clientHeight || 500;
      const margin = { top: 24, right: 160, bottom: 36, left: 16 };
      const innerW = W - margin.left - margin.right;

      // When the line panel is visible the SVG is split: stream on top, lines below
      const splitY = Math.round(H * STREAM_SPLIT);
      const streamInnerH = hasLinePanel
        ? splitY - margin.top - 8
        : H - margin.top - margin.bottom;
      const linePanelY = splitY + 8;
      const lineInnerH = H - linePanelY - margin.bottom;

      // ── Stack data ──────────────────────────────────────────────────────
      type StackRow = { date: Date } & Record<number, number>;
      const stackData: StackRow[] = snapshots.map((s) => {
        const row: StackRow = { date: s.date } as StackRow;
        for (let i = 0; i < numCohorts; i++) row[i] = s.values[i];
        return row;
      });

      const keys = Array.from({ length: numCohorts }, (_, i) => i);
      const activeKeys = keys.filter((k) => !excludedCohorts.has(k));

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
        series.length > 0
          ? Math.max(Math.abs(Math.min(...allY)), Math.abs(Math.max(...allY)))
          : 1;
      const yScale = scaleLinear().domain([-absMax, absMax]).range([streamInnerH, 0]);

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const areaGen = area<any>()
        .x((d) => xScale(d.data.date))
        .y0((d) => yScale(d[0]))
        .y1((d) => yScale(d[1]))
        .curve(curveBasis);

      select(svg!).selectAll("*").remove();
      const root = select(svg!).attr("width", W).attr("height", H);
      const g = root.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

      // ── Stream paths ────────────────────────────────────────────────────
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const paths = g.selectAll<SVGPathElement, any>("path.stream")
        .data(series)
        .join("path")
        .attr("class", "stream")
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .attr("fill", (d: any) => cohortColor(d.key as number, numCohorts))
        .attr("fill-opacity", 0)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .attr("d", (d: any) => areaGen(d))
        .style("cursor", "pointer")
        .on("mouseenter", function () {
          paths.interrupt().attr("fill-opacity", 0.3);
          // eslint-disable-next-line @typescript-eslint/no-invalid-this
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
          const cohortIdx = d.key as number;
          const netLines = snapshots[closestIdx].values[cohortIdx];
          const cohortStart = cohortDates[cohortIdx];
          const cohortEnd =
            cohortIdx < numCohorts - 1 ? cohortDates[cohortIdx + 1] : new Date(maxTime);
          const fmt = (dt: Date) =>
            dt.toLocaleDateString(undefined, { year: "numeric", month: "short" });

          tooltip!.style.display = "block";
          tooltip!.style.left = `${mx + 14}px`;
          tooltip!.style.top = `${my - 16}px`;
          tooltip!.innerHTML =
            `<div style="color:${cohortColor(cohortIdx, numCohorts)};font-weight:600;margin-bottom:2px">` +
            `Cohort ${cohortIdx + 1} of ${numCohorts}</div>` +
            `<div>${fmt(cohortStart)} – ${fmt(cohortEnd)}</div>` +
            `<div style="margin-top:4px">${netLines.toLocaleString()} net LOC</div>` +
            `<div style="margin-top:6px;color:#6e7681;font-size:10px">click to extract</div>`;
        })
        .on("mouseleave", function () {
          tooltip!.style.display = "none";
          paths.interrupt().attr("fill-opacity", 0.88);
        })
        .on("click", (_: MouseEvent, d: unknown) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const cohortIdx = (d as any).key as number;
          tooltip!.style.display = "none";
          setExcludedCohorts((prev) => {
            const next = new Set(prev);
            next.add(cohortIdx);
            return next;
          });
        });

      // Fade-in transition
      paths.transition().duration(500).attr("fill-opacity", 0.88);

      // Center axis line
      g.append("line")
        .attr("x1", 0)
        .attr("x2", innerW)
        .attr("y1", yScale(0))
        .attr("y2", yScale(0))
        .attr("stroke", "#8b949e")
        .attr("stroke-width", 1)
        .attr("stroke-dasharray", "4,3");

      // X axis — suppressed on stream when line panel has its own
      if (!hasLinePanel) {
        g.append("g")
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
          return { s, cohortIdx: s.key as number, maxHeight, maxIdx };
        })
        .filter(({ maxHeight }) => Math.abs(yScale(0) - yScale(maxHeight)) > 20)
        .sort((a, b) => b.maxHeight - a.maxHeight)
        .slice(0, 5)
        .forEach(({ s, cohortIdx, maxIdx }) => {
          const d = s[maxIdx];
          const peakLoc = snapshots[maxIdx].values[cohortIdx];
          const label = peakLoc >= 1000 ? `${(peakLoc / 1000).toFixed(1)}k` : `${peakLoc}`;
          g.append("text")
            .attr("x", xScale(snapshots[maxIdx].date))
            .attr("y", yScale((d[0] + d[1]) / 2))
            .attr("text-anchor", "middle")
            .attr("dominant-baseline", "middle")
            .attr("fill", "#c9d1d9")
            .attr("font-size", 9)
            .attr("pointer-events", "none")
            .text(label);
        });

      // Legend — grey out extracted cohorts so their absence is visible
      const legendG = root
        .append("g")
        .attr("transform", `translate(${margin.left + innerW + 16}, ${margin.top})`);

      legendG
        .append("text")
        .attr("fill", "#6e7681")
        .attr("font-size", 9)
        .attr("letter-spacing", "0.06em")
        .attr("dy", "-0.4em")
        .text("COHORT (OLDEST → NEWEST)");

      const step = Math.ceil(numCohorts / 10);
      const legendItems = cohortDates
        .map((date, i) => ({ date, i }))
        .filter(({ i }) => i % step === 0 || i === numCohorts - 1);

      legendItems.forEach(({ date, i }, li) => {
        const isExtracted = excludedCohorts.has(i);
        const row = legendG.append("g").attr("transform", `translate(0, ${li * 18 + 8})`);
        row
          .append("rect")
          .attr("width", 10)
          .attr("height", 10)
          .attr("y", -5)
          .attr("rx", 2)
          .attr("fill", isExtracted ? "#21262d" : cohortColor(i, numCohorts))
          .attr("stroke", isExtracted ? cohortColor(i, numCohorts) : "none")
          .attr("stroke-width", 1);
        row
          .append("text")
          .attr("x", 14)
          .attr("fill", isExtracted ? "#3d444d" : "#8b949e")
          .attr("font-size", 9)
          .attr("dy", "0.35em")
          .text(date.toLocaleDateString(undefined, { year: "numeric", month: "short" }));
      });

      // Annotation (only when no line panel, otherwise it would overlap)
      if (!hasLinePanel) {
        root
          .append("text")
          .attr("x", margin.left + innerW / 2)
          .attr("y", H - 4)
          .attr("text-anchor", "middle")
          .attr("fill", "#3d444d")
          .attr("font-size", 9)
          .text(
            "band width = net lines of code · each file is charged to the cohort that introduced it",
          );
      }

      // ── Line panel ──────────────────────────────────────────────────────
      if (!hasLinePanel) return;

      // Divider between the two panels
      root
        .append("line")
        .attr("x1", margin.left)
        .attr("x2", margin.left + innerW)
        .attr("y1", splitY)
        .attr("y2", splitY)
        .attr("stroke", "#21262d")
        .attr("stroke-width", 1);

      const lineG = root
        .append("g")
        .attr("transform", `translate(${margin.left},${linePanelY})`);

      // Transparent hit area for double-click to restore all
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

      // Panel header
      lineG
        .append("text")
        .attr("fill", "#6e7681")
        .attr("font-size", 9)
        .attr("letter-spacing", "0.06em")
        .attr("y", -4)
        .text("EXTRACTED COHORTS · click to restore · double-click to restore all");

      // Y scale shared across all extracted cohort lines
      const maxLocValue = Math.max(
        1,
        ...Array.from(excludedCohorts).flatMap((ci) => snapshots.map((s) => s.values[ci])),
      );
      const lineYScale = scaleLinear().domain([0, maxLocValue * 1.05]).range([lineInnerH, 0]);

      // X axis
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

      // One line per extracted cohort
      Array.from(excludedCohorts)
        .sort((a, b) => a - b)
        .forEach((cohortIdx) => {
          const color = cohortColor(cohortIdx, numCohorts);

          const lineGen = line<Snapshot>()
            .x((s) => xScale(s.date))
            .y((s) => lineYScale(s.values[cohortIdx]))
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
              const netLines = snapshots[closestIdx].values[cohortIdx];
              const cohortStart = cohortDates[cohortIdx];
              const cohortEnd =
                cohortIdx < numCohorts - 1 ? cohortDates[cohortIdx + 1] : new Date(maxTime);
              const fmt = (dt: Date) =>
                dt.toLocaleDateString(undefined, { year: "numeric", month: "short" });

              tooltip!.style.display = "block";
              tooltip!.style.left = `${mx + 14}px`;
              tooltip!.style.top = `${my - 16}px`;
              tooltip!.innerHTML =
                `<div style="color:${color};font-weight:600;margin-bottom:2px">` +
                `Cohort ${cohortIdx + 1} of ${numCohorts}</div>` +
                `<div>${fmt(cohortStart)} – ${fmt(cohortEnd)}</div>` +
                `<div style="margin-top:4px">${netLines.toLocaleString()} net LOC</div>` +
                `<div style="margin-top:6px;color:#6e7681;font-size:10px">click to restore</div>`;
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
                next.delete(cohortIdx);
                return next;
              });
            });

          // Label at right end of line
          const lastVal = snapshots[snapshots.length - 1].values[cohortIdx];
          const endLabel =
            lastVal >= 1000 ? `C${cohortIdx + 1} ${(lastVal / 1000).toFixed(1)}k` : `C${cohortIdx + 1} ${lastVal}`;
          lineG
            .append("text")
            .attr("x", innerW + 6)
            .attr("y", lineYScale(lastVal))
            .attr("dominant-baseline", "middle")
            .attr("fill", color)
            .attr("font-size", 9)
            .attr("pointer-events", "none")
            .text(endLabel);
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

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}
    >
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
