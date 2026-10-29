import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { apiGet, apiPost, apiPut, apiDelete } from "@/lib/api";

export interface NvrUserRow {
  user_id: number; username: string; full_name: string;
  email: string | null; phone: string | null;
  role: string; is_active: number; is_locked: number;
  created_at: string; last_login_at: string | null;
  // compat fields used by UserAdmin
  display_name: string | null; roles: string[];
}

export function useUsers() {
  return useQuery<NvrUserRow[]>({
    queryKey: ["users"],
    queryFn: async () => {
      const data = await apiGet<{ users: any[] }>("/api/users");
      return data.users.map(u => ({ ...u, display_name: u.full_name, roles: [u.role.toLowerCase()] }));
    },
  });
}

export function useCreateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (u: { username: string; password: string; full_name: string; email?: string; role?: string }) =>
      apiPost("/api/users", u),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useUpdateUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ user_id, ...u }: { user_id: number; [k: string]: any }) =>
      apiPut(`/api/users/${user_id}`, u),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}

export function useDeleteUser() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (user_id: number) => apiDelete(`/api/users/${user_id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["users"] }),
  });
}
