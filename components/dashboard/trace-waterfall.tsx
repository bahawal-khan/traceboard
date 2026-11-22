"use client";

import { useVirtualizer } from "@tanstack/react-virtual";
import { CircleAlert } from "lucide-react";
import { useId, useRef, useState } from "react";
import {
  MAX_VISUAL_INDENT_LEVELS,
  describeSpan,
  isSelectKey,
  moveActive,
  spanAriaLabel,
  type SpanView,
} from "@/lib/dashboard/trace-detail-view";
import { cn } from "@/lib/utils";

/** Fixed row height: also the minimum tap target (44 px). The virtualiser relies on it, so rows never measure themselves. */
export const WATERFALL_ROW_HEIGHT = 44;
/** Tallest the scrolling list gets (about ten rows; a short trace is shorter). The page does not grow with the number of spans. */
export const WATERFALL_HEIGHT = 440;
const OVERSCAN = 6;
const INDENT_PX = 12;

/**
 * The waterfall: one fixed-height row per span in display order, bars on the trace scale. Only the rows in view (plus a few
 * above and below) are in the DOM, so 2,000 spans cost as much as 20.
 *
 * Accessibility: a listbox. Focus stays on the list itself and `aria-activedescendant` names the active row, because a
 * virtualised row can leave the DOM while it is active. Arrow keys, Home, End and Page keys move; Enter or Space selects.
 * Every row also takes a click or tap. Each row's name says what the bar shows, so colour is never the only signal.
 */
export function TraceWaterfall({ spans, selectedKey, onSelect }: { spans: readonly SpanView[]; selectedKey: string | null; onSelect: (key: string) => void }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const uid = useId();
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);

  // TanStack Virtual returns functions that React Compiler cannot memoise; the compiler then simply skips this component,
  // which is the intended behaviour here (the list re-renders on scroll by design).
  // eslint-disable-next-line react-hooks/incompatible-library
  const virtualizer = useVirtualizer({
    count: spans.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => WATERFALL_ROW_HEIGHT,
    overscan: OVERSCAN,
    getItemKey: (i) => spans[i]?.key ?? i,
    // Before the browser measures, render a list-sized window (so the server HTML already holds the first rows).
    initialRect: { width: 0, height: WATERFALL_HEIGHT },
  });

  const rowId = (i: number) => `${uid}-row-${i}`;
  const activeIndex = Math.min(active, Math.max(0, spans.length - 1));

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (e.altKey || e.ctrlKey || e.metaKey) return;
    const next = moveActive(activeIndex, e.key, spans.length);
    if (next !== null) {
      e.preventDefault();
      setActive(next);
      virtualizer.scrollToIndex(next, { align: "auto" });
      return;
    }
    if (isSelectKey(e.key) && spans[activeIndex]) {
      e.preventDefault();
      onSelect(spans[activeIndex]!.key);
    }
  }

  return (
    <div
      ref={scrollRef}
      role="listbox"
      tabIndex={0}
      aria-label={`Spans in trace order, ${spans.length} in total. Arrow keys move, Enter selects.`}
      aria-activedescendant={spans.length > 0 ? rowId(activeIndex) : undefined}
      onKeyDown={onKeyDown}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{ maxHeight: WATERFALL_HEIGHT }}
      className="relative overflow-x-hidden overflow-y-auto rounded-lg border bg-card focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <div style={{ height: virtualizer.getTotalSize(), position: "relative", width: "100%" }}>
        {virtualizer.getVirtualItems().map((v) => {
          const s = spans[v.index]!;
          const selected = s.key === selectedKey;
          const isActive = focused && v.index === activeIndex;
          return (
            <div
              key={v.key}
              id={rowId(v.index)}
              role="option"
              aria-selected={selected}
              aria-posinset={v.index + 1}
              aria-setsize={spans.length}
              aria-label={spanAriaLabel(s)}
              onClick={() => {
                setActive(v.index);
                onSelect(s.key);
              }}
              style={{ position: "absolute", top: 0, left: 0, width: "100%", height: WATERFALL_ROW_HEIGHT, transform: `translateY(${v.start}px)` }}
              className={cn(
                "cursor-pointer border-b px-3 text-left hover:bg-muted/60",
                selected && "bg-accent",
                isActive && "ring-2 ring-inset ring-ring",
              )}
            >
              <Row span={s} />
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Row({ span }: { span: SpanView }) {
  const d = describeSpan(span);
  const indent = Math.min(span.depth, MAX_VISUAL_INDENT_LEVELS) * INDENT_PX;
  return (
    <div className="grid h-full grid-rows-[1fr_auto] items-center gap-y-1 py-1 md:grid-cols-[minmax(0,16rem)_minmax(0,1fr)] md:grid-rows-1 md:gap-x-3 md:py-0" aria-hidden="true">
      <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: indent }}>
        {span.isError ? <CircleAlert className="size-4 shrink-0 text-status-critical" /> : null}
        <span className={cn("truncate text-sm", span.unnamed ? "italic text-muted-foreground" : "font-medium")} title={span.label}>
          {span.label}
        </span>
        <span className={cn("ml-auto shrink-0 pl-2 text-xs tabular-nums", span.durationKnown ? "text-muted-foreground" : "italic text-muted-foreground")}>
          {span.durationKnown ? d.duration : "duration unknown"}
        </span>
      </div>
      <div className="relative h-2.5 overflow-hidden rounded-sm bg-muted md:h-3" title={`${d.offset}, ${span.durationKnown ? d.duration : "duration unknown"}`}>
        {span.marker ? (
          <span
            className="absolute inset-y-0 w-0.5 border-l-2 border-dashed border-foreground/70"
            style={{ left: `min(${span.leftPct}%, calc(100% - 2px))` }}
          />
        ) : (
          <span
            className={cn("absolute inset-y-0 rounded-sm", span.isError ? "bg-status-critical" : "bg-chart-1")}
            style={{ left: `min(${span.leftPct}%, calc(100% - 3px))`, width: `${span.widthPct}%`, minWidth: 3 }}
          />
        )}
      </div>
    </div>
  );
}
