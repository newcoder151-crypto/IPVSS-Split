import { useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useToast } from "@/hooks/use-toast";
import { KeyRound } from "lucide-react";

/**
 * Shown instead of the app while the signed-in account still has a default / temporary password.
 * The server refuses every other request until it is changed, so this is the one thing that can be done.
 */
export function ChangePasswordGate() {
  const { user, changePassword, signOut } = useAuth();
  const { toast } = useToast();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (next !== again) {
      toast({ title: "Passwords do not match", description: "Type the new password twice, the same.", variant: "destructive" });
      return;
    }
    if (next === current) {
      toast({ title: "Choose a different password", description: "The new password must differ from the current one.", variant: "destructive" });
      return;
    }
    setBusy(true);
    const { error } = await changePassword(current, next);
    setBusy(false);
    if (error) toast({ title: "Could not change password", description: error.message, variant: "destructive" });
    else toast({ title: "Password changed", description: "You can now use the system." });
  };

  return (
    <div className="min-h-screen flex items-center justify-center p-4 railway-gradient">
      <Card className="w-full max-w-md bg-card border-border">
        <CardHeader className="text-center space-y-3">
          <div className="mx-auto w-14 h-14 rounded-xl railway-gradient flex items-center justify-center">
            <KeyRound className="h-7 w-7 text-primary-foreground" />
          </div>
          <CardTitle className="text-xl text-foreground">Set a new password</CardTitle>
          <p className="text-sm text-muted-foreground">
            {user ? <>Signed in as <b>{user.username}</b>. </> : null}
            This account is still using a default password. Choose your own before continuing.
          </p>
        </CardHeader>
        <CardContent>
          <form onSubmit={submit} className="space-y-4">
            <div><Label>Current password</Label><Input type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required autoComplete="current-password" /></div>
            <div><Label>New password</Label><Input type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={10} autoComplete="new-password" /></div>
            <div><Label>Repeat new password</Label><Input type="password" value={again} onChange={(e) => setAgain(e.target.value)} required minLength={10} autoComplete="new-password" /></div>
            <p className="text-xs text-muted-foreground">Use at least 10 characters and avoid common passwords.</p>
            <div className="flex gap-2">
              <Button type="button" variant="outline" className="flex-1" onClick={signOut}>Sign out</Button>
              <Button type="submit" className="flex-1" disabled={busy}>{busy ? "Saving..." : "Change password"}</Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
