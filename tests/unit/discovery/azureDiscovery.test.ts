import { afterEach, describe, expect, it, vi } from "vitest";
import { AzureDiscoveryAdapter } from "../../../src/models/discovery/azureDiscovery";
import { UNKNOWN_RESOURCE_FACTS, type Connection } from "../../../src/models/connections";

const armEnv = {
  AZURE_ARM_TENANT_ID: "tenant-1", AZURE_ARM_CLIENT_ID: "client-1", AZURE_ARM_CLIENT_SECRET: "arm-secret",
  AZURE_ARM_SUBSCRIPTION_ID: "sub-1", AZURE_ARM_RESOURCE_GROUP: "rg-1", AZURE_ARM_ACCOUNT_NAME: "account-1"
};

function connection(overrides: Partial<Connection> = {}): Connection {
  return { connectionId: "default-azure", apiKind: "azure-openai-chat", resourceFacts: UNKNOWN_RESOURCE_FACTS, quota: {}, compute: { ownedOrRented: "unknown" }, ...overrides };
}

describe("AzureDiscoveryAdapter", () => {
  afterEach(() => vi.restoreAllMocks());

  it("throws a clear, specific error naming the missing management-plane variables (no ARM call attempted)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const adapter = new AzureDiscoveryAdapter({});
    await expect(adapter.discover(connection(), new AbortController().signal)).rejects.toThrow(/AZURE_ARM_TENANT_ID/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fetches an AAD token then lists deployments, mapping fields without leaking the client secret", async () => {
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("login.microsoftonline.com")) {
        expect(String(init?.body)).toContain("arm-secret");
        return new Response(JSON.stringify({ access_token: "fake-arm-token" }), { status: 200 });
      }
      if (url.includes("management.azure.com")) {
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer fake-arm-token");
        return new Response(JSON.stringify({
          value: [
            { name: "gpt-fast-deployment", properties: { model: { name: "gpt-4o-mini", version: "2024-07-18" }, provisioningState: "Succeeded" } },
            { name: "old-deployment", properties: { model: { name: "gpt-35" }, provisioningState: "Failed" } }
          ]
        }), { status: 200 });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock as unknown as typeof fetch);

    const adapter = new AzureDiscoveryAdapter(armEnv);
    const observations = await adapter.discover(connection(), new AbortController().signal);

    expect(observations).toEqual([
      expect.objectContaining({ model: "gpt-fast-deployment", revision: "2024-07-18", health: "reachable", access: "unknown", installed: "yes", source: "azure-arm-deployments-list" }),
      expect.objectContaining({ model: "old-deployment", health: "unreachable" })
    ]);
    expect(JSON.stringify(observations)).not.toContain("arm-secret");
  });

  it("follows nextLink pagination up to a bounded number of pages", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async (url: string) => {
      if (url.includes("login.microsoftonline.com")) return new Response(JSON.stringify({ access_token: "t" }), { status: 200 });
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ value: [{ name: "page1-deployment", properties: {} }], nextLink: "https://management.azure.com/next" }), { status: 200 });
      return new Response(JSON.stringify({ value: [{ name: "page2-deployment", properties: {} }] }), { status: 200 });
    }) as unknown as typeof fetch);

    const adapter = new AzureDiscoveryAdapter(armEnv);
    const observations = await adapter.discover(connection(), new AbortController().signal);
    expect(observations.map((o) => o.model)).toEqual(["page1-deployment", "page2-deployment"]);
  });

  it("throws when the AAD token endpoint fails", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })) as unknown as typeof fetch);
    const adapter = new AzureDiscoveryAdapter(armEnv);
    await expect(adapter.discover(connection(), new AbortController().signal)).rejects.toThrow(/401/);
  });
});
