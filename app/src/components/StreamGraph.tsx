import { useRef, useMemo, useEffect } from "react";
import { select } from "d3-selection";
import {
  stack,
  stackOffsetWiggle,
  stackOrderInsideOut,
  area,
  curveBasis,
} from "d3-shape";
import { scaleTime, scaleLinear } from "d3-scale";
import { axisBottom } from "d3-axis";
import type { Commit } from "../types/git";

const NUM_COHORTS = 64;
const NUM_SAMPLES = 200;

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

  // Each file is owned by the cohort that introduced it.
  // Additions and deletions are always charged to that file's owning cohort.
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
        cohortLines[owner] = Math.max(0, cohortLines[owner] + f.additions - f.deletions);
      }
    }

    snapshots.push({ date: new Date(t), values: [...cohortLines] });
  }

  const cohortDates = Array.from(
    { length: numCohorts },
    (_, i) => new Date(minTime + i * cohortMs),
  );

  return { snapshots, cohortDates };
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

  const streamData = useMemo(
    () => buildStreamData(commits, NUM_COHORTS, NUM_SAMPLES),
    [commits],
  );

  useEffect(() => {
    const svg = svgRef.current;
    const container = containerRef.current;
    if (!svg || !container || !streamData) return;

    const W = container.clientWidth || 800;
    const H = container.clientHeight || 500;
    const margin = { top: 24, right: 160, bottom: 36, left: 16 };
    const innerW = W - margin.left - margin.right;
    const innerH = H - margin.top - margin.bottom;

    const { snapshots, cohortDates } = streamData;
    const numCohorts = cohortDates.length;

    select(svg).selectAll("*").remove();
    const root = select(svg).attr("width", W).attr("height", H);
    const g = root.append("g").attr("transform", `translate(${margin.left},${margin.top})`);

    // Build flat data objects for d3-shape stack
    type StackRow = { date: Date } & Record<number, number>;
    const stackData: StackRow[] = snapshots.map((s) => {
      const row: StackRow = { date: s.date } as StackRow;
      for (let i = 0; i < numCohorts; i++) row[i] = s.values[i];
      return row;
    });

    const keys = Array.from({ length: numCohorts }, (_, i) => i);

    const stackGen = stack<StackRow, number>()
      .keys(keys)
      .value((d, key) => d[key] ?? 0)
      .offset(stackOffsetWiggle)
      .order(stackOrderInsideOut);

    const series = stackGen(stackData);

    // Scales
    const xScale = scaleTime()
      .domain([snapshots[0].date, snapshots[snapshots.length - 1].date])
      .range([0, innerW]);

    const allY = series.flatMap((s) => s.flatMap((d) => [d[0], d[1]]));
    const absMax = Math.max(Math.abs(Math.min(...allY)), Math.abs(Math.max(...allY)));
    const yScale = scaleLinear()
      .domain([-absMax, absMax])
      .range([innerH, 0]);

    // Area generator
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const areaGen = area<any>()
      .x((d) => xScale(d.data.date))
      .y0((d) => yScale(d[0]))
      .y1((d) => yScale(d[1]))
      .curve(curveBasis);

    // Streams
    g.selectAll("path.stream")
      .data(series)
      .join("path")
      .attr("class", "stream")
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .attr("fill", (d: any) => cohortColor(d.key as number, numCohorts))
      .attr("fill-opacity", 0.88)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .attr("d", (d: any) => areaGen(d));

    // Center axis line
    g.append("line")
      .attr("x1", 0).attr("x2", innerW)
      .attr("y1", yScale(0)).attr("y2", yScale(0))
      .attr("stroke", "#8b949e")
      .attr("stroke-width", 1)
      .attr("stroke-dasharray", "4,3");

    // X axis
    g.append("g")
      .attr("transform", `translate(0,${innerH})`)
      .call(axisBottom(xScale).ticks(6).tickSize(-innerH))
      .call((ax) => {
        ax.select(".domain").remove();
        ax.selectAll(".tick line")
          .attr("stroke", "#21262d")
          .attr("stroke-dasharray", "3,3");
        ax.selectAll(".tick text")
          .attr("fill", "#6e7681")
          .attr("font-size", 10)
          .attr("dy", "1.2em");
      });

    // Legend (right side)
    const legendG = root
      .append("g")
      .attr("transform", `translate(${margin.left + innerW + 16}, ${margin.top})`);

    legendG.append("text")
      .attr("fill", "#6e7681")
      .attr("font-size", 9)
      .attr("letter-spacing", "0.06em")
      .attr("dy", "-0.4em")
      .text("COHORT (OLDEST → NEWEST)");

    const step = Math.ceil(numCohorts / 10);
    const legendItems = cohortDates.filter((_, i) => i % step === 0 || i === numCohorts - 1);

    legendItems.forEach((date, li) => {
      const i = li * step >= numCohorts ? numCohorts - 1 : li * step;
      const row = legendG.append("g").attr("transform", `translate(0, ${li * 18 + 8})`);
      row.append("rect")
        .attr("width", 10).attr("height", 10).attr("y", -5).attr("rx", 2)
        .attr("fill", cohortColor(i, numCohorts));
      row.append("text")
        .attr("x", 14).attr("fill", "#8b949e").attr("font-size", 9).attr("dy", "0.35em")
        .text(date.toLocaleDateString(undefined, { year: "numeric", month: "short" }));
    });

    // Annotation
    root.append("text")
      .attr("x", margin.left + innerW / 2)
      .attr("y", H - 4)
      .attr("text-anchor", "middle")
      .attr("fill", "#3d444d")
      .attr("font-size", 9)
      .text("band width = net lines of code · each file is charged to the cohort that introduced it");

  }, [streamData]);

  if (commits.length === 0)
    return <p style={{ padding: 32, color: "#8b949e" }}>No commits selected.</p>;
  if (!commits.some((c) => c.files && c.files.length > 0))
    return <p style={{ padding: 32, color: "#8b949e" }}>No file data available.</p>;
  if (!streamData)
    return <p style={{ padding: 32, color: "#8b949e" }}>Not enough data.</p>;

  return (
    <div ref={containerRef} style={{ width: "100%", height: "100%", overflow: "hidden" }}>
      <svg ref={svgRef} style={{ width: "100%", height: "100%" }} />
    </div>
  );
}
