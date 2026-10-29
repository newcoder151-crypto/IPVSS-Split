import { useQuery, useMutation } from "@tanstack/react-query";
import { apiGet, apiPost } from "@/lib/api";

export interface SystemInfo {
  hostname: string;
  platform: string;
  arch: string;
  release: string;
  node_version: string;
  uptime_seconds: number;
  process_uptime_seconds: number;
  cpu_model: string;
  cpu_count: number;
  load_avg: number[];
  total_mem_bytes: number;
  free_mem_bytes: number;
  used_mem_bytes: number;
}

export function useSystemInfo() {
  return useQuery<SystemInfo>({
    queryKey: ["system-info"],
    queryFn: () => apiGet<SystemInfo>("/api/system/info"),
    refetchInterval: 10000,
  });
}

export function useRebootSystem() {
  return useMutation({
    mutationFn: () => apiPost<{ message: string }>("/api/system/reboot", {}),
  });
}

export function useShutdownSystem() {
  return useMutation({
    mutationFn: () => apiPost<{ message: string }>("/api/system/shutdown", {}),
  });
}
