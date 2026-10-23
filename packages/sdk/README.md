# @infinimed/sdk

TypeScript SDK for the InfiniMed API. Zero runtime dependencies; Node 18+, Bun, Deno and edge runtimes.
Keep your API key on the server.

```ts
import { InfiniMed, isInfiniMedError, parseReturnUrl } from "@infinimed/sdk";

const im = new InfiniMed(process.env.INFINIMED_API_KEY!, { baseUrl: "https://api.example.com" });

// Start a session; redirect the patient to session.url
const session = await im.patientSessions.create({ patient_id: "user_42", return_url: "https://app.example.com/connected" });

// On your return_url route
const result = parseReturnUrl(new URL(req.url).searchParams);
const patient = await im.patients.retrieve(result!.patient_id);
const live = patient.connections.filter((c) => c.status === "active");

// Records: one page, or every page
const page = await im.patients.records("user_42", { count: 100, type: "Observation" });
for await (const item of im.patients.allRecords("user_42").autoPagingIterator()) console.log(item.resource.resourceType);

// Reconciled clinical data
const { data: facts } = await im.patients.facts("user_42", { concepts: ["hba1c", "bmi"] });
const { data: allergies } = await im.patients.model("user_42", "allergies");

// Any list: await for one page, or iterate
for await (const source of im.sources.list({ q: "mychart" }).autoPagingIterator()) console.log(source.name);
```

## Errors

Every failed request throws one `InfiniMedError` with `type`, `code`, `message`, `param`, `statusCode`,
`requestId` and `retryAfter`. Network failures that outlive retries surface as the runtime's own error.

```ts
try {
  await im.patients.create({ patient_id: "user_42" });
} catch (err) {
  if (!isInfiniMedError(err)) throw err;
  if (err.code === "external_id_already_exists") { /* fine */ }
  else console.error(err.code, err.requestId);
}
```

The client retries 429 (honouring `Retry-After`), 502, 503, 504 and network failures up to
`maxNetworkRetries` (default 3), and sends an idempotency key with every POST so retries are safe.

## Webhooks

```ts
import { InfiniMed, InfiniMedSignatureError } from "@infinimed/sdk";

export async function POST(req: Request) {
  const raw = await req.text(); // the raw body, never re-serialized JSON
  try {
    const event = await InfiniMed.webhooks.constructEvent(raw, req.headers.get("InfiniMed-Signature"), process.env.INFINIMED_WEBHOOK_SECRET!);
    switch (event.type) {
      case "records.sync.completed": /* event.data.object.patient_id */ break;
      case "connection.token_refresh_failed": /* ask the patient to reconnect */ break;
    }
    return new Response("ok");
  } catch (err) {
    if (err instanceof InfiniMedSignatureError) return new Response(err.reason, { status: 400 });
    throw err;
  }
}
```

`InfiniMed.webhooks.generateTestHeader(body, secret)` signs payloads for unit tests.
