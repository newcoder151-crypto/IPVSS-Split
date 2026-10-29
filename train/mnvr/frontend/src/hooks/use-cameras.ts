import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, apiDelete } from "@/lib/api";

export interface Camera {
  camera_id: number; camera_name: string; camera_type: string;
  ip_address: string; rtsp_url: string; rtsp_port: number;
  status: string; location_description: string | null; physical_position: string | null;
  resolution_width: number; resolution_height: number; target_fps: number;
  video_codec: string; audio_supported: number; ptz_supported: number;
  manufacturer: string | null; model: string | null;
  hls_playlist_url: string | null; hls_output_dir: string | null; rec_output_dir: string | null;
  added_at: string; updated_at: string;
  ai_detection_enabled?: boolean;
  // from health join
  is_online: number | null; is_recording: number | null;
  frame_rate_actual: number | null; bitrate_kbps: number | null; last_error: string | null;
}

// Fields the Add/Edit Camera form can send but that the API never echoes
// back on GET (they embed the camera credential — see cameras.js
// CAMERA_PUBLIC_COLUMNS comment). One submit here now populates both the
// `cameras` table AND the cameras_config_details ONVIF/credential row —
// see syncConfigDetails in backend/api/src/routes/cameras.js.
export interface CameraCreateInput {
  camera_name: string;
  camera_type: string;
  ip_address?: string;
  rtsp_url: string;               // live/sub-stream URL
  rec_rtsp_url?: string;          // dedicated recording-profile URL (optional — falls back to rtsp_url)
  third_rtsp_url?: string;        // ONVIF "ThirdStream" — low-res analytics/mobile profile (optional)
  username?: string;
  password_hash?: string;         // plaintext RTSP/ONVIF password (field name is legacy, not actually hashed)
  onvif_port?: number;            // defaults to 80 if omitted
  location_description?: string;
}

interface CamerasResponse { cameras: Camera[]; total: number; }

export function useCameras(params?: { status?: string; camera_type?: string }) {
  const qs = new URLSearchParams(params as Record<string,string> || {}).toString();
  return useQuery<Camera[]>({
    queryKey: ["cameras", params],
    queryFn: async () => {
      const data = await apiGet<CamerasResponse>(`/api/cameras${qs ? '?' + qs : ''}`);
      return data.cameras;
    },
    refetchInterval: 15000,
  });
}

export function useCamera(id: number | undefined) {
  return useQuery<Camera>({
    queryKey: ["cameras", id],
    enabled: !!id,
    queryFn: () => apiGet<Camera>(`/api/cameras/${id}`),
  });
}

// What the server hands back right after a save — includes the one-shot
// RTSP reachability probe result (see backend/api/src/services/rtspCheck.js) so
// the UI can tell the admin immediately whether the camera actually
// connects, instead of only finding out later from a blank tile.
export interface ConnectivityResult { reachable: boolean; error: string | null; }
export type CameraWithConnectivity = Camera & { connectivity?: ConnectivityResult | null };

export function useCreateCamera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (camera: CameraCreateInput) => apiPost<CameraWithConnectivity>("/api/cameras", camera),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cameras"] }),
  });
}

export function useUpdateCameraCredentials() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ camera_id, username, password_hash }: { camera_id: number; username?: string; password_hash?: string }) =>
      apiPut<CameraWithConnectivity>(`/api/cameras/${camera_id}/credentials`, { username, password_hash }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cameras"] }),
  });
}

export function useUpdateCamera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ camera_id, ...updates }: Partial<Camera & CameraCreateInput> & { camera_id: number }) =>
      apiPut<CameraWithConnectivity>(`/api/cameras/${camera_id}`, updates),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cameras"] }),
  });
}

export function useDeleteCamera() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (camera_id: number) => apiDelete(`/api/cameras/${camera_id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["cameras"] }),
  });
}

export interface RtspProbeResult {
  reachable: boolean;
  error: string | null;
  host: string;
  port: number;
  rtsp_url: string;
  has_credentials: boolean;
  video?: { codec: string | null; width: number | null; height: number | null } | null;
  has_audio?: boolean;
}

/** Tries an RTSP address (nothing is saved). */
export function useProbeRtsp() {
  return useMutation({
    mutationFn: (body: { rtsp_url: string; username?: string; password?: string }) =>
      apiPost<RtspProbeResult>("/api/cameras/probe-rtsp", body),
  });
}
