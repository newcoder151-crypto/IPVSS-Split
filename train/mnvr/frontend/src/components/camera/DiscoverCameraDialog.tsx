import { useState, useEffect } from "react";
import { Wand2, RefreshCw, Loader2, CheckCircle2, XCircle, Link2, ScanSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCreateCamera, useProbeRtsp, type RtspProbeResult } from "@/hooks/use-cameras";
import { useDiscoverOnvifDevices, useProbeOnvifDevice, type DiscoveredDevice, type ProbedDeviceInfo } from "@/hooks/use-onvif";
import { useToast } from "@/hooks/use-toast";

// Add Camera dialog, shared by the camera grid and Settings. Two ways in:
//   1. Scan network - ONVIF discovery, then just a username and password (everything else is read from the camera).
//   2. RTSP address - type or paste the camera's RTSP URL (credentials may be inside it). Works with any camera, with or
//      without ONVIF, and for cameras that cannot be discovered (other network, factory password not yet changed...).
type DiscoverStep = "scan" | "credentials" | "confirm";
type Mode = "scan" | "rtsp";

export function DiscoverCameraDialog({ open, onClose, onAdded }: { open: boolean; onClose: () => void; onAdded: () => void }) {
  const { toast } = useToast();
  const discover = useDiscoverOnvifDevices();
  const probe = useProbeOnvifDevice();
  const probeRtsp = useProbeRtsp();
  const createCamera = useCreateCamera();

  const [mode, setMode] = useState<Mode>("scan");
  const [step, setStep] = useState<DiscoverStep>("scan");
  const [selected, setSelected] = useState<{ hostname: string; port: number; path: string } | null>(null);
  const [manualHost, setManualHost] = useState("");
  const [creds, setCreds] = useState({ username: "", password: "" });
  const [probed, setProbed] = useState<ProbedDeviceInfo | null>(null);
  const [cameraName, setCameraName] = useState("");
  const [cameraType, setCameraType] = useState("INTERIOR");
  const [locationDescription, setLocationDescription] = useState("");
  // RTSP-address mode
  const [rtspUrl, setRtspUrl] = useState("");
  const [subUrl, setSubUrl] = useState("");
  const [rtspCreds, setRtspCreds] = useState({ username: "", password: "" });
  const [rtspResult, setRtspResult] = useState<RtspProbeResult | null>(null);
  const [rtspError, setRtspError] = useState<string | null>(null);

  const reset = () => {
    setMode("scan"); setStep("scan"); setSelected(null); setManualHost(""); setCreds({ username: "", password: "" });
    setProbed(null); setCameraName(""); setCameraType("INTERIOR"); setLocationDescription("");
    setRtspUrl(""); setSubUrl(""); setRtspCreds({ username: "", password: "" }); setRtspResult(null); setRtspError(null);
  };

  useEffect(() => {
    if (open) { reset(); discover.mutate(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const pickDevice = (d: { hostname: string; port: number; path: string }) => { setSelected(d); setStep("credentials"); };

  const handleConnect = async (e: React.FormEvent) => {
    e.preventDefault();
    const target = selected ?? { hostname: manualHost, port: 80, path: "/onvif/device_service" };
    if (!target.hostname) { toast({ title: "Enter a camera IP address", variant: "destructive" }); return; }
    try {
      const info = await probe.mutateAsync({ hostname: target.hostname, port: target.port, path: target.path, username: creds.username, password: creds.password });
      setSelected(target); setProbed(info); setCameraName(info.suggested_name); setStep("confirm");
    } catch { /* toast already shown by onvifMutationErrorHandler */ }
  };

  const finishAdd = (created: { connectivity?: { reachable?: boolean; error?: string } }) => {
    if (created.connectivity?.reachable === false) {
      toast({ title: "Camera saved, but couldn't connect", description: created.connectivity.error || "Double-check the address and credentials.", variant: "destructive" });
    } else {
      toast({ title: "Camera added", description: "Its stream appears in the grid within ~15s." });
    }
    onAdded(); onClose();
  };

  const handleConfirmAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!selected || !probed) return;
    try {
      const created = await createCamera.mutateAsync({
        camera_name: cameraName || probed.suggested_name, camera_type: cameraType, ip_address: selected.hostname,
        rtsp_url: probed.rtsp_url || "", rec_rtsp_url: "", third_rtsp_url: probed.third_rtsp_url || "",
        username: creds.username, password_hash: creds.password, location_description: locationDescription,
      });
      finishAdd(created);
    } catch (err: any) { toast({ title: "Error", description: err.message, variant: "destructive" }); }
  };

  // ---- RTSP address mode
  const testRtsp = async () => {
    setRtspResult(null); setRtspError(null);
    try {
      const r = await probeRtsp.mutateAsync({ rtsp_url: rtspUrl.trim(), username: rtspCreds.username, password: rtspCreds.password });
      setRtspResult(r);
      if (!cameraName) setCameraName(r.host);
    } catch (err: any) { setRtspError(err.message); }
  };

  const handleRtspAdd = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const created = await createCamera.mutateAsync({
        camera_name: cameraName || rtspResult?.host || "Camera", camera_type: cameraType, rtsp_url: rtspUrl.trim(),
        third_rtsp_url: subUrl.trim() || undefined, username: rtspCreds.username || undefined, password_hash: rtspCreds.password || undefined,
        location_description: locationDescription, ...(rtspResult?.video?.width ? { resolution_width: rtspResult.video.width, resolution_height: rtspResult.video.height } : {}),
      });
      finishAdd(created);
    } catch (err: any) { toast({ title: "Could not add camera", description: err.message, variant: "destructive" }); }
  };

  const typeAndLocation = (
    <>
      <div>
        <Label className="text-xs">Camera Name</Label>
        <Input className="mt-1" required value={cameraName} onChange={(e) => setCameraName(e.target.value)} />
      </div>
      <div>
        <Label className="text-xs">Type</Label>
        <Select value={cameraType} onValueChange={setCameraType}>
          <SelectTrigger className="mt-1"><SelectValue /></SelectTrigger>
          <SelectContent>{["INTERIOR", "EXTERIOR", "DOOR", "DRIVER_CAB"].map((t) => (<SelectItem key={t} value={t}>{t}</SelectItem>))}</SelectContent>
        </Select>
      </div>
      <div>
        <Label className="text-xs">Location <span className="text-muted-foreground">(optional)</span></Label>
        <Input className="mt-1" placeholder="Coach S1 - Front" value={locationDescription} onChange={(e) => setLocationDescription(e.target.value)} />
      </div>
    </>
  );

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="bg-card border-border max-w-md max-h-[90vh] overflow-y-auto">
        <DialogTitle className="flex items-center gap-2">
          <Wand2 className="h-4 w-4 text-primary" />
          Add Camera
        </DialogTitle>

        <div className="grid grid-cols-2 gap-1 rounded-md bg-muted/40 p-1 text-xs">
          {([["scan", "Scan network", ScanSearch], ["rtsp", "RTSP address", Link2]] as const).map(([k, label, Icon]) => (
            <button key={k} type="button" onClick={() => { setMode(k); if (k === "scan") setStep("scan"); }}
              className={`flex items-center justify-center gap-1.5 rounded px-2 py-1.5 transition-colors ${mode === k ? "bg-background shadow text-foreground font-medium" : "text-muted-foreground hover:text-foreground"}`}>
              <Icon className="h-3.5 w-3.5" /> {label}
            </button>
          ))}
        </div>

        {mode === "scan" && step === "scan" && (
          <div className="space-y-3 mt-2">
            <div className="flex items-center justify-between">
              <p className="text-xs text-muted-foreground">
                Scanning the local network for ONVIF cameras…
              </p>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs gap-1"
                onClick={() => discover.mutate()}
                disabled={discover.isPending}
              >
                <RefreshCw className={`h-3 w-3 ${discover.isPending ? "animate-spin" : ""}`} />
                Rescan
              </Button>
            </div>

            {discover.isPending && (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
              </div>
            )}

            {!discover.isPending && (discover.data?.devices?.length ?? 0) === 0 && (
              <p className="text-xs text-muted-foreground text-center py-4">
                No ONVIF devices found on this network. If your camera is on a
                different VLAN, enter its IP manually below.
              </p>
            )}

            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {discover.data?.devices?.map((d: DiscoveredDevice) => (
                <button
                  key={d.hostname}
                  disabled={d.already_added}
                  onClick={() => pickDevice(d)}
                  className={`w-full flex items-center justify-between gap-2 px-3 py-2 rounded-md border text-left text-xs transition-colors ${
                    d.already_added
                      ? "border-border bg-muted/30 text-muted-foreground cursor-not-allowed"
                      : "border-border hover:border-primary hover:bg-muted/50"
                  }`}
                >
                  <span className="font-mono">{d.hostname}</span>
                  {d.already_added ? (
                    <span className="flex items-center gap-1 text-[10px]">
                      <CheckCircle2 className="h-3 w-3" /> Already added
                    </span>
                  ) : (
                    <span className="text-[10px] text-primary">Select →</span>
                  )}
                </button>
              ))}
            </div>

            <div className="pt-2 border-t border-border space-y-2">
              <Label className="text-xs">Or enter IP manually</Label>
              <div className="flex gap-2">
                <Input
                  placeholder="192.168.1.101"
                  value={manualHost}
                  onChange={(e) => setManualHost(e.target.value)}
                  className="h-8 text-xs"
                />
                <Button
                  size="sm"
                  className="h-8 text-xs shrink-0"
                  disabled={!manualHost}
                  onClick={() => pickDevice({ hostname: manualHost, port: 80, path: "/onvif/device_service" })}
                >
                  Use IP
                </Button>
              </div>
            </div>
          </div>
        )}

        {mode === "scan" && step === "credentials" && selected && (
          <form onSubmit={handleConnect} className="space-y-3 mt-2">
            <p className="text-xs text-muted-foreground">
              Connecting to <span className="font-mono">{selected.hostname}</span>.
              Enter the camera's ONVIF username and password — everything
              else is read automatically.
            </p>
            <div>
              <Label className="text-xs">Username</Label>
              <Input
                className="mt-1"
                autoComplete="off"
                required
                value={creds.username}
                onChange={(e) => setCreds({ ...creds, username: e.target.value })}
              />
            </div>
            <div>
              <Label className="text-xs">Password</Label>
              <Input
                className="mt-1"
                type="password"
                autoComplete="off"
                required
                value={creds.password}
                onChange={(e) => setCreds({ ...creds, password: e.target.value })}
              />
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" className="flex-1" onClick={() => setStep("scan")}>
                Back
              </Button>
              <Button type="submit" className="flex-1" disabled={probe.isPending}>
                {probe.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                Connect
              </Button>
            </div>
          </form>
        )}

        {mode === "scan" && step === "confirm" && probed && selected && (
          <form onSubmit={handleConfirmAdd} className="space-y-3 mt-2">
            <div className="rounded-md bg-muted/40 p-2.5 text-xs space-y-1">
              <p className="flex items-center gap-1.5 text-green-600 dark:text-green-400 font-medium">
                <CheckCircle2 className="h-3.5 w-3.5" /> Connected
              </p>
              {probed.model && <p>Model: {probed.manufacturer} {probed.model}</p>}
              {probed.resolution_width && (
                <p>Resolution: {probed.resolution_width}×{probed.resolution_height}</p>
              )}
              <p>{probed.profile_count} stream profile(s) found{probed.third_rtsp_url ? " (incl. sub-stream)" : ""}</p>
            </div>
            <div>
              <Label className="text-xs">Camera Name</Label>
              <Input
                className="mt-1"
                required
                value={cameraName}
                onChange={(e) => setCameraName(e.target.value)}
              />
            </div>
            <div>
              <Label className="text-xs">Type</Label>
              <Select value={cameraType} onValueChange={setCameraType}>
                <SelectTrigger className="mt-1">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {["INTERIOR", "EXTERIOR", "DOOR", "DRIVER_CAB"].map((t) => (
                    <SelectItem key={t} value={t}>{t}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="text-xs">Location <span className="text-muted-foreground">(optional)</span></Label>
              <Input
                className="mt-1"
                placeholder="Coach S1 — Front"
                value={locationDescription}
                onChange={(e) => setLocationDescription(e.target.value)}
              />
            </div>
            <div className="flex gap-2">
              <Button type="button" variant="outline" className="flex-1" onClick={() => setStep("credentials")}>
                Back
              </Button>
              <Button type="submit" className="flex-1" disabled={createCamera.isPending}>
                {createCamera.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
                Add Camera
              </Button>
            </div>
          </form>
        )}
        {mode === "rtsp" && (
          <form onSubmit={handleRtspAdd} className="space-y-3 mt-2">
            <p className="text-xs text-muted-foreground">
              Paste the camera's RTSP address. Username and password can be part of it
              (<span className="font-mono">rtsp://user:pass@192.168.1.20:554/stream1</span>) or typed below.
            </p>
            <div>
              <Label className="text-xs">RTSP address (main / recording stream)</Label>
              <Input className="mt-1 font-mono text-xs" required placeholder="rtsp://192.168.1.20:554/stream1" value={rtspUrl}
                onChange={(e) => { setRtspUrl(e.target.value); setRtspResult(null); setRtspError(null); }} />
            </div>
            <div className="grid grid-cols-2 gap-2">
              <div><Label className="text-xs">Username <span className="text-muted-foreground">(if not in the address)</span></Label>
                <Input className="mt-1" autoComplete="off" value={rtspCreds.username} onChange={(e) => setRtspCreds({ ...rtspCreds, username: e.target.value })} /></div>
              <div><Label className="text-xs">Password</Label>
                <Input className="mt-1" type="password" autoComplete="off" value={rtspCreds.password} onChange={(e) => setRtspCreds({ ...rtspCreds, password: e.target.value })} /></div>
            </div>
            <div>
              <Label className="text-xs">Sub-stream address <span className="text-muted-foreground">(optional, lighter stream for live view)</span></Label>
              <Input className="mt-1 font-mono text-xs" placeholder="rtsp://192.168.1.20:554/stream2" value={subUrl} onChange={(e) => setSubUrl(e.target.value)} />
            </div>
            <Button type="button" variant="outline" className="w-full gap-2" disabled={!rtspUrl.trim() || probeRtsp.isPending} onClick={testRtsp}>
              {probeRtsp.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />} Test connection
            </Button>
            {rtspResult && (
              <div className={`rounded-md p-2.5 text-xs flex items-start gap-2 ${rtspResult.reachable ? "bg-green-500/10 text-green-600 dark:text-green-400" : "bg-destructive/10 text-destructive"}`}>
                {rtspResult.reachable ? <CheckCircle2 className="h-3.5 w-3.5 mt-0.5 shrink-0" /> : <XCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />}
                <div>
                  {rtspResult.reachable
                    ? <>Connected to <span className="font-mono">{rtspResult.host}:{rtspResult.port}</span>
                        {rtspResult.video ? <> - {rtspResult.video.codec?.toUpperCase()} {rtspResult.video.width}x{rtspResult.video.height}</> : null}
                        {rtspResult.has_audio ? " + audio" : ""}</>
                    : <>Could not connect: {rtspResult.error}. You can still add it and fix the address or password later.</>}
                </div>
              </div>
            )}
            {rtspError && <div className="rounded-md bg-destructive/10 text-destructive p-2.5 text-xs">{rtspError}</div>}
            {typeAndLocation}
            <Button type="submit" className="w-full" disabled={createCamera.isPending || !rtspUrl.trim()}>
              {createCamera.isPending && <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />}
              Add Camera
            </Button>
          </form>
        )}

      </DialogContent>
    </Dialog>
  );
}
