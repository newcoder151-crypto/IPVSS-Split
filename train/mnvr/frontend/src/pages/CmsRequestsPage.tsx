import { useMemo, useState } from "react";
import { UploadCloud, Wifi, WifiOff, CheckCircle2, AlertTriangle, Clock, Loader2 } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { useCmsRequests, type CmsTransfer, type TransferStatus } from "@/hooks/use-cms-requests";

const STATUS: Record<TransferStatus, { label: string; cls: string }> = {
  queued: { label: "Queued", cls: "bg-muted text-muted-foreground" },
  waiting_for_recording: { label: "Waiting for recording", cls: "bg-amber-500/15 text-amber-500" },
  preparing: { label: "Preparing", cls: "bg-blue-500/15 text-blue-500" },
  uploading: { label: "Transferring", cls: "bg-blue-500/15 text-blue-500" },
  paused: { label: "Paused - no signal", cls: "bg-amber-500/15 text-amber-500" },
  completed: { label: "Completed", cls: "bg-green-500/15 text-green-500" },
  partial: { label: "Completed (gaps)", cls: "bg-amber-500/15 text-amber-500" },
  failed: { label: "Failed", cls: "bg-destructive/15 text-destructive" },
  interrupted: { label: "Interrupted - will resume", cls: "bg-amber-500/15 text-amber-500" },
};
const ACTIVE: TransferStatus[] = ["queued", "waiting_for_recording", "preparing", "uploading", "paused", "interrupted"];

const fmtBytes = (b: number) => {
  if (!b) return "0 B";
  const u = ["B", "KB", "MB", "GB"]; const i = Math.min(3, Math.floor(Math.log(b) / Math.log(1024)));
  return `${(b / 1024 ** i).toFixed(i ? 1 : 0)} ${u[i]}`;
};
const fmtTime = (s: string) => new Date(s).toLocaleString([], { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });
const fmtWindow = (t: CmsTransfer) => {
  const mins = Math.max(1, Math.round((new Date(t.window_end).getTime() - new Date(t.window_start).getTime()) / 60000));
  return `${fmtTime(t.window_start)} - ${new Date(t.window_end).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })} (${mins} min)`;
};

function Row({ t }: { t: CmsTransfer }) {
  const st = STATUS[t.status] ?? STATUS.queued;
  const running = t.status === "uploading" || t.status === "preparing";
  return (
    <div className="grid grid-cols-12 gap-3 items-center px-4 py-3 border-b border-border last:border-0">
      <div className="col-span-3 min-w-0">
        <p className="text-sm font-medium text-foreground truncate">
          {t.kind === "auto" ? `Pre-upload for event #${t.event_id}` : t.request_id ? `CMS request #${t.request_id}` : `CMS command #${t.command_id}`}
        </p>
        <p className="text-[11px] text-muted-foreground truncate">{t.camera_name}</p>
      </div>
      <div className="col-span-3 text-xs text-muted-foreground">
        <p>{fmtWindow(t)}</p>
        <p className="text-[10px]">requested {fmtTime(t.created_at)}</p>
      </div>
      <div className="col-span-4">
        <div className="flex items-center gap-2">
          <Progress value={t.percent} className="h-2 flex-1" />
          <span className="text-xs font-semibold w-10 text-right tabular-nums">{t.percent}%</span>
        </div>
        <p className="text-[10px] text-muted-foreground mt-1">
          {t.segments_total ? `${t.segments_done}/${t.segments_total} segments - ` : ""}
          {t.bytes_total ? `${fmtBytes(t.bytes_sent)} of ${fmtBytes(t.bytes_total)}` : "no data sent yet"}
          {running && t.current_file ? ` - ${t.current_file}` : ""}
        </p>
      </div>
      <div className="col-span-2 flex flex-col items-end gap-1">
        <Badge className={`${st.cls} border-0 text-[10px]`}>
          {running && <Loader2 className="h-3 w-3 mr-1 animate-spin" />}
          {st.label}
        </Badge>
        {(t.error || t.message || (t.missing && t.missing.length > 0)) && (
          <p className="text-[10px] text-muted-foreground text-right">
            {t.error || t.message || `${t.missing!.length} gap(s) - not recorded`}
          </p>
        )}
      </div>
    </div>
  );
}

export default function CmsRequestsPage() {
  const { data, isLoading } = useCmsRequests();
  const [show, setShow] = useState<"all" | "active">("all");
  const rows = useMemo(() => {
    const all = data?.transfers ?? [];
    return show === "active" ? all.filter((t) => ACTIVE.includes(t.status)) : all;
  }, [data, show]);
  const active = (data?.transfers ?? []).filter((t) => ACTIVE.includes(t.status)).length;
  const done = (data?.transfers ?? []).filter((t) => t.status === "completed" || t.status === "partial").length;
  const failed = (data?.transfers ?? []).filter((t) => t.status === "failed").length;

  return (
    <AppLayout>
      <div className="p-6 space-y-4 max-w-6xl mx-auto">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <UploadCloud className="h-5 w-5 text-primary" />
            <h1 className="text-lg font-semibold text-foreground">CMS Footage Requests</h1>
          </div>
          <div className="flex items-center gap-2 text-xs">
            {data?.bridge_running && data.online ? (
              <Badge className="bg-green-500/15 text-green-500 border-0"><Wifi className="h-3 w-3 mr-1" />Connected to CMS</Badge>
            ) : data?.bridge_running ? (
              <Badge className="bg-amber-500/15 text-amber-500 border-0"><WifiOff className="h-3 w-3 mr-1" />No coverage - transfers wait</Badge>
            ) : (
              <Badge className="bg-destructive/15 text-destructive border-0"><AlertTriangle className="h-3 w-3 mr-1" />CMS bridge not running</Badge>
            )}
          </div>
        </div>

        <div className="grid grid-cols-3 gap-3">
          {[{ i: Clock, l: "In progress", v: active }, { i: CheckCircle2, l: "Delivered", v: done }, { i: AlertTriangle, l: "Failed", v: failed }].map((c) => (
            <Card key={c.l} className="bg-card border-border"><CardContent className="p-4 flex items-center gap-3">
              <c.i className="h-5 w-5 text-primary" /><div><p className="text-[11px] text-muted-foreground">{c.l}</p><p className="text-xl font-semibold">{c.v}</p></div>
            </CardContent></Card>
          ))}
        </div>

        <Card className="bg-card border-border">
          <CardHeader className="pb-2 flex-row items-center justify-between">
            <CardTitle className="text-sm">Requests from control room</CardTitle>
            <div className="flex gap-1 text-xs">
              {(["all", "active"] as const).map((k) => (
                <button key={k} onClick={() => setShow(k)} className={`px-2 py-1 rounded ${show === k ? "bg-primary/10 text-primary" : "text-muted-foreground hover:text-foreground"}`}>
                  {k === "all" ? "All" : "In progress"}
                </button>
              ))}
            </div>
          </CardHeader>
          <CardContent className="p-0">
            {isLoading ? <p className="p-6 text-sm text-muted-foreground">Loading...</p>
              : rows.length === 0 ? <p className="p-6 text-sm text-muted-foreground">
                  {data?.bridge_running === false ? "The CMS bridge is not running on this unit, so requests from the control room cannot be served. Start it with: bash start.sh" : "No requests yet. When an RPF officer requests footage and the CMS operator approves, it is fetched from the recordings here automatically."}
                </p>
              : rows.map((t) => <Row key={t.key} t={t} />)}
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
}
