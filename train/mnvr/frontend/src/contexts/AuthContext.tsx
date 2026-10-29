import { createContext, useContext, useEffect, useState, ReactNode } from "react";
import { apiPost, apiGet, tokenStore, setUnauthorizedHandler, setMustChangePasswordHandler } from "@/lib/api";

export interface NvrUser {
  user_id: number;
  username: string;
  full_name: string;
  email: string | null;
  role: "ADMIN" | "OPERATOR" | "MAINTENANCE" | "VIEWER";
  must_change_password?: boolean;
}

interface AuthContextType {
  user: NvrUser | null;
  loading: boolean;
  signIn: (username: string, password: string) => Promise<{ error: Error | null }>;
  signUp: (username: string, password: string, fullName: string, email?: string) => Promise<{ error: Error | null }>;
  signOut: () => void;
  mustChangePassword: boolean;
  changePassword: (currentPassword: string, newPassword: string) => Promise<{ error: Error | null }>;
  isAdmin: boolean;
  isOperator: boolean;
}

const AuthContext = createContext<AuthContextType>({} as AuthContextType);
export const useAuth = () => useContext(AuthContext);

export const AuthProvider = ({ children }: { children: ReactNode }) => {
  const [user, setUser] = useState<NvrUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [mustChangePassword, setMustChangePassword] = useState(false);

  useEffect(() => {
    setMustChangePasswordHandler(() => setMustChangePassword(true));
    return () => setMustChangePasswordHandler(null);
  }, []);

  useEffect(() => {
    // If apiFetch ever sees a 401 on a protected call (session expired,
    // token invalidated, etc.), this clears the in-memory user immediately
    // instead of leaving stale UI up until the next manual refresh — the
    // route guard below then reacts to `user` becoming null and navigates
    // away on its own, via the router (no hard page reload).
    setUnauthorizedHandler(() => setUser(null));
    return () => setUnauthorizedHandler(null);
  }, []);

  useEffect(() => {
    const token = tokenStore.get();
    if (!token) { setLoading(false); return; }

    let cancelled = false;
    // A network error / backend-briefly-unreachable blip on THIS ONE check
    // was previously enough to bounce a person to the login screen — even
    // though ProtectedRoute only reacts to `user` being null, not to the
    // token being gone. Retrying a few times before giving up means a
    // multi-second backend hiccup (e.g. a restart) resolves itself without
    // ever being visible as a forced logout. Only a real 401 short-circuits
    // this immediately, since that means the token itself is invalid and
    // no amount of retrying will change that.
    const MAX_ATTEMPTS = 4;
    const RETRY_DELAY_MS = 1500;

    const checkSession = async (attempt: number) => {
      try {
        const me = await apiGet<NvrUser>("/api/auth/me");
        if (!cancelled) { setUser(me); setMustChangePassword(!!me.must_change_password); }
      } catch (err: unknown) {
        if (cancelled) return;
        if ((err as any)?.status === 401) {
          // Token is genuinely invalid — clear it now, no point retrying.
          tokenStore.clear();
          return;
        }
        if (attempt < MAX_ATTEMPTS) {
          await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          if (!cancelled) return checkSession(attempt + 1);
        }
        // Retries exhausted on a non-401 error: leave the token alone (it
        // may well still be valid) — we just couldn't confirm it right
        // now. The person will see the login screen, but a normal
        // page refresh once the backend is reachable again logs them
        // straight back in without re-entering a password.
      }
    };

    checkSession(1).finally(() => {
      if (!cancelled) setLoading(false);
    });

    return () => { cancelled = true; };
  }, []);

  const signIn = async (username: string, password: string) => {
    try {
      const data = await apiPost<{ token: string; must_change_password?: boolean; user: NvrUser }>("/api/auth/login", { username, password });
      tokenStore.set(data.token);
      setUser(data.user);
      setMustChangePassword(!!data.must_change_password);
      return { error: null };
    } catch (err) { return { error: err as Error }; }
  };

  const signUp = async (username: string, password: string, fullName: string, email?: string) => {
    try {
      const data = await apiPost<{ token: string; user: NvrUser }>("/api/auth/register", { username, password, full_name: fullName, email });
      tokenStore.set(data.token);
      setUser(data.user);
      return { error: null };
    } catch (err) { return { error: err as Error }; }
  };

  const signOut = () => { tokenStore.clear(); setUser(null); setMustChangePassword(false); };

  // Replaces the password and fetches a fresh token (the old one still carries the "must change" flag).
  const changePassword = async (currentPassword: string, newPassword: string) => {
    try {
      await apiPost("/api/auth/change-password", { current_password: currentPassword, new_password: newPassword });
      const r = await apiPost<{ token: string }>("/api/auth/refresh", {});
      tokenStore.set(r.token);
      setMustChangePassword(false);
      return { error: null };
    } catch (err) { return { error: err as Error }; }
  };

  return (
    <AuthContext.Provider value={{
      user, loading, signIn, signUp, signOut, mustChangePassword, changePassword,
      isAdmin:    user?.role === "ADMIN",
      isOperator: user?.role === "ADMIN" || user?.role === "OPERATOR",
    }}>
      {children}
    </AuthContext.Provider>
  );
};
