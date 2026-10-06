import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  UnsafeDestinationError,
  assertLocalDestination,
  clientAuthHeaders
} from "../../src/auth/clientToken";
import { LocalIdentityError, loadOrCreateIdentity } from "../../src/auth/localIdentity";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function root() {
  const dir = await mkdtemp(join(tmpdir(), "chat-client-token-"));
  roots.push(dir);
  return dir;
}

describe("client credentials", () => {
  it("are only sent to plain-HTTP loopback destinations without user information", () => {
    for (const ok of ["http://localhost:3100", "http://127.0.0.1:1/", "http://[::1]:3100/x"])
      expect(() => assertLocalDestination(ok)).not.toThrow();
    for (const bad of [
      "https://127.0.0.1:3100",
      "http://example.com",
      "http://127.0.0.2:3100",
      "http://localhost.example.com",
      "http://user:pass@127.0.0.1:3100",
      "http://user@localhost:3100",
      "ftp://127.0.0.1",
      "not a url",
      ""
    ])
      expect(() => assertLocalDestination(bad), bad).toThrow(UnsafeDestinationError);
  });

  it("refuse an unsafe destination before reading any identity", async () => {
    // The directory holds no identity: reading it first would fail differently.
    await expect(
      clientAuthHeaders("http://example.com", "operator", await root())
    ).rejects.toBeInstanceOf(UnsafeDestinationError);
  });

  it("load an existing identity and never create one", async () => {
    const empty = join(await root(), "ChatAgent");
    await expect(clientAuthHeaders("http://127.0.0.1:1", "client", empty)).rejects.toThrow(
      LocalIdentityError
    );
    await expect(readdir(empty)).rejects.toMatchObject({ code: "ENOENT" });

    const dir = join(await root(), "ChatAgent");
    const identity = await loadOrCreateIdentity(dir);
    expect(await clientAuthHeaders("http://127.0.0.1:1", "client", dir)).toEqual({
      authorization: `Bearer ${identity.clientToken}`
    });
    expect(await clientAuthHeaders("http://localhost:1", "operator", dir)).toEqual({
      authorization: `Bearer ${identity.operatorToken}`
    });
  }, 120_000);
});
