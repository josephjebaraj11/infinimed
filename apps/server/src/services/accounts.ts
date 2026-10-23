import { and, desc, eq, gt, isNull, sql } from "drizzle-orm";
import { db } from "../db/client.js";
import { apiKeys, invitations, memberships, userSessions, users, workspaces, type Environment, type Role } from "../db/schema.js";
import { hashPassword, sha256Hex, verifyPassword } from "../lib/crypto.js";
import { ApiError } from "../lib/errors.js";
import { newId, randomToken } from "../lib/ids.js";
import { API_KEY_PREFIX } from "../http/middleware.js";
import { validateEmail } from "./patients.js";

/**
 * Dashboard accounts: users, sessions, workspaces, memberships, invitations and API keys.
 * Roles: owner (everything, including members and deletion), admin (keys, credentials, exports,
 * webhooks), member (read-only views).
 */

export const SESSION_TTL_MS = 12 * 3600_000;
export const MAX_ACTIVE_KEYS = 20;
export const API_KEY_SCOPES = [
  "patients:read",
  "patients:write",
  "patients:delete",
  "records:read",
  "records:write",
  "sources:read",
  "sessions:read",
  "sessions:write",
  "webhooks:read",
  "webhooks:write",
  "exports:read",
  "exports:write",
  "launch:read",
  "backend:read",
  "backend:write",
] as const;

const ROLE_RANK: Record<Role, number> = { member: 1, admin: 2, owner: 3 };
export const roleAtLeast = (role: Role, min: Role) => ROLE_RANK[role] >= ROLE_RANK[min];

export function validatePassword(pw: unknown): string {
  if (typeof pw !== "string" || pw.length < 10 || pw.length > 200) {
    throw new ApiError("invalid_data", "Password must be 10 to 200 characters", { param: "password" });
  }
  return pw;
}

export async function createUser(input: { email: unknown; password: unknown; name?: unknown }) {
  const email = validateEmail(input.email);
  if (!email) throw new ApiError("invalid_data", "email is required", { param: "email" });
  const password = validatePassword(input.password);
  const [existing] = await db().select({ id: users.id }).from(users).where(eq(users.email, email)).limit(1);
  if (existing) throw new ApiError("resource_conflict", "An account with this email already exists", { param: "email" });
  const [user] = await db()
    .insert(users)
    .values({ id: newId("user"), email, name: typeof input.name === "string" ? input.name.slice(0, 200) : null, passwordHash: await hashPassword(password) })
    .returning();
  return user!;
}

const loginFailures = new Map<string, { count: number; until: number }>();

export async function authenticate(emailRaw: unknown, password: unknown, ip: string | null) {
  const email = typeof emailRaw === "string" ? emailRaw.toLowerCase().trim() : "";
  const key = `${email}|${ip ?? ""}`;
  const f = loginFailures.get(key);
  if (f && f.until > Date.now()) throw new ApiError("throttled", "Too many failed sign-in attempts. Try again later.", { retryAfter: Math.ceil((f.until - Date.now()) / 1000) });
  const [user] = await db().select().from(users).where(eq(users.email, email)).limit(1);
  const ok = !!user?.passwordHash && typeof password === "string" && (await verifyPassword(password, user.passwordHash));
  if (!ok || !user) {
    const count = (f?.count ?? 0) + 1;
    loginFailures.set(key, { count, until: count >= 5 ? Date.now() + Math.min(15 * 60_000, 2 ** (count - 5) * 30_000) : 0 });
    throw new ApiError("invalid_credentials", "Email or password is incorrect");
  }
  loginFailures.delete(key);
  await db().update(users).set({ lastLoginAt: new Date() }).where(eq(users.id, user.id));
  return user;
}

export async function createSessionFor(userId: string, activeWorkspaceId: string | null, meta: { ip: string | null; userAgent: string | null }) {
  const token = randomToken(32);
  const id = `ses_${randomToken(12)}`;
  await db()
    .insert(userSessions)
    .values({ id, tokenHash: sha256Hex(token), userId, activeWorkspaceId, expiresAt: new Date(Date.now() + SESSION_TTL_MS), ip: meta.ip, userAgent: meta.userAgent?.slice(0, 300) ?? null });
  return { token, id };
}

export async function sessionFromToken(token: string) {
  const [row] = await db()
    .select({ session: userSessions, user: users })
    .from(userSessions)
    .innerJoin(users, eq(users.id, userSessions.userId))
    .where(and(eq(userSessions.tokenHash, sha256Hex(token)), gt(userSessions.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export async function destroySession(token: string) {
  await db().delete(userSessions).where(eq(userSessions.tokenHash, sha256Hex(token)));
}

export async function createWorkspace(userId: string, input: { name: unknown; environment: unknown }) {
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 100) : null;
  if (!name) throw new ApiError("invalid_data", "Workspace name is required", { param: "name" });
  if (input.environment !== "sandbox" && input.environment !== "production") throw new ApiError("invalid_data", "environment must be sandbox or production", { param: "environment" });
  const id = newId("workspace");
  await db().transaction(async (tx) => {
    await tx.insert(workspaces).values({ id, name, environment: input.environment as Environment, branding: { display_name: name } });
    await tx.insert(memberships).values({ id: newId("membership"), userId, workspaceId: id, role: "owner" });
  });
  const [ws] = await db().select().from(workspaces).where(eq(workspaces.id, id));
  return ws!;
}

export async function membershipsFor(userId: string) {
  return db()
    .select({ ws: workspaces, role: memberships.role })
    .from(memberships)
    .innerJoin(workspaces, eq(workspaces.id, memberships.workspaceId))
    .where(eq(memberships.userId, userId))
    .orderBy(workspaces.createdAt);
}

export async function roleIn(userId: string, workspaceId: string): Promise<Role | null> {
  const [m] = await db()
    .select({ role: memberships.role })
    .from(memberships)
    .where(and(eq(memberships.userId, userId), eq(memberships.workspaceId, workspaceId)))
    .limit(1);
  return m?.role ?? null;
}

export async function setActiveWorkspace(sessionId: string, workspaceId: string) {
  await db().update(userSessions).set({ activeWorkspaceId: workspaceId }).where(eq(userSessions.id, sessionId));
}

// ------------------------------------------------------------------ API keys

export async function createApiKey(ws: typeof workspaces.$inferSelect, input: { name?: unknown; scopes?: unknown; expires_in_days?: unknown }, createdBy: string | null) {
  const name = typeof input.name === "string" && input.name.trim() ? input.name.trim().slice(0, 100) : null;
  if (!name) throw new ApiError("invalid_data", "Key name is required", { param: "name" });
  let scopes: string[] = ["*"];
  if (input.scopes !== undefined) {
    if (!Array.isArray(input.scopes) || input.scopes.length === 0) throw new ApiError("invalid_data", "scopes must be a non-empty array", { param: "scopes" });
    for (const s of input.scopes) {
      if (s !== "*" && !(API_KEY_SCOPES as readonly string[]).includes(String(s))) throw new ApiError("invalid_data", `Unknown scope ${String(s)}`, { param: "scopes" });
    }
    scopes = input.scopes.map(String);
  }
  let expiresAt: Date | null = null;
  if (input.expires_in_days !== undefined && input.expires_in_days !== null) {
    const days = Number(input.expires_in_days);
    if (!Number.isInteger(days) || days < 1 || days > 730) throw new ApiError("invalid_data", "expires_in_days must be 1 to 730", { param: "expires_in_days" });
    expiresAt = new Date(Date.now() + days * 86400_000);
  }
  const [count] = await db()
    .select({ n: sql<number>`count(*)::int` })
    .from(apiKeys)
    .where(and(eq(apiKeys.workspaceId, ws.id), isNull(apiKeys.revokedAt)));
  if (Number(count?.n ?? 0) >= MAX_ACTIVE_KEYS) throw new ApiError("api_key_limit_exceeded", "Workspace has reached its active API key cap. Revoke an existing key first.");
  const prefix = API_KEY_PREFIX[ws.environment];
  const secret = `${prefix}${randomToken(32)}`;
  const [row] = await db()
    .insert(apiKeys)
    .values({ id: newId("apiKey"), workspaceId: ws.id, name, tokenPrefix: prefix, tokenHash: sha256Hex(secret), last4: secret.slice(-4), scopes, createdByUserId: createdBy, expiresAt })
    .returning();
  return { row: row!, secret };
}

export function serializeApiKey(k: typeof apiKeys.$inferSelect) {
  const status = k.revokedAt ? "revoked" : k.expiresAt && k.expiresAt.getTime() < Date.now() ? "expired" : "active";
  return {
    id: k.id,
    object: "api_key" as const,
    name: k.name,
    redacted: `${k.tokenPrefix}…${k.last4}`,
    scopes: k.scopes,
    status,
    created_at: k.createdAt.toISOString(),
    last_used_at: k.lastUsedAt?.toISOString() ?? null,
    expires_at: k.expiresAt?.toISOString() ?? null,
    revoked_at: k.revokedAt?.toISOString() ?? null,
  };
}

export async function listApiKeys(workspaceId: string) {
  return db().select().from(apiKeys).where(eq(apiKeys.workspaceId, workspaceId)).orderBy(desc(apiKeys.createdAt));
}

export async function revokeApiKey(workspaceId: string, id: string) {
  const [row] = await db()
    .update(apiKeys)
    .set({ revokedAt: new Date() })
    .where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, workspaceId), isNull(apiKeys.revokedAt)))
    .returning();
  if (!row) throw new ApiError("resource_not_found", "Active API key not found");
  return row;
}

export async function deleteApiKey(workspaceId: string, id: string) {
  const rows = await db().delete(apiKeys).where(and(eq(apiKeys.id, id), eq(apiKeys.workspaceId, workspaceId))).returning();
  if (!rows.length) throw new ApiError("resource_not_found", "API key not found");
}

// ------------------------------------------------------------------ invitations

export async function inviteMember(workspaceId: string, input: { email: unknown; role: unknown }, invitedBy: string) {
  const email = validateEmail(input.email);
  if (!email) throw new ApiError("invalid_data", "email is required", { param: "email" });
  if (input.role !== "admin" && input.role !== "member" && input.role !== "owner") throw new ApiError("invalid_data", "role must be owner, admin or member", { param: "role" });
  const token = randomToken(32);
  await db()
    .insert(invitations)
    .values({ id: newId("invitation"), workspaceId, email, role: input.role, tokenHash: sha256Hex(token), invitedByUserId: invitedBy, expiresAt: new Date(Date.now() + 7 * 86400_000) });
  return token;
}

export async function acceptInvitation(userId: string, userEmail: string, token: string) {
  const [inv] = await db()
    .select()
    .from(invitations)
    .where(and(eq(invitations.tokenHash, sha256Hex(token)), isNull(invitations.acceptedAt), gt(invitations.expiresAt, new Date())))
    .limit(1);
  if (!inv) throw new ApiError("resource_not_found", "Invitation not found or expired");
  if (inv.email !== userEmail.toLowerCase()) throw new ApiError("forbidden", "This invitation was sent to a different email address");
  if (!(await roleIn(userId, inv.workspaceId))) {
    await db().insert(memberships).values({ id: newId("membership"), userId, workspaceId: inv.workspaceId, role: inv.role });
  }
  await db().update(invitations).set({ acceptedAt: new Date() }).where(eq(invitations.id, inv.id));
  return inv.workspaceId;
}
