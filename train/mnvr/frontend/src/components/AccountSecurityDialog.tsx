import { useState } from "react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiPost } from "@/lib/api";
import { useAuth } from "@/contexts/AuthContext";
import { useToast } from "@/hooks/use-toast";
import { KeyRound } from "lucide-react";

/** My account: change my password, and make a new recovery code (replaces the old one). */
export function AccountSecurityDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { user } = useAuth();
  const { toast } = useToast();
  const [f, setF] = useState({ current: "", next: "", again: "" });
  const [busy, setBusy] = useState(false);
  const close = () => { setF({ current: "", next: "", again: "" }); onClose(); };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (f.next !== f.again) { toast({ title: "Passwords do not match", variant: "destructive" }); return; }
    setBusy(true);
    try {
      await apiPost("/api/auth/change-password", { current_password: f.current, new_password: f.next });
      toast({ title: "Password changed" });
      close();
    } catch (err: any) { toast({ title: "Could not change password", description: err.message, variant: "destructive" }); }
    finally { setBusy(false); }
  };

  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent className="bg-card border-border max-w-md">
        <DialogTitle className="flex items-center gap-2"><KeyRound className="h-4 w-4 text-primary" /> Change password - {user?.username}</DialogTitle>
        <form onSubmit={submit} className="space-y-3">
          <div><Label className="text-xs">Current password</Label><Input type="password" className="mt-1" value={f.current} onChange={(e) => setF({ ...f, current: e.target.value })} required autoComplete="current-password" /></div>
          <div><Label className="text-xs">New password</Label><Input type="password" className="mt-1" minLength={10} value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} required autoComplete="new-password" /></div>
          <div><Label className="text-xs">Repeat new password</Label><Input type="password" className="mt-1" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} required autoComplete="new-password" /></div>
          <Button type="submit" className="w-full" disabled={busy}>{busy ? "Saving..." : "Change password"}</Button>
        </form>
      </DialogContent>
    </Dialog>
  );
}
