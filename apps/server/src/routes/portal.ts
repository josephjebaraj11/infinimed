import { Hono } from "hono";
import { html } from "hono/html";
import { and, eq, gt } from "drizzle-orm";
import { config } from "../config.js";
import { db } from "../db/client.js";
import { magicLinks, patients, workspaces } from "../db/schema.js";
import { sha256Hex } from "../lib/crypto.js";
import { randomToken } from "../lib/ids.js";
import type { AppEnv } from "../http/context.js";
import { createSession } from "../services/sessions.js";
import { patientConnections } from "../services/patients.js";
import { recordStats } from "../services/records.js";
import { CSP, layout, type Branding } from "./pages/layout.js";

/**
 * Patient portal for sandbox and support use: a magic link signs a person in as one patient of the
 * workspace, lists what they have connected, and lets them link more portals through the hosted flow.
 */

export async function createMagicLink(workspaceId: string, patientId: string) {
  const token = randomToken(32);
  await db()
    .insert(magicLinks)
    .values({ tokenHash: sha256Hex(token), workspaceId, patientId, expiresAt: new Date(Date.now() + 24 * 3600_000) });
  return `${config().publicUrl}/portal/${token}`;
}

async function resolve(token: string) {
  const [row] = await db()
    .select({ link: magicLinks, patient: patients, ws: workspaces })
    .from(magicLinks)
    .innerJoin(patients, eq(patients.id, magicLinks.patientId))
    .innerJoin(workspaces, eq(workspaces.id, magicLinks.workspaceId))
    .where(and(eq(magicLinks.tokenHash, sha256Hex(token)), gt(magicLinks.expiresAt, new Date())))
    .limit(1);
  return row ?? null;
}

export function portalRouter() {
  const r = new Hono<AppEnv>();
  r.use("/portal/*", async (c, next) => {
    await next();
    c.header("Content-Security-Policy", CSP);
    c.header("Cache-Control", "no-store");
  });

  r.get("/portal/:token", async (c) => {
    const ctx = await resolve(c.req.param("token"));
    if (!ctx) return c.html(layout({ title: "Link expired", body: html`<div class="card"><h1>Link expired</h1><p>Ask for a new sign-in link.</p></div>` }), 410);
    const branding = ctx.ws.branding as Branding;
    const conns = await patientConnections(ctx.patient.id);
    const stats = await recordStats(ctx.patient.id);
    const total = stats.reduce((s, x) => s + Number(x.n), 0);
    return c.html(
      layout({
        title: "Your health records",
        branding,
        body: html`<div class="card">
            <h1>Hello${ctx.patient.name ? `, ${ctx.patient.name}` : ""}</h1>
            <p>${total} records from ${conns.filter((x) => x.connection.status === "active").length} connected sources.</p>
            <form method="post" action="/portal/${c.req.param("token")}/link"><button type="submit">Link your patient portals</button></form>
          </div>
          <div class="card"><h2>Connected sources</h2>
            <ul class="list">${conns.length
              ? conns.map(
                  ({ connection, source }) => html`<li><div class="meta"><strong>${source?.name ?? connection.sourceId}</strong><span>${connection.lastPullAt ? `Last updated ${connection.lastPullAt.toISOString().slice(0, 16).replace("T", " ")} UTC` : "Waiting for records"}</span></div>
                  <span class="chip ${connection.status === "active" ? "ok" : "bad"}">${connection.status}</span></li>`,
                )
              : html`<li class="muted">Nothing connected yet.</li>`}</ul>
          </div>`,
      }),
    );
  });

  r.post("/portal/:token/link", async (c) => {
    const token = c.req.param("token");
    const ctx = await resolve(token);
    if (!ctx) return c.text("Link expired", 410);
    const session = await createSession(
      ctx.ws,
      { patient_id: ctx.patient.externalId, return_url: `${config().publicUrl}/portal/${token}`, return_button_label: "Back to your records" },
      "portal",
    );
    return c.redirect(session.url!, 302);
  });

  return r;
}
