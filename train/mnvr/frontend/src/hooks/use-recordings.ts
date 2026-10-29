import { useQuery, keepPreviousData } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";

export interface Recording {
  recording_id: number;
  camera_id: number;
  file_path: string;
  file_name: string;
  file_size_bytes: number | null;
  duration_seconds: number | null;
  start_timestamp: string;
  end_timestamp: string | null;
  video_codec: string;
  resolution_width: number;
  resolution_height: number;
  fps_actual: number | null;
  has_audio: number;
  recording_mode: string;
  status: string;
  hls_playlist_path: string | null;
  gps_latitude: number | null;
  gps_longitude: number | null;
  gps_speed_kmh: number | null;
  created_at: string;
  camera_name: string | null;
  location_description: string | null;
  ip_address: string | null;
  camera_type: string | null;
  cameras?: { camera_name: string | null };
}

interface RecordingsResponse { recordings: Recording[]; total: number; limit?: number; offset?: number; }

// Fetches every recording matching the filter, paging through the API's
// 500-per-request cap (see backend/api/src/routes/recordings.js — that cap is a
// deliberate resource-exhaustion guard, not something to raise). Anything
// that needs the FULL set — e.g. VideoPlayer's timeline, which has to see
// every recording for a camera to draw a continuous scrubber — should use
// this instead of useRecordings({ limit: <big number> }), which silently
// truncates at the server's page cap with no indication anything was cut off.
export function useAllRecordings(filters?: {
  camera_id?: number;
  start_date?: string;
  end_date?: string;
  status?: string;
}) {
  return useQuery<Recording[]>({
    queryKey: ["recordings", "all", filters],
    queryFn: async () => {
      const PAGE_SIZE = 500; // matches the server's max page size
      const MAX_PAGES = 200; // safety cap — 100k recordings — never legitimately hit
      let offset = 0;
      let all: Recording[] = [];
      for (let page = 0; page < MAX_PAGES; page++) {
        const params = new URLSearchParams();
        if (filters?.camera_id)  params.set("camera_id",  String(filters.camera_id));
        if (filters?.start_date) params.set("start_date", filters.start_date);
        if (filters?.end_date)   params.set("end_date",   filters.end_date);
        if (filters?.status)     params.set("status",     filters.status);
        params.set("limit", String(PAGE_SIZE));
        params.set("offset", String(offset));
        const data = await apiGet<RecordingsResponse>(`/api/recordings?${params.toString()}`);
        all = all.concat(data.recordings.map(r => ({ ...r, cameras: { camera_name: r.camera_name } })));
        if (all.length >= data.total || data.recordings.length < PAGE_SIZE) break;
        offset += PAGE_SIZE;
      }
      return all;
    },
    refetchInterval: 15000,
  });
}

export interface RecordingsPage {
  recordings: Recording[];
  total: number;
  limit: number;
  offset: number;
}

// Server-side-filtered, server-side-paginated recording search — used by
// SearchPage. Unlike useAllRecordings (which deliberately fetches
// everything for a camera and lets the caller filter client-side), this
// hook trusts the server's `total` for real pagination: it does NOT
// silently truncate at a page cap the caller can't see, because the
// caller gets `total` back and can page through it properly.
export function useRecordings(filters?: {
  camera_id?: number;
  start_date?: string;
  end_date?: string;
  status?: string;
  q?: string;
  limit?: number;
  offset?: number;
}) {
  const params = new URLSearchParams();
  if (filters?.camera_id)  params.set("camera_id",  String(filters.camera_id));
  if (filters?.start_date) params.set("start_date", filters.start_date);
  if (filters?.end_date)   params.set("end_date",   filters.end_date);
  if (filters?.status)     params.set("status",     filters.status);
  if (filters?.q)          params.set("q",          filters.q);
  if (filters?.limit)      params.set("limit",      String(filters.limit));
  if (filters?.offset != null) params.set("offset", String(filters.offset));
  const qs = params.toString();

  return useQuery<RecordingsPage>({
    queryKey: ["recordings", filters],
    queryFn: async () => {
      const data = await apiGet<RecordingsResponse>(`/api/recordings${qs ? '?' + qs : ''}`);
      return {
        recordings: data.recordings.map(r => ({ ...r, cameras: { camera_name: r.camera_name } })),
        total: data.total,
        limit: data.limit ?? filters?.limit ?? data.recordings.length,
        offset: data.offset ?? filters?.offset ?? 0,
      };
    },
    // Keep the previous page's results on screen while the next page
    // loads, instead of the list flashing empty/loading on every Next
    // click or filter change.
    placeholderData: keepPreviousData,
    refetchInterval: 15000,
  });
}
