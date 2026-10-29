import { useState, useRef, useEffect, useMemo } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Play,
  Pause,
  Download,
  RotateCcw,
  RotateCw,
  Volume2,
  Volume1,
  VolumeX,
  Camera,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  ChevronDown,
  Calendar as CalendarIcon,
  Clock,
  AlertCircle,
  AlertTriangle,
  Video,
  Gauge,
  Check,
  Scissors,
  Loader2,
} from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Calendar as DatePickerCalendar } from "@/components/ui/calendar";
import { Slider } from "@/components/ui/slider";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { useAllRecordings, type Recording } from "@/hooks/use-recordings";
import { useCameras } from "@/hooks/use-cameras";
import { useEvents, type EventRow } from "@/hooks/use-events";
import { getStreamUrl, getDownloadUrl, exportRecordingRange } from "@/lib/api";
import { useToast } from "@/hooks/use-toast";
import {
  format,
  startOfDay,
  addDays,
  subDays,
  addMonths,
  subMonths,
  addYears,
  subYears,
  isSameDay,
  differenceInSeconds,
} from "date-fns";

// ── Helpers ────────────────────────────────────────────────────────────────────
const SECS_IN_DAY = 86400;

function secsToHMS(s: number) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(sec).padStart(2, "0")}`;
}

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}

const DURATION_PRESETS: { label: string; hours: number }[] = [
  { label: "30 minute view", hours: 0.5 },
  { label: "1 hour view", hours: 1 },
  { label: "2 hour view", hours: 2 },
  { label: "6 hour view", hours: 6 },
  { label: "Full day (24h)", hours: 24 },
];

// YouTube's exact playback-speed set and the "Normal" label for 1×.
const SPEED_OPTIONS = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];
const speedLabel = (s: number) => (s === 1 ? "Normal" : `${s}×`);

// ── Professional "measuring scale" ruler timeline ───────────────────────────
// Two-tier tick marks (major = taller + labeled, minor = shorter, unlabeled)
// styled after the timeline scrubbers in commercial NVR software (Hikvision/
// Dahua/Milestone etc.), rather than a plain <input type="range"> scrubber.
interface TimelineProps {
  recordings: Recording[];
  events: EventRow[];
  selectedId: number | null;
  currentSec: number; // seconds from midnight of viewDate
  viewDate: Date;
  zoomHours: number; // visible window in hours
  offsetSec: number; // seconds from midnight at left edge of view
  onSeek: (secFromMidnight: number, isFinal?: boolean) => void;
  onSelectEvent?: (event: EventRow) => void;
}

function RulerTimeline({
  recordings,
  events,
  selectedId,
  currentSec,
  viewDate,
  zoomHours,
  offsetSec,
  onSeek,
  onSelectEvent,
}: TimelineProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const windowSecs = zoomHours * 3600;
  const dayStart = startOfDay(viewDate).getTime();
  const [hoverPct, setHoverPct] = useState<number | null>(null);
  const [isDragging, setIsDragging] = useState(false); // drives cursor style
  // and gates the document-level drag listeners (see the effect below).

  // The playhead's normal position (`currentSec` prop) is derived from the
  // parent's actual <video> playback time, which round-trips through a
  // video seek (async, sometimes slow over a network stream) before it
  // updates. Waiting on that during a drag is what made the marker seem
  // stuck. `dragPreviewSec` is purely local state that mirrors the pointer
  // 1:1, with nothing else in the loop — it can never lag.
  const [dragPreviewSec, setDragPreviewSec] = useState<number | null>(null);
  const displaySec = dragPreviewSec ?? currentSec;
  const dayRecs = useMemo(
    () =>
      recordings.filter((r) => {
        const s = new Date(r.start_timestamp).getTime();
        return s >= dayStart && s < dayStart + SECS_IN_DAY * 1000;
      }),
    [recordings, dayStart],
  );

  const dayEvents = useMemo(
    () =>
      events.filter((e) => {
        const t = new Date(e.occurred_at).getTime();
        return t >= dayStart && t < dayStart + SECS_IN_DAY * 1000;
      }),
    [events, dayStart],
  );

  const secToPercent = (sec: number) =>
    clamp(((sec - offsetSec) / windowSecs) * 100, 0, 100);

  const pctToSec = (clientX: number) => {
    if (!barRef.current) return offsetSec;
    const rect = barRef.current.getBoundingClientRect();
    const pct = (clientX - rect.left) / rect.width;
    return offsetSec + pct * windowSecs;
  };

  const lastSecRef = useRef(offsetSec);

  // ── Single, unambiguous interaction: press anywhere = jump there, drag
  // = scrub live. No separate "drag to pan" gesture on the ruler itself —
  // that split (previous version) was the confusing part. Moving to a
  // different part of the day is now done with the explicit Prev/Next
  // window buttons above the timeline instead. ────────────────────────────
  //
  // Capture + listen on the SAME element (barRef), always — every
  // pointerdown entry point (the bar itself, a recording segment, the
  // playhead handle) explicitly captures onto barRef.current rather than
  // `e.currentTarget`, and the move/up/cancel handlers live as normal
  // React pointer props on that same bar element below, not on
  // `document`. This used to capture on whichever element was actually
  // pressed (bar, segment, or handle — three different elements) while
  // always listening on `document` — relying on captured pointer events
  // still bubbling all the way up to `document` to work. That bubbling
  // behavior is exactly the kind of thing that isn't guaranteed identical
  // across browser engines once pointer capture is involved; capturing
  // and listening on the one same element sidesteps the question
  // entirely, since the browser is required to deliver every subsequent
  // event for that pointer straight to the capturing element.
  const startDrag = (initialSec: number, pointerId?: number) => {
    if (pointerId != null) {
      try {
        barRef.current?.setPointerCapture(pointerId);
      } catch {
        /* already released/invalid — fine */
      }
    }
    lastSecRef.current = initialSec;
    setDragPreviewSec(initialSec);
    setIsDragging(true);
    // isFinal=false here on purpose: pressing down is the START of an
    // interaction, not the end of one. Calling this with isFinal=true
    // fired the "no recording at this time" toast on the very first pixel
    // of a press/drag if it didn't happen to land exactly on a segment —
    // before the person had any chance to actually drag toward one. The
    // "commit" (toast-if-empty, resume playback) now only happens once, on
    // release, in endDrag below.
    onSeek(initialSec, false);
  };

  const endDrag = () => {
    onSeek(lastSecRef.current, true);
    setIsDragging(false);
    setDragPreviewSec(null);
  };

  const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    startDrag(clamp(pctToSec(e.clientX), 0, SECS_IN_DAY), e.pointerId);
  };
  const handleBarPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    if (!barRef.current) return;
    const rect = barRef.current.getBoundingClientRect();
    setHoverPct(clamp(((e.clientX - rect.left) / rect.width) * 100, 0, 100));
    if (!isDragging) return;
    const sec = clamp(pctToSec(e.clientX), 0, SECS_IN_DAY);
    lastSecRef.current = sec;
    setDragPreviewSec(sec);
    onSeek(sec, false);
  };
  const handleBarPointerUp = () => {
    if (isDragging) endDrag();
  };

  // Three-tier tick hierarchy — major (labeled, tallest), minor (medium),
  // micro (shortest, densest) — the way a physical ruler/tape measure has
  // numbered graduations with several finer unlabeled marks between them.
  // Coarser at wide zoom (24h), fine-grained at narrow zoom (30m).
  const { majorStepSec, minorStepSec, microStepSec } = useMemo(() => {
    if (zoomHours <= 0.5)
      return { majorStepSec: 300, minorStepSec: 60, microStepSec: 15 };
    if (zoomHours <= 1)
      return { majorStepSec: 600, minorStepSec: 120, microStepSec: 30 };
    if (zoomHours <= 2)
      return { majorStepSec: 900, minorStepSec: 300, microStepSec: 60 };
    if (zoomHours <= 6)
      return { majorStepSec: 1800, minorStepSec: 600, microStepSec: 120 };
    return { majorStepSec: 3600 * 2, minorStepSec: 1800, microStepSec: 600 };
  }, [zoomHours]);

  const majorTicks = useMemo(() => {
    const out: number[] = [];
    let t = Math.floor(offsetSec / majorStepSec) * majorStepSec;
    while (t <= offsetSec + windowSecs) {
      if (t >= 0 && t <= SECS_IN_DAY) out.push(t);
      t += majorStepSec;
    }
    return out;
  }, [offsetSec, windowSecs, majorStepSec]);

  const minorTicks = useMemo(() => {
    const out: number[] = [];
    let t = Math.floor(offsetSec / minorStepSec) * minorStepSec;
    while (t <= offsetSec + windowSecs) {
      if (t >= 0 && t <= SECS_IN_DAY && t % majorStepSec !== 0) out.push(t);
      t += minorStepSec;
    }
    return out;
  }, [offsetSec, windowSecs, minorStepSec, majorStepSec]);

  const microTicks = useMemo(() => {
    const out: number[] = [];
    let t = Math.floor(offsetSec / microStepSec) * microStepSec;
    while (t <= offsetSec + windowSecs) {
      if (t >= 0 && t <= SECS_IN_DAY && t % minorStepSec !== 0) out.push(t);
      t += microStepSec;
    }
    return out;
  }, [offsetSec, windowSecs, microStepSec, minorStepSec]);

  const fmtTick = (sec: number) =>
    `${String(Math.floor(sec / 3600)).padStart(2, "0")}:${String(Math.floor((sec % 3600) / 60)).padStart(2, "0")}`;

  const nowPct = secToPercent(displaySec);

  return (
    <div className="select-none">
      <div
        ref={barRef}
        className={`relative h-[78px] rounded-md border border-border overflow-hidden font-mono bg-[hsl(var(--muted))]/30 touch-none ${isDragging ? "cursor-grabbing" : "cursor-grab"}`}
        onPointerDown={handlePointerDown}
        onPointerMove={handleBarPointerMove}
        onPointerUp={handleBarPointerUp}
        onPointerCancel={handleBarPointerUp}
        onMouseLeave={() => setHoverPct(null)}
      >
        {/* Ruler strip (top) — numbered graduations, purely a visual
            reference for where you are; the whole bar (ruler + track) is
            one single click/drag-to-seek surface, so there's nothing extra
            to learn about this row specifically. Tall enough (h-9) to fit
            the label + gap + tick without the label clipping at the top. */}
        <div className="relative h-9 border-b border-border bg-muted/40 pointer-events-none overflow-visible">
          {microTicks.map((sec) => (
            <div
              key={`mic-${sec}`}
              className="absolute bottom-0 w-px h-1.5 bg-border/70"
              style={{ left: `${secToPercent(sec)}%` }}
            />
          ))}
          {minorTicks.map((sec) => (
            <div
              key={`min-${sec}`}
              className="absolute bottom-0 w-px h-2.5 bg-muted-foreground/50"
              style={{ left: `${secToPercent(sec)}%` }}
            />
          ))}
          {majorTicks.map((sec) => (
            <div
              key={`maj-${sec}`}
              className="absolute bottom-0 flex flex-col items-center"
              style={{
                left: `${secToPercent(sec)}%`,
                transform: "translateX(-50%)",
              }}
            >
              <span className="text-[9px] leading-none text-foreground/80 font-semibold mb-1 whitespace-nowrap">
                {fmtTick(sec)}
              </span>
              <div className="w-px h-3 bg-foreground/70" />
            </div>
          ))}
        </div>

        {/* Scrub track (bottom) — recording segments, event ticks, and the
            live playhead. */}
        <div className="relative h-[42px]">
          {/* Recording segments — each has its own hit-test so a click
              anywhere on a (possibly visually widened, for thin clips)
              segment always resolves to a timestamp inside THAT
              recording's real bounds, instead of relying on the generic
              bar-wide position math and sometimes missing a thin clip. */}
          <div className="absolute inset-x-0 top-1.5 h-7">
            {dayRecs.map((rec) => {
              const recStartSec = differenceInSeconds(
                new Date(rec.start_timestamp),
                startOfDay(viewDate),
              );
              const recEndSec = rec.end_timestamp
                ? differenceInSeconds(
                    new Date(rec.end_timestamp),
                    startOfDay(viewDate),
                  )
                : recStartSec + (rec.duration_seconds ?? 60);
              const left = secToPercent(recStartSec);
              const right = secToPercent(recEndSec);
              const width = clamp(right - left, 0.3, 100);
              if (right < 0 || left > 100) return null;
              const isSelected = rec.recording_id === selectedId;
              return (
                <div
                  key={rec.recording_id}
                  className={`absolute top-0 h-full rounded-sm cursor-pointer transition-all hover:brightness-125 ${isSelected ? "ring-1 ring-primary" : ""}`}
                  style={{
                    left: `${clamp(left, 0, 99)}%`,
                    width: `${width}%`,
                    minWidth: "8px",
                    background: isSelected
                      ? "linear-gradient(180deg, rgba(99,102,241,0.9), rgba(99,102,241,0.55))"
                      : "linear-gradient(180deg, rgba(34,197,94,0.75), rgba(34,197,94,0.35))",
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    // Capture on the BAR (not this segment) — see the long
                    // comment above startDrag(): every pointerdown entry
                    // point funnels capture onto the one element (barRef)
                    // that actually owns the move/up handlers, rather than
                    // whichever element happened to be pressed.
                    try {
                      barRef.current?.setPointerCapture(e.pointerId);
                    } catch {
                      /* ignore */
                    }
                    const rect = e.currentTarget.getBoundingClientRect();
                    const pct = clamp(
                      (e.clientX - rect.left) / rect.width,
                      0,
                      1,
                    );
                    const durSec = Math.max(1, recEndSec - recStartSec);
                    startDrag(recStartSec + pct * durSec);
                  }}
                  title={`${rec.camera_name} — ${format(new Date(rec.start_timestamp), "HH:mm:ss")}`}
                />
              );
            })}
          </div>

          {/* Event markers */}
          {dayEvents.map((ev) => {
            const evSec = differenceInSeconds(
              new Date(ev.occurred_at),
              startOfDay(viewDate),
            );
            const pct = secToPercent(evSec);
            if (pct < 0 || pct > 100) return null;
            return (
              <div
                key={`evt-${ev.event_id}`}
                className="absolute top-0 bottom-0 z-20 cursor-pointer group"
                style={{ left: `${pct}%`, transform: "translateX(-50%)" }}
                onPointerDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  onSelectEvent?.(ev);
                }}
                title={`${ev.title || ev.event_type} — ${format(new Date(ev.occurred_at), "HH:mm:ss")}`}
              >
                <div className="w-0.5 h-full bg-red-500 opacity-90 group-hover:w-1 transition-all" />
                <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 rounded-full bg-red-500 ring-2 ring-background group-hover:scale-125 transition-transform" />
              </div>
            );
          })}

          {dayRecs.length === 0 && (
            <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
              <span className="text-[10px] text-muted-foreground">
                No recordings for {format(viewDate, "dd MMM yyyy")}
              </span>
            </div>
          )}
        </div>

        {/* Hover crosshair + time tooltip — spans the whole bar */}
        {hoverPct !== null && !isDragging && (
          <div
            className="absolute top-0 bottom-0 pointer-events-none z-30"
            style={{ left: `${hoverPct}%` }}
          >
            <div className="w-px h-full bg-foreground/25" />
            <div className="absolute top-0.5 left-1/2 -translate-x-1/2 bg-popover border border-border rounded px-1.5 py-0.5 text-[10px] font-mono text-foreground whitespace-nowrap shadow">
              {fmtTick(
                clamp(
                  offsetSec + (hoverPct / 100) * windowSecs,
                  0,
                  SECS_IN_DAY,
                ),
              )}
            </div>
          </div>
        )}

        {/* Playhead — full-height line with a draggable handle at the top,
            exactly like Hikvision's timeline cursor. The handle has its own
            (larger, easy-to-grab) hit area and can be dragged independently
            of pressing elsewhere on the bar.

            The hit area (w-7 h-7) is deliberately much bigger than the
            visible triangle (10px) — a small, precisely-shaped hit target
            is exactly what makes a handle feel unresponsive: the drag
            starts fine as long as the pointer lands pixel-perfect on the
            visible glyph, but any near-miss lands on the bar underneath
            instead and jumps rather than grabs. Kept flush at `top-0`
            (not poking above the bar) since the bar's `overflow-hidden`
            clips anything positioned outside its box — including, for
            pointer-event purposes, hit-testing on the clipped-away part
            of an element, not just its paint. */}
        {nowPct >= 0 && nowPct <= 100 && (
          <div
            className="absolute top-0 bottom-0 z-20"
            style={{ left: `${nowPct}%`, transform: "translateX(-50%)" }}
          >
            <div
              className="absolute top-0 left-1/2 -translate-x-1/2 w-7 h-7 flex items-start justify-center pt-0.5 cursor-grab active:cursor-grabbing touch-none"
              onPointerDown={(e) => {
                e.preventDefault();
                e.stopPropagation();
                startDrag(displaySec, e.pointerId);
              }}
              title="Drag to scrub"
            >
              <div className="w-0 h-0 border-l-[6px] border-r-[6px] border-t-[8px] border-l-transparent border-r-transparent border-t-primary drop-shadow" />
            </div>
            <div className="w-0.5 h-full bg-primary mx-auto pointer-events-none" />
          </div>
        )}
      </div>

      {/* Current time readout + legend */}
      <div className="flex items-center justify-between mt-1.5 px-1 flex-wrap gap-2">
        <div className="flex items-center gap-1.5">
          <Clock className="h-3 w-3 text-primary" />
          <span className="text-xs font-mono font-semibold text-primary">
            {secsToHMS(displaySec)}
          </span>
        </div>
        <div className="flex gap-3">
          <div className="flex items-center gap-1">
            <div className="w-3 h-2 rounded-sm bg-green-500/60" />
            <span className="text-[10px] text-muted-foreground">
              Recording ({dayRecs.length})
            </span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-3 h-2 rounded-sm bg-primary/70" />
            <span className="text-[10px] text-muted-foreground">Selected</span>
          </div>
          <div className="flex items-center gap-1">
            <div className="w-2 h-2 rounded-full bg-red-500" />
            <span className="text-[10px] text-muted-foreground">
              Event ({dayEvents.length})
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Calendar panel — left-bottom, with month AND year navigation ───────────
function CalendarPanel({
  selected,
  onSelect,
}: {
  selected: Date;
  onSelect: (d: Date) => void;
}) {
  const [month, setMonth] = useState<Date>(selected);

  // Follow the selected date if it changes elsewhere (e.g. picking a
  // recording jumps the whole page to that recording's day).
  useEffect(() => {
    setMonth((m) =>
      isSameDay(m, selected) ||
      (m.getMonth() === selected.getMonth() &&
        m.getFullYear() === selected.getFullYear())
        ? m
        : selected,
    );
  }, [selected]);

  return (
    <div className="border border-border rounded-lg bg-card p-2.5 w-full max-w-[260px] mx-auto">
      {/* Custom caption: << < Month Year > >> — replaces the DayPicker's
          own single-step month nav with proper month AND year stepping. */}
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center">
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            title="Previous year"
            onClick={() => setMonth((m) => subYears(m, 1))}
          >
            <ChevronsLeft className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            title="Previous month"
            onClick={() => setMonth((m) => subMonths(m, 1))}
          >
            <ChevronLeft className="h-3.5 w-3.5" />
          </Button>
        </div>
        <span className="text-xs font-semibold text-foreground">
          {format(month, "MMMM yyyy")}
        </span>
        <div className="flex items-center">
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            title="Next month"
            onClick={() => setMonth((m) => addMonths(m, 1))}
          >
            <ChevronRight className="h-3.5 w-3.5" />
          </Button>
          <Button
            size="icon"
            variant="ghost"
            className="h-6 w-6"
            title="Next year"
            onClick={() => setMonth((m) => addYears(m, 1))}
          >
            <ChevronsRight className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <DatePickerCalendar
        mode="single"
        month={month}
        onMonthChange={setMonth}
        selected={selected}
        onSelect={(d) => d && onSelect(startOfDay(d))}
        disabled={(d) => startOfDay(d) > startOfDay(new Date())}
        classNames={{
          caption: "hidden",
          nav: "hidden",
          months: "flex flex-col w-full",
          month: "space-y-1 w-full",
          table: "w-full border-collapse",
          head_row: "flex w-full",
          head_cell:
            "flex-1 text-muted-foreground font-normal text-[0.65rem] text-center",
          cell: "flex-1 aspect-square text-center text-xs p-0.5 relative [&:has([aria-selected])]:bg-accent focus-within:relative focus-within:z-20",
          day: "h-full w-full mx-auto p-0 font-normal text-xs rounded-md hover:bg-muted aria-selected:opacity-100 flex items-center justify-center",
          day_selected:
            "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground",
          day_today: "border border-primary/50 text-primary font-semibold",
          row: "flex w-full mt-0.5",
        }}
      />
      <Button
        size="sm"
        variant="outline"
        className="w-full h-6 text-[10px] mt-1"
        onClick={() => {
          const today = startOfDay(new Date());
          setMonth(today);
          onSelect(today);
        }}
      >
        Jump to Today
      </Button>
    </div>
  );
}

// ── Left tree: Normal Playback (recordings) + Events Playback ──────────────
// Grouped by camera, expandable to show that camera's clips/events for the
// currently-viewed day — clicking a leaf loads it into the player.
type TreeMode = "recordings" | "events";

function PlaybackTree({
  cameras,
  recordings,
  events,
  viewDate,
  filterCamId,
  onSelectCamera,
  onSelectEvent,
}: {
  cameras:
    | {
        camera_id: number;
        camera_name: string;
        ip_address: string | null;
        is_online?: number | null;
      }[]
    | undefined;
  recordings: Recording[];
  events: EventRow[];
  viewDate: Date;
  filterCamId: number | null;
  onSelectCamera: (id: number | null) => void;
  onSelectEvent: (ev: EventRow) => void;
}) {
  const [openSection, setOpenSection] = useState<TreeMode | "both">("both");
  const [expandedEvtCams, setExpandedEvtCams] = useState<Set<number>>(
    new Set(),
  );

  const dayStart = startOfDay(viewDate).getTime();
  const dayEnd = dayStart + SECS_IN_DAY * 1000;

  const recsByCam = useMemo(() => {
    const map = new Map<number, Recording[]>();
    recordings
      .filter((r) => {
        const t = new Date(r.start_timestamp).getTime();
        return t >= dayStart && t < dayEnd;
      })
      .forEach((r) => {
        if (!map.has(r.camera_id)) map.set(r.camera_id, []);
        map.get(r.camera_id)!.push(r);
      });
    map.forEach((list) =>
      list.sort(
        (a, b) =>
          new Date(b.start_timestamp).getTime() -
          new Date(a.start_timestamp).getTime(),
      ),
    );
    return map;
  }, [recordings, dayStart, dayEnd]);

  const evtsByCam = useMemo(() => {
    const map = new Map<number, EventRow[]>();
    events
      .filter((e) => {
        const t = new Date(e.occurred_at).getTime();
        return t >= dayStart && t < dayEnd;
      })
      .forEach((e) => {
        const camId = e.camera_id ?? 0;
        if (!map.has(camId)) map.set(camId, []);
        map.get(camId)!.push(e);
      });
    map.forEach((list) =>
      list.sort(
        (a, b) =>
          new Date(b.occurred_at).getTime() - new Date(a.occurred_at).getTime(),
      ),
    );
    return map;
  }, [events, dayStart, dayEnd]);

  const toggleCam = (
    set: Set<number>,
    setter: (s: Set<number>) => void,
    id: number,
  ) => {
    const next = new Set(set);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setter(next);
  };

  const SectionHeader = ({
    mode,
    icon: Icon,
    label,
    count,
  }: {
    mode: TreeMode;
    icon: React.ElementType;
    label: string;
    count: number;
  }) => {
    const isOpen = openSection === mode || openSection === "both";
    return (
      <button
        onClick={() =>
          setOpenSection((s) => (s === mode ? ("both" as const) : mode))
        }
        className="w-full flex items-center justify-between px-2 py-1.5 text-xs font-semibold text-foreground bg-muted/40 hover:bg-muted/60 transition-colors rounded-t-md"
      >
        <span className="flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5 text-primary" />
          {label}
          <span className="text-[10px] font-normal text-muted-foreground">
            ({count})
          </span>
        </span>
        <ChevronDown
          className={`h-3.5 w-3.5 transition-transform ${isOpen ? "" : "-rotate-90"}`}
        />
      </button>
    );
  };

  const recCount = [...recsByCam.values()].reduce((a, l) => a + l.length, 0);
  const evtCount = [...evtsByCam.values()].reduce((a, l) => a + l.length, 0);
  const showRecordings = openSection === "recordings" || openSection === "both";
  const showEvents = openSection === "events" || openSection === "both";

  return (
    <div className="flex-1 min-h-0 overflow-y-auto space-y-2 pr-0.5">
      {/* Normal Playback tree — a flat, professional camera list. Clicking
          a camera loads its playback directly (see onSelectCamera in the
          parent); there's no separate "pick a clip" sub-list here — the
          timeline scrubber below is how you choose a moment in time. */}
      <div className="border border-border rounded-md overflow-hidden">
        <SectionHeader
          mode="recordings"
          icon={Video}
          label="Normal Playback"
          count={recCount}
        />
        {showRecordings && (
          <div className="py-1">
            <button
              onClick={() => onSelectCamera(null)}
              className={`w-full text-left px-2.5 py-1.5 text-xs hover:bg-muted/50 transition-colors ${!filterCamId ? "bg-primary/10 text-primary font-medium" : "text-foreground"}`}
            >
              All cameras
            </button>
            {cameras?.map((cam) => {
              return (
                <button
                  key={cam.camera_id}
                  onClick={() => onSelectCamera(cam.camera_id)}
                  className={`w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-left hover:bg-muted/50 transition-colors ${filterCamId === cam.camera_id ? "bg-primary/10 text-primary font-medium" : "text-foreground"}`}
                >
                  <span
                    className={`h-1.5 w-1.5 rounded-full shrink-0 ${cam.is_online ? "bg-green-500" : "bg-muted-foreground/40"}`}
                  />
                  <span className="truncate flex-1">{cam.camera_name}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {/* Events Playback tree */}
      <div className="border border-border rounded-md overflow-hidden">
        <SectionHeader
          mode="events"
          icon={AlertTriangle}
          label="Events Playback"
          count={evtCount}
        />
        {showEvents && (
          <div className="py-1">
            {evtCount === 0 && (
              <p className="text-[10px] text-muted-foreground text-center py-3">
                No events this day
              </p>
            )}
            {cameras
              ?.filter((cam) => (evtsByCam.get(cam.camera_id)?.length ?? 0) > 0)
              .map((cam) => {
                const evts = evtsByCam.get(cam.camera_id) ?? [];
                const isExpanded = expandedEvtCams.has(cam.camera_id);
                return (
                  <div key={cam.camera_id}>
                    <button
                      onClick={() =>
                        toggleCam(
                          expandedEvtCams,
                          setExpandedEvtCams,
                          cam.camera_id,
                        )
                      }
                      className="w-full flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-left hover:bg-muted/50 transition-colors text-foreground"
                    >
                      <ChevronDown
                        className={`h-3 w-3 shrink-0 transition-transform ${isExpanded ? "" : "-rotate-90"}`}
                      />
                      <span className="truncate flex-1">{cam.camera_name}</span>
                    </button>
                    {isExpanded && (
                      <div className="pl-6 pb-1">
                        {evts.map((ev) => (
                          <button
                            key={ev.event_id}
                            onClick={() => onSelectEvent(ev)}
                            className="w-full flex items-center gap-1.5 text-left px-2 py-1 rounded text-[11px] hover:bg-muted/50 transition-colors text-muted-foreground"
                          >
                            <AlertCircle
                              className={`h-2.5 w-2.5 shrink-0 ${ev.severity === "CRITICAL" || ev.severity === "HIGH" ? "text-red-500" : "text-yellow-500"}`}
                            />
                            <span className="font-mono shrink-0">
                              {format(new Date(ev.occurred_at), "HH:mm:ss")}
                            </span>
                            <span className="truncate">
                              {ev.title || ev.event_type}
                            </span>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}

// ── Main VideoPlayer ──────────────────────────────────────────────────────────
const VideoPlayer = () => {
  const [searchParams] = useSearchParams();
  const { toast } = useToast();

  const videoRef = useRef<HTMLVideoElement>(null);

  const initRecId = searchParams.get("recording")
    ? parseInt(searchParams.get("recording")!)
    : null;
  const initCamId = searchParams.get("camera")
    ? parseInt(searchParams.get("camera")!)
    : null;
  // ISO timestamp to seek to when opening from a notification/event link
  const initAt = searchParams.get("at") || null;

  // View state
  const [filterCamId, setFilterCamId] = useState<number | null>(initCamId);
  const [selectedRecId, setSelectedRecId] = useState<number | null>(initRecId);
  const [viewDate, setViewDate] = useState<Date>(startOfDay(new Date()));
  const [zoomHours, setZoomHours] = useState(2); // visible window, one of DURATION_PRESETS
  const [offsetSec, setOffsetSec] = useState(0); // left edge of timeline view (sec from midnight)

  // Playback state
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [speedMenuOpen, setSpeedMenuOpen] = useState(false);
  // Mirrors `playing` without being a dependency of the load-recording
  // effect below — lets that effect know "was already playing" at the
  // moment a new recording is selected, without re-running itself every
  // time playing flips from onPlay/onPause events.
  const playingRef = useRef(false);
  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  // Waits for the browser's own "I actually have a frame ready" signal
  // (loadeddata) before calling play(). Calling play() right after
  // load()/a src change leaves .paused=false (so the button correctly
  // shows "playing") but with no decoded frame yet — visually frozen
  // until enough data arrives, which is exactly the "button says
  // playing/doesn't play, click again and now it plays" symptom. Every
  // call site that loads a new recording and wants it to (keep) playing
  // should go through this instead of an arbitrary setTimeout + play().
  const playWhenReady = (video: HTMLVideoElement, onReady?: () => void) => {
    const start = () => {
      onReady?.();
      video.play().catch(() => {
        // Autoplay blocked or src not ready — stay paused, onPause already reflects that.
      });
    };
    if (video.readyState >= 2)
      start(); // HAVE_CURRENT_DATA or beyond
    else video.addEventListener("loadeddata", start, { once: true });
  };
  const [muted, setMuted] = useState(true);
  const [volume, setVolume] = useState(80);
  const [curTime, setCurTime] = useState(0);
  const [duration, setDuration] = useState(0);

  // Playhead as seconds-from-midnight for the timeline
  const [playheadSec, setPlayheadSec] = useState<number>(0);
  // When a recording switch happens because the scrubber was dragged across
  // a clip boundary, the "load recording" effect below should NOT reset the
  // playhead/view back to that recording's start or re-center the ruler —
  // handleTimelineSeek has already placed the playhead exactly where the
  // drag is. This flag distinguishes that case from an explicit selection
  // (tree click, event click) where jumping to the recording's start and
  // re-centering the view is exactly what should happen.
  const skipPlayheadResetRef = useRef(false);

  const { data: cameras } = useCameras();

  // Memoized, not inline object literals — useAllRecordings/useEvents were
  // being called with a brand-new `{ camera_id: ... }` object on every
  // render. filterCamId itself only changes when the user picks a
  // different camera, so these should be referentially stable across all
  // the OTHER renders this page does constantly (e.g. every pointermove
  // while dragging the scrubber). A fresh object every render made
  // react-query's internals re-arm their refetch-interval subscription
  // every render too — harmless in isolation, but during a fast drag this
  // page can re-render dozens of times a second, and that pile-up is the
  // exact shape of the runaway recursive dispatch chain seen in the
  // Firefox crash report (`updateRefetchInterval_fn` re-entering itself
  // repeatedly until the stack overflowed) — Firefox's SpiderMonkey has a
  // noticeably lower recursion ceiling than Chrome's V8, which is why this
  // surfaced as a hard crash there specifically and only as a stall/never-
  // visible-update everywhere else.
  const recordingsFilter = useMemo(
    () => (filterCamId ? { camera_id: filterCamId } : undefined),
    [filterCamId],
  );
  const eventsFilter = useMemo(
    () =>
      filterCamId ? { camera_id: filterCamId, limit: 500 } : { limit: 500 },
    [filterCamId],
  );
  const { data: recordings } = useAllRecordings(recordingsFilter);
  const { data: eventsResp } = useEvents(eventsFilter);
  const allEvents = eventsResp?.events ?? [];

  const currentRec = recordings?.find((r) => r.recording_id === selectedRecId);

  // ── Time-range export — same merged-segments-into-one-file export as
  // SearchPage's "Export Range", surfaced here too since this page already
  // has a loaded camera/time in context. Defaults to a window around
  // whatever's currently playing so the common case ("clip out roughly
  // what I'm looking at") needs no typing. ──────────────────────────────
  const [exportOpen, setExportOpen] = useState(false);
  const [exportCameraId, setExportCameraId] = useState<string>("");
  const [exportStart, setExportStart] = useState("");
  const [exportEnd, setExportEnd] = useState("");
  const [exporting, setExporting] = useState(false);

  const openExportDialog = () => {
    const toLocalInput = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm");
    if (currentRec) {
      setExportCameraId(String(currentRec.camera_id));
      const dayStart = startOfDay(viewDate);
      const centerMs = dayStart.getTime() + playheadSec * 1000;
      setExportStart(toLocalInput(new Date(centerMs - 5 * 60 * 1000)));
      setExportEnd(toLocalInput(new Date(centerMs + 5 * 60 * 1000)));
    } else {
      const now = new Date();
      setExportCameraId(cameras?.[0] ? String(cameras[0].camera_id) : "");
      setExportStart(toLocalInput(new Date(now.getTime() - 10 * 60 * 1000)));
      setExportEnd(toLocalInput(now));
    }
    setExportOpen(true);
  };

  const runExport = async () => {
    if (!exportCameraId || !exportStart || !exportEnd) return;
    if (new Date(exportStart) >= new Date(exportEnd)) {
      toast({
        title: "Invalid range",
        description: "Start time must be before end time.",
        variant: "destructive",
      });
      return;
    }
    setExporting(true);
    try {
      // datetime-local gives "YYYY-MM-DDTHH:mm" — append seconds to match
      // the naive local-time format the export endpoint (and the rest of
      // this app) expects for this column; see toApiDateTime().
      const blob = await exportRecordingRange(
        parseInt(exportCameraId, 10),
        `${exportStart}:00.000`,
        `${exportEnd}:00.000`,
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download =
        `camera_${exportCameraId}_${exportStart}_to_${exportEnd}.mp4`.replace(
          /[:]/g,
          "-",
        );
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportOpen(false);
      toast({
        title: "Export ready",
        description: "Your clip has downloaded.",
      });
    } catch (err) {
      toast({
        title: "Export failed",
        description:
          err instanceof Error ? err.message : "Could not build that clip.",
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  // ── Playback speed — applied to the element directly, and reapplied
  // after every src swap since browsers reset playbackRate on load(). ────
  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = speed;
  }, [speed, selectedRecId]);

  // ── Volume — video.volume is separate from the `muted` attribute; both
  // need to be kept in sync with the slider/icon state. ──────────────────
  useEffect(() => {
    if (videoRef.current) videoRef.current.volume = volume / 100;
  }, [volume, selectedRecId]);

  // ── initAt: auto-select the recording containing the event timestamp ───────
  // Fires once when recordings first arrive and ?at= is in the URL.
  const initAtApplied = useRef(false);
  useEffect(() => {
    if (!initAt || !recordings?.length || initAtApplied.current) return;
    const targetMs = new Date(initAt).getTime();
    if (isNaN(targetMs)) return;

    const camRecs = recordings.filter(
      (r) => !initCamId || r.camera_id === initCamId,
    );
    let hit = camRecs.find((r) => {
      const s = new Date(r.start_timestamp).getTime();
      const e = r.end_timestamp
        ? new Date(r.end_timestamp).getTime()
        : s + (r.duration_seconds ?? 120) * 1000;
      return targetMs >= s && targetMs <= e;
    });
    if (!hit) {
      hit = [...camRecs]
        .filter((r) => new Date(r.start_timestamp).getTime() <= targetMs)
        .sort(
          (a, b) =>
            new Date(b.start_timestamp).getTime() -
            new Date(a.start_timestamp).getTime(),
        )[0];
    }
    if (!hit) return;

    initAtApplied.current = true;
    setFilterCamId(hit.camera_id);
    setSelectedRecId(hit.recording_id);

    const seekSec = Math.max(
      0,
      (targetMs - new Date(hit.start_timestamp).getTime()) / 1000,
    );
    setTimeout(() => {
      const video = videoRef.current;
      if (!video) return;
      const doSeek = () => {
        video.currentTime = seekSec;
        video.play().catch(() => {});
      };
      if (video.readyState >= 1) doSeek();
      else video.addEventListener("loadedmetadata", doSeek, { once: true });
    }, 250);
  }, [recordings, initAt, initCamId]);

  // ── Load recording ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedRecId) return;
    const video = videoRef.current;
    if (!video) return;
    const wasPlaying = playingRef.current;
    video.src = getStreamUrl(selectedRecId);
    video.load();
    if (wasPlaying) playWhenReady(video);
    setCurTime(0);
    setDuration(0);

    if (skipPlayheadResetRef.current) {
      // This switch happened mid-drag on the scrubber — playheadSec,
      // offsetSec, and viewDate are already correct; resetting them here
      // would snap the playhead back to this clip's start on every clip
      // boundary crossed while dragging.
      skipPlayheadResetRef.current = false;
      return;
    }

    const rec = recordings?.find((r) => r.recording_id === selectedRecId);
    if (rec) {
      const recDate = startOfDay(new Date(rec.start_timestamp));
      setViewDate(recDate);
      const secFromMidnight = differenceInSeconds(
        new Date(rec.start_timestamp),
        recDate,
      );
      setPlayheadSec(secFromMidnight);
      const windowSecs = zoomHours * 3600;
      setOffsetSec(
        clamp(secFromMidnight - windowSecs / 2, 0, SECS_IN_DAY - windowSecs),
      );
    }
  }, [selectedRecId]);

  // ── Update playhead as video plays ────────────────────────────────────────
  useEffect(() => {
    if (!currentRec) return;
    const recStartSec = differenceInSeconds(
      new Date(currentRec.start_timestamp),
      startOfDay(viewDate),
    );
    setPlayheadSec(recStartSec + curTime);
  }, [curTime, currentRec, viewDate]);

  // ── Timeline seek → find recording at that second ─────────────────────────
  const handleTimelineSeek = (
    secFromMidnight: number,
    isFinal: boolean = true,
  ) => {
    // During a drag, the ruler already shows a live preview entirely on its
    // own (local `dragPreviewSec` state in RulerTimeline) — it doesn't need
    // anything from here to do that. Doing real work on every intermediate
    // pointermove (switching selectedRecId, reloading/seeking the actual
    // <video>, sometimes toasting) was expensive enough to make the whole
    // page's re-render lag behind the drag, which is what made it look
    // "stuck"/unresponsive despite the marker's own state being fine. So:
    // do nothing at all until the drag actually settles on release.
    if (!isFinal) return;
    if (!recordings) return;

    setPlayheadSec(clamp(secFromMidnight, 0, SECS_IN_DAY));

    const viewDayStart = startOfDay(viewDate).getTime();
    const clickTs = viewDayStart + secFromMidnight * 1000;

    const hit = recordings.find((r) => {
      const s = new Date(r.start_timestamp).getTime();
      const dur = r.duration_seconds ?? 60;
      const e = r.end_timestamp
        ? new Date(r.end_timestamp).getTime()
        : s + dur * 1000;
      return clickTs >= s && clickTs <= e;
    });

    if (hit) {
      const isNewRec = hit.recording_id !== selectedRecId;
      if (isNewRec) skipPlayheadResetRef.current = true;
      setSelectedRecId(hit.recording_id);
      const recStart = new Date(hit.start_timestamp).getTime();
      const offsetSecs = (clickTs - recStart) / 1000;
      const video = videoRef.current;
      if (video) {
        if (isNewRec) {
          setTimeout(
            () =>
              playWhenReady(video, () => {
                video.currentTime = offsetSecs;
              }),
            0,
          );
        } else {
          video.currentTime = offsetSecs;
          video.play().catch(() => {});
        }
      }
    } else {
      // No recording covers the exact spot the drag was released on —
      // an ordinary outcome given most timelines have gaps between
      // segments, not a rare edge case. THIS IS THE ROOT CAUSE of the
      // drag appearing to do nothing: setPlayheadSec above already
      // placed the marker at the drop point, but the video that was
      // already loaded is untouched — if it's still playing, its
      // native `timeupdate` events keep firing every ~250ms and the
      // "Update playhead as video plays" effect below unconditionally
      // recomputes `playheadSec` from the video's OWN (unchanged)
      // position on every one of them. That overwrite lands within a
      // quarter second of the drop and snaps the marker straight back
      // to wherever the video already was — the drag LOOKS like it
      // was ignored, even though the local drag mechanics (and this
      // handler) ran correctly.
      //
      // Snapping to the nearest recording is both the fix and the
      // better behavior: it's what every mainstream NVR viewer does
      // when you scrub into a gap, and it sidesteps the clobbering
      // above entirely by actually loading/seeking a video (so its
      // own timeupdate ticks now agree with the new playheadSec
      // instead of fighting it).
      const camRecs = filterCamId
        ? recordings.filter((r) => r.camera_id === filterCamId)
        : recordings;
      let nearest: { rec: Recording; s: number; e: number } | null = null;
      let nearestDist = Infinity;
      for (const r of camRecs) {
        const s = new Date(r.start_timestamp).getTime();
        const dur = r.duration_seconds ?? 60;
        const e = r.end_timestamp
          ? new Date(r.end_timestamp).getTime()
          : s + dur * 1000;
        const dist = clickTs < s ? s - clickTs : clickTs > e ? clickTs - e : 0;
        if (dist < nearestDist) {
          nearestDist = dist;
          nearest = { rec: r, s, e };
        }
      }

      if (nearest) {
        const { rec, s, e } = nearest;
        const snapMs = clickTs < s ? s : clickTs > e ? e : clickTs;
        const snapSecFromMidnight = differenceInSeconds(
          new Date(snapMs),
          startOfDay(viewDate),
        );
        setPlayheadSec(clamp(snapSecFromMidnight, 0, SECS_IN_DAY));

        const isNewRec = rec.recording_id !== selectedRecId;
        if (isNewRec) skipPlayheadResetRef.current = true;
        setSelectedRecId(rec.recording_id);
        const offsetSecs = (snapMs - s) / 1000;
        const video = videoRef.current;
        if (video) {
          if (isNewRec) {
            setTimeout(
              () =>
                playWhenReady(video, () => {
                  video.currentTime = offsetSecs;
                }),
              0,
            );
          } else {
            video.currentTime = offsetSecs;
            video.play().catch(() => {});
          }
        }
        toast({
          title: "Jumped to nearest recording",
          description:
            "No footage exactly there — landed on the closest available clip.",
        });
      } else {
        // Genuinely nothing recorded anywhere on this camera for this
        // day — pause so the old video's timeupdate ticks stop
        // fighting the dropped marker position (see the long comment
        // above); otherwise it snaps straight back within a fraction
        // of a second and the drag looks broken.
        videoRef.current?.pause();
        toast({
          title: "No recording at this time",
          description: "Click on a green segment to play a recording",
          variant: "destructive",
        });
      }
    }
  };

  // ── Jump to the recording covering a specific event's timestamp ───────────
  // ── Clicking a camera in the tree loads its playback directly — no
  // separate "pick a clip" list; the timeline scrubber is how time gets
  // chosen. Prefers whatever recording covers the current playhead time,
  // falling back to that camera's earliest clip for the day. ─────────────
  const handleSelectCamera = (id: number | null) => {
    setFilterCamId(id);
    if (id === null || !recordings) {
      setSelectedRecId(null);
      return;
    }

    const dayStartMs = startOfDay(viewDate).getTime();
    const dayEndMs = dayStartMs + SECS_IN_DAY * 1000;
    const camRecsForDay = recordings
      .filter((r) => r.camera_id === id)
      .filter((r) => {
        const t = new Date(r.start_timestamp).getTime();
        return t >= dayStartMs && t < dayEndMs;
      })
      .sort(
        (a, b) =>
          new Date(a.start_timestamp).getTime() -
          new Date(b.start_timestamp).getTime(),
      );

    if (camRecsForDay.length === 0) {
      setSelectedRecId(null);
      toast({
        title: "No recordings for this camera",
        description: format(viewDate, "dd MMM yyyy"),
      });
      return;
    }

    const playheadTs = dayStartMs + playheadSec * 1000;
    const covering = camRecsForDay.find((r) => {
      const s = new Date(r.start_timestamp).getTime();
      const e = r.end_timestamp
        ? new Date(r.end_timestamp).getTime()
        : s + (r.duration_seconds ?? 60) * 1000;
      return playheadTs >= s && playheadTs <= e;
    });

    setSelectedRecId((covering ?? camRecsForDay[0]).recording_id);
  };

  const handleSelectEvent = (ev: EventRow) => {
    if (!recordings) return;
    const evTs = new Date(ev.occurred_at).getTime();

    const hit = recordings.find((r) => {
      const s = new Date(r.start_timestamp).getTime();
      const dur = r.duration_seconds ?? 60;
      const e = r.end_timestamp
        ? new Date(r.end_timestamp).getTime()
        : s + dur * 1000;
      return evTs >= s && evTs <= e;
    });

    if (hit) {
      setSelectedRecId(hit.recording_id);
      const recStart = new Date(hit.start_timestamp).getTime();
      const offsetSecs = (evTs - recStart) / 1000;
      const video = videoRef.current;
      if (video) {
        setTimeout(
          () =>
            playWhenReady(video, () => {
              video.currentTime = offsetSecs;
            }),
          0,
        );
      }
      toast({
        title: ev.title || ev.event_type,
        description: "Jumped to event in recording",
      });
    } else {
      const evDate = startOfDay(new Date(ev.occurred_at));
      setViewDate(evDate);
      const secFromMidnight = differenceInSeconds(
        new Date(ev.occurred_at),
        evDate,
      );
      setPlayheadSec(secFromMidnight);
      toast({
        title: "No recording covers this event",
        description: ev.title || ev.event_type,
        variant: "destructive",
      });
    }
  };

  // ── Jump ±N seconds ────────────────────────────────────────────────────────
  const skip = (s: number) => {
    if (!videoRef.current) return;
    const newTime = videoRef.current.currentTime + s;
    if (newTime < 0 && currentRec) {
      jumpRelativeRecording(-1);
    } else if (newTime > duration && currentRec) {
      jumpRelativeRecording(1);
    } else {
      videoRef.current.currentTime = clamp(newTime, 0, duration);
    }
  };

  // ── Jump to adjacent recording ─────────────────────────────────────────────
  // Deliberately walks the SAME day-scoped, camera-scoped list as the tree
  // (camSortedRecs, defined below) rather than the full history — otherwise
  // this button could silently jump to a wildly different day than the one
  // on screen, and the "N of M" counter would go out of sync with what
  // Prev/Next actually did. To see a different day's clips, use the
  // calendar — that's the one control that changes which day you're
  // looking at.
  const jumpRelativeRecording = (dir: -1 | 1) => {
    if (!selectedRecId) return;
    const camRecs = [...camSortedRecs].sort(
      (a, b) =>
        new Date(a.start_timestamp).getTime() -
        new Date(b.start_timestamp).getTime(),
    );
    const idx = camRecs.findIndex((r) => r.recording_id === selectedRecId);
    const next = camRecs[idx + dir];
    if (next) {
      setSelectedRecId(next.recording_id);
      const v = videoRef.current;
      if (v) {
        const onReady = () => {
          v.removeEventListener("loadeddata", onReady);
          if (dir === -1) v.currentTime = next.duration_seconds ?? 0;
          v.play().catch(() => {});
        };
        v.addEventListener("loadeddata", onReady);
      }
    }
  };

  // Play/pause: only update state via native video events (onPlay/onPause,
  // plus onWaiting/onPlaying to catch stalls). Do NOT call setPlaying here.
  const togglePlay = () => {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused || v.ended) {
      v.play().catch(() => {});
    } else {
      v.pause();
    }
  };

  // ── Timeline duration presets ──────────────────────────────────────────────
  const windowSecs = zoomHours * 3600;
  const setDurationPreset = (hours: number) => {
    setZoomHours(hours);
    const win = hours * 3600;
    setOffsetSec((prev) => clamp(playheadSec - win / 2, 0, SECS_IN_DAY - win));
  };
  const panTimeline = (newOffsetSec: number) => {
    setOffsetSec(clamp(newOffsetSec, 0, Math.max(0, SECS_IN_DAY - windowSecs)));
  };

  // Recordings for the currently selected camera AND the day shown on the
  // calendar/timeline above — this is what the tree, the "N of M" counter,
  // and Prev/Next recording navigation all use.
  const camSortedRecs = useMemo(() => {
    if (!recordings) return [];
    const dayStart = startOfDay(viewDate).getTime();
    const dayEnd = dayStart + 24 * 3600 * 1000;
    return [...recordings]
      .filter((r) => !filterCamId || r.camera_id === filterCamId)
      .filter((r) => {
        const t = new Date(r.start_timestamp).getTime();
        return t >= dayStart && t < dayEnd;
      })
      .sort(
        (a, b) =>
          new Date(b.start_timestamp).getTime() -
          new Date(a.start_timestamp).getTime(),
      );
  }, [recordings, filterCamId, viewDate]);

  const selectedIdx = camSortedRecs.findIndex(
    (r) => r.recording_id === selectedRecId,
  );
  const hasPrev = selectedIdx > 0;
  const hasNext = selectedIdx < camSortedRecs.length - 1;

  return (
    <AppLayout>
      <div className="flex flex-col gap-3 h-full">
        {/* Header */}
        <div className="shrink-0">
          <h1 className="text-2xl font-bold text-foreground">Playback</h1>
          <p className="text-sm text-muted-foreground">
            Timeline scrubber · Recording &amp; event playback
          </p>
        </div>

        <div className="flex-1 min-h-0 flex flex-col lg:flex-row gap-3">
          {/* ── Left sidebar: tree (top) + calendar (bottom) ─────────────── */}
          <div className="lg:w-72 shrink-0 flex flex-col gap-2 min-h-0 max-h-[40vh] lg:max-h-none">
            <PlaybackTree
              cameras={cameras}
              recordings={recordings ?? []}
              events={allEvents}
              viewDate={viewDate}
              filterCamId={filterCamId}
              onSelectCamera={handleSelectCamera}
              onSelectEvent={handleSelectEvent}
            />
            <div className="shrink-0">
              <CalendarPanel selected={viewDate} onSelect={setViewDate} />
            </div>
          </div>

          {/* ── Main: video + controls + ruler timeline — sized to always
              fit the viewport with no scrolling; the video simply grows
              or shrinks with whatever vertical space is left over. ──── */}
          <div className="flex-1 min-w-0 flex flex-col gap-2 min-h-0">
            {/* Video — flex-1 fills whatever height remains after the
                controls/timeline/info below claim their (fixed) space,
                instead of forcing a 16:9 box that can overflow the page. */}
            <div className="relative bg-black rounded-xl overflow-hidden flex-1 min-h-0">
              <video
                ref={videoRef}
                className="absolute inset-0 w-full h-full object-contain z-0"
                onPlay={() => setPlaying(true)}
                onPause={() => setPlaying(false)}
                onPlaying={() => setPlaying(true)}
                onWaiting={() => setPlaying(false)}
                onEnded={() => {
                  setPlaying(false);
                  if (hasNext) jumpRelativeRecording(1);
                }}
                onTimeUpdate={(e) =>
                  setCurTime((e.target as HTMLVideoElement).currentTime)
                }
                onLoadedMetadata={(e) => {
                  setDuration((e.target as HTMLVideoElement).duration);
                  (e.target as HTMLVideoElement).playbackRate = speed;
                }}
                muted={muted}
                playsInline
              />
              {!selectedRecId && (
                <div className="absolute inset-0 z-10 flex flex-col items-center justify-center text-muted-foreground pointer-events-none">
                  <Camera className="h-14 w-14 mb-3 opacity-20" />
                  <p className="text-sm text-foreground">
                    Select a clip from the tree, or click the timeline below
                  </p>
                </div>
              )}
              {speed !== 1 && playing && (
                <div className="absolute top-3 right-3 z-10 bg-black/70 text-white text-xs font-mono font-semibold px-2 py-1 rounded">
                  {speed}×
                </div>
              )}
            </div>

            {/* Playback controls */}
            <div className="flex items-center gap-2 flex-wrap shrink-0">
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8"
                disabled={!hasPrev}
                onClick={() => jumpRelativeRecording(-1)}
                title="Previous recording"
              >
                <ChevronLeft className="h-4 w-4" />
              </Button>
              <Button
                variant="ghost"
                className="h-10 w-11 flex flex-col items-center justify-center gap-0.5 px-1 py-1"
                onClick={() => skip(-30)}
                title="Back 30s"
              >
                <RotateCcw className="h-4 w-4" />
                <span className="text-[9px] font-semibold leading-none">
                  30
                </span>
              </Button>
              <Button size="icon" className="h-9 w-9" onClick={togglePlay}>
                {playing ? (
                  <Pause className="h-5 w-5" />
                ) : (
                  <Play className="h-5 w-5" />
                )}
              </Button>
              <Button
                variant="ghost"
                className="h-10 w-11 flex flex-col items-center justify-center gap-0.5 px-1 py-1"
                onClick={() => skip(30)}
                title="Forward 30s"
              >
                <RotateCw className="h-4 w-4" />
                <span className="text-[9px] font-semibold leading-none">
                  30
                </span>
              </Button>
              <Button
                size="icon"
                variant="outline"
                className="h-8 w-8"
                disabled={!hasNext}
                onClick={() => jumpRelativeRecording(1)}
                title="Next recording"
              >
                <ChevronRight className="h-4 w-4" />
              </Button>

              {/* Volume — YouTube-style icon + level slider, instead of a
                  plain mute toggle. Icon click still mutes/unmutes; the
                  slider sets an actual level and un-mutes automatically
                  when dragged above 0. */}
              <div className="flex items-center gap-1.5 ml-1">
                <Button
                  size="icon"
                  variant="ghost"
                  className="h-8 w-8 shrink-0"
                  onClick={() => setMuted((m) => !m)}
                  title={muted ? "Unmute" : "Mute"}
                >
                  {muted || volume === 0 ? (
                    <VolumeX className="h-4 w-4" />
                  ) : volume < 50 ? (
                    <Volume1 className="h-4 w-4" />
                  ) : (
                    <Volume2 className="h-4 w-4" />
                  )}
                </Button>
                <Slider
                  value={[muted ? 0 : volume]}
                  onValueChange={([v]) => {
                    setVolume(v);
                    setMuted(v === 0);
                  }}
                  max={100}
                  step={1}
                  className="w-20"
                />
              </div>

              {/* Speed control — YouTube-style: a single button that opens
                  a vertical list of options with a checkmark on the active
                  one, rather than a row of always-visible buttons. Popover
                  is controlled so picking an option closes it immediately,
                  instead of needing a click elsewhere to dismiss it. */}
              <Popover open={speedMenuOpen} onOpenChange={setSpeedMenuOpen}>
                <PopoverTrigger asChild>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-8 gap-1.5 text-xs font-mono ml-1"
                    title="Playback speed"
                  >
                    <Gauge className="h-3.5 w-3.5" />
                    {speedLabel(speed)}
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="start" className="w-32 p-1">
                  {SPEED_OPTIONS.map((s) => (
                    <button
                      key={s}
                      onClick={() => {
                        setSpeed(s);
                        if (videoRef.current) videoRef.current.playbackRate = s;
                        setSpeedMenuOpen(false);
                      }}
                      className={`w-full flex items-center gap-2 px-2 py-1.5 rounded text-xs text-left transition-colors ${
                        speed === s
                          ? "bg-muted text-foreground font-medium"
                          : "text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                      }`}
                    >
                      <Check
                        className={`h-3.5 w-3.5 shrink-0 ${speed === s ? "opacity-100" : "opacity-0"}`}
                      />
                      {speedLabel(s)}
                    </button>
                  ))}
                </PopoverContent>
              </Popover>

              {duration > 0 && (
                <span className="text-[11px] font-mono text-muted-foreground ml-1">
                  {secsToHMS(curTime)} / {secsToHMS(duration)}
                </span>
              )}

              {selectedRecId && (
                <Button size="sm" variant="ghost" className="h-8 gap-1" asChild>
                  <a href={getDownloadUrl(selectedRecId)} download>
                    <Download className="h-3.5 w-3.5" />
                    Download
                  </a>
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                className="h-8 gap-1.5 ml-auto"
                onClick={openExportDialog}
              >
                <Scissors className="h-3.5 w-3.5" />
                Export Range
              </Button>
            </div>

            <Dialog
              open={exportOpen}
              onOpenChange={(open) => !exporting && setExportOpen(open)}
            >
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Export Time Range</DialogTitle>
                  <DialogDescription>
                    Pick a camera and a start/end time — the matching footage is
                    merged into a single downloadable video, however many
                    recording segments it spans.
                  </DialogDescription>
                </DialogHeader>
                <div className="space-y-3 py-1">
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      Camera
                    </Label>
                    <Select
                      value={exportCameraId}
                      onValueChange={setExportCameraId}
                    >
                      <SelectTrigger className="h-9 mt-1 text-sm">
                        <SelectValue placeholder="Select a camera" />
                      </SelectTrigger>
                      <SelectContent>
                        {cameras?.map((c) => (
                          <SelectItem
                            key={c.camera_id}
                            value={String(c.camera_id)}
                          >
                            {c.camera_name}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        From
                      </Label>
                      <Input
                        type="datetime-local"
                        className="h-9 mt-1 text-sm"
                        value={exportStart}
                        max={exportEnd || undefined}
                        onChange={(e) => setExportStart(e.target.value)}
                      />
                    </div>
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        To
                      </Label>
                      <Input
                        type="datetime-local"
                        className="h-9 mt-1 text-sm"
                        value={exportEnd}
                        min={exportStart || undefined}
                        onChange={(e) => setExportEnd(e.target.value)}
                      />
                    </div>
                  </div>
                </div>
                <DialogFooter>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={exporting}
                    onClick={() => setExportOpen(false)}
                  >
                    Cancel
                  </Button>
                  <Button
                    size="sm"
                    className="gap-1.5"
                    disabled={
                      exporting || !exportCameraId || !exportStart || !exportEnd
                    }
                    onClick={runExport}
                  >
                    {exporting ? (
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                    ) : (
                      <Download className="h-3.5 w-3.5" />
                    )}
                    {exporting ? "Building clip…" : "Export & Download"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>

            {/* ── Ruler timeline (replaces the drag scrubber) ──────────────── */}
            <Card className="bg-card border-border shrink-0">
              <CardHeader className="pb-2 border-b border-border/60">
                <div className="flex items-center justify-between gap-2 flex-wrap">
                  {/* Date navigation */}
                  <div className="flex items-center gap-1.5">
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => setViewDate((d) => subDays(d, 1))}
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <span className="flex items-center gap-1.5 text-sm font-medium text-foreground px-1.5">
                      <CalendarIcon className="h-3.5 w-3.5 text-muted-foreground" />
                      {format(viewDate, "dd MMM yyyy")}
                    </span>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="h-7 w-7"
                      onClick={() => setViewDate((d) => addDays(d, 1))}
                      disabled={startOfDay(viewDate) >= startOfDay(new Date())}
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      className="h-7 text-xs"
                      onClick={() => setViewDate(startOfDay(new Date()))}
                    >
                      Today
                    </Button>
                  </div>

                  {/* Time window: a clearly-labeled dropdown instead of
                      terse "1h/2h/24h" pills, plus explicit Prev/Next
                      window buttons — each click moves by exactly one full
                      window, which is predictable in a way dragging the
                      ruler wasn't. */}
                  <div className="flex items-center gap-1.5">
                    <Select
                      value={String(zoomHours)}
                      onValueChange={(v) => setDurationPreset(Number(v))}
                    >
                      <SelectTrigger className="h-7 w-[9.5rem] text-xs">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {DURATION_PRESETS.map(({ label, hours }) => (
                          <SelectItem
                            key={label}
                            value={String(hours)}
                            className="text-xs"
                          >
                            {label}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-7 w-7"
                      onClick={() => panTimeline(offsetSec - windowSecs)}
                      disabled={offsetSec <= 0}
                      title="Previous window"
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="outline"
                      className="h-7 w-7"
                      onClick={() => panTimeline(offsetSec + windowSecs)}
                      disabled={offsetSec + windowSecs >= SECS_IN_DAY}
                      title="Next window"
                    >
                      <ChevronRight className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </CardHeader>
              <CardContent className="p-3">
                <RulerTimeline
                  recordings={recordings ?? []}
                  events={allEvents}
                  selectedId={selectedRecId}
                  currentSec={playheadSec}
                  viewDate={viewDate}
                  zoomHours={zoomHours}
                  offsetSec={offsetSec}
                  onSeek={handleTimelineSeek}
                  onSelectEvent={handleSelectEvent}
                />
              </CardContent>
            </Card>

            {/* Current recording info — a single compact strip rather than
                a multi-row grid, to keep its footprint small and predictable
                so it never pushes the timeline/video off screen. */}
            {currentRec && (
              <Card className="bg-card border-border shrink-0">
                <CardContent className="px-3 py-2 flex items-center gap-x-4 gap-y-1 flex-wrap text-[11px]">
                  <span className="font-medium text-foreground">
                    {currentRec.camera_name}
                  </span>
                  <span className="text-muted-foreground font-mono">
                    {currentRec.ip_address || "—"}
                  </span>
                  <span className="text-muted-foreground font-mono">
                    {format(
                      new Date(currentRec.start_timestamp),
                      "dd MMM HH:mm:ss",
                    )}
                  </span>
                  <span className="text-muted-foreground">
                    {currentRec.duration_seconds
                      ? `${Math.floor(currentRec.duration_seconds / 60)}m ${currentRec.duration_seconds % 60}s`
                      : "—"}
                  </span>
                  <span className="text-muted-foreground">
                    {currentRec.video_codec} · {currentRec.resolution_width}×
                    {currentRec.resolution_height}
                  </span>
                  {currentRec.location_description && (
                    <span className="text-muted-foreground truncate max-w-[10rem]">
                      {currentRec.location_description}
                    </span>
                  )}
                  {currentRec.gps_speed_kmh && (
                    <span className="text-muted-foreground">
                      🚂 {currentRec.gps_speed_kmh} km/h
                    </span>
                  )}
                  <span className="text-muted-foreground font-mono ml-auto">
                    {selectedIdx + 1} of {camSortedRecs.length}
                  </span>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </AppLayout>
  );
};

export default VideoPlayer;
