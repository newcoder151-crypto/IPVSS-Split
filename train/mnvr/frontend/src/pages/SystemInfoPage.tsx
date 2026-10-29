import {
  Activity,
  Cpu,
  MemoryStick,
  Server,
  Clock,
  RefreshCw,
  HardDrive,
} from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Badge } from "@/components/ui/badge";
import { useSystemInfo } from "@/hooks/use-system";
import { useDashboardStats } from "@/hooks/use-dashboard-stats";

function formatBytes(bytes: number) {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}

function formatUptime(seconds: number) {
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const parts = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  parts.push(`${m}m`);
  return parts.join(" ");
}

function StatCard({
  icon: Icon,
  label,
  value,
  sub,
}: {
  icon: React.ElementType;
  label: string;
  value: string;
  sub?: string;
}) {
  return (
    <Card className="bg-card border-border">
      <CardContent className="p-4 flex items-start gap-3">
        <div className="w-9 h-9 rounded-md bg-primary/10 flex items-center justify-center shrink-0">
          <Icon className="h-4.5 w-4.5 text-primary" />
        </div>
        <div className="min-w-0">
          <p className="text-[11px] text-muted-foreground">{label}</p>
          <p className="text-sm font-semibold text-foreground truncate">
            {value}
          </p>
          {sub && (
            <p className="text-[10px] text-muted-foreground mt-0.5">{sub}</p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

const SystemInfoPage = () => {
  const { data: info, isLoading, refetch, isFetching } = useSystemInfo();
  const { data: stats } = useDashboardStats();

  const memUsedPct = info
    ? Math.round((info.used_mem_bytes / info.total_mem_bytes) * 100)
    : 0;
  const load1 = info?.load_avg?.[0] ?? 0;
  const loadPct = info ? Math.min(100, Math.round((load1 / info.cpu_count) * 100)) : 0;

  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between flex-wrap gap-2">
          <div>
            <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
              <Activity className="h-5 w-5 text-primary" />
              System Info
            </h1>
            <p className="text-sm text-muted-foreground">
              Live status of the NVR host machine
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => refetch()}
            disabled={isFetching}
          >
            <RefreshCw
              className={`h-3.5 w-3.5 mr-1 ${isFetching ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>

        {isLoading && (
          <p className="text-sm text-muted-foreground">Loading system info…</p>
        )}

        {info && (
          <>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <StatCard
                icon={Server}
                label="Hostname"
                value={info.hostname}
                sub={`${info.platform} / ${info.arch}`}
              />
              <StatCard
                icon={Clock}
                label="System Uptime"
                value={formatUptime(info.uptime_seconds)}
                sub={`API process: ${formatUptime(info.process_uptime_seconds)}`}
              />
              <StatCard
                icon={Cpu}
                label="CPU"
                value={`${info.cpu_count} cores`}
                sub={info.cpu_model}
              />
              <StatCard
                icon={MemoryStick}
                label="Memory"
                value={formatBytes(info.total_mem_bytes)}
                sub={`${formatBytes(info.used_mem_bytes)} used`}
              />
            </div>

            <div className="grid md:grid-cols-2 gap-3">
              <Card className="bg-card border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">CPU Load (1 min avg)</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <Progress value={loadPct} />
                  <div className="flex justify-between text-[11px] text-muted-foreground">
                    <span>
                      Load: {load1.toFixed(2)} / {info.cpu_count} cores
                    </span>
                    <span>{loadPct}%</span>
                  </div>
                  <div className="flex gap-3 text-[10px] text-muted-foreground pt-1">
                    <span>5m: {info.load_avg[1]?.toFixed(2)}</span>
                    <span>15m: {info.load_avg[2]?.toFixed(2)}</span>
                  </div>
                </CardContent>
              </Card>

              <Card className="bg-card border-border">
                <CardHeader className="pb-2">
                  <CardTitle className="text-sm">Memory Usage</CardTitle>
                </CardHeader>
                <CardContent className="space-y-2">
                  <Progress value={memUsedPct} />
                  <div className="flex justify-between text-[11px] text-muted-foreground">
                    <span>
                      {formatBytes(info.used_mem_bytes)} of{" "}
                      {formatBytes(info.total_mem_bytes)}
                    </span>
                    <span>{memUsedPct}%</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground pt-1">
                    Free: {formatBytes(info.free_mem_bytes)}
                  </p>
                </CardContent>
              </Card>
            </div>

            <Card className="bg-card border-border">
              <CardHeader className="pb-2">
                <CardTitle className="text-sm flex items-center gap-2">
                  <HardDrive className="h-4 w-4" /> Fleet Summary
                </CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
                  <div>
                    <p className="text-[11px] text-muted-foreground">Cameras</p>
                    <p className="text-sm font-semibold">
                      {stats?.activeCameras ?? "—"} / {stats?.totalCameras ?? "—"} active
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">Events (24h)</p>
                    <p className="text-sm font-semibold">
                      {stats?.totalEvents ?? "—"}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">Unacknowledged</p>
                    <p className="text-sm font-semibold flex items-center gap-1.5">
                      {stats?.unacknowledgedAlerts ?? "—"}
                      {!!stats?.unacknowledgedAlerts && (
                        <Badge variant="destructive" className="text-[9px] h-4">
                          Attention
                        </Badge>
                      )}
                    </p>
                  </div>
                  <div>
                    <p className="text-[11px] text-muted-foreground">Node runtime</p>
                    <p className="text-sm font-semibold">{info.node_version}</p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </>
        )}
      </div>
    </AppLayout>
  );
};

export default SystemInfoPage;
