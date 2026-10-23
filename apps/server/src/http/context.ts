import type { Context } from "hono";
import type { apiKeys, users, workspaces } from "../db/schema.js";
import type { Actor } from "../services/audit.js";

export type WorkspaceRow = typeof workspaces.$inferSelect;
export type ApiKeyRow = typeof apiKeys.$inferSelect;
export type UserRow = typeof users.$inferSelect;

export type AppEnv = {
  Variables: {
    requestId: string;
    ws: WorkspaceRow;
    apiKey: ApiKeyRow;
    actor: Actor;
    user: UserRow;
    role: "owner" | "admin" | "member";
    sessionId: string;
  };
};

export type Ctx = Context<AppEnv>;

export function clientIp(c: Ctx): string | null {
  const fwd = c.req.header("x-forwarded-for");
  if (fwd) return fwd.split(",")[0]!.trim();
  // @hono/node-server exposes the socket on env.incoming
  const incoming = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming;
  return incoming?.socket?.remoteAddress ?? null;
}
