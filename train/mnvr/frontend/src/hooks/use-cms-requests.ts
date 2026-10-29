import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";

export type TransferStatus =
  | "queued" | "waiting_for_recording" | "preparing" | "uploading" | "paused"
  | "completed" | "partial" | "failed" | "interrupted";

export interface CmsTransfer {
  key: string;
  kind: "cms_request" | "auto";
  command_id?: number;
  request_id: number | null;
  event_id?: number;
  camera_name: string;
  window_start: string;
  window_end: string;
  status: TransferStatus;
  message: string | null;
  error: string | null;
  percent: number;
  bytes_total: number;
  bytes_sent: number;
  segments_total: number;
  segments_done: number;
  current_file?: string;
  attempts: number;
  created_at: string;
  updated_at: string;
  finished_at: string | null;
  missing?: { from: string; to: string }[];
}

export interface CmsRequestsResponse {
  bridge_running: boolean;
  online: boolean;
  last_ok: string | null;
  transfers: CmsTransfer[];
}

export function useCmsRequests() {
  return useQuery<CmsRequestsResponse>({
    queryKey: ["cms-requests"],
    queryFn: () => apiGet<CmsRequestsResponse>("/api/cms-requests"),
    refetchInterval: 1500, // live progress
  });
}
