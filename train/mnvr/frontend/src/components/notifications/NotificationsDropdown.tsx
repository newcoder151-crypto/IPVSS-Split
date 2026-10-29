import { useEffect, useRef, useState } from "react";
import {
  Bell,
  CheckCheck,
  CheckCircle2,
  AlertTriangle,
  Info,
  AlertCircle,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  useEvents,
  useAcknowledgeEvent,
  useAcknowledgeAll,
} from "@/hooks/use-events";
import { API_BASE, tokenStore } from "@/lib/api";
import { formatDistanceToNow } from "date-fns";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { useNavigate } from "react-router-dom";
import type { EventRow } from "@/hooks/use-events";

/* ── severity styling ───────────────────────────────────────────────── */
const SEV_DOT: Record<string, string> = {
  CRITICAL: "bg-red-500",
  EMERGENCY: "bg-red-500",
  ERROR: "bg-red-400",
  WARNING: "bg-yellow-400",
  INFO: "bg-blue-400",
};

const SEV_ICON: Record<string, React.ElementType> = {
  CRITICAL: Zap,
  EMERGENCY: Zap,
  ERROR: AlertCircle,
  WARNING: AlertTriangle,
  INFO: Info,
};

const SEV_TOAST: Record<string, (msg: string, opts: any) => void> = {
  CRITICAL: (m, o) => toast.error(m, { ...o, duration: 8000 }),
  EMERGENCY: (m, o) => toast.error(m, { ...o, duration: 8000 }),
  ERROR: (m, o) => toast.error(m, { ...o, duration: 6000 }),
  WARNING: (m, o) => toast.warning(m, { ...o, duration: 5000 }),
  INFO: (m, o) => toast.info(m, { ...o, duration: 4000 }),
};

function showEventToast(ev: EventRow) {
  const fn = SEV_TOAST[ev.severity] ?? toast.info;
  fn(ev.title, {
    description:
      [ev.camera_name, ev.description].filter(Boolean).join(" — ") || undefined,
    closeButton: true,
  });
}

/* ── component ──────────────────────────────────────────────────────── */
const NotificationsDropdown = () => {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [popoverOpen, setPopoverOpen] = useState(false);

  /* Fetch ALL unacknowledged — no limit cap, server returns exact total */
  const { data: resp, refetch } = useEvents({ is_acknowledged: 0, limit: 500 });
  const events = resp?.events ?? [];
  const total = resp?.total ?? 0; /* server-side exact count */
  const unread = total;

  const acknowledge = useAcknowledgeEvent();
  const acknowledgeAll = useAcknowledgeAll();
  const wsRef = useRef<WebSocket | null>(null);

  /* Keep track of event IDs we've already toasted so reconnects don't re-fire */
  const seenRef = useRef<Set<number>>(new Set());

  /* ── WebSocket ───────────────────────────────────────────────────── */
  useEffect(() => {
    const token = tokenStore.get();
    if (!token) return;
    const base = API_BASE || window.location.origin;
    const wsUrl =
      base.replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(token)}`;
    let ws: WebSocket;
    let retryTimer: ReturnType<typeof setTimeout>;

    const connect = () => {
      try {
        ws = new WebSocket(wsUrl);
        wsRef.current = ws;

        ws.onmessage = (msg) => {
          try {
            const d = JSON.parse(msg.data);

            if (d.type === "event.new" && d.data) {
              const ev = d.data as EventRow;
              /* Show popup toast for every new event */
              if (!seenRef.current.has(ev.event_id)) {
                seenRef.current.add(ev.event_id);
                showEventToast(ev);
              }
              /* Refresh the list */
              refetch();
              qc.invalidateQueries({ queryKey: ["dashboard-stats"] });
              qc.invalidateQueries({ queryKey: ["events"] });
            }

            if (
              d.type === "event.acknowledged" ||
              d.type === "events.batch_acknowledged"
            ) {
              refetch();
              qc.invalidateQueries({ queryKey: ["dashboard-stats"] });
              qc.invalidateQueries({ queryKey: ["events"] });
            }
          } catch {}
        };

        ws.onclose = () => {
          retryTimer = setTimeout(connect, 5000);
        };
        ws.onerror = () => {};
      } catch {}
    };

    connect();
    return () => {
      clearTimeout(retryTimer);
      wsRef.current?.close();
    };
  }, [refetch, qc]);

  /* ── handlers ────────────────────────────────────────────────────── */
  const handleAck = (event_id: number) => {
    acknowledge.mutate(event_id, { onError: () => refetch() });
  };

  const handleAckAll = () => {
    acknowledgeAll.mutate(undefined, { onError: () => refetch() });
  };

  /** Navigate to VideoPlayer and seek to the exact frame of the event */
  const handleEventClick = (ev: EventRow) => {
    setPopoverOpen(false);
    if (ev.camera_id) {
      navigate(
        `/player?camera=${ev.camera_id}&at=${encodeURIComponent(ev.occurred_at)}`,
      );
    }
  };

  return (
    <Popover open={popoverOpen} onOpenChange={setPopoverOpen}>
      <PopoverTrigger asChild>
        <Button variant="ghost" size="icon" className="relative h-8 w-8">
          <Bell className="h-4 w-4" />
          {unread > 0 && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[18px] h-[18px] px-0.5 rounded-full bg-destructive text-[9px] font-bold text-white flex items-center justify-center animate-pulse leading-none">
              {unread}
            </span>
          )}
        </Button>
      </PopoverTrigger>

      <PopoverContent
        align="end"
        className="w-80 bg-card border-border p-0 shadow-xl"
      >
        {/* Header */}
        <div className="flex items-center justify-between px-3 py-2.5 border-b border-border">
          <span className="text-sm font-semibold text-foreground">
            Notifications
          </span>
          {unread > 0 && (
            <Badge className="text-[10px] bg-destructive/10 text-destructive border-destructive/20">
              {unread} unread
            </Badge>
          )}
        </div>

        {/* Scrollable event list */}
        <div className="max-h-[420px] overflow-y-auto">
          {events.length === 0 && (
            <div className="flex flex-col items-center justify-center py-10 text-muted-foreground">
              <CheckCircle2 className="h-8 w-8 mb-2 text-green-400/50" />
              <p className="text-sm">All caught up</p>
            </div>
          )}

          {events.map((ev) => {
            const Icon = SEV_ICON[ev.severity] ?? Info;
            const isClickable = !!ev.camera_id;
            return (
              <div
                key={ev.event_id}
                className={`flex items-start gap-2.5 px-3 py-2.5 border-b border-border/40 last:border-0 transition-colors
                  ${
                    isClickable
                      ? "hover:bg-primary/5 cursor-pointer group"
                      : "hover:bg-muted/30"
                  }`}
                onClick={() => isClickable && handleEventClick(ev)}
                title={
                  isClickable
                    ? "Click to view recording at this moment"
                    : undefined
                }
              >
                {/* Severity dot */}
                <div
                  className={`mt-1.5 w-2 h-2 rounded-full shrink-0 ${SEV_DOT[ev.severity] ?? "bg-blue-400"}`}
                />

                <div className="flex-1 min-w-0">
                  <p className="text-xs font-medium text-foreground leading-tight">
                    {ev.title}
                    {isClickable && (
                      <span className="ml-1 text-[9px] text-primary/60 group-hover:text-primary opacity-0 group-hover:opacity-100 transition-opacity">
                        → view recording
                      </span>
                    )}
                  </p>
                  {ev.camera_name && (
                    <p className="text-[10px] text-muted-foreground">
                      {ev.camera_name}
                    </p>
                  )}
                  {ev.description && (
                    <p className="text-[10px] text-muted-foreground/80 truncate">
                      {ev.description}
                    </p>
                  )}
                  <p className="text-[10px] text-muted-foreground mt-0.5">
                    {formatDistanceToNow(new Date(ev.occurred_at), {
                      addSuffix: true,
                    })}
                  </p>
                </div>

                {/* Acknowledge button — stop propagation so clicking it doesn't navigate */}
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 w-6 p-0 shrink-0 hover:text-green-400"
                  onClick={(e) => {
                    e.stopPropagation();
                    handleAck(ev.event_id);
                  }}
                  disabled={acknowledge.isPending}
                  title="Acknowledge"
                >
                  <CheckCheck className="h-3.5 w-3.5" />
                </Button>
              </div>
            );
          })}
        </div>

        {/* Acknowledge All */}
        {unread > 0 && (
          <div className="px-3 py-2 border-t border-border">
            <Button
              size="sm"
              variant="outline"
              className="w-full h-7 text-xs"
              onClick={handleAckAll}
              disabled={acknowledgeAll.isPending}
            >
              <CheckCheck className="h-3 w-3 mr-1" />
              Acknowledge All ({unread})
            </Button>
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
};

export default NotificationsDropdown;
