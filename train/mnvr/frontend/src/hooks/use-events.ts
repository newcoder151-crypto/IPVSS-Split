import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPut } from "@/lib/api";

export interface EventRow {
  event_id: number;
  event_type: string;
  severity: string;
  title: string;
  description: string | null;
  camera_id: number | null;
  status: string;
  is_acknowledged: number;
  acknowledged_by: string | null;
  acknowledged_at: string | null;
  occurred_at: string;
  created_at: string;
  snapshot_path: string | null;
  video_clip_path: string | null;
  gps_latitude: number | null;
  gps_longitude: number | null;
  camera_name: string | null;
  location_description: string | null;
  ip_address: string | null;
}

interface EventsResponse {
  events: EventRow[];
  total: number;
}

export function useEvents(filters?: {
  severity?: string;
  event_type?: string;
  is_acknowledged?: number;
  camera_id?: number;
  limit?: number;
  offset?: number;
}) {
  const p = new URLSearchParams();
  if (filters?.severity) p.set("severity", filters.severity);
  if (filters?.event_type) p.set("event_type", filters.event_type);
  if (filters?.is_acknowledged !== undefined)
    p.set("acknowledged", filters.is_acknowledged === 1 ? "true" : "false");
  if (filters?.camera_id) p.set("camera_id", String(filters.camera_id));
  if (filters?.limit) p.set("limit", String(filters.limit));
  if (filters?.offset) p.set("offset", String(filters.offset));
  const qs = p.toString();

  return useQuery<EventsResponse>({
    queryKey: ["events", filters],
    queryFn: async () => {
      const data = await apiGet<EventsResponse>(
        `/api/events${qs ? "?" + qs : ""}`,
      );
      return { events: data.events, total: data.total };
    },
    refetchInterval: 10000,
  });
}

/** Pass event_id as a plain number */
export function useAcknowledgeEvent() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (event_id: number) =>
      apiPut(`/api/events/${event_id}/acknowledge`, {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["events"] });
      qc.invalidateQueries({ queryKey: ["dashboard-stats"] });
    },
  });
}

export function useAcknowledgeAll() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => apiPut("/api/events/all/acknowledge", {}),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["events"] });
      qc.invalidateQueries({ queryKey: ["dashboard-stats"] });
    },
  });
}

/** Batch acknowledge a list of event IDs in a single request */
export function useAcknowledgeBatch() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (event_ids: number[]) =>
      apiPut("/api/events/batch/acknowledge", { event_ids }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["events"] });
      qc.invalidateQueries({ queryKey: ["dashboard-stats"] });
    },
  });
}
