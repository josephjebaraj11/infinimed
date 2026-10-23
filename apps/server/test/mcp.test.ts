import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { createHash, randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { completeSyntheticLogin, setupWorkspace, startTestServer, type TestServer } from "./harness.js";

let server: TestServer;
let apiKey: string;
let dash: Awaited<ReturnType<typeof setupWorkspace>>["dash"];

beforeAll(async () => {
  server = await startTestServer();
  ({ apiKey, dash } = await setupWorkspace(server));
});
afterAll(async () => server?.close());

type ToolResult = { content: { type: string; text: string }[]; isError?: boolean };
const parse = (r: unknown) => JSON.parse((r as ToolResult).content[0]!.text) as Record<string, unknown>;

describe("MCP with an API key", () => {
  let client: Client;
  beforeAll(async () => {
    client = new Client({ name: "test-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } }));
  });
  afterAll(async () => client?.close());

  test("lists tools with annotations", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining(["get_workspace_overview", "search_health_systems", "connect_health_system", "check_connection_status", "get_health_records", "disconnect_health_system", "delete_person"]),
    );
    expect(tools.find((t) => t.name === "delete_person")!.annotations?.destructiveHint).toBe(true);
    expect(tools.find((t) => t.name === "get_health_records")!.annotations?.readOnlyHint).toBe(true);
  });

  test("search, connect a person, check status, read reconciled records", async () => {
    const found = parse(await client.callTool({ name: "search_health_systems", arguments: { query: "synthetic" } }));
    const sourceId = (found.matches as { source_id: string }[])[0]!.source_id;
    const conn = parse(await client.callTool({ name: "connect_health_system", arguments: { source_ids: [sourceId], person_name: "Marisol Ventura" } }));
    expect(String(conn.link)).toContain("/connect/");
    await completeSyntheticLogin(server, String(conn.link), { patientRow: "syn_1" });
    await server.worker.drain();
    const status = parse(await client.callTool({ name: "check_connection_status", arguments: { patient_id: conn.patient_id } }));
    expect((status.connections as { status: string }[])[0]!.status).toBe("active");
    const summary = parse(await client.callTool({ name: "get_health_records", arguments: { patient_id: conn.patient_id } }));
    expect((summary.allergies as unknown[]).length).toBeGreaterThan(0);
    expect((summary.latest_vitals_and_labs as unknown[]).length).toBeGreaterThan(5);
    // the same name reuses the person
    const again = parse(await client.callTool({ name: "connect_health_system", arguments: { source_ids: [sourceId], person_name: "marisol ventura" } }));
    expect(again.patient_id).toBe(conn.patient_id);
    const people = parse(await client.callTool({ name: "list_people", arguments: {} }));
    expect((people.people as unknown[]).length).toBe(1);
    // a new person needs a full name
    const bad = (await client.callTool({ name: "connect_health_system", arguments: { source_ids: [sourceId], person_name: "Cher" } })) as ToolResult;
    expect(bad.isError).toBe(true);
  });

  test("every tool call is audited", async () => {
    const audit = await dash.ok<{ data: { action: string }[] }>("/audit");
    expect(audit.data.some((a) => a.action === "mcp.tool.get_health_records")).toBe(true);
  });
});

describe("MCP with OAuth (dynamic client registration, PKCE, consent scopes)", () => {
  test("full authorization flow and scope enforcement", async () => {
    const unauth = await fetch(`${server.url}/mcp`, { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" });
    expect(unauth.status).toBe(401);
    expect(unauth.headers.get("www-authenticate")).toContain("resource_metadata=");
    const prm = (await (await fetch(`${server.url}/.well-known/oauth-protected-resource/mcp`)).json()) as { authorization_servers: string[]; resource: string };
    expect(prm.resource).toBe(`${server.url}/mcp`);
    const asMeta = (await (await fetch(`${prm.authorization_servers[0]}/.well-known/oauth-authorization-server`)).json()) as Record<string, string>;

    const reg = (await (await fetch(asMeta.registration_endpoint!, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ client_name: "Test Assistant", redirect_uris: ["http://127.0.0.1:33418/callback"] }) })).json()) as { client_id: string };
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authUrl = new URL(asMeta.authorization_endpoint!);
    for (const [k, v] of Object.entries({ response_type: "code", client_id: reg.client_id, redirect_uri: "http://127.0.0.1:33418/callback", code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "connect records:read manage", resource: `${server.url}/mcp` })) authUrl.searchParams.set(k, v);

    // Not signed in: the login form appears; sign in with the dashboard account.
    const loginPage = await (await fetch(authUrl)).text();
    const request = /name="request" value="([^"]+)"/.exec(loginPage)![1]!;
    const me = await dash.ok<{ user: { email: string } }>("/me");
    const login = await fetch(`${server.url}/oauth/login`, { method: "POST", body: new URLSearchParams({ request, email: me.user.email, password: "correct horse battery" }), redirect: "manual" });
    const cookie = login.headers.get("set-cookie")!.split(";")[0]!;
    const consentPage = await (await fetch(new URL(login.headers.get("location")!, server.url), { headers: { Cookie: cookie } })).text();
    expect(consentPage).toContain("Allow Test Assistant?");
    const consentReq = /name="request" value="([^"]+)"/.exec(consentPage)![1]!;
    const wsId = /<option value="(ws_[A-Z0-9]+)"/.exec(consentPage)![1]!;
    // The user unticks "manage".
    const form = new URLSearchParams({ request: consentReq, workspace_id: wsId, decision: "allow" });
    form.append("scope", "connect");
    form.append("scope", "records:read");
    const consent = await fetch(`${server.url}/oauth/consent`, { method: "POST", headers: { Cookie: cookie }, body: form, redirect: "manual" });
    const redirect = new URL(consent.headers.get("location")!);
    expect(redirect.searchParams.get("state")).toBe("xyz");
    const code = redirect.searchParams.get("code")!;

    const tokenRes = await fetch(asMeta.token_endpoint!, {
      method: "POST",
      body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: "http://127.0.0.1:33418/callback", code_verifier: verifier, resource: `${server.url}/mcp` }),
    });
    const tokens = (await tokenRes.json()) as { access_token: string; refresh_token: string; scope: string };
    expect(tokens.scope).toBe("connect records:read");
    // codes are single use
    const replay = await fetch(asMeta.token_endpoint!, { method: "POST", body: new URLSearchParams({ grant_type: "authorization_code", code, client_id: reg.client_id, redirect_uri: "http://127.0.0.1:33418/callback", code_verifier: verifier }) });
    expect(replay.status).toBe(400);

    const client = new Client({ name: "oauth-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(`${server.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${tokens.access_token}` } } }));
    const overview = parse(await client.callTool({ name: "get_workspace_overview", arguments: {} }));
    expect((overview.user as { email: string }).email).toBe(me.user.email);
    const denied = (await client.callTool({ name: "delete_person", arguments: { patient_id: "anyone" } })) as ToolResult;
    expect(denied.isError).toBe(true);
    expect(denied.content[0]!.text).toContain("manage");
    await client.close();

    // Refresh rotates; the old refresh token stops working.
    const refreshed = (await (await fetch(asMeta.token_endpoint!, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token, client_id: reg.client_id }) })).json()) as { refresh_token: string };
    expect(refreshed.refresh_token).not.toBe(tokens.refresh_token);
    const stale = await fetch(asMeta.token_endpoint!, { method: "POST", body: new URLSearchParams({ grant_type: "refresh_token", refresh_token: tokens.refresh_token }) });
    expect(stale.status).toBe(400);

    // Revoking from the dashboard blocks further use.
    const grants = await dash.ok<{ data: { id: string; client_name: string }[] }>("/mcp/grants");
    const grant = grants.data.find((g) => g.client_name === "Test Assistant")!;
    await dash.ok(`/mcp/grants/${grant.id}/revoke`, {});
    const afterRevoke = await fetch(`${server.url}/mcp`, { method: "POST", headers: { Authorization: `Bearer ${tokens.access_token}`, "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
    expect(afterRevoke.status).toBe(401);
  });
});

