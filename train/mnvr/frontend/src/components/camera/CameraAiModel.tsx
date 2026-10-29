import { useEffect, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Loader2, AlertCircle, CheckCircle2 } from "lucide-react";
import { apiGet, apiPut } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

// "AI Model" tab of the camera controls: which AI model runs on this camera.
// The options are NOT hard-coded: GET /api/analytics/models reads REGISTRY in
// backend/ai/analytics/analyzers/__init__.py every time, so adding / removing / renaming an
// analyzer there changes this list. (If that endpoint is unreachable - e.g. an older API - the
// list falls back to the names the per-camera endpoint reports.)
interface Model { name: string; label: string }
interface AnalyticRow { analytic: string; enabled: boolean; params: Record<string, unknown> | null }

const NONE = "__none__";
const pretty = (n: string) => n.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());

export function CameraAiModel({ cameraId, aiDetectionEnabled }: { cameraId: number; aiDetectionEnabled?: boolean }) {
  const { isAdmin } = useAuth();
  const { toast } = useToast();
  const qc = useQueryClient();
  const [saving, setSaving] = useState(false);

  const models = useQuery({
    queryKey: ["analytics-models"],
    queryFn: () => apiGet<{ models: Model[]; source?: string }>("/api/analytics/models"),
    staleTime: 0,
    refetchOnMount: "always",
    retry: false,
  });
  const cam = useQuery({
    queryKey: ["camera-analytics", cameraId],
    queryFn: () => apiGet<{ available: string[]; analytics: AnalyticRow[] }>(`/api/analytics/cameras/${cameraId}`),
    refetchOnMount: "always",
    retry: false,
  });

  const rows = cam.data?.analytics ?? [];
  const enabled = rows.filter((r) => r.enabled);
  const current = enabled[0]?.analytic ?? NONE;
  const live = enabled[0] ? enabled[0].params?.shadow === false : true;   // analyzers start in "shadow" (log only) until shadow=false

  const list: Model[] = models.data?.models
    ?? (cam.data?.available ?? []).map((n) => ({ name: n, label: pretty(n) }));
  const known = new Set(list.map((m) => m.name));
  const labelOf = (n: string) => list.find((m) => m.name === n)?.label ?? n;

  const [value, setValue] = useState<string>(current);
  useEffect(() => { setValue(current); }, [current]);

  const paramsOf = (name: string) => (rows.find((r) => r.analytic === name)?.params ?? {}) as Record<string, unknown>;
  const refresh = async () => {
    await qc.invalidateQueries({ queryKey: ["camera-analytics", cameraId] });
    qc.invalidateQueries({ queryKey: ["cameras"] });
  };
  const fail = (title: string, e: any) =>
    toast({ title, description: e?.message ?? String(e), variant: "destructive" });

  // choose a model: one per camera - the others are switched off, the chosen one on (and live)
  const choose = async (next: string) => {
    const prev = value;
    setValue(next);
    setSaving(true);
    try {
      for (const r of enabled) {
        if (r.analytic !== next) await apiPut(`/api/analytics/cameras/${cameraId}/${r.analytic}`, { enabled: false });
      }
      if (next !== NONE) {
        await apiPut(`/api/analytics/cameras/${cameraId}/${next}`, { enabled: true, params: { ...paramsOf(next), shadow: false } });
        // the AI worker only looks at cameras whose AI detection switch is on
        if (aiDetectionEnabled === false) await apiPut(`/api/cameras/${cameraId}`, { ai_detection_enabled: true });
      }
      await refresh();
      toast({
        title: next === NONE ? "AI model turned off" : "AI model started",
        description: next === NONE ? "No AI model runs on this camera." : `${labelOf(next)} will start on this camera within about 30 seconds.`,
      });
    } catch (e) {
      setValue(prev);
      fail("Could not change the AI model", e);
    } finally {
      setSaving(false);
    }
  };

  // live alerts on/off for the running model (off = test mode: events are logged as INFO "[SHADOW]" only)
  const setLive = async (on: boolean) => {
    if (current === NONE) return;
    setSaving(true);
    try {
      await apiPut(`/api/analytics/cameras/${cameraId}/${current}`, { params: { ...paramsOf(current), shadow: !on } });
      await refresh();
    } catch (e) {
      fail("Could not change the alert mode", e);
    } finally {
      setSaving(false);
    }
  };

  const loading = models.isLoading || cam.isLoading;
  const orphan = value !== NONE && !known.has(value) && !loading;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2">
        <Brain className="h-4 w-4 text-primary" />
        <p className="text-sm font-medium text-foreground">AI model for this camera</p>
        {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" />}
      </div>

      <Select value={value} onValueChange={choose} disabled={!isAdmin || saving || loading || cam.isError}>
        <SelectTrigger className="h-9 w-full max-w-sm text-sm">
          <SelectValue placeholder={loading ? "Loading..." : "Select AI model"} />
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>None (AI off)</SelectItem>
          {list.map((m) => (
            <SelectItem key={m.name} value={m.name}>{m.label}</SelectItem>
          ))}
          {orphan && <SelectItem value={value}>{value} (no longer available)</SelectItem>}
        </SelectContent>
      </Select>

      {current !== NONE && (
        <div className="flex items-center gap-2 text-xs">
          <Switch checked={live} onCheckedChange={setLive} disabled={!isAdmin || saving} />
          <Label className="text-xs text-muted-foreground">
            {live ? "Live: detections raise real alerts" : "Test mode: detections are only logged as [SHADOW] info events"}
          </Label>
        </div>
      )}

      {current !== NONE && !saving && (
        <p className="flex items-center gap-1.5 text-[11px] text-green-600">
          <CheckCircle2 className="h-3.5 w-3.5" /> {labelOf(current)} is set for this camera
        </p>
      )}
      {!isAdmin && <p className="text-[11px] text-muted-foreground">Only an administrator can change the AI model.</p>}
      {models.isError && !cam.isError && (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-600">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
          The live model list could not be read ({(models.error as Error)?.message}); showing the models this camera reports. Restart the M-NVR API so it has the new analytics route.
        </p>
      )}
      {models.data?.source === "builtin" && (
        <p className="flex items-start gap-1.5 text-[11px] text-amber-600">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
          backend/ai/analytics/analyzers/__init__.py was not found by the API, so a built-in list is shown (set ANALYZERS_DIR if the folder is elsewhere).
        </p>
      )}
      {cam.isError && (
        <p className="flex items-start gap-1.5 text-[11px] text-destructive">
          <AlertCircle className="h-3.5 w-3.5 shrink-0 mt-px" />
          Could not load this camera's AI settings: {(cam.error as Error)?.message}
        </p>
      )}
    </div>
  );
}
