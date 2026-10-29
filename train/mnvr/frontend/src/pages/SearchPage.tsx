import { useEffect, useMemo, useState } from "react";
import {
  Search, Download, Play, X, Clock, Camera as CameraIcon,
  Video, Calendar as CalendarIcon, Film, HardDrive,
  ChevronLeft, ChevronRight, Loader2, Scissors, Sparkles,
} from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Label } from "@/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Calendar as DatePickerCalendar } from "@/components/ui/calendar";
import {
  Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter,
} from "@/components/ui/dialog";
import type { DateRange } from "react-day-picker";
import { useRecordings } from "@/hooks/use-recordings";
import { useCameras } from "@/hooks/use-cameras";
import {
  getDownloadUrl, exportRecordingRange,
  smartSearch, getSmartSearchThumbnailUrl,
  type SmartSearchResult, type SmartSearchResponse,
} from "@/lib/api";
import { toApiDateTime, paginationRange } from "@/lib/utils";
import { format, startOfDay, endOfDay, subDays, subHours } from "date-fns";
import { useNavigate } from "react-router-dom";
import { useToast } from "@/hooks/use-toast";

// Quick date-range presets, in the style of commercial NVR search UIs
// (Hikvision/Dahua/Milestone-style "Today / Yesterday / Last 7 days" chips)
const RANGE_PRESETS = [
  { key: "today", label: "Today" },
  { key: "yesterday", label: "Yesterday" },
  { key: "24h", label: "Last 24h" },
  { key: "7d", label: "Last 7 days" },
  { key: "30d", label: "Last 30 days" },
] as const;
type PresetKey = typeof RANGE_PRESETS[number]["key"];
type RangeKey = PresetKey | "custom";

const PAGE_SIZE_OPTIONS = [10, 25, 50, 100] as const;

// Deliberately NOT `.toISOString()` — see toApiDateTime() for why: this
// app's recording pipeline stores timestamps as local wall-clock time in a
// timezone-naive column, and converting to UTC here compared the wrong
// window against that data (root cause of "Today" showing 0 recordings
// that clearly existed).
function presetToDates(key: PresetKey): { start: string; end: string } {
  const now = new Date();
  switch (key) {
    case "today":
      return { start: toApiDateTime(startOfDay(now)), end: toApiDateTime(now) };
    case "yesterday": {
      const y = subDays(startOfDay(now), 1);
      return { start: toApiDateTime(y), end: toApiDateTime(startOfDay(now)) };
    }
    case "24h":
      return { start: toApiDateTime(subHours(now, 24)), end: toApiDateTime(now) };
    case "7d":
      return { start: toApiDateTime(subDays(now, 7)), end: toApiDateTime(now) };
    case "30d":
      return { start: toApiDateTime(subDays(now, 30)), end: toApiDateTime(now) };
  }
}

const SMART_SEARCH_EXAMPLES = [
  "person in a red shirt between 2 and 4pm",
  "someone wearing a blue jacket this morning",
  "person in a white uniform yesterday afternoon",
  "camera 2 person in black jacket evening",
];

// The AI/CLIP-powered natural-language panel, shown in place of the
// filter chips + results grid when the "Smart Search (AI)" toggle is
// active. Kept self-contained so its loading/result state never touches
// the filter-based search state above it.
function SmartSearchPanel() {
  const { toast } = useToast();
  const [prompt, setPrompt] = useState("");
  const [loading, setLoading] = useState(false);
  const [response, setResponse] = useState<SmartSearchResponse | null>(null);
  const [downloadingId, setDownloadingId] = useState<number | null>(null);

  const runSearch = async (q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setLoading(true);
    setResponse(null);
    try {
      const data = await smartSearch(trimmed);
      setResponse(data);
      if (data.results.length === 0) {
        toast({ title: "No matches", description: "Try a different description, or widen the time window." });
      }
    } catch (err) {
      toast({
        title: "Search failed",
        description: err instanceof Error ? err.message : "Could not run smart search.",
        variant: "destructive",
      });
    } finally {
      setLoading(false);
    }
  };

  const downloadClip = async (r: SmartSearchResult) => {
    setDownloadingId(r.detection_id);
    try {
      const blob = await exportRecordingRange(r.camera_id, r.clip_start, r.clip_end);
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `cam_${r.camera_id}_${r.occurred_at}.mp4`.replace(/[:\s]/g, "-");
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err) {
      toast({
        title: "Clip export failed",
        description: err instanceof Error ? err.message : "Could not build that clip.",
        variant: "destructive",
      });
    } finally {
      setDownloadingId(null);
    }
  };

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Describe who or what you're looking for, in plain English — matching clips are found
        from footage indexed in near real-time.
      </p>

      <div className="flex gap-2">
        <Input
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") runSearch(prompt); }}
          placeholder='e.g. "person in a red t-shirt between 2 and 4pm"'
          className="flex-1"
        />
        <Button onClick={() => runSearch(prompt)} disabled={loading || !prompt.trim()}>
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}
          <span className="ml-2">Search</span>
        </Button>
      </div>

      {!response && !loading && (
        <div className="flex flex-wrap gap-2">
          {SMART_SEARCH_EXAMPLES.map((ex) => (
            <Badge
              key={ex}
              variant="outline"
              className="cursor-pointer hover:bg-accent"
              onClick={() => { setPrompt(ex); runSearch(ex); }}
            >
              {ex}
            </Badge>
          ))}
        </div>
      )}

      {response && (
        <div className="text-sm text-muted-foreground">
          Interpreted as: <span className="font-medium">{response.interpreted.description_used}</span>
          {response.interpreted.time_phrase && (
            <> · time: <span className="font-medium">{response.interpreted.time_phrase}</span></>
          )}
          {response.interpreted.camera_id && <> · camera {response.interpreted.camera_id}</>}
          {" · "}scanned {response.candidates_scanned} indexed detections
        </div>
      )}

      {response && response.results.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
          {response.results.map((r) => (
            <Card key={r.detection_id} className="overflow-hidden">
              <div className="aspect-video bg-muted relative">
                <img
                  src={getSmartSearchThumbnailUrl(r.thumbnail_url)}
                  alt="Matched detection"
                  className="w-full h-full object-cover"
                />
                <Badge className="absolute top-2 right-2 bg-black/70 text-white border-0">
                  {Math.round(r.similarity * 100)}% match
                </Badge>
              </div>
              <CardContent className="p-3 space-y-2">
                <div className="flex items-center gap-1.5 text-sm">
                  <CameraIcon className="h-3.5 w-3.5 text-muted-foreground" />
                  <span className="font-medium">{r.camera_name || `Camera ${r.camera_id}`}</span>
                </div>
                <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
                  <Clock className="h-3.5 w-3.5" />
                  {format(new Date(r.occurred_at), "PPp")}
                </div>
                {r.caption && <div className="text-xs text-muted-foreground italic">"{r.caption}"</div>}
                <Button
                  size="sm" variant="outline" className="w-full"
                  disabled={downloadingId === r.detection_id}
                  onClick={() => downloadClip(r)}
                >
                  {downloadingId === r.detection_id
                    ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" />
                    : <Download className="h-3.5 w-3.5 mr-1.5" />}
                  Download clip
                </Button>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {response && response.results.length === 0 && (
        <Card>
          <CardContent className="p-8 text-center text-muted-foreground">
            No matching footage found for that description in the given time window.
          </CardContent>
        </Card>
      )}
    </div>
  );
}

const SearchPage = () => {
  const navigate = useNavigate();

  const [rangeKey, setRangeKey] = useState<RangeKey>("today");

  // Custom range: `customRange` is the *applied* range (what's actually
  // queried); `draftRange` is what's being picked inside the popover
  // before the user clicks Apply. Nothing re-queries until Apply is
  // clicked — picking a range is a two-click gesture (start day, end
  // day), and querying after the first click alone would show a
  // meaningless one-sided result flash mid-selection, which is what made
  // "Custom" feel broken.
  const [customRange, setCustomRange] = useState<DateRange | undefined>();
  const [draftRange, setDraftRange] = useState<DateRange | undefined>();
  const [customPopoverOpen, setCustomPopoverOpen] = useState(false);
  const [mode, setMode] = useState<"filters" | "smart">("filters");

  const [cameraId, setCameraId] = useState<string>("all");
  const [status, setStatus] = useState<string>("all");

  // Free-text search: `queryInput` tracks every keystroke for a responsive
  // field, but only `appliedQuery` (committed via Enter or the search
  // button) is actually sent to the server. Camera/status/date-range
  // filters below stay live/instant, as they were before — only the
  // free-text box needs a deliberate "commit" step.
  const [queryInput, setQueryInput] = useState("");
  const [appliedQuery, setAppliedQuery] = useState("");

  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<number>(25);

  const { data: cameras } = useCameras();
  const { toast } = useToast();

  // Time-range export: pulls the segments covering [start,end] for one
  // camera into a single MP4 (see /api/streaming/recordings/export) rather
  // than making the user download each segment file separately. Kept as
  // its own small dialog with datetime-local inputs — the filter bar's date
  // range above is day-granular ("Today", "Last 7 days"), but an export
  // needs an actual clock time on both ends.
  const [exportOpen, setExportOpen] = useState(false);
  const [exportCameraId, setExportCameraId] = useState<string>("");
  const [exportStart, setExportStart] = useState("");
  const [exportEnd, setExportEnd] = useState("");
  const [exporting, setExporting] = useState(false);

  const openExportDialog = () => {
    // Pre-fill from whatever's already selected in the filter bar, when
    // available, so the common case (searching a camera/range, then
    // exporting it) doesn't require re-entering the same values.
    setExportCameraId(cameraId !== "all" ? cameraId : (cameras?.[0] ? String(cameras[0].camera_id) : ""));
    const now = new Date();
    const toLocalInput = (d: Date) => format(d, "yyyy-MM-dd'T'HH:mm");
    setExportStart(toLocalInput(subHours(now, 1)));
    setExportEnd(toLocalInput(now));
    setExportOpen(true);
  };

  const runExport = async () => {
    if (!exportCameraId || !exportStart || !exportEnd) return;
    if (new Date(exportStart) >= new Date(exportEnd)) {
      toast({ title: "Invalid range", description: "Start time must be before end time.", variant: "destructive" });
      return;
    }
    setExporting(true);
    try {
      // datetime-local gives "YYYY-MM-DDTHH:mm" — append seconds so it
      // matches toApiDateTime()'s "yyyy-MM-dd'T'HH:mm:ss.SSS" format the
      // rest of the app already uses for this timezone-naive column.
      const blob = await exportRecordingRange(
        parseInt(exportCameraId, 10),
        `${exportStart}:00.000`,
        `${exportEnd}:00.000`,
      );
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `camera_${exportCameraId}_${exportStart}_to_${exportEnd}.mp4`.replace(/[:]/g, "-");
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setExportOpen(false);
      toast({ title: "Export ready", description: "Your clip has downloaded." });
    } catch (err) {
      toast({
        title: "Export failed",
        description: err instanceof Error ? err.message : "Could not build that clip.",
        variant: "destructive",
      });
    } finally {
      setExporting(false);
    }
  };

  const { start: startDate, end: endDate } = useMemo(() => {
    if (rangeKey === "custom") {
      if (!customRange?.from) return { start: undefined, end: undefined };
      return {
        start: toApiDateTime(startOfDay(customRange.from)),
        end: toApiDateTime(endOfDay(customRange.to ?? customRange.from)),
      };
    }
    return presetToDates(rangeKey);
  }, [rangeKey, customRange]);

  // Any filter change invalidates the current page — jumping straight
  // back to page 1 avoids landing on an empty "page 4 of 1" after
  // narrowing the result set.
  useEffect(() => {
    setPage(1);
  }, [cameraId, status, rangeKey, customRange, appliedQuery, pageSize]);

  const { data, isLoading, isFetching, isError } = useRecordings({
    camera_id: cameraId !== "all" ? parseInt(cameraId) : undefined,
    start_date: startDate,
    end_date: endDate,
    status: status !== "all" ? status : undefined,
    q: appliedQuery || undefined,
    limit: pageSize,
    offset: (page - 1) * pageSize,
  });

  const recordings = data?.recordings ?? [];
  const total = data?.total ?? 0;
  const { totalPages, rangeFrom, rangeTo } = paginationRange(page, pageSize, total);

  const formatSize = (b: number | null) => {
    if (!b) return "—";
    if (b > 1e9) return `${(b / 1e9).toFixed(1)} GB`;
    return `${(b / 1e6).toFixed(0)} MB`;
  };

  const hasFilters =
    cameraId !== "all" || status !== "all" || appliedQuery || rangeKey !== "today";
  const searchPending = queryInput.trim() !== appliedQuery;

  const submitSearch = () => setAppliedQuery(queryInput.trim());

  const resetAll = () => {
    setRangeKey("today");
    setCustomRange(undefined);
    setDraftRange(undefined);
    setCameraId("all");
    setStatus("all");
    setQueryInput("");
    setAppliedQuery("");
    setPage(1);
  };

  const customLabel = customRange?.from
    ? customRange.to && customRange.to.getTime() !== customRange.from.getTime()
      ? `${format(customRange.from, "dd MMM")} – ${format(customRange.to, "dd MMM yyyy")}`
      : format(customRange.from, "dd MMM yyyy")
    : "Custom";

  const Pager = ({ compact = false }: { compact?: boolean }) => (
    <div className="flex items-center gap-2">
      {!compact && (
        <Select value={String(pageSize)} onValueChange={(v) => setPageSize(Number(v))}>
          <SelectTrigger className="h-7 w-[104px] text-xs"><SelectValue /></SelectTrigger>
          <SelectContent>
            {PAGE_SIZE_OPTIONS.map((n) => (
              <SelectItem key={n} value={String(n)}>{n} / page</SelectItem>
            ))}
          </SelectContent>
        </Select>
      )}
      <Button
        size="sm" variant="outline" className="h-7 w-7 p-0"
        disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}
      >
        <ChevronLeft className="h-3.5 w-3.5" />
      </Button>
      <span className="text-xs text-muted-foreground min-w-[64px] text-center shrink-0">
        Page {page} of {totalPages}
      </span>
      <Button
        size="sm" variant="outline" className="h-7 w-7 p-0"
        disabled={page >= totalPages} onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
      >
        <ChevronRight className="h-3.5 w-3.5" />
      </Button>
    </div>
  );

  return (
    <AppLayout>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Recording Search</h1>
            <p className="text-sm text-muted-foreground">
              Find and play back stored footage by camera, time range, and status
            </p>
          </div>
          <Button size="sm" variant="outline" className="gap-1.5" onClick={openExportDialog}>
            <Scissors className="h-3.5 w-3.5" />
            Export Range
          </Button>
        </div>

        {/* Search mode toggle: plain filters vs AI-powered natural-language search */}
        <div className="inline-flex rounded-lg border border-border bg-card p-0.5">
          <button
            onClick={() => setMode("filters")}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors ${
              mode === "filters" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            Filters
          </button>
          <button
            onClick={() => setMode("smart")}
            className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors flex items-center gap-1.5 ${
              mode === "smart" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            <Sparkles className="h-3.5 w-3.5" />
            Smart Search (AI)
          </button>
        </div>

        {mode === "smart" && <SmartSearchPanel />}

        {mode === "filters" && (
        <>
        {/* Quick date-range chips */}
        <div className="flex flex-wrap gap-1.5">
          {RANGE_PRESETS.map((r) => (
            <button
              key={r.key}
              onClick={() => setRangeKey(r.key)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                rangeKey === r.key
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-muted-foreground border-border hover:text-foreground hover:border-foreground/30"
              }`}
            >
              {r.label}
            </button>
          ))}

          {/* Custom range — a single calendar in range-select mode (click
              start day, click end day), like commercial NVR search UIs,
              instead of two separate raw date/time fields. Nothing is
              queried until Apply is clicked. */}
          <Popover
            open={customPopoverOpen}
            onOpenChange={(open) => {
              setCustomPopoverOpen(open);
              if (open) setDraftRange(customRange);
            }}
          >
            <PopoverTrigger asChild>
              <button
                className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors flex items-center gap-1.5 ${
                  rangeKey === "custom"
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-card text-muted-foreground border-border hover:text-foreground hover:border-foreground/30"
                }`}
              >
                <CalendarIcon className="h-3 w-3" />
                {customLabel}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-auto p-0" align="start">
              <DatePickerCalendar
                mode="range"
                numberOfMonths={2}
                selected={draftRange}
                onSelect={setDraftRange}
                disabled={(d) => d > new Date()}
                initialFocus
              />
              <div className="flex items-center justify-between gap-2 p-3 border-t border-border">
                <span className="text-xs text-muted-foreground">
                  {draftRange?.from ? format(draftRange.from, "dd MMM yyyy") : "Start date"}
                  {" – "}
                  {draftRange?.to
                    ? format(draftRange.to, "dd MMM yyyy")
                    : draftRange?.from
                      ? format(draftRange.from, "dd MMM yyyy")
                      : "End date"}
                </span>
                <Button
                  size="sm" className="h-7 text-xs"
                  disabled={!draftRange?.from}
                  onClick={() => {
                    setCustomRange(draftRange);
                    setRangeKey("custom");
                    setCustomPopoverOpen(false);
                  }}
                >
                  Apply
                </Button>
              </div>
            </PopoverContent>
          </Popover>
        </div>

        {/* Filter bar */}
        <Card className="bg-card border-border">
          <CardContent className="p-3">
            <div className="flex flex-wrap items-end gap-3">
              <div className="min-w-[160px]">
                <Label className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <CameraIcon className="h-3 w-3" /> Camera
                </Label>
                <Select value={cameraId} onValueChange={setCameraId}>
                  <SelectTrigger className="h-8 mt-1 text-xs"><SelectValue placeholder="All cameras" /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All cameras</SelectItem>
                    {cameras?.map((c) => (
                      <SelectItem key={c.camera_id} value={String(c.camera_id)}>{c.camera_name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="min-w-[140px]">
                <Label className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Film className="h-3 w-3" /> Status
                </Label>
                <Select value={status} onValueChange={setStatus}>
                  <SelectTrigger className="h-8 mt-1 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">All</SelectItem>
                    <SelectItem value="COMPLETED">Completed</SelectItem>
                    <SelectItem value="RECORDING">Recording</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="flex-1 min-w-[200px]">
                <Label className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Search className="h-3 w-3" /> Camera / location
                </Label>
                <div className="relative mt-1">
                  <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
                  <Input
                    placeholder="Search, then press Enter…"
                    className="h-8 pl-8 pr-16 text-xs"
                    value={queryInput}
                    onChange={(e) => setQueryInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        submitSearch();
                      }
                    }}
                  />
                  {queryInput && (
                    <button
                      type="button"
                      className="absolute right-8 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                      onClick={() => { setQueryInput(""); setAppliedQuery(""); }}
                      title="Clear"
                    >
                      <X className="h-3.5 w-3.5" />
                    </button>
                  )}
                  <Button
                    size="sm"
                    variant={searchPending ? "default" : "ghost"}
                    className="absolute right-0.5 top-1/2 -translate-y-1/2 h-7 w-7 p-0"
                    onClick={submitSearch}
                    title="Search"
                  >
                    <Search className="h-3.5 w-3.5" />
                  </Button>
                </div>
                {searchPending && (
                  <p className="text-[10px] text-muted-foreground mt-1">Press Enter to search</p>
                )}
              </div>

              {hasFilters && (
                <Button size="sm" variant="ghost" className="h-8 text-xs gap-1" onClick={resetAll}>
                  <X className="h-3 w-3" /> Reset
                </Button>
              )}
            </div>
          </CardContent>
        </Card>

        {/* Results header / pagination */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            {isLoading ? (
              "Searching…"
            ) : isError ? (
              "Search failed"
            ) : total === 0 ? (
              "0 recordings found"
            ) : (
              <>
                Showing {rangeFrom}–{rangeTo} of {total} recording(s)
                {isFetching && <Loader2 className="h-3 w-3 animate-spin" />}
              </>
            )}
          </p>
          {!isLoading && !isError && total > pageSize && <Pager />}
        </div>

        <div className="space-y-2">
          {isError && (
            <div className="text-center py-16 text-destructive">
              <p className="text-sm">Couldn't load recordings. Check your connection and try again.</p>
            </div>
          )}

          {!isError && recordings.map((rec) => (
            <Card key={rec.recording_id} className="bg-card border-border hover:border-primary/30 transition-colors">
              <CardContent className="p-3 flex items-center gap-3">
                <div className="w-16 h-11 rounded-md bg-muted/40 border border-border flex items-center justify-center shrink-0">
                  <Video className="h-5 w-5 text-muted-foreground/50" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-0.5 flex-wrap">
                    <span className="font-medium text-sm text-foreground truncate">
                      {rec.camera_name || `Camera ${rec.camera_id}`}
                    </span>
                    <Badge variant="outline" className="text-[10px] shrink-0">{rec.status}</Badge>
                    {rec.video_codec && (
                      <Badge variant="secondary" className="text-[10px] shrink-0">{rec.video_codec}</Badge>
                    )}
                  </div>
                  <div className="flex gap-3 text-xs text-muted-foreground flex-wrap">
                    <span className="flex items-center gap-1">
                      <Clock className="h-3 w-3" />
                      {format(new Date(rec.start_timestamp), "dd MMM yyyy, HH:mm:ss")}
                    </span>
                    {rec.duration_seconds != null && (
                      <span>{Math.floor(rec.duration_seconds / 60)}m {rec.duration_seconds % 60}s</span>
                    )}
                    <span className="flex items-center gap-1">
                      <HardDrive className="h-3 w-3" />
                      {formatSize(rec.file_size_bytes)}
                    </span>
                    {rec.resolution_width && rec.resolution_height && (
                      <span>{rec.resolution_width}×{rec.resolution_height}</span>
                    )}
                    {rec.gps_speed_kmh != null && <span>{rec.gps_speed_kmh} km/h</span>}
                  </div>
                  {rec.location_description && (
                    <p className="text-[10px] text-muted-foreground mt-0.5 truncate">{rec.location_description}</p>
                  )}
                </div>
                <div className="flex gap-1 shrink-0">
                  <Button
                    size="sm" variant="ghost" className="h-8 w-8 p-0"
                    onClick={() => navigate(`/player?recording=${rec.recording_id}`)}
                    title="Play"
                  >
                    <Play className="h-3.5 w-3.5" />
                  </Button>
                  <Button size="sm" variant="ghost" className="h-8 w-8 p-0" asChild title="Download">
                    <a href={getDownloadUrl(rec.recording_id)} download><Download className="h-3.5 w-3.5" /></a>
                  </Button>
                </div>
              </CardContent>
            </Card>
          ))}

          {!isLoading && !isError && !recordings.length && (
            <div className="text-center py-16 text-muted-foreground">
              <Search className="h-10 w-10 mx-auto mb-2 opacity-30" />
              <p className="text-sm">No recordings match your filters</p>
            </div>
          )}

          {!isLoading && !isError && total > pageSize && (
            <div className="flex justify-center pt-2">
              <Pager compact />
            </div>
          )}
        </div>
        </>
        )}
      </div>

      <Dialog open={exportOpen} onOpenChange={(open) => !exporting && setExportOpen(open)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Export Time Range</DialogTitle>
            <DialogDescription>
              Pick a camera and a start/end time — the matching footage is merged into a single
              downloadable video, however many recording segments it spans.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3 py-1">
            <div>
              <Label className="text-xs text-muted-foreground">Camera</Label>
              <Select value={exportCameraId} onValueChange={setExportCameraId}>
                <SelectTrigger className="h-9 mt-1 text-sm"><SelectValue placeholder="Select a camera" /></SelectTrigger>
                <SelectContent>
                  {cameras?.map((c) => (
                    <SelectItem key={c.camera_id} value={String(c.camera_id)}>{c.camera_name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label className="text-xs text-muted-foreground">From</Label>
                <Input
                  type="datetime-local"
                  className="h-9 mt-1 text-sm"
                  value={exportStart}
                  max={exportEnd || undefined}
                  onChange={(e) => setExportStart(e.target.value)}
                />
              </div>
              <div>
                <Label className="text-xs text-muted-foreground">To</Label>
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
            <Button variant="ghost" size="sm" disabled={exporting} onClick={() => setExportOpen(false)}>
              Cancel
            </Button>
            <Button
              size="sm"
              className="gap-1.5"
              disabled={exporting || !exportCameraId || !exportStart || !exportEnd}
              onClick={runExport}
            >
              {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />}
              {exporting ? "Building clip…" : "Export & Download"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
};

export default SearchPage;
