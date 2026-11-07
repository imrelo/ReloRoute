import assert from "node:assert/strict";
import test from "node:test";
import { getProviderModels } from "../../open-sse/config/providerModels.ts";
import { getRegistryEntry } from "../../open-sse/config/providerRegistry.ts";
import { getExecutor } from "../../open-sse/executors/index.ts";
import { MuseAiWebExecutor } from "../../open-sse/executors/muse-ai-web.ts";
import { validateProviderApiKey } from "../../src/lib/providers/validation.ts";
import { WEB_COOKIE_PROVIDERS } from "../../src/shared/constants/providers.ts";
import {
  getWebSessionCredentialRequirement,
  resolveWebSessionImportApiKey,
} from "../../src/shared/providers/webSessionCredentials.ts";

test("Muse AI routes its model alias to the muse.ai provider and supports cookie imports", async () => {
  const provider = getRegistryEntry("museai");
  assert.equal(provider?.id, "muse-ai-web");
  assert.equal(provider.baseUrl, "https://muse.ai");
  assert.equal(WEB_COOKIE_PROVIDERS[provider.id].alias, "museai");
  assert.ok((await getExecutor("museai")) instanceof MuseAiWebExecutor);
  assert.ok((await getExecutor("muse-ai-web")) instanceof MuseAiWebExecutor);
  assert.deepEqual(getProviderModels("museai"), [
    { id: "muse-chat", name: "Muse Chat", toolCalling: true },
  ]);
  const requirement = getWebSessionCredentialRequirement(provider.id);
  assert.equal(requirement?.credentialName, "hatch_sess");
  assert.equal(resolveWebSessionImportApiKey(requirement, "test-cookie"), null);
});

test("Muse AI validates a bulk-imported cookie without an API key or a chat request", async (t) => {
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (..._args: Parameters<typeof globalThis.fetch>) => Response.json({ status: "assigned" })
  );
  const result = await validateProviderApiKey({
    provider: "muse-ai-web",
    apiKey: null,
    providerSpecificData: { cookie: "hatch_sess=test-cookie; hatch_vml=test-vm" },
  });
  assert.equal(result.valid, true);
  assert.equal(fetch.mock.callCount(), 1);
  const [url, init] = fetch.mock.calls[0].arguments;
  assert.equal(String(url), "https://muse.ai/api/session");
  assert.equal(init?.method, "GET");
  assert.equal(init?.redirect, "manual");
  assert.equal(
    new Headers(init?.headers).get("cookie"),
    "hatch_sess=test-cookie; hatch_vml=test-vm"
  );
});

test("Muse AI distinguishes an expired session from denied access", async (t) => {
  const fetch = t.mock.method(
    globalThis,
    "fetch",
    async (..._args: Parameters<typeof globalThis.fetch>) =>
      new Response("test-cookie", {
        status: 401,
      })
  );
  const options = { provider: "museai", apiKey: "test-cookie" };
  const expired = await validateProviderApiKey(options);
  assert.equal(expired.valid, false);
  assert.equal(expired.error, "SESSION_EXPIRED");
  const [, init] = fetch.mock.calls[0].arguments;
  assert.equal(new Headers(init?.headers).get("cookie"), "hatch_sess=test-cookie");

  fetch.mock.mockImplementation(async () => new Response("test-cookie", { status: 403 }));
  const denied = await validateProviderApiKey(options);
  assert.equal(denied.valid, false);
  assert.equal(denied.error, "Muse AI session check failed (HTTP 403)");

  fetch.mock.mockImplementation(async () => Response.json({ status: "unassigned" }));
  const unassigned = await validateProviderApiKey(options);
  assert.equal(unassigned.valid, false);
  assert.equal(unassigned.error, "Muse AI did not return an assigned workspace session");
});
