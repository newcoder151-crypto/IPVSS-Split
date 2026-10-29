import { ReactNode } from "react";
import { AppHeader } from "./AppHeader";

export const AppLayout = ({ children }: { children: ReactNode }) => {
  return (
    <div className="h-screen flex flex-col w-full bg-background overflow-hidden">
      <AppHeader />
      <main className="flex-1 min-h-0 min-w-0 overflow-auto p-4 md:p-6">
        {children}
      </main>
    </div>
  );
};
