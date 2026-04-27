import { useEffect, useRef, useMemo, useState, useCallback } from "react";
import { scaleTime, scaleLinear } from "d3-scale";
import type { ScaleTime } from "d3-scale";
import { select } from "d3-selection";
import { brushX } from "d3-brush";
import { bin, max } from "d3-array";
import { axisBottom } from "d3-axis";
import type { Commit } from "../types/git";

interface Props {
  commits: Commit[];
  onRangeChange: (filtered: Commit[], range: [Date, Date] | null) => void;
}

const MARGIN = { top: 6, right: 16, bottom: 20, left: 16 };
const TOTAL_STEPS = 20; // 20 × 5% = 100%
const STEP_MS = 2000;

export default function CommitTimeline({ commits, onRangeChange }: Props) {
  const svgRef = useRef<SVGSVGElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  // Refs for programmatic brush control
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const brushBehaviorRef = useRef<any>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const brushGRef = useRef<any>(null);
  const xScaleRef = useRef<ScaleTime<number, number, never> | null>(null);
  const minDateRef = useRef<Date | null>(null);
  const maxDateRef = useRef<Date | null>(null);

  // Playback state
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const stepRef = useRef(0);
  const [isPlaying, setIsPlaying] = useState(false);

  const withDates = useMemo(
    () =>
      commits
        .map((c) => ({ commit: c, date: new Date(c.date) }))
        .filter(({ date }) => !isNaN(date.getTime())),
    [commits],
  );

  // ── Playback helpers ────────────────────────────────────────────────────────
  const stopPlay = useCallback(() => {
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    setIsPlaying(false);
    stepRef.current = 0;
  }, []);

  const advanceStep = useCallback(() => {
    const xScale = xScaleRef.current;
    const brush = brushBehaviorRef.current;
    const brushG = brushGRef.current;
    const minDate = minDateRef.current;
    const maxDate = maxDateRef.current;
    if (!xScale || !brush || !brushG || !minDate || !maxDate) return;

    stepRef.current += 1;
    if (stepRef.current > TOTAL_STEPS) {
      stopPlay();
      return;
    }

    const pct = stepRef.current / TOTAL_STEPS;
    const endDate = new Date(minDate.getTime() + pct * (maxDate.getTime() - minDate.getTime()));
    // Moving the brush triggers its "end" handler → calls onRangeChange automatically
    brushG.call(brush.move, [xScale(minDate), xScale(endDate)]);
  }, [stopPlay]);

  const handlePlay = useCallback(() => {
    if (isPlaying) {
      stopPlay();
      return;
    }
    stepRef.current = 0;
    setIsPlaying(true);
    advanceStep();
    intervalRef.current = setInterval(advanceStep, STEP_MS);
  }, [isPlaying, stopPlay, advanceStep]);

  // Stop playback when commits change (repo switch, etc.)
  useEffect(() => {
    stopPlay();
  }, [commits, stopPlay]);

  // Cleanup on unmount
  useEffect(
    () => () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    },
    [],
  );

  // ── Brush callbacks ─────────────────────────────────────────────────────────
  const handleBrush = useCallback(
    (x0: Date, x1: Date) => {
      const filtered = withDates
        .filter(({ date }) => date >= x0 && date <= x1)
        .map(({ commit }) => commit);
      onRangeChange(filtered.length > 0 ? filtered : commits, [x0, x1]);
    },
    [withDates, commits, onRangeChange],
  );

  const handleClear = useCallback(() => {
    onRangeChange(commits, null);
  }, [commits, onRangeChange]);

  // ── D3 setup ────────────────────────────────────────────────────────────────
  useEffect(() => {
    const svg = svgRef.current;
    const container = containerRef.current;
    if (!svg || !container || withDates.length === 0) return;

    const W = container.clientWidth;
    const H = container.clientHeight;
    const innerW = W - MARGIN.left - MARGIN.right;
    const innerH = H - MARGIN.top - MARGIN.bottom;
    if (innerW <= 0 || innerH <= 0) return;

    const dates = withDates.map(({ date }) => date);
    const minDate = new Date(Math.min(...dates.map((d) => d.getTime())));
    const maxDate = new Date(Math.max(...dates.map((d) => d.getTime())));
    minDateRef.current = minDate;
    maxDateRef.current = maxDate;

    const xScale = scaleTime().domain([minDate, maxDate]).range([0, innerW]);
    xScaleRef.current = xScale;

    const binner = bin<{ commit: Commit; date: Date }, Date>()
      .value((d) => d.date)
      .domain([minDate, maxDate])
      .thresholds(xScale.ticks(80));
    const bins = binner(withDates);
    const maxCount = max(bins, (b) => b.length) ?? 1;
    const yScale = scaleLinear().domain([0, maxCount]).range([innerH, 0]);

    select(svg).selectAll("*").remove();
    const root = select(svg).attr("width", W).attr("height", H);
    const g = root.append("g").attr("transform", `translate(${MARGIN.left},${MARGIN.top})`);

    g.append("rect").attr("width", innerW).attr("height", innerH).attr("fill", "#010409");

    g.append("g")
      .selectAll("rect")
      .data(bins)
      .join("rect")
      .attr("x", (d) => xScale(d.x0!))
      .attr("width", (d) => Math.max(0, xScale(d.x1!) - xScale(d.x0!) - 1))
      .attr("y", (d) => yScale(d.length))
      .attr("height", (d) => innerH - yScale(d.length))
      .attr("fill", "#30363d");

    g.append("g")
      .attr("transform", `translate(0,${innerH})`)
      .call(
        axisBottom(xScale)
          .ticks(8)
          .tickSize(3)
          .tickFormat((d) => (d as Date).getFullYear().toString()),
      )
      .call((ax) => {
        ax.select(".domain").attr("stroke", "#30363d");
        ax.selectAll("line").attr("stroke", "#30363d");
        ax.selectAll("text")
          .attr("fill", "#6e7681")
          .attr("font-size", 9)
          .attr("font-family", "ui-monospace, monospace");
      });

    const brush = brushX()
      .extent([
        [0, 0],
        [innerW, innerH],
      ])
      .on("end", (event) => {
        if (!event.selection) {
          handleClear();
          return;
        }
        const [px0, px1] = event.selection as [number, number];
        handleBrush(xScale.invert(px0), xScale.invert(px1));
      });

    brushBehaviorRef.current = brush;
    const brushG = g.append("g").call(brush as Parameters<typeof g.call>[0]);
    brushGRef.current = brushG;

    brushG
      .select(".selection")
      .attr("fill", "#58a6ff")
      .attr("fill-opacity", 0.12)
      .attr("stroke", "#58a6ff")
      .attr("stroke-opacity", 0.5)
      .attr("stroke-width", 1);
    brushG.selectAll(".handle").attr("fill", "#58a6ff").attr("fill-opacity", 0.6);
    brushG.select(".overlay").attr("cursor", "crosshair");
  }, [withDates, handleBrush, handleClear]);

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", overflow: "hidden", position: "relative" }}
    >
      <button
        onClick={handlePlay}
        title={isPlaying ? "Pause" : "Play: grow selection by 5% every 3 seconds"}
        style={{
          position: "absolute",
          top: 4,
          right: 4,
          zIndex: 10,
          background: isPlaying ? "#6e7681" : "#238636",
          color: "#fff",
          border: "none",
          borderRadius: 4,
          padding: "2px 10px",
          fontSize: 11,
          cursor: "pointer",
          fontFamily: "ui-monospace, 'Cascadia Code', monospace",
          lineHeight: 1.6,
        }}
      >
        {isPlaying ? "⏸ Pause" : "▶ Play"}
      </button>
      <svg ref={svgRef} style={{ display: "block", width: "100%", height: "100%" }} />
    </div>
  );
}
