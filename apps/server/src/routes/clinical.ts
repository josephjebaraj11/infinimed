import { Hono } from "hono";
import { html } from "hono/html";
import { ApiError } from "../lib/errors.js";
import { errorFields, log } from "../lib/logger.js";
import type { AppEnv, Ctx } from "../http/context.js";
import { beginEhrLaunch, completeEhrLaunch } from "../services/ehr-launch.js";
import { cdsDiscovery, cdsInvoke } from "../services/cds-hooks.js";
import { CSP, layout } from "./pages/layout.js";

/** Clinician workflow endpoints the EHR calls: SMART EHR launch and CDS Hooks. */
export function clinicalRouter() {
  const r = new Hono<AppEnv>();

  const errorPage = (title: string, message: string) => layout({ title, body: html`<div class="card"><h1>${title}</h1><p>${message}</p></div>` });

  r.get("/smart/launch/:workspaceId", async (c) => {
    c.header("Content-Security-Policy", CSP);
    try {
      const url = await beginEhrLaunch(c.req.param("workspaceId"), c.req.query("iss") ?? null, c.req.query("launch") ?? null);
      return c.redirect(url, 302);
    } catch (err) {
      const message = err instanceof ApiError ? err.message : "The launch could not be started.";
      if (!(err instanceof ApiError)) log.error("ehr launch failed", errorFields(err));
      return c.html(errorPage("Launch failed", message), err instanceof ApiError ? (err.status as 400) : 500);
    }
  });

  r.get("/smart/launch-callback", async (c) => {
    c.header("Content-Security-Policy", CSP);
    const result = await completeEhrLaunch(new URL(c.req.url).searchParams);
    if (result.redirectTo) return c.redirect(result.redirectTo, 302);
    return c.html(errorPage("Launch failed", result.error?.description ?? "Unknown error"), 400);
  });

  r.get("/cds-services/:workspaceId", async (c) => c.json(await cdsDiscovery(c.req.param("workspaceId"))));

  const invoke = (feedback: boolean) => async (c: Ctx) => {
    const body = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
    if (!body) return c.json({ error: "Body must be JSON" }, 400);
    try {
      const res = await cdsInvoke({ workspaceId: c.req.param("workspaceId")!, serviceId: c.req.param("serviceId")!, body, authorization: c.req.header("authorization") ?? null, feedback });
      return c.json(res.body as object, res.status as 200);
    } catch (err) {
      if (err instanceof ApiError) return c.json({ error: err.message }, err.status as 400);
      throw err;
    }
  };
  r.post("/cds-services/:workspaceId/:serviceId", invoke(false));
  r.post("/cds-services/:workspaceId/:serviceId/feedback", invoke(true));

  return r;
}
