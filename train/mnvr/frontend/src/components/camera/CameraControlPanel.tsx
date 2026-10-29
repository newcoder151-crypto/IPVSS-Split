import { useEffect, useRef, useState } from "react";
import {
  ChevronUp,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Home,
  Plus,
  Minus,
  Video,
  Save,
  Trash2,
  RefreshCw,
  Sun,
  Contrast,
  Palette,
  Sparkles,
  Volume2,
  Loader2,
  AlertCircle,
  CheckCircle2,
  Radio,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Input } from "@/components/ui/input";
import { useToast } from "@/hooks/use-toast";
import {
  useOnvifCapabilities,
  useMediaProfiles,
  useActivateStreamProfile,
  usePtzStatus,
  usePtzMove,
  usePtzStop,
  usePtzHome,
  usePtzPresets,
  useCreatePtzPreset,
  useGotoPtzPreset,
  useDeletePtzPreset,
  useImageSettings,
  useUpdateImageSettings,
  useAudioSettings,
  useUpdateAudioSettings,
} from "@/hooks/use-onvif";
import { useCamera } from "@/hooks/use-cameras";
import { CameraAiModel } from "@/components/camera/CameraAiModel";

interface CameraControlPanelProps {
  cameraId: number;
  cameraName: string;
  ptzSupported?: boolean;
}

/* ── PTZ Joystick ─────────────────────────────────────────────────────── */
function PtzJoystick({ cameraId }: { cameraId: number }) {
  const { toast } = useToast();
  const move = usePtzMove(cameraId);
  const stop = usePtzStop(cameraId);
  const home = usePtzHome(cameraId);
  const { data: status } = usePtzStatus(cameraId);
  const [speed, setSpeed] = useState(0.5);
  const activeDir = useRef<string | null>(null);

  const startMove = (x: number, y: number, dir: string) => {
    activeDir.current = dir;
    move.mutate({ mode: "continuous", x: x * speed, y: y * speed, zoom: 0 });
  };

  const stopMove = () => {
    if (!activeDir.current) return;
    activeDir.current = null;
    stop.mutate();
  };

  const zoomMove = (z: number) => {
    activeDir.current = "zoom";
    move.mutate({ mode: "continuous", x: 0, y: 0, zoom: z * speed });
  };

  const dirBtn = (
    icon: React.ReactNode,
    x: number,
    y: number,
    dir: string,
    className = "",
  ) => (
    <button
      className={`flex items-center justify-center w-10 h-10 rounded-md bg-muted hover:bg-primary/20 active:bg-primary/40 transition-colors text-foreground ${className}`}
      onMouseDown={() => startMove(x, y, dir)}
      onMouseUp={stopMove}
      onMouseLeave={stopMove}
      onTouchStart={() => startMove(x, y, dir)}
      onTouchEnd={stopMove}
    >
      {icon}
    </button>
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="grid grid-cols-3 gap-1.5 w-fit">
          <div />
          {dirBtn(<ChevronUp className="h-4 w-4" />, 0, 1, "up")}
          <div />
          {dirBtn(<ChevronLeft className="h-4 w-4" />, -1, 0, "left")}
          <button
            className="flex items-center justify-center w-10 h-10 rounded-md bg-primary/10 hover:bg-primary/30 text-primary transition-colors"
            onClick={() => home.mutate("goto")}
            title="Go to home position"
          >
            <Home className="h-4 w-4" />
          </button>
          {dirBtn(<ChevronRight className="h-4 w-4" />, 1, 0, "right")}
          <div />
          {dirBtn(<ChevronDown className="h-4 w-4" />, 0, -1, "down")}
          <div />
        </div>

        <div className="flex flex-col items-center gap-1.5">
          <Label className="text-[10px] text-muted-foreground">Zoom</Label>
          <button
            className="flex items-center justify-center w-9 h-9 rounded-md bg-muted hover:bg-primary/20 active:bg-primary/40 transition-colors"
            onMouseDown={() => zoomMove(1)}
            onMouseUp={stopMove}
            onMouseLeave={stopMove}
            onTouchStart={() => zoomMove(1)}
            onTouchEnd={stopMove}
          >
            <Plus className="h-4 w-4" />
          </button>
          <button
            className="flex items-center justify-center w-9 h-9 rounded-md bg-muted hover:bg-primary/20 active:bg-primary/40 transition-colors"
            onMouseDown={() => zoomMove(-1)}
            onMouseUp={stopMove}
            onMouseLeave={stopMove}
            onTouchStart={() => zoomMove(-1)}
            onTouchEnd={stopMove}
          >
            <Minus className="h-4 w-4" />
          </button>
        </div>
      </div>

      <div>
        <div className="flex justify-between items-center mb-1">
          <Label className="text-xs text-muted-foreground">Speed</Label>
          <span className="text-xs font-mono text-foreground">
            {(speed * 100).toFixed(0)}%
          </span>
        </div>
        <Slider
          value={[speed]}
          min={0.1}
          max={1}
          step={0.05}
          onValueChange={([v]) => setSpeed(v)}
        />
      </div>

      {status && (
        <div className="grid grid-cols-3 gap-2 text-center text-xs bg-muted/40 rounded-md p-2">
          <div>
            <p className="text-muted-foreground text-[10px]">Pan</p>
            <p className="font-mono">{status.pan?.toFixed(2) ?? "—"}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-[10px]">Tilt</p>
            <p className="font-mono">{status.tilt?.toFixed(2) ?? "—"}</p>
          </div>
          <div>
            <p className="text-muted-foreground text-[10px]">Zoom</p>
            <p className="font-mono">{status.zoom?.toFixed(2) ?? "—"}</p>
          </div>
        </div>
      )}
    </div>
  );
}

/* ── PTZ Presets ──────────────────────────────────────────────────────── */
function PtzPresetsPanel({ cameraId }: { cameraId: number }) {
  const { toast } = useToast();
  const { data, isLoading } = usePtzPresets(cameraId);
  const create = useCreatePtzPreset(cameraId);
  const goto = useGotoPtzPreset(cameraId);
  const del = useDeletePtzPreset(cameraId);
  const [newName, setNewName] = useState("");

  const handleCreate = () => {
    if (!newName.trim()) return;
    create.mutate(newName.trim(), {
      onSuccess: () => {
        setNewName("");
        toast({ title: `Preset "${newName}" saved` });
      },
      onError: (e: any) =>
        toast({
          title: "Failed to save preset",
          description: e.message,
          variant: "destructive",
        }),
    });
  };

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <Input
          placeholder="New preset name…"
          value={newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleCreate()}
          className="h-8 text-xs"
        />
        <Button
          size="sm"
          className="h-8"
          onClick={handleCreate}
          disabled={create.isPending || !newName.trim()}
        >
          <Save className="h-3.5 w-3.5" />
        </Button>
      </div>

      {isLoading && (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground mx-auto" />
      )}

      {!isLoading && !data?.presets?.length && (
        <p className="text-xs text-muted-foreground text-center py-3">
          No presets saved yet
        </p>
      )}

      <div className="space-y-1 max-h-44 overflow-y-auto">
        {data?.presets?.map((p) => (
          <div
            key={p.preset_token}
            className="flex items-center justify-between gap-2 rounded-md bg-muted/40 px-2 py-1.5"
          >
            <button
              className="flex-1 text-left text-xs font-medium text-foreground hover:text-primary truncate"
              onClick={() => goto.mutate(p.preset_token)}
              disabled={goto.isPending}
            >
              {p.preset_name || p.preset_token}
            </button>
            <Button
              size="icon"
              variant="ghost"
              className="h-6 w-6 text-muted-foreground hover:text-destructive"
              onClick={() => del.mutate(p.preset_token)}
            >
              <Trash2 className="h-3 w-3" />
            </Button>
          </div>
        ))}
      </div>

      {data && !data.live && (
        <p className="text-[10px] text-amber-500 flex items-center gap-1">
          <AlertCircle className="h-3 w-3" /> Camera unreachable — showing
          last-known presets
        </p>
      )}
    </div>
  );
}

/* ── Stream Profile Selector ──────────────────────────────────────────── */
function StreamProfilesPanel({ cameraId }: { cameraId: number }) {
  const { toast } = useToast();
  const { data, isLoading, isError, error, refetch, isFetching } =
    useMediaProfiles(cameraId);
  const activate = useActivateStreamProfile(cameraId);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          {data?.profiles?.length ?? 0} stream profile(s) available
        </p>
        <Button
          size="sm"
          variant="ghost"
          className="h-7 px-2"
          onClick={() => refetch()}
          disabled={isFetching}
        >
          <RefreshCw
            className={`h-3.5 w-3.5 ${isFetching ? "animate-spin" : ""}`}
          />
        </Button>
      </div>

      {isLoading && (
        <Loader2 className="h-4 w-4 animate-spin text-muted-foreground mx-auto" />
      )}

      {isError && (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 flex items-start gap-2">
          <AlertCircle className="h-3.5 w-3.5 text-destructive shrink-0 mt-0.5" />
          <div>
            <p className="text-xs text-destructive font-medium">
              Couldn't reach the camera's ONVIF media service
            </p>
            <p className="text-[11px] text-muted-foreground mt-0.5">
              {(error as any)?.message || "Unknown error"}
            </p>
          </div>
        </div>
      )}

      <div className="space-y-2">
        {data?.profiles?.map((p) => (
          <div
            key={p.profile_token}
            className={`rounded-md border px-3 py-2 ${p.is_active_stream ? "border-primary bg-primary/5" : "border-border bg-muted/20"}`}
          >
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <Video className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
                  <p className="text-sm font-medium text-foreground truncate">
                    {p.profile_name || p.profile_token}
                  </p>
                  {p.is_active_stream && (
                    <Badge
                      variant="default"
                      className="text-[10px] px-1.5 py-0"
                    >
                      Active
                    </Badge>
                  )}
                </div>
                <p className="text-[11px] text-muted-foreground font-mono mt-0.5">
                  {p.resolution_width && p.resolution_height
                    ? `${p.resolution_width}×${p.resolution_height}`
                    : "—"}
                  {p.fps ? ` @ ${p.fps}fps` : ""}
                  {p.encoding ? ` · ${p.encoding}` : ""}
                  {p.bitrate_kbps ? ` · ${p.bitrate_kbps}kbps` : ""}
                </p>
              </div>
              {!p.is_active_stream && (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs shrink-0"
                  onClick={() =>
                    activate.mutate(p.profile_token, {
                      onSuccess: () =>
                        toast({
                          title: `Switched to ${p.profile_name || p.profile_token}`,
                          description:
                            "NVR will use this stream on next reload",
                        }),
                      onError: (e: any) =>
                        toast({
                          title: "Failed to switch stream",
                          description: e.message,
                          variant: "destructive",
                        }),
                    })
                  }
                  disabled={activate.isPending}
                >
                  Use this
                </Button>
              )}
            </div>
          </div>
        ))}
      </div>

      {!isLoading && !isError && !data?.profiles?.length && (
        <p className="text-xs text-muted-foreground text-center py-3">
          No stream profiles reported by this camera
        </p>
      )}
    </div>
  );
}

/* ── Image Settings ───────────────────────────────────────────────────── */
function ImageSettingsPanel({ cameraId }: { cameraId: number }) {
  const { data, isLoading } = useImageSettings(cameraId);
  const update = useUpdateImageSettings(cameraId);
  const [local, setLocal] = useState<Record<string, number>>({});

  // Diagnostic trace, temporary: helps confirm/rule out whether this
  // panel is remounting mid-interaction (which would reset `local` back
  // to {} right as the user drags) as the cause of the reported "—"
  // symptom. Safe to remove once that's confirmed either way.
  useEffect(() => {
    console.debug(`[ImageSettingsPanel] mounted for camera ${cameraId}`);
    return () =>
      console.debug(`[ImageSettingsPanel] UNMOUNTED for camera ${cameraId}`);
  }, [cameraId]);

  useEffect(() => {
    if (data) {
      console.debug(
        "[ImageSettingsPanel] data-driven reset firing, raw data:",
        data,
      );
      // Number(...) here is load-bearing, not defensive styling: the
      // ONVIF image-settings endpoint returns these as strings (e.g.
      // "50"), and a string silently passes `?.toFixed` in sliderRow's
      // display (a string isn't null/undefined, so optional chaining
      // doesn't short-circuit) only to then throw
      // "toFixed is not a function", since String.prototype has no
      // toFixed. Coercing once here, at the single point data enters
      // this component's state, means every consumer of `local` below
      // can safely assume real numbers.
      setLocal({
        brightness: Number(data.brightness ?? 50),
        contrast: Number(data.contrast ?? 50),
        saturation: Number(data.color_saturation ?? 50),
        sharpness: Number(data.sharpness ?? 50),
      });
    }
  }, [data]);

  const commit = (key: string, value: number) => {
    update.mutate({ [key]: value } as any);
  };

  const sliderRow = (key: string, label: string, icon: React.ReactNode, minRaw: number = 0, maxRaw: number = 100) => {
    // Root cause of the reported NaN/frozen-slider bug: Radix's Slider
    // does internal math like (value - min) / (max - min) on every drag
    // to compute position. If min/max come in as strings (same
    // string-vs-number issue already fixed for the value itself below)
    // or if this camera's ONVIF response reports min >= max for one
    // setting (confirmed: saturation), that division produces NaN on
    // every interaction. Coercing AND validating here means every
    // sliderRow() call gets a guaranteed-sane numeric range regardless
    // of what the camera actually returned.
    const min = Number(minRaw);
    const max = Number(maxRaw);
    const safeMin = isFinite(min) ? min : 0;
    const safeMax = isFinite(max) && max > safeMin ? max : safeMin + 100;
    return (
      <div>
        <div className="flex items-center justify-between mb-1">
          <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
            {icon}
            {label}
          </Label>
          <span className="text-xs font-mono text-foreground">
            {isFinite(Number(local[key])) ? Number(local[key]).toFixed(0) : "—"}
          </span>
        </div>
        <Slider
          value={[isFinite(Number(local[key])) ? Math.min(Math.max(Number(local[key]), safeMin), safeMax) : (safeMin + safeMax) / 2]}
          min={safeMin}
          max={safeMax}
          step={1}
          onValueChange={([v]) => {
            const n = Number(v);
            if (!isFinite(n)) {
              console.warn(`[ImageSettingsPanel] onValueChange got a non-finite value for "${key}":`, v);
            }
            setLocal((p) => ({ ...p, [key]: isFinite(n) ? n : (p[key] ?? 50) }));
          }}
          onValueCommit={([v]) => {
            const n = Number(v);
            if (isFinite(n)) commit(key === "saturation" ? "saturation" : key, n);
          }}
        />
      </div>
    );
  };

  if (isLoading)
    return (
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground mx-auto" />
    );

  return (
    <div className="space-y-4">
      {sliderRow(
        "brightness",
        "Brightness",
        <Sun className="h-3.5 w-3.5" />,
        data?.brightness_min ?? 0,
        data?.brightness_max ?? 100,
      )}
      {sliderRow(
        "contrast",
        "Contrast",
        <Contrast className="h-3.5 w-3.5" />,
        data?.contrast_min ?? 0,
        data?.contrast_max ?? 100,
      )}
      {sliderRow(
        "saturation",
        "Saturation",
        <Palette className="h-3.5 w-3.5" />,
        data?.saturation_min ?? 0,
        data?.saturation_max ?? 100,
      )}
      {sliderRow(
        "sharpness",
        "Sharpness",
        <Sparkles className="h-3.5 w-3.5" />,
        data?.sharpness_min ?? 0,
        data?.sharpness_max ?? 100,
      )}

      <div className="flex items-center justify-between pt-1">
        <Label className="text-xs text-muted-foreground">
          Wide Dynamic Range
        </Label>
        <Switch
          checked={!!data?.wide_dynamic_range}
          onCheckedChange={(v) => update.mutate({ wide_dynamic_range: v })}
        />
      </div>

      <div>
        <Label className="text-xs text-muted-foreground mb-1 block">
          IR Cut Filter
        </Label>
        <Select
          value={data?.ir_cut_filter ?? "AUTO"}
          onValueChange={(v) => update.mutate({ ir_cut_filter: v })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="AUTO">Auto</SelectItem>
            <SelectItem value="ON">On (Night mode)</SelectItem>
            <SelectItem value="OFF">Off (Day mode)</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label className="text-xs text-muted-foreground mb-1 block">
          Exposure Mode
        </Label>
        <Select
          value={data?.exposure_mode ?? "AUTO"}
          onValueChange={(v) => update.mutate({ exposure_mode: v })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="AUTO">Auto</SelectItem>
            <SelectItem value="MANUAL">Manual</SelectItem>
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/* ── Audio Settings ───────────────────────────────────────────────────── */
function AudioSettingsPanel({ cameraId }: { cameraId: number }) {
  const { data, isLoading } = useAudioSettings(cameraId);
  const update = useUpdateAudioSettings(cameraId);

  if (isLoading)
    return (
      <Loader2 className="h-4 w-4 animate-spin text-muted-foreground mx-auto" />
    );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <Label className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Volume2 className="h-3.5 w-3.5" /> Audio Enabled
        </Label>
        <Switch
          checked={!!data?.is_enabled}
          onCheckedChange={(v) => update.mutate({ is_enabled: v })}
        />
      </div>

      <div>
        <Label className="text-xs text-muted-foreground mb-1 block">
          Encoding
        </Label>
        <Select
          value={data?.encoding ?? "AAC"}
          onValueChange={(v) => update.mutate({ encoding: v })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="G711">G.711</SelectItem>
            <SelectItem value="G726">G.726</SelectItem>
            <SelectItem value="AAC">AAC</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label className="text-xs text-muted-foreground mb-1 block">
          Bitrate (kbps)
        </Label>
        <Select
          value={String(data?.bitrate_kbps ?? 64)}
          onValueChange={(v) => update.mutate({ bitrate_kbps: Number(v) })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[16, 32, 64, 96, 128].map((b) => (
              <SelectItem key={b} value={String(b)}>
                {b} kbps
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label className="text-xs text-muted-foreground mb-1 block">
          Sample Rate (kHz)
        </Label>
        <Select
          value={String(data?.sample_rate_khz ?? 16)}
          onValueChange={(v) => update.mutate({ sample_rate_khz: Number(v) })}
        >
          <SelectTrigger className="h-8 text-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {[8, 16, 32, 44.1, 48].map((s) => (
              <SelectItem key={s} value={String(s)}>
                {s} kHz
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}

/* ── Main exported panel ──────────────────────────────────────────────── */
export function CameraControlPanel({
  cameraId,
  cameraName,
  ptzSupported,
}: CameraControlPanelProps) {
  const { data: caps, isLoading: capsLoading } = useOnvifCapabilities(cameraId);
  // Real device/stream connectivity (same source the Camera Grid uses), so this
  // panel doesn't call a camera "Offline" just because the separate ONVIF
  // control channel failed to answer while the video stream is fine.
  const { data: camera, isLoading: cameraLoading } = useCamera(cameraId);
  const isDeviceOnline = !!camera?.is_online;

  const hasPtz = caps?.supports_ptz ?? !!ptzSupported;
  const hasImaging = caps?.supports_imaging ?? true;
  const hasAudio = caps?.supports_audio ?? true;

  return (
    <div className="bg-card border border-border rounded-lg p-3">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <Radio className="h-4 w-4 text-primary" />
          <p className="text-sm font-semibold text-foreground">
            Camera Controls — {cameraName}
          </p>
        </div>
        {capsLoading || cameraLoading ? (
          <Badge variant="outline" className="text-[10px] gap-1">
            <Loader2 className="h-3 w-3 animate-spin" />
            Checking
          </Badge>
        ) : !isDeviceOnline ? (
          <Badge variant="destructive" className="text-[10px] gap-1">
            <AlertCircle className="h-3 w-3" />
            Offline
          </Badge>
        ) : (
          <Badge
            variant="outline"
            className="text-[10px] gap-1 text-green-600 border-green-600/30"
          >
            <CheckCircle2 className="h-3 w-3" />
            Online
          </Badge>
        )}
      </div>

      <Tabs defaultValue="streams" className="w-full">
        <TabsList className="grid w-full grid-cols-5 h-8">
          <TabsTrigger value="streams" className="text-xs">
            Streams
          </TabsTrigger>
          <TabsTrigger value="ptz" className="text-xs" disabled={!hasPtz}>
            PTZ
          </TabsTrigger>
          <TabsTrigger value="image" className="text-xs" disabled={!hasImaging}>
            Image
          </TabsTrigger>
          <TabsTrigger value="audio" className="text-xs" disabled={!hasAudio}>
            Audio
          </TabsTrigger>
          <TabsTrigger value="ai" className="text-xs">
            AI Model
          </TabsTrigger>
        </TabsList>

        <TabsContent value="streams" className="mt-3">
          <StreamProfilesPanel cameraId={cameraId} />
        </TabsContent>

        <TabsContent value="ptz" className="mt-3">
          {hasPtz ? (
            <Tabs defaultValue="joystick">
              <TabsList className="grid grid-cols-2 h-7 mb-3">
                <TabsTrigger value="joystick" className="text-[11px]">
                  Joystick
                </TabsTrigger>
                <TabsTrigger value="presets" className="text-[11px]">
                  Presets
                </TabsTrigger>
              </TabsList>
              <TabsContent value="joystick">
                <PtzJoystick cameraId={cameraId} />
              </TabsContent>
              <TabsContent value="presets">
                <PtzPresetsPanel cameraId={cameraId} />
              </TabsContent>
            </Tabs>
          ) : (
            <p className="text-xs text-muted-foreground text-center py-4">
              This camera does not support PTZ
            </p>
          )}
        </TabsContent>

        <TabsContent value="image" className="mt-3">
          <ImageSettingsPanel cameraId={cameraId} />
        </TabsContent>

        <TabsContent value="audio" className="mt-3">
          <AudioSettingsPanel cameraId={cameraId} />
        </TabsContent>

        <TabsContent value="ai" className="mt-3">
          <CameraAiModel cameraId={cameraId} aiDetectionEnabled={camera?.ai_detection_enabled} />
        </TabsContent>
      </Tabs>
    </div>
  );
}

export default CameraControlPanel;
