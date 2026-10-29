import { Component, type ErrorInfo, type ReactNode } from "react";
import { AlertTriangle, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";

interface ErrorBoundaryProps {
  children: ReactNode;
  /** Optional label shown in the error card, e.g. "Camera Controls" —
   * helps identify which part of the app crashed without needing the
   * console. */
  label?: string;
}

interface ErrorBoundaryState {
  error: Error | null;
}

/**
 * React only stops a render crash from taking down the WHOLE app if
 * something in the tree implements getDerivedStateFromError/
 * componentDidCatch — there was previously nothing anywhere in this app
 * doing that, so any single uncaught exception (e.g. the ImageSettingsPanel
 * bug that prompted this) unmounted the entire React root, leaving a
 * fully blank page with no way to recover except reloading and no
 * indication of what broke.
 *
 * This wraps route-level content (see App.tsx) so a crash in one page/tab
 * shows a small recoverable error card in its place instead — the rest of
 * the app (navigation, other pages) stays usable, and there's a visible
 * "Reload" action instead of a silent blank screen.
 */
export class ErrorBoundary extends Component<
  ErrorBoundaryProps,
  ErrorBoundaryState
> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Keep this even though we don't have remote error reporting wired up
    // yet — without it, the only trace of what crashed disappears the
    // moment the blank screen replaces it.
    console.error(
      `[ErrorBoundary${this.props.label ? `: ${this.props.label}` : ""}]`,
      error,
      info.componentStack,
    );
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex flex-col items-center justify-center gap-3 p-8 text-center min-h-[240px]">
          <AlertTriangle className="h-8 w-8 text-destructive" />
          <div className="space-y-1">
            <p className="text-sm font-medium text-foreground">
              {this.props.label
                ? `${this.props.label} hit an error`
                : "Something went wrong"}
            </p>
            <p className="text-xs text-muted-foreground max-w-sm">
              {this.state.error.message ||
                "An unexpected error occurred while rendering this section."}
            </p>
          </div>
          <Button
            size="sm"
            variant="outline"
            onClick={() => this.setState({ error: null })}
          >
            <RotateCcw className="h-3.5 w-3.5 mr-1.5" />
            Try again
          </Button>
        </div>
      );
    }
    return this.props.children;
  }
}
