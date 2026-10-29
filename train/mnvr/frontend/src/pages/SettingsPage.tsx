import { useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Settings,
  Save,
  Plus,
  Trash2,
  Camera,
  HardDrive,
  Video,
  Wifi,
  Activity,
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
} from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { useSystemConfig, useUpdateConfig } from "@/hooks/use-system-config";
import { useToast } from "@/hooks/use-toast";
import { DiscoverCameraDialog } from "@/components/camera/DiscoverCameraDialog";
import { apiGet, apiPut, apiDelete } from "@/lib/api";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";

/* ── Types ─────────────────────────────────────────────────────────── */

interface HealthSettings {
  id: number;
  poll_interval_sec: number;
  cpu_warn_threshold: number;
  mem_warn_threshold: number;
  disk_warn_threshold: number;
  cpu_critical_threshold: number;
  mem_critical_threshold: number;
  disk_critical_threshold: number;
  enable_alerts: boolean;
}

interface RecordingSettings {
  id: number;
  storage_path: string;
  recording_retention_days: number;
  log_retention_days: number;
  segment_duration_sec: number;
  segment_max_size_mb: number;
  max_storage_gb: number;
  enable_audio: boolean;
  enable_watermark: boolean;
}

interface HlsSettings {
  id: number;
  hls_base: string;
  hls_segment_sec: number;
  hls_window_size: number;
  hls_delete_old_segments: boolean;
}

interface OnvifSettings {
  id: number;
  multicast_ip: string;
  multicast_port: number;
  discovery_interval_sec: number;
  probe_timeout_ms: number;
  enable_discovery: boolean;
}

interface CameraConfigDetail {
  id: number;
  camera_slot: number;
  name: string;
  location: string;
  camera_type: string;
  ip_address: string;
  onvif_port: number;
  onvif_username: string;
  rtsp_username: string;
  manufacturer: string;
  model: string;
  is_active: boolean;
  onvif_password?: string;
  rtsp_password?: string;
}

/* ── Helpers ────────────────────────────────────────────────────────── */

function SectionHeader({
  icon: Icon,
  title,
  open,
  onToggle,
}: {
  icon: React.ElementType;
  title: string;
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className="flex items-center gap-2 w-full text-left py-1"
      onClick={onToggle}
    >
      <Icon className="h-4 w-4 text-primary" />
      <span className="text-sm font-semibold text-foreground">{title}</span>
      <span className="ml-auto text-muted-foreground">
        {open ? (
          <ChevronDown className="h-4 w-4" />
        ) : (
          <ChevronRight className="h-4 w-4" />
        )}
      </span>
    </button>
  );
}

function PasswordInput({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
}) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <Input
        type={show ? "text" : "password"}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder ?? "••••••••"}
        className="h-7 text-xs pr-8"
      />
      <button
        type="button"
        className="absolute right-2 top-1.5 text-muted-foreground hover:text-foreground"
        onClick={() => setShow((s) => !s)}
      >
        {show ? (
          <EyeOff className="h-3.5 w-3.5" />
        ) : (
          <Eye className="h-3.5 w-3.5" />
        )}
      </button>
    </div>
  );
}

function CameraForm({
  form,
  onChange,
}: {
  form: any;
  onChange: (vals: any) => void;
}) {
  const set = (k: string, v: any) => onChange({ ...form, [k]: v });
  return (
    <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
      <div>
        <Label className="text-xs text-muted-foreground">Slot #</Label>
        <Input
          type="number"
          className="h-7 text-xs mt-1"
          value={form.camera_slot ?? ""}
          onChange={(e) => set("camera_slot", Number(e.target.value))}
        />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Camera Name</Label>
        <Input
          className="h-7 text-xs mt-1"
          value={form.name ?? ""}
          onChange={(e) => set("name", e.target.value)}
          placeholder="Front Entrance"
        />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Location</Label>
        <Input
          className="h-7 text-xs mt-1"
          value={form.location ?? ""}
          onChange={(e) => set("location", e.target.value)}
          placeholder="Coach A - Door 1"
        />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Camera Type</Label>
        <Select
          value={form.camera_type ?? "INTERIOR"}
          onValueChange={(v) => set("camera_type", v)}
        >
          <SelectTrigger className="h-7 text-xs mt-1">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {["INTERIOR", "EXTERIOR", "DOOR", "DRIVER_CAB"].map((t) => (
              <SelectItem key={t} value={t} className="text-xs">
                {t}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">IP Address</Label>
        <Input
          className="h-7 text-xs mt-1 font-mono"
          value={form.ip_address ?? ""}
          onChange={(e) => set("ip_address", e.target.value)}
          placeholder="192.168.1.100"
        />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">ONVIF Port</Label>
        <Input
          type="number"
          className="h-7 text-xs mt-1"
          value={form.onvif_port ?? 80}
          onChange={(e) => set("onvif_port", Number(e.target.value))}
        />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">ONVIF Username</Label>
        <Input
          className="h-7 text-xs mt-1"
          value={form.onvif_username ?? ""}
          onChange={(e) => set("onvif_username", e.target.value)}
          placeholder="admin"
        />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">ONVIF Password</Label>
        <PasswordInput
          value={form.onvif_password ?? ""}
          onChange={(v) => set("onvif_password", v)}
        />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">RTSP Username</Label>
        <Input
          className="h-7 text-xs mt-1"
          value={form.rtsp_username ?? ""}
          onChange={(e) => set("rtsp_username", e.target.value)}
          placeholder="admin"
        />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">RTSP Password</Label>
        <PasswordInput
          value={form.rtsp_password ?? ""}
          onChange={(v) => set("rtsp_password", v)}
        />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Manufacturer</Label>
        <Input
          className="h-7 text-xs mt-1"
          value={form.manufacturer ?? ""}
          onChange={(e) => set("manufacturer", e.target.value)}
          placeholder="Hikvision"
        />
      </div>
      <div>
        <Label className="text-xs text-muted-foreground">Model</Label>
        <Input
          className="h-7 text-xs mt-1"
          value={form.model ?? ""}
          onChange={(e) => set("model", e.target.value)}
          placeholder="DS-2CD2143G2-I"
        />
      </div>
      <div className="flex items-center gap-2 pt-5">
        <Switch
          checked={form.is_active !== false}
          onCheckedChange={(v) => set("is_active", v)}
        />
        <Label className="text-xs">Active</Label>
      </div>
    </div>
  );
}

/* ── Main Component ─────────────────────────────────────────────────── */

const SettingsPage = () => {
  const { toast } = useToast();
  const qc = useQueryClient();
  const navigate = useNavigate();

  const [open, setOpen] = useState({
    system: true,
    health: false,
    recording: false,
    hls: false,
    onvif: true,
    cameras: true,
  });
  const toggle = (k: keyof typeof open) =>
    setOpen((p) => ({ ...p, [k]: !p[k] }));

  /* System config */
  const { data: config, isLoading: configLoading } = useSystemConfig();
  const updateConfig = useUpdateConfig();
  const [cfgEdits, setCfgEdits] = useState<Record<string, string>>({});

  const { data: status } = useQuery({
    queryKey: ["system-status"],
    queryFn: () => apiGet<any>("/api/config/status"),
    refetchInterval: 30000,
  });

  const handleSaveConfig = async (key: string) => {
    if (cfgEdits[key] === undefined) return;
    try {
      await updateConfig.mutateAsync({
        configKey: key,
        configValue: cfgEdits[key],
      });
      toast({ title: "Saved", description: `${key} updated` });
      setCfgEdits((prev) => {
        const n = { ...prev };
        delete n[key];
        return n;
      });
    } catch (err: any) {
      toast({
        title: "Error",
        description: err.message,
        variant: "destructive",
      });
    }
  };

  const editableKeys = config?.filter((c) => c.is_readonly === 0) || [];
  const readonlyKeys = config?.filter((c) => c.is_readonly === 1) || [];

  /* Health settings */
  const { data: healthData, isLoading: healthLoading } =
    useQuery<HealthSettings>({
      queryKey: ["settings-health"],
      queryFn: () => apiGet("/api/settings/health"),
    });
  const [healthForm, setHealthForm] = useState<Partial<HealthSettings>>({});
  const saveHealth = useMutation({
    mutationFn: () =>
      apiPut("/api/settings/health", { ...healthData, ...healthForm }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings-health"] });
      setHealthForm({});
      toast({ title: "Health settings saved" });
    },
    onError: (e: any) =>
      toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  /* Recording settings */
  const { data: recData, isLoading: recLoading } = useQuery<RecordingSettings>({
    queryKey: ["settings-recording"],
    queryFn: () => apiGet("/api/settings/recording"),
  });
  const [recForm, setRecForm] = useState<Partial<RecordingSettings>>({});
  const saveRec = useMutation({
    mutationFn: () =>
      apiPut("/api/settings/recording", { ...recData, ...recForm }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings-recording"] });
      setRecForm({});
      toast({ title: "Recording settings saved" });
    },
    onError: (e: any) =>
      toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  /* HLS settings */
  const { data: hlsData, isLoading: hlsLoading } = useQuery<HlsSettings>({
    queryKey: ["settings-hls"],
    queryFn: () => apiGet("/api/settings/hls"),
  });
  const [hlsForm, setHlsForm] = useState<Partial<HlsSettings>>({});
  const saveHls = useMutation({
    mutationFn: () => apiPut("/api/settings/hls", { ...hlsData, ...hlsForm }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings-hls"] });
      setHlsForm({});
      toast({ title: "HLS settings saved" });
    },
    onError: (e: any) =>
      toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  /* ONVIF settings */
  const { data: onvifData, isLoading: onvifLoading } = useQuery<OnvifSettings>({
    queryKey: ["settings-onvif"],
    queryFn: () => apiGet("/api/settings/onvif"),
  });
  const [onvifForm, setOnvifForm] = useState<Partial<OnvifSettings>>({});
  const saveOnvif = useMutation({
    mutationFn: () =>
      apiPut("/api/settings/onvif", { ...onvifData, ...onvifForm }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings-onvif"] });
      setOnvifForm({});
      toast({ title: "ONVIF settings saved" });
    },
    onError: (e: any) =>
      toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  /* Camera config details */
  const { data: camConfigs, isLoading: camConfigLoading } = useQuery<
    CameraConfigDetail[]
  >({
    queryKey: ["settings-cameras"],
    queryFn: () => apiGet("/api/settings/cameras"),
  });



  const [addCamOpen, setAddCamOpen] = useState(false);
  const [editCam, setEditCam] = useState<CameraConfigDetail | null>(null);
  const [deleteCamSlot, setDeleteCamSlot] = useState<number | null>(null);

  const updateCamera = useMutation({
    mutationFn: () =>
      editCam
        ? apiPut(`/api/settings/cameras/${editCam.camera_slot}`, editCam)
        : Promise.resolve(),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings-cameras"] });
      setEditCam(null);
      toast({ title: "Camera updated" });
    },
    onError: (e: any) =>
      toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  const deleteCamera = useMutation({
    mutationFn: (slot: number) => apiDelete(`/api/settings/cameras/${slot}`),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings-cameras"] });
      qc.invalidateQueries({ queryKey: ["cameras"] }); // the grid and every camera list must drop it too
      setDeleteCamSlot(null);
      toast({ title: "Camera removed", description: "It is gone from the camera grid and has stopped recording." });
    },
    onError: (e: any) =>
      toast({ title: "Error", description: e.message, variant: "destructive" }),
  });

  return (
    <AppLayout>
      <div className="space-y-4 max-w-4xl">
        <div>
          <h1 className="text-2xl font-bold text-foreground flex items-center gap-2">
            <Settings className="h-6 w-6" /> System Settings
          </h1>
          <p className="text-sm text-muted-foreground">
            All settings are persisted to the database and read by the NVR core
            at startup.
          </p>
        </div>

        {status && (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 text-xs">
            <div className="bg-card border border-border rounded-md p-3">
              <p className="text-muted-foreground">Uptime</p>
              <p className="font-mono font-semibold">
                {Math.floor((status.system?.uptime_seconds || 0) / 3600)}h{" "}
                {Math.floor(((status.system?.uptime_seconds || 0) % 3600) / 60)}
                m
              </p>
            </div>
            <div className="bg-card border border-border rounded-md p-3">
              <p className="text-muted-foreground">Cameras</p>
              <p className="font-semibold">
                {status.cameras?.ACTIVE || 0} / {status.cameras?.total || 0}{" "}
                Active
              </p>
            </div>
            <div className="bg-card border border-border rounded-md p-3">
              <p className="text-muted-foreground">Events</p>
              <p className="font-semibold">
                {status.events?.unacknowledged || 0} Unacked
              </p>
            </div>
            <div className="bg-card border border-border rounded-md p-3">
              <p className="text-muted-foreground">Version</p>
              <p className="font-mono font-semibold">
                {status.system?.version || "—"}
              </p>
            </div>
          </div>
        )}

        {/* ── System Config ── */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2 pt-4 px-4">
            <SectionHeader
              icon={Settings}
              title="System Configuration"
              open={open.system}
              onToggle={() => toggle("system")}
            />
          </CardHeader>
          {open.system && (
            <CardContent className="space-y-3 px-4 pb-4">
              {configLoading && (
                <p className="text-xs text-muted-foreground">Loading…</p>
              )}
              {editableKeys.map((item) => (
                <div
                  key={item.config_key}
                  className="grid grid-cols-3 gap-2 items-end"
                >
                  <div>
                    <Label className="text-xs text-muted-foreground">
                      {item.config_key}
                    </Label>
                    {item.description && (
                      <p className="text-[10px] text-muted-foreground/70">
                        {item.description}
                      </p>
                    )}
                  </div>
                  <Input
                    className="h-7 text-xs"
                    value={cfgEdits[item.config_key] ?? item.config_value}
                    onChange={(e) =>
                      setCfgEdits((p) => ({
                        ...p,
                        [item.config_key]: e.target.value,
                      }))
                    }
                  />
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    variant={
                      cfgEdits[item.config_key] !== undefined
                        ? "default"
                        : "ghost"
                    }
                    onClick={() => handleSaveConfig(item.config_key)}
                    disabled={cfgEdits[item.config_key] === undefined}
                  >
                    <Save className="h-3 w-3" />
                  </Button>
                </div>
              ))}
              {readonlyKeys.length > 0 && (
                <>
                  <Separator />
                  <p className="text-[10px] text-muted-foreground font-medium uppercase tracking-wider">
                    System Info{" "}
                    <Badge variant="secondary" className="text-[9px] ml-1">
                      Read-only
                    </Badge>
                  </p>
                  {readonlyKeys.map((item) => (
                    <div
                      key={item.config_key}
                      className="flex justify-between text-xs py-0.5"
                    >
                      <span className="text-muted-foreground">
                        {item.config_key}
                      </span>
                      <span className="font-mono">{item.config_value}</span>
                    </div>
                  ))}
                </>
              )}
            </CardContent>
          )}
        </Card>

        {/* ── Health Monitor ── */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2 pt-4 px-4">
            <SectionHeader
              icon={Activity}
              title="Health Monitor Settings"
              open={open.health}
              onToggle={() => toggle("health")}
            />
          </CardHeader>
          {open.health && (
            <CardContent className="space-y-3 px-4 pb-4">
              {healthLoading ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                    {(
                      [
                        {
                          label: "Poll Interval (sec)",
                          key: "poll_interval_sec",
                        },
                        { label: "CPU Warn %", key: "cpu_warn_threshold" },
                        {
                          label: "CPU Critical %",
                          key: "cpu_critical_threshold",
                        },
                        { label: "Mem Warn %", key: "mem_warn_threshold" },
                        {
                          label: "Mem Critical %",
                          key: "mem_critical_threshold",
                        },
                        { label: "Disk Warn %", key: "disk_warn_threshold" },
                        {
                          label: "Disk Critical %",
                          key: "disk_critical_threshold",
                        },
                      ] as { label: string; key: keyof HealthSettings }[]
                    ).map((f) => (
                      <div key={f.key}>
                        <Label className="text-xs text-muted-foreground">
                          {f.label}
                        </Label>
                        <Input
                          type="number"
                          className="h-7 text-xs mt-1"
                          value={
                            (healthForm as any)[f.key] ??
                            (healthData as any)?.[f.key] ??
                            ""
                          }
                          onChange={(e) =>
                            setHealthForm((p) => ({
                              ...p,
                              [f.key]: Number(e.target.value),
                            }))
                          }
                        />
                      </div>
                    ))}
                    <div className="flex items-center gap-2 pt-5">
                      <Switch
                        checked={
                          (healthForm.enable_alerts ??
                            healthData?.enable_alerts) === true
                        }
                        onCheckedChange={(v) =>
                          setHealthForm((p) => ({ ...p, enable_alerts: v }))
                        }
                      />
                      <Label className="text-xs">Enable Alerts</Label>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    disabled={
                      Object.keys(healthForm).length === 0 ||
                      saveHealth.isPending
                    }
                    onClick={() => saveHealth.mutate()}
                  >
                    <Save className="h-3 w-3 mr-1" /> Save
                  </Button>
                </>
              )}
            </CardContent>
          )}
        </Card>

        {/* ── Recording Settings ── */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2 pt-4 px-4">
            <SectionHeader
              icon={HardDrive}
              title="Recording Settings"
              open={open.recording}
              onToggle={() => toggle("recording")}
            />
          </CardHeader>
          {open.recording && (
            <CardContent className="space-y-3 px-4 pb-4">
              {recLoading ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    <div className="col-span-2 md:col-span-3">
                      <Label className="text-xs text-muted-foreground">
                        Storage Path
                      </Label>
                      <Input
                        className="h-7 text-xs mt-1 font-mono"
                        value={
                          recForm.storage_path ?? recData?.storage_path ?? ""
                        }
                        onChange={(e) =>
                          setRecForm((p) => ({
                            ...p,
                            storage_path: e.target.value,
                          }))
                        }
                      />
                    </div>
                    {(
                      [
                        {
                          label: "Recording Retention (days)",
                          key: "recording_retention_days",
                        },
                        {
                          label: "Log Retention (days)",
                          key: "log_retention_days",
                        },
                        {
                          label: "Segment Duration (sec)",
                          key: "segment_duration_sec",
                        },
                        {
                          label: "Segment Max Size (MB)",
                          key: "segment_max_size_mb",
                        },
                        { label: "Max Storage (GB)", key: "max_storage_gb" },
                      ] as { label: string; key: keyof RecordingSettings }[]
                    ).map((f) => (
                      <div key={f.key}>
                        <Label className="text-xs text-muted-foreground">
                          {f.label}
                        </Label>
                        <Input
                          type="number"
                          className="h-7 text-xs mt-1"
                          value={
                            (recForm as any)[f.key] ??
                            (recData as any)?.[f.key] ??
                            ""
                          }
                          onChange={(e) =>
                            setRecForm((p) => ({
                              ...p,
                              [f.key]: Number(e.target.value),
                            }))
                          }
                        />
                      </div>
                    ))}
                    <div className="flex items-center gap-2 pt-5">
                      <Switch
                        checked={
                          (recForm.enable_audio ?? recData?.enable_audio) ===
                          true
                        }
                        onCheckedChange={(v) =>
                          setRecForm((p) => ({ ...p, enable_audio: v }))
                        }
                      />
                      <Label className="text-xs">Enable Audio</Label>
                    </div>
                    <div className="flex items-center gap-2 pt-5">
                      <Switch
                        checked={
                          (recForm.enable_watermark ??
                            recData?.enable_watermark) === true
                        }
                        onCheckedChange={(v) =>
                          setRecForm((p) => ({ ...p, enable_watermark: v }))
                        }
                      />
                      <Label className="text-xs">Enable Watermark</Label>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    disabled={
                      Object.keys(recForm).length === 0 || saveRec.isPending
                    }
                    onClick={() => saveRec.mutate()}
                  >
                    <Save className="h-3 w-3 mr-1" /> Save
                  </Button>
                </>
              )}
            </CardContent>
          )}
        </Card>

        {/* ── HLS Settings ── */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2 pt-4 px-4">
            <SectionHeader
              icon={Video}
              title="HLS Streaming Settings"
              open={open.hls}
              onToggle={() => toggle("hls")}
            />
          </CardHeader>
          {open.hls && (
            <CardContent className="space-y-3 px-4 pb-4">
              {hlsLoading ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    <div className="col-span-2 md:col-span-3">
                      <Label className="text-xs text-muted-foreground">
                        HLS Base Path
                      </Label>
                      <Input
                        className="h-7 text-xs mt-1 font-mono"
                        value={hlsForm.hls_base ?? hlsData?.hls_base ?? ""}
                        onChange={(e) =>
                          setHlsForm((p) => ({
                            ...p,
                            hls_base: e.target.value,
                          }))
                        }
                      />
                    </div>
                    {(
                      [
                        {
                          label: "Segment Duration (sec)",
                          key: "hls_segment_sec",
                        },
                        {
                          label: "Window Size (segments)",
                          key: "hls_window_size",
                        },
                      ] as { label: string; key: keyof HlsSettings }[]
                    ).map((f) => (
                      <div key={f.key}>
                        <Label className="text-xs text-muted-foreground">
                          {f.label}
                        </Label>
                        <Input
                          type="number"
                          className="h-7 text-xs mt-1"
                          value={
                            (hlsForm as any)[f.key] ??
                            (hlsData as any)?.[f.key] ??
                            ""
                          }
                          onChange={(e) =>
                            setHlsForm((p) => ({
                              ...p,
                              [f.key]: Number(e.target.value),
                            }))
                          }
                        />
                      </div>
                    ))}
                    <div className="flex items-center gap-2 pt-5">
                      <Switch
                        checked={
                          (hlsForm.hls_delete_old_segments ??
                            hlsData?.hls_delete_old_segments) === true
                        }
                        onCheckedChange={(v) =>
                          setHlsForm((p) => ({
                            ...p,
                            hls_delete_old_segments: v,
                          }))
                        }
                      />
                      <Label className="text-xs">Delete Old Segments</Label>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    disabled={
                      Object.keys(hlsForm).length === 0 || saveHls.isPending
                    }
                    onClick={() => saveHls.mutate()}
                  >
                    <Save className="h-3 w-3 mr-1" /> Save
                  </Button>
                </>
              )}
            </CardContent>
          )}
        </Card>

        {/* ── ONVIF Settings ── */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2 pt-4 px-4">
            <SectionHeader
              icon={Wifi}
              title="ONVIF Discovery Settings"
              open={open.onvif}
              onToggle={() => toggle("onvif")}
            />
          </CardHeader>
          {open.onvif && (
            <CardContent className="space-y-3 px-4 pb-4">
              <p className="text-[11px] text-muted-foreground bg-muted/30 rounded p-2 flex items-center justify-between gap-2 flex-wrap">
                <span>
                  These settings control automatic camera{" "}
                  <strong>discovery</strong> (multicast probing) only.
                  Per-camera{" "}
                  <strong>
                    multi-stream selection, PTZ, image
                    (brightness/contrast/saturation/sharpness), and audio
                    settings
                  </strong>{" "}
                  are controlled from the <strong>Camera Grid</strong> page —
                  expand any camera tile and click <strong>"Controls"</strong>.
                </span>
                <Button
                  size="sm"
                  variant="outline"
                  className="h-6 text-[10px] px-2 shrink-0"
                  onClick={() => navigate("/cameras")}
                >
                  Open Camera Grid
                </Button>
              </p>
              {onvifLoading ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : (
                <>
                  <div className="grid grid-cols-2 md:grid-cols-3 gap-3">
                    <div>
                      <Label className="text-xs text-muted-foreground">
                        Multicast IP
                      </Label>
                      <Input
                        className="h-7 text-xs mt-1 font-mono"
                        value={
                          onvifForm.multicast_ip ??
                          onvifData?.multicast_ip ??
                          ""
                        }
                        onChange={(e) =>
                          setOnvifForm((p) => ({
                            ...p,
                            multicast_ip: e.target.value,
                          }))
                        }
                      />
                    </div>
                    {(
                      [
                        { label: "Multicast Port", key: "multicast_port" },
                        {
                          label: "Discovery Interval (sec)",
                          key: "discovery_interval_sec",
                        },
                        {
                          label: "Probe Timeout (ms)",
                          key: "probe_timeout_ms",
                        },
                      ] as { label: string; key: keyof OnvifSettings }[]
                    ).map((f) => (
                      <div key={f.key}>
                        <Label className="text-xs text-muted-foreground">
                          {f.label}
                        </Label>
                        <Input
                          type="number"
                          className="h-7 text-xs mt-1"
                          value={
                            (onvifForm as any)[f.key] ??
                            (onvifData as any)?.[f.key] ??
                            ""
                          }
                          onChange={(e) =>
                            setOnvifForm((p) => ({
                              ...p,
                              [f.key]: Number(e.target.value),
                            }))
                          }
                        />
                      </div>
                    ))}
                    <div className="flex items-center gap-2 pt-5">
                      <Switch
                        checked={
                          (onvifForm.enable_discovery ??
                            onvifData?.enable_discovery) === true
                        }
                        onCheckedChange={(v) =>
                          setOnvifForm((p) => ({ ...p, enable_discovery: v }))
                        }
                      />
                      <Label className="text-xs">Enable Discovery</Label>
                    </div>
                  </div>
                  <Button
                    size="sm"
                    className="h-7 text-xs"
                    disabled={
                      Object.keys(onvifForm).length === 0 || saveOnvif.isPending
                    }
                    onClick={() => saveOnvif.mutate()}
                  >
                    <Save className="h-3 w-3 mr-1" /> Save
                  </Button>
                </>
              )}
            </CardContent>
          )}
        </Card>

        {/* ── Camera Credentials ── */}
        <Card className="bg-card border-border">
          <CardHeader className="pb-2 pt-4 px-4">
            <div className="flex items-center justify-between">
              <SectionHeader
                icon={Camera}
                title={`Camera Credentials & Slots${camConfigs ? ` (${camConfigs.length})` : ""}`}
                open={open.cameras}
                onToggle={() => toggle("cameras")}
              />
              {open.cameras && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs ml-2 shrink-0"
                  onClick={() => { setAddCamOpen(true); setEditCam(null); }}
                >
                  <Plus className="h-3 w-3 mr-1" /> Add Camera
                </Button>
              )}
            </div>
          </CardHeader>
          {open.cameras && (
            <CardContent className="space-y-3 px-4 pb-4">
              <p className="text-[11px] text-muted-foreground bg-muted/30 rounded p-2">
                <span className="font-medium">Add Camera</span> scans the network for ONVIF cameras, or takes a camera's
                RTSP address directly. Use this list to review or rotate a camera's credentials, or to remove a camera.
                Removing a camera here removes it everywhere (camera grid, live view and recording).
              </p>

              {camConfigLoading ? (
                <p className="text-xs text-muted-foreground">Loading…</p>
              ) : (
                <div className="space-y-2">
                  {(!camConfigs || camConfigs.length === 0) && (
                    <p className="text-xs text-muted-foreground text-center py-4">
                      No cameras yet. Click "Add Camera" to
                      get started.
                    </p>
                  )}
                  {camConfigs?.map((cam) => (
                    <div
                      key={cam.id}
                      className="border border-border rounded-md p-3"
                    >
                      {editCam?.camera_slot === cam.camera_slot ? (
                        <div className="space-y-3">
                          <p className="text-xs font-semibold">
                            Editing Slot {cam.camera_slot}
                          </p>
                          <CameraForm
                            form={editCam}
                            onChange={(vals) => setEditCam(vals)}
                          />
                          <div className="flex gap-2">
                            <Button
                              size="sm"
                              className="h-7 text-xs"
                              disabled={updateCamera.isPending}
                              onClick={() => updateCamera.mutate()}
                            >
                              <Save className="h-3 w-3 mr-1" /> Update
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="h-7 text-xs"
                              onClick={() => setEditCam(null)}
                            >
                              Cancel
                            </Button>
                          </div>
                        </div>
                      ) : (
                        <div className="flex items-start gap-2">
                          <div className="grid grid-cols-2 md:grid-cols-5 gap-x-4 gap-y-1 flex-1 text-xs">
                            <div>
                              <span className="text-muted-foreground">
                                Slot{" "}
                              </span>
                              <span className="font-mono font-bold">
                                {cam.camera_slot}
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">
                                Name{" "}
                              </span>
                              <span>{cam.name}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">IP </span>
                              <span className="font-mono">
                                {cam.ip_address}:{cam.onvif_port}
                              </span>
                            </div>
                            <div>
                              <Badge
                                variant="outline"
                                className="text-[9px] h-4"
                              >
                                {cam.camera_type}
                              </Badge>
                            </div>
                            <div>
                              <Badge
                                variant={
                                  cam.is_active ? "default" : "secondary"
                                }
                                className="text-[9px] h-4"
                              >
                                {cam.is_active ? "Active" : "Inactive"}
                              </Badge>
                            </div>
                            <div className="col-span-2">
                              <span className="text-muted-foreground">
                                Location{" "}
                              </span>
                              <span>{cam.location || "—"}</span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">
                                ONVIF{" "}
                              </span>
                              <span className="font-mono">
                                {cam.onvif_username} / ••••
                              </span>
                            </div>
                            <div>
                              <span className="text-muted-foreground">
                                RTSP{" "}
                              </span>
                              <span className="font-mono">
                                {cam.rtsp_username} / ••••
                              </span>
                            </div>
                          </div>
                          <div className="flex gap-1 shrink-0">
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6"
                              onClick={() => {
                                setEditCam({
                                  ...cam,
                                  onvif_password: "",
                                  rtsp_password: "",
                                });
                                }}
                            >
                              <Settings className="h-3 w-3" />
                            </Button>
                            <Button
                              size="icon"
                              variant="ghost"
                              className="h-6 w-6 text-destructive hover:text-destructive"
                              onClick={() => setDeleteCamSlot(cam.camera_slot)}
                            >
                              <Trash2 className="h-3 w-3" />
                            </Button>
                          </div>
                        </div>
                      )}
                    </div>
                  ))}

                </div>
              )}
            </CardContent>
          )}
        </Card>
      </div>

      <DiscoverCameraDialog
        open={addCamOpen}
        onClose={() => setAddCamOpen(false)}
        onAdded={() => {
          qc.invalidateQueries({ queryKey: ["settings-cameras"] });
          qc.invalidateQueries({ queryKey: ["cameras"] });
        }}
      />

      <AlertDialog
        open={deleteCamSlot !== null}
        onOpenChange={() => setDeleteCamSlot(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove Camera Slot {deleteCamSlot}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              This removes the camera completely: it disappears from the camera
              grid, live view and recording stop, and its saved credentials are
              deleted. Footage files already recorded stay on disk, but the
              camera's recordings are no longer listed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              className="bg-destructive text-destructive-foreground"
              onClick={() =>
                deleteCamSlot !== null && deleteCamera.mutate(deleteCamSlot)
              }
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
};

export default SettingsPage;
