import { useQuery } from "@tanstack/react-query";
import { apiGet } from "@/lib/api";

export interface DashboardStats {
  activeCameras: number; totalCameras: number;
  totalEvents: number; unacknowledgedAlerts: number;
  recentAlerts: Array<{
    event_id: number; severity: string; is_acknowledged: number;
    event_type: string; camera_id: number | null; title: string;
    description: string | null; occurred_at: string;
  }>;
  cameras: Array<{ camera_id: number; camera_name: string; status: string; location_description: string | null; camera_type: string }>;
}

export function useDashboardStats() {
  return useQuery<DashboardStats>({
    queryKey: ["dashboard-stats"],
    queryFn: () => apiGet<DashboardStats>("/api/config/dashboard"),
    refetchInterval: 30000,
  });
}
