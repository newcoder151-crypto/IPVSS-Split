import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPut } from "@/lib/api";

export interface SystemConfig {
  id: number; config_key: string; config_value: string;
  config_type: string; description: string | null; is_readonly: number;
}

export function useSystemConfig() {
  return useQuery<SystemConfig[]>({
    queryKey: ["system_config"],
    queryFn: async () => {
      const data = await apiGet<{ config: SystemConfig[] }>("/api/config");
      return data.config;
    },
  });
}

export function useConfigValue(key: string) {
  return useQuery<SystemConfig | null>({
    queryKey: ["system_config", key],
    queryFn: () => apiGet<SystemConfig>(`/api/config/${key}`).catch(() => null),
  });
}

export function useUpdateConfig() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ configKey, configValue }: { configKey: string; configValue: string }) =>
      apiPut(`/api/config/${configKey}`, { config_value: configValue }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["system_config"] }),
  });
}
