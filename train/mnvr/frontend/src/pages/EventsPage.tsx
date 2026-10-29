import { useState, useMemo } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  CheckCheck,
  RefreshCw,
  Search,
  Camera,
  ShieldAlert,
  Eye,
  Users,
  WifiOff,
  Settings,
  Bell,
  X,
} from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import {
  useEvents,
  useAcknowledgeEvent,
  useAcknowledgeAll,
  useAcknowledgeBatch,
} from "@/hooks/use-events";
import { useCameras } from "@/hooks/use-cameras";
import { formatDistanceToNow, format } from "date-fns";
import { useToast } from "@/hooks/use-toast";
import { useNavigate } from "react-router-dom";
import { getEventSnapshotUrl } from "@/lib/api";

const SEVERITY_STYLES: Record<string, { badge: string; dot: string }> = {
  CRITICAL: { badge: "bg-destructive/10 text-destructive border-destructive/20", dot: "bg-destructive" },
  EMERGENCY: { badge: "bg-destructive/10 text-destructive border-destructive/20", dot: "bg-destructive" },
  ERROR: { badge: "bg-destructive/10 text-destructive border-destructive/20", dot: "bg-destructive" },
  WARNING: { badge: "bg-warning/10 text-warning border-warning/20", dot: "bg-warning" },
  INFO: { badge: "bg-blue-500/10 text-blue-400 border-blue-500/20", dot: "bg-blue-400" },
};

const EVENT_TYPE_ICON: Record<string, typeof AlertTriangle> = {
  CROWD_DENSITY: Users,
  INTRUSION: ShieldAlert,
  MOTION: Eye,
  ALARM: Bell,
  TAMPERING: ShieldAlert,
  SYSTEM: Settings,
  CAMERA_OFFLINE: WifiOff,
  // AI analytics worker (backend/ai/analytics)
  PASSENGER_FALLEN: ShieldAlert,
  PASSENGER_LEANING_OUT: ShieldAlert,
  SMOKE_DETECTED: AlertTriangle,
  TRACK_OBSTACLE: ShieldAlert,
  TRACK_NOT_VISIBLE: AlertTriangle,
  AI_TEST: Bell,
};

const EVENT_TYPES = [
  "CROWD_DENSITY", "INTRUSION", "MOTION", "ALARM",
  "TAMPERING", "SYSTEM", "CAMERA_OFFLINE",
  "PASSENGER_FALLEN", "PASSENGER_LEANING_OUT", "SMOKE_DETECTED", "TRACK_OBSTACLE", "TRACK_NOT_VISIBLE", "AI_TEST",
];
const SEVERITIES = ["CRITICAL", "EMERGENCY", "ERROR", "WARNING", "INFO"];

const QUICK_FILTERS = [
  { key: "all", label: "All" },
  { key: "unack", label: "Unacknowledged" },
  { key: "critical", label: "Critical" },
  { key: "warning", label: "Warning" },
  { key: "info", label: "Info" },
] as const;

const EventsPage = () => {
  const { toast } = useToast();
  const navigate = useNavigate();

  const [quickFilter, setQuickFilter] = useState<typeof QUICK_FILTERS[number]["key"]>("all");
  const [typeFilter, setTypeFilter] = useState("");
  const [cameraFilter, setCameraFilter] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(0);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const limit = 50;

  const severityFilter =
    quickFilter === "critical" ? "CRITICAL" : quickFilter === "warning" ? "WARNING" : quickFilter === "info" ? "INFO" : "";
  const ackFilter = quickFilter === "unack" ? 0 : undefined;

  const {
    data: resp,
    isLoading,
    refetch,
    isFetching,
  } = useEvents({
    severity: severityFilter || undefined,
    event_type: typeFilter || undefined,
    camera_id: cameraFilter ? parseInt(cameraFilter) : undefined,
    is_acknowledged: ackFilter,
    limit,
    offset: page * limit,
  });
  const events = resp?.events ?? [];
  const { data: cameras } = useCameras();
  const acknowledge = useAcknowledgeEvent();
  const acknowledgeAll = useAcknowledgeAll();
  const acknowledgeBatch = useAcknowledgeBatch();

  const filtered = useMemo(
    () =>
      events.filter(
        (e) =>
          !search ||
          e.title?.toLowerCase().includes(search.toLowerCase()) ||
          e.description?.toLowerCase().includes(search.toLowerCase()),
      ),
    [events, search],
  );

  const unackCount = events.filter((e) => e.is_acknowledged === 0).length;
  const hasFilters = Boolean(typeFilter || cameraFilter || search || quickFilter !== "all");

  const toggleSelected = (id: number) => {
    setSelected((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  };

  const handleAck = async (id: number) => {
    try {
      await acknowledge.mutateAsync(id);
      toast({ title: "Event acknowledged" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleAckSelected = async () => {
    try {
      await acknowledgeBatch.mutateAsync(Array.from(selected));
      toast({ title: `${selected.size} event(s) acknowledged` });
      setSelected(new Set());
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  const handleAckAll = async () => {
    try {
      await acknowledgeAll.mutateAsync();
      toast({ title: "All events acknowledged" });
    } catch (err: any) {
      toast({ title: "Error", description: err.message, variant: "destructive" });
    }
  };

  return (
    <AppLayout>
      <div className="space-y-4">
        {/* Header */}
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Alarms & Events</h1>
            <p className="text-sm text-muted-foreground">
              {resp?.total ?? 0} total
              {unackCount > 0 && (
                <span className="text-warning"> · {unackCount} unacknowledged on this page</span>
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {unackCount > 0 && (
              <Button size="sm" variant="outline" className="gap-1.5" onClick={handleAckAll} disabled={acknowledgeAll.isPending}>
                <CheckCheck className="h-3.5 w-3.5" />
                Acknowledge all
              </Button>
            )}
            <Button size="sm" variant="outline" onClick={() => refetch()} disabled={isFetching}>
              <RefreshCw className={`h-3.5 w-3.5 mr-1 ${isFetching ? "animate-spin" : ""}`} />
              Refresh
            </Button>
          </div>
        </div>

        {/* Quick severity/status filter chips */}
        <div className="flex flex-wrap gap-1.5">
          {QUICK_FILTERS.map((f) => (
            <button
              key={f.key}
              onClick={() => { setQuickFilter(f.key); setPage(0); }}
              className={`px-3 py-1.5 rounded-full text-xs font-medium border transition-colors ${
                quickFilter === f.key
                  ? "bg-primary text-primary-foreground border-primary"
                  : "bg-card text-muted-foreground border-border hover:text-foreground hover:border-foreground/30"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>

        {/* Secondary filters */}
        <div className="flex flex-wrap gap-2 items-center">
          <div className="relative">
            <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
            <Input
              placeholder="Search title or description…"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              className="w-56 h-8 pl-8 text-xs"
            />
          </div>
          <Select value={typeFilter} onValueChange={(v) => { setTypeFilter(v === "all" ? "" : v); setPage(0); }}>
            <SelectTrigger className="w-44 h-8 text-xs">
              <SelectValue placeholder="Event Type" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Types</SelectItem>
              {EVENT_TYPES.map((t) => (
                <SelectItem key={t} value={t}>{t.replace(/_/g, " ")}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Select value={cameraFilter} onValueChange={(v) => { setCameraFilter(v === "all" ? "" : v); setPage(0); }}>
            <SelectTrigger className="w-44 h-8 text-xs">
              <SelectValue placeholder="Camera" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All Cameras</SelectItem>
              {cameras?.map((c) => (
                <SelectItem key={c.camera_id} value={c.camera_id.toString()}>{c.camera_name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          {hasFilters && (
            <Button
              size="sm" variant="ghost" className="h-8 text-xs gap-1"
              onClick={() => { setQuickFilter("all"); setTypeFilter(""); setCameraFilter(""); setSearch(""); setPage(0); }}
            >
              <X className="h-3 w-3" />
              Clear
            </Button>
          )}
        </div>

        {/* Bulk-select action bar */}
        {selected.size > 0 && (
          <div className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-primary/5 border border-primary/20">
            <p className="text-xs text-foreground">{selected.size} selected</p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="h-7 text-xs gap-1" onClick={handleAckSelected} disabled={acknowledgeBatch.isPending}>
                <CheckCircle2 className="h-3 w-3" />
                Acknowledge selected
              </Button>
              <Button size="sm" variant="ghost" className="h-7 text-xs" onClick={() => setSelected(new Set())}>
                Clear selection
              </Button>
            </div>
          </div>
        )}

        {/* Events list */}
        <div className="space-y-1.5">
          {isLoading ? (
            Array.from({ length: 8 }).map((_, i) => (
              <div key={i} className="h-16 bg-muted/30 rounded-lg animate-pulse" />
            ))
          ) : filtered.length === 0 ? (
            <div className="text-center py-16 text-muted-foreground">
              <AlertTriangle className="h-12 w-12 mx-auto mb-2 opacity-20" />
              <p className="text-sm">No events found</p>
            </div>
          ) : (
            filtered.map((event) => {
              const sev = SEVERITY_STYLES[event.severity] || SEVERITY_STYLES.INFO;
              const TypeIcon = EVENT_TYPE_ICON[event.event_type] || AlertTriangle;
              return (
                <Card
                  key={event.event_id}
                  className={`bg-card border-border hover:border-primary/30 transition-colors ${event.is_acknowledged === 0 ? "border-l-2 border-l-warning" : ""}`}
                >
                  <CardContent className="p-3">
                    <div className="flex items-start gap-3">
                      <Checkbox
                        checked={selected.has(event.event_id)}
                        onCheckedChange={() => toggleSelected(event.event_id)}
                        className="mt-1.5 shrink-0"
                      />
                      <div className={`w-7 h-7 rounded-md flex items-center justify-center shrink-0 mt-0.5 ${sev.badge}`}>
                        <TypeIcon className="h-3.5 w-3.5" />
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 flex-wrap">
                          <p className="text-sm font-medium text-foreground">{event.title}</p>
                          <Badge variant="outline" className={`text-[10px] py-0 ${sev.badge}`}>
                            {event.severity}
                          </Badge>
                          {event.is_acknowledged === 1 && (
                            <Badge className="text-[10px] py-0 bg-muted text-muted-foreground">ACK</Badge>
                          )}
                        </div>
                        {event.description && (
                          <p className="text-xs text-muted-foreground mt-0.5 truncate">{event.description}</p>
                        )}
                        <div className="flex items-center gap-3 mt-1 text-[10px] text-muted-foreground flex-wrap">
                          {event.camera_name && (
                            <span
                              className="flex items-center gap-1 cursor-pointer hover:text-foreground"
                              onClick={() => navigate(`/cameras`)}
                            >
                              <Camera className="h-2.5 w-2.5" />
                              {event.camera_name}
                            </span>
                          )}
                          <span>{formatDistanceToNow(new Date(event.occurred_at), { addSuffix: true })}</span>
                          <span className="hidden sm:block">
                            {format(new Date(event.occurred_at), "yyyy-MM-dd HH:mm:ss")}
                          </span>
                        </div>
                      </div>
                      {event.snapshot_path && (
                        <a
                          href={getEventSnapshotUrl(event.event_id)}
                          target="_blank" rel="noreferrer" title="Open snapshot" className="shrink-0"
                        >
                          <img
                            src={getEventSnapshotUrl(event.event_id)} alt="" loading="lazy"
                            className="h-12 w-20 object-cover rounded border border-border"
                            onError={(e) => { (e.currentTarget.parentElement as HTMLElement).style.display = "none"; }}
                          />
                        </a>
                      )}
                      <div className="flex items-center gap-1 shrink-0">
                        {event.camera_id && (
                          <Button
                            size="sm" variant="ghost" className="h-7 text-xs"
                            title="Jump to this moment in recordings"
                            onClick={() => navigate(`/player?camera=${event.camera_id}&at=${encodeURIComponent(event.occurred_at)}`)}
                          >
                            Watch
                          </Button>
                        )}
                        {event.is_acknowledged === 0 && (
                          <Button
                            size="sm" variant="outline" className="h-7 text-xs gap-1"
                            onClick={() => handleAck(event.event_id)}
                            disabled={acknowledge.isPending}
                          >
                            <CheckCircle2 className="h-3 w-3" />
                            Ack
                          </Button>
                        )}
                      </div>
                    </div>
                  </CardContent>
                </Card>
              );
            })
          )}
        </div>

        {/* Pagination */}
        <div className="flex items-center justify-center gap-2">
          <Button size="sm" variant="outline" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>
            ← Prev
          </Button>
          <span className="text-xs text-muted-foreground">Page {page + 1}</span>
          <Button size="sm" variant="outline" disabled={filtered.length < limit} onClick={() => setPage((p) => p + 1)}>
            Next →
          </Button>
        </div>
      </div>
    </AppLayout>
  );
};
export default EventsPage;
