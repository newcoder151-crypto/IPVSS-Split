import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { Camera, Users, AlertTriangle, Activity, Eye, Shield, Cpu, FileText, ArrowUpRight, ArrowDownRight, Wifi, WifiOff, RefreshCw } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { AppLayout } from "@/components/layout/AppLayout";
import { useDashboardStats } from "@/hooks/use-dashboard-stats";
import { Skeleton } from "@/components/ui/skeleton";
import { formatDistanceToNow } from "date-fns";
import { useNavigate } from "react-router-dom";
import { API_BASE, tokenStore, apiGet } from "@/lib/api";
import { useQuery } from "@tanstack/react-query";

const severityColor: Record<string,string> = {
  CRITICAL:"bg-destructive/10 text-destructive border-destructive/20",
  EMERGENCY:"bg-destructive/10 text-destructive border-destructive/20",
  ERROR:"bg-destructive/10 text-destructive border-destructive/20",
  WARNING:"bg-warning/10 text-warning border-warning/20",
  INFO:"bg-blue-500/10 text-blue-400 border-blue-500/20",
};

// Real-time WebSocket hook for live events
function useWebSocket() {
  const [wsStatus, setWsStatus] = useState<"connecting"|"connected"|"disconnected">("disconnected");
  const [lastEvent, setLastEvent] = useState<any>(null);
  const wsRef = useRef<WebSocket|null>(null);
  useEffect(() => {
    const token = tokenStore.get();
    if (!token) return;
    const wsUrl = (API_BASE || window.location.origin).replace(/^http/, "ws") + `/ws?token=${encodeURIComponent(token)}`;
    const ws = new WebSocket(wsUrl);
    wsRef.current = ws;
    setWsStatus("connecting");
    ws.onopen = () => setWsStatus("connected");
    ws.onclose = () => setWsStatus("disconnected");
    ws.onerror = () => setWsStatus("disconnected");
    ws.onmessage = (e) => { try { setLastEvent(JSON.parse(e.data)); } catch {} };
    return () => ws.close();
  }, []);
  return { wsStatus, lastEvent };
}

const Dashboard = () => {
  const { data: stats, isLoading, refetch } = useDashboardStats();
  const navigate = useNavigate();
  const { wsStatus, lastEvent } = useWebSocket();
  const [liveAlerts, setLiveAlerts] = useState<any[]>([]);

  // System status from NVR core API  
  const { data: sysStatus } = useQuery({
    queryKey: ["system-status"],
    queryFn: () => apiGet<any>("/api/config/status"),
    refetchInterval: 15000,
  });

  // Append live WS events to the alerts list
  useEffect(() => {
    if (!lastEvent) return;
    if (lastEvent.type === "event.new" && lastEvent.data) {
      setLiveAlerts(prev => [lastEvent.data, ...prev].slice(0, 5));
      refetch();
    }
    if (lastEvent.type === "camera.health") refetch();
  }, [lastEvent, refetch]);

  const statCards = [
    { label:"Active Cameras", value: stats ? `${stats.activeCameras}/${stats.totalCameras}` : "—", icon:Camera, color:"text-green-400" },
    { label:"Events Today", value: stats?.totalEvents?.toString()||"0", icon:Eye, color:"text-blue-400" },
    { label:"Unacknowledged Alerts", value: stats?.unacknowledgedAlerts?.toString()||"0", icon:AlertTriangle, color:"text-warning" },
    { label:"Recordings", value: sysStatus?.recordings?.total?.toString()||"—", icon:Activity, color:"text-ai-glow" },
  ];

  const displayAlerts = liveAlerts.length > 0
    ? [...liveAlerts, ...(stats?.recentAlerts||[])].slice(0,6)
    : (stats?.recentAlerts||[]);

  return (
    <AppLayout>
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-foreground">Dashboard</h1>
            <p className="text-sm text-muted-foreground flex items-center gap-2">
              mNVR Train Surveillance
              <span className={`inline-flex items-center gap-1 text-xs ${wsStatus==="connected"?"text-green-400":"text-muted-foreground"}`}>
                {wsStatus==="connected" ? <Wifi className="h-3 w-3"/> : <WifiOff className="h-3 w-3"/>}
                {wsStatus}
              </span>
            </p>
          </div>
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => refetch()} className="gap-2">
              <RefreshCw className="h-4 w-4"/>Refresh
            </Button>
            <Button variant="outline" size="sm" className="gap-2" onClick={() => navigate("/events")}>
              <FileText className="h-4 w-4"/>All Events
            </Button>
          </div>
        </div>

        {/* Stat cards */}
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {statCards.map((stat,i) => (
            <motion.div key={stat.label} initial={{opacity:0,y:20}} animate={{opacity:1,y:0}} transition={{delay:i*0.1}}>
              <Card className="bg-card border-border">
                <CardContent className="p-4">
                  <div className="flex items-center justify-between mb-2">
                    <stat.icon className={`h-5 w-5 ${stat.color}`}/>
                  </div>
                  {isLoading ? <Skeleton className="h-8 w-20"/> : <p className="text-2xl font-bold text-foreground">{stat.value}</p>}
                  <p className="text-xs text-muted-foreground mt-1">{stat.label}</p>
                </CardContent>
              </Card>
            </motion.div>
          ))}
        </div>

        {/* System resource bars */}
        {sysStatus?.health && (
          <div className="grid grid-cols-3 gap-4">
            {[
              {label:"CPU", val: sysStatus.health.cpu_usage_pct??0},
              {label:"Memory", val: sysStatus.health.mem_usage_pct??0},
              {label:"Disk", val: sysStatus.health.disk_usage_pct??0},
            ].map(r => (
              <Card key={r.label} className="bg-card border-border">
                <CardContent className="p-3">
                  <div className="flex justify-between mb-1">
                    <span className="text-xs text-muted-foreground">{r.label}</span>
                    <span className="text-xs font-mono text-foreground">{Number(r.val).toFixed(1)}%</span>
                  </div>
                  <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                    <div className={`h-full rounded-full transition-all ${Number(r.val)>85?"bg-destructive":Number(r.val)>70?"bg-warning":"bg-green-500"}`}
                      style={{width:`${Math.min(100,r.val)}%`}}/>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        <div className="grid lg:grid-cols-3 gap-6">
          {/* Recent alerts */}
          <Card className="lg:col-span-2 bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <AlertTriangle className="h-4 w-4 text-warning"/>Recent Alerts
                {liveAlerts.length > 0 && <Badge className="text-[10px] bg-green-500/20 text-green-400 animate-pulse">LIVE</Badge>}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-3">
                {isLoading ? (
                  Array.from({length:4}).map((_,i)=><Skeleton key={i} className="h-14 w-full"/>)
                ) : displayAlerts.length > 0 ? (
                  displayAlerts.map((alert: any, idx: number) => (
                    <motion.div key={alert.event_id??idx} initial={{opacity:0,x:-10}} animate={{opacity:1,x:0}}
                      className="flex items-center justify-between p-3 rounded-lg border border-border bg-muted/30 cursor-pointer hover:bg-muted/50"
                      onClick={() => navigate("/events")}>
                      <div className="flex items-center gap-3">
                        <div className={`w-2 h-2 rounded-full flex-shrink-0 ${alert.severity==="CRITICAL"||alert.severity==="EMERGENCY"?"bg-destructive animate-pulse":"bg-warning"}`}/>
                        <div>
                          <p className="text-sm font-medium text-foreground">{alert.title}</p>
                          <p className="text-xs text-muted-foreground">{alert.description||alert.event_type}</p>
                        </div>
                      </div>
                      <div className="flex items-center gap-2 flex-shrink-0">
                        {alert.occurred_at && (
                          <span className="text-xs text-muted-foreground hidden sm:block">
                            {formatDistanceToNow(new Date(alert.occurred_at),{addSuffix:true})}
                          </span>
                        )}
                        <Badge variant="outline" className={`text-[10px] ${severityColor[alert.severity]||severityColor.INFO}`}>{alert.severity}</Badge>
                      </div>
                    </motion.div>
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground text-center py-8">No recent alerts</p>
                )}
              </div>
            </CardContent>
          </Card>

          {/* Storage & system */}
          <Card className="bg-card border-border">
            <CardHeader className="pb-3">
              <CardTitle className="text-base flex items-center gap-2">
                <Cpu className="h-4 w-4 text-ai-glow"/>System Info
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {sysStatus ? (
                <>
                  <div className="space-y-1.5 text-xs">
                    <div className="flex justify-between"><span className="text-muted-foreground">Uptime</span>
                      <span className="font-mono">{Math.floor((sysStatus.system?.uptime_seconds||0)/3600)}h {Math.floor(((sysStatus.system?.uptime_seconds||0)%3600)/60)}m</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Active Cams</span>
                      <span className="font-mono text-green-400">{sysStatus.cameras?.ACTIVE||0}</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Recordings</span>
                      <span className="font-mono">{sysStatus.recordings?.total||0} files</span></div>
                    <div className="flex justify-between"><span className="text-muted-foreground">Active Recs</span>
                      <span className="font-mono text-red-400">{sysStatus.recordings?.active||0}</span></div>
                  </div>
                  {sysStatus.storage?.length > 0 && (
                    <div className="space-y-2 pt-2 border-t border-border">
                      <p className="text-xs text-muted-foreground font-medium">Storage</p>
                      {sysStatus.storage.map((s: any) => (
                        <div key={s.storage_id} className="text-xs">
                          <div className="flex justify-between mb-0.5">
                            <span className="text-muted-foreground truncate">{s.label||s.mount_path}</span>
                            <span className="font-mono">{s.usage_pct?.toFixed(0)||0}%</span>
                          </div>
                          <div className="h-1 bg-muted rounded-full overflow-hidden">
                            <div className={`h-full rounded-full ${(s.usage_pct||0)>85?"bg-destructive":"bg-primary"}`} style={{width:`${s.usage_pct||0}%`}}/>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <div className="space-y-2">
                  {Array.from({length:4}).map((_,i)=><Skeleton key={i} className="h-4 w-full"/>)}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {/* Camera health grid */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-3">
            <CardTitle className="text-base flex items-center justify-between">
              <span className="flex items-center gap-2"><Shield className="h-4 w-4 text-primary"/>Camera Health Overview</span>
              <Button size="sm" variant="ghost" onClick={() => navigate("/cameras")} className="text-xs">View All →</Button>
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-4 sm:grid-cols-8 lg:grid-cols-16 gap-2">
              {isLoading ? (
                Array.from({length:16}).map((_,i)=><Skeleton key={i} className="h-16 w-full"/>)
              ) : stats?.cameras && stats.cameras.length > 0 ? (
                stats.cameras.map(cam => {
                  const dotColor = cam.status==="ACTIVE"?"bg-green-500":cam.status==="MAINTENANCE"?"bg-yellow-500":"bg-red-500";
                  return (
                    <div key={cam.camera_id}
                      className="flex flex-col items-center gap-1 p-2 rounded-md border border-border bg-muted/30 cursor-pointer hover:border-primary/40 transition-colors"
                      onClick={() => navigate(`/cameras`)}>
                      <Camera className="h-4 w-4 text-muted-foreground"/>
                      <span className="text-[10px] text-muted-foreground truncate w-full text-center">{cam.camera_name}</span>
                      <div className={`w-2 h-2 rounded-full ${dotColor}`}/>
                    </div>
                  );
                })
              ) : (
                <p className="text-sm text-muted-foreground col-span-full text-center py-4">No cameras configured</p>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </AppLayout>
  );
};
export default Dashboard;
