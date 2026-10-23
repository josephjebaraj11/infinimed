import { createContext, useContext } from "react";
import type { Me } from "./api";

export type SessionCtx = {
  me: Me;
  workspace: Me["workspaces"][number] | null;
  refresh: () => Promise<void>;
  switchWorkspace: (id: string) => Promise<void>;
  canAdmin: boolean;
};

export const Session = createContext<SessionCtx | null>(null);

export function useSession(): SessionCtx {
  const s = useContext(Session);
  if (!s) throw new Error("useSession outside provider");
  return s;
}
