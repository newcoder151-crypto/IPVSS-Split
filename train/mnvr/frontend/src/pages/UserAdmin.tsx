import { useState } from "react";
import { Users, Plus, Lock, Unlock, Trash2, Key } from "lucide-react";
import { AppLayout } from "@/components/layout/AppLayout";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { useUsers, useCreateUser, useUpdateUser, useDeleteUser } from "@/hooks/use-users";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { apiPut } from "@/lib/api";

const roleColor: Record<string,string> = {
  admin: "bg-destructive/10 text-destructive",
  ADMIN: "bg-destructive/10 text-destructive",
  operator: "bg-warning/10 text-warning",
  OPERATOR: "bg-warning/10 text-warning",
  maintenance: "bg-blue-400/10 text-blue-400",
  MAINTENANCE: "bg-blue-400/10 text-blue-400",
  viewer: "bg-muted text-muted-foreground",
  VIEWER: "bg-muted text-muted-foreground",
};

const UserAdmin = () => {
  const { user: me } = useAuth();
  const { toast } = useToast();
  const { data: users, isLoading } = useUsers();
  const createUser = useCreateUser();
  const updateUser = useUpdateUser();
  const deleteUser = useDeleteUser();

  const [newUser, setNewUser] = useState({ username: "", password: "", full_name: "", email: "", role: "VIEWER" });
  const [open, setOpen] = useState(false);
  const [pwDialog, setPwDialog] = useState<number|null>(null);
  const [newPw, setNewPw] = useState("");

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await createUser.mutateAsync(newUser);
      toast({ title: "User created" });
      setOpen(false);
      setNewUser({ username: "", password: "", full_name: "", email: "", role: "VIEWER" });
    } catch (err: any) { toast({ title: "Error", description: err.message, variant: "destructive" }); }
  };

  const handleToggleLock = async (user_id: number, is_locked: number) => {
    await updateUser.mutateAsync({ user_id, is_locked: is_locked ? 0 : 1 });
    toast({ title: is_locked ? "User unlocked" : "User locked" });
  };

  const handleResetPw = async (user_id: number) => {
    try {
      await apiPut(`/api/users/${user_id}/password`, { password: newPw });
      toast({ title: "Password updated" });
      setPwDialog(null); setNewPw("");
    } catch (err: any) { toast({ title: "Error", description: err.message, variant: "destructive" }); }
  };

  const handleDelete = async (user_id: number) => {
    if (!confirm("Deactivate this user?")) return;
    await deleteUser.mutateAsync(user_id);
    toast({ title: "User deactivated" });
  };

  return (
    <AppLayout>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <div><h1 className="text-2xl font-bold text-foreground">User Administration</h1>
            <p className="text-sm text-muted-foreground">{users?.length || 0} users</p></div>
          <Dialog open={open} onOpenChange={setOpen}>
            <DialogTrigger asChild><Button size="sm" className="gap-1"><Plus className="h-4 w-4" />Add User</Button></DialogTrigger>
            <DialogContent className="bg-card border-border">
              <DialogHeader><DialogTitle>Create User</DialogTitle></DialogHeader>
              <form onSubmit={handleCreate} className="space-y-3">
                <div><Label className="text-xs">Full Name</Label><Input value={newUser.full_name} onChange={e => setNewUser({...newUser, full_name: e.target.value})} required /></div>
                <div><Label className="text-xs">Username</Label><Input value={newUser.username} onChange={e => setNewUser({...newUser, username: e.target.value})} required /></div>
                <div><Label className="text-xs">Email</Label><Input type="email" value={newUser.email} onChange={e => setNewUser({...newUser, email: e.target.value})} /></div>
                <div><Label className="text-xs">Password</Label><Input type="password" value={newUser.password} onChange={e => setNewUser({...newUser, password: e.target.value})} required /></div>
                <div><Label className="text-xs">Role</Label>
                  <Select value={newUser.role} onValueChange={v => setNewUser({...newUser, role: v})}>
                    <SelectTrigger><SelectValue /></SelectTrigger>
                    <SelectContent>{["ADMIN","OPERATOR","MAINTENANCE","VIEWER"].map(r => <SelectItem key={r} value={r}>{r}</SelectItem>)}</SelectContent>
                  </Select>
                </div>
                <Button type="submit" className="w-full" disabled={createUser.isPending}>Create User</Button>
              </form>
            </DialogContent>
          </Dialog>
        </div>

        <div className="space-y-2">
          {isLoading && <div className="text-center py-8 text-muted-foreground text-sm">Loading users...</div>}
          {users?.map(u => (
            <Card key={u.user_id} className="bg-card border-border">
              <CardContent className="p-3 flex items-center gap-3">
                <div className="w-8 h-8 rounded-full bg-primary/20 flex items-center justify-center text-xs font-bold text-primary shrink-0">
                  {(u.full_name || u.username || "?").charAt(0).toUpperCase()}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm text-foreground">{u.full_name || u.username}</span>
                    <span className="text-xs text-muted-foreground">@{u.username}</span>
                    <Badge className={`text-[10px] ${roleColor[u.role] || ""}`}>{u.role}</Badge>
                    {u.is_locked ? <Badge className="text-[10px] bg-destructive/10 text-destructive">LOCKED</Badge> : null}
                    {!u.is_active ? <Badge className="text-[10px] bg-muted text-muted-foreground">INACTIVE</Badge> : null}
                  </div>
                  <div className="text-[10px] text-muted-foreground mt-0.5">{u.email || "no email"} • Last login: {u.last_login_at ? new Date(u.last_login_at).toLocaleDateString() : "never"}</div>
                </div>
                {u.user_id !== me?.user_id && (
                  <div className="flex gap-1 shrink-0">
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => handleToggleLock(u.user_id, u.is_locked)}>
                      {u.is_locked ? <Unlock className="h-3 w-3" /> : <Lock className="h-3 w-3" />}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0" onClick={() => setPwDialog(u.user_id)}>
                      <Key className="h-3 w-3" />
                    </Button>
                    <Button size="sm" variant="ghost" className="h-7 w-7 p-0 text-destructive hover:text-destructive" onClick={() => handleDelete(u.user_id)}>
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          ))}
        </div>
      </div>

      {/* Reset password dialog */}
      <Dialog open={!!pwDialog} onOpenChange={() => setPwDialog(null)}>
        <DialogContent className="bg-card border-border">
          <DialogHeader><DialogTitle>Reset Password</DialogTitle></DialogHeader>
          <div className="space-y-3">
            <div><Label className="text-xs">New Password</Label><Input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} /></div>
            <Button className="w-full" onClick={() => pwDialog && handleResetPw(pwDialog)} disabled={!newPw}>Update Password</Button>
          </div>
        </DialogContent>
      </Dialog>
    </AppLayout>
  );
};
export default UserAdmin;
