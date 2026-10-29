import { useState } from "react";
import { AccountSecurityDialog } from "@/components/AccountSecurityDialog";
import {
  Moon,
  Sun,
  LogOut,
  User,
  LayoutDashboard,
  Camera,
  PlayCircle,
  Search,
  AlertTriangle,
  Settings,
  Activity,
  Power,
  RotateCcw,
  Loader2,
  UploadCloud,
  KeyRound,
} from "lucide-react";
import { useTheme } from "@/contexts/ThemeContext";
import { useAuth } from "@/contexts/AuthContext";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { NavLink } from "@/components/NavLink";
import { useDashboardStats } from "@/hooks/use-dashboard-stats";
import { useRebootSystem, useShutdownSystem } from "@/hooks/use-system";
import { useToast } from "@/hooks/use-toast";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import NotificationsDropdown from "@/components/notifications/NotificationsDropdown";

const NAV_ITEMS = [
  { title: "Camera View", url: "/", icon: Camera, end: true },
  { title: "Dashboard", url: "/dashboard", icon: LayoutDashboard },
  { title: "Playback", url: "/player", icon: PlayCircle },
  { title: "Search", url: "/search", icon: Search },
  { title: "CMS Requests", url: "/cms-requests", icon: UploadCloud },
  { title: "System Info", url: "/system-info", icon: Activity },
  { title: "Events & Alarms", url: "/events", icon: AlertTriangle, badgeKey: "alarms" as const },
  { title: "Settings", url: "/settings", icon: Settings },
];

export const AppHeader = () => {
  const { theme, toggleTheme } = useTheme();
  const { user, isAdmin, signOut } = useAuth();
  const [accountOpen, setAccountOpen] = useState(false);
  const { data: stats } = useDashboardStats();
  const { toast } = useToast();
  const rebootSystem = useRebootSystem();
  const shutdownSystem = useShutdownSystem();
  const [confirmAction, setConfirmAction] = useState<"reboot" | "shutdown" | null>(null);

  const runConfirmed = async () => {
    try {
      if (confirmAction === "reboot") {
        await rebootSystem.mutateAsync();
        toast({ title: "Reboot initiated", description: "The system will restart shortly." });
      } else if (confirmAction === "shutdown") {
        await shutdownSystem.mutateAsync();
        toast({ title: "Shutdown initiated", description: "The system will power off shortly." });
      }
    } catch (err: any) {
      toast({ title: "Action failed", description: err.message, variant: "destructive" });
    } finally {
      setConfirmAction(null);
    }
  };

  return (
    <>
      <AccountSecurityDialog open={accountOpen} onClose={() => setAccountOpen(false)} />
      <header className="h-16 border-b border-border bg-card/80 backdrop-blur-md flex items-center justify-between px-3 sticky top-0 z-30 gap-3">
        {/* Brand */}
        <div className="flex items-center gap-2 shrink-0">
          <div className="w-9 h-9 rounded-md railway-gradient flex items-center justify-center">
            <span className="text-primary-foreground font-bold text-sm">NVR</span>
          </div>
          <div className="hidden xl:block">
            <h1 className="text-sm font-semibold text-foreground leading-tight">
              Railway NVR
            </h1>
            <p className="text-[10px] text-muted-foreground leading-tight">
              Network Video Recorder
            </p>
          </div>
        </div>

        {/* Primary navigation */}
        <nav className="flex-1 flex items-center justify-center gap-1 overflow-x-auto no-scrollbar min-w-0">
          {NAV_ITEMS.map((item) => (
            <NavItemButton key={item.title} item={item} stats={stats} />
          ))}
        </nav>

        {/* Right cluster */}
        <div className="flex items-center gap-1.5 shrink-0">
          <NotificationsDropdown />

          <Button
            variant="ghost"
            size="icon"
            className="text-muted-foreground hover:text-foreground h-10 w-10"
            onClick={toggleTheme}
          >
            {theme === "dark" ? <Sun className="h-5 w-5" /> : <Moon className="h-5 w-5" />}
          </Button>

          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-foreground h-10 w-10"
              >
                <User className="h-5 w-5" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="w-52">
              <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
                {user?.email || "operator@railway.gov.in"}
              </DropdownMenuLabel>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={() => setAccountOpen(true)}>
                <KeyRound className="mr-2 h-4 w-4" /> Change password
              </DropdownMenuItem>
              <DropdownMenuItem onClick={signOut}>
                <LogOut className="mr-2 h-4 w-4" /> Sign Out
              </DropdownMenuItem>
              {isAdmin && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem onClick={() => setConfirmAction("reboot")}>
                    <RotateCcw className="mr-2 h-4 w-4" /> Reboot System
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => setConfirmAction("shutdown")}
                    className="text-destructive focus:text-destructive"
                  >
                    <Power className="mr-2 h-4 w-4" /> Shutdown System
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </header>

      <AlertDialog open={confirmAction !== null} onOpenChange={(open) => !open && setConfirmAction(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {confirmAction === "reboot" ? "Reboot system?" : "Shut down system?"}
            </AlertDialogTitle>
            <AlertDialogDescription>
              {confirmAction === "reboot"
                ? "This will restart the NVR host machine. All live streams and recordings in progress will be interrupted until it comes back up."
                : "This will power off the NVR host machine. Cameras will stop recording until someone turns the machine back on."}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={runConfirmed}
              disabled={rebootSystem.isPending || shutdownSystem.isPending}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {(rebootSystem.isPending || shutdownSystem.isPending) && (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              )}
              {confirmAction === "reboot" ? "Reboot" : "Shutdown"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};

// ── Nav item button — bigger icons, active-state highlight, optional badge ──
function NavItemButton({
  item,
  stats,
}: {
  item: (typeof NAV_ITEMS)[number];
  stats: ReturnType<typeof useDashboardStats>["data"];
}) {
  const badgeCount = item.badgeKey === "alarms" ? stats?.unacknowledgedAlerts : undefined;
  return (
    <NavLink
      to={item.url}
      end={item.end}
      className="relative flex flex-col items-center justify-center gap-0.5 px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted/60 transition-colors shrink-0 min-w-[3.5rem]"
      activeClassName="bg-primary/10 text-primary"
    >
      <item.icon className="h-6 w-6 shrink-0" />
      <span className="text-[10px] font-medium hidden sm:inline leading-none">
        {item.title}
      </span>
      {!!badgeCount && badgeCount > 0 && (
        <Badge className="absolute -top-1 right-0 h-4 min-w-4 px-1 flex items-center justify-center text-[9px] bg-destructive text-destructive-foreground border-0">
          {badgeCount > 99 ? "99+" : badgeCount}
        </Badge>
      )}
    </NavLink>
  );
}
