import { createHmac, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  LocalAuthenticator,
  SESSION_MAX_AGE_SECONDS,
  ownerKey
} from "../../src/auth/authenticator";
import { evaluatePosixMode, evaluateWindowsAcl, type WindowsAcl } from "../../src/auth/filePrivacy";
import { localIdentitySchema, type LocalIdentity } from "../../src/auth/localIdentity";

const ME = "S-1-5-21-1-2-3-1001";
const FULL = 0x1f01ff;
const acl = (over: Partial<WindowsAcl> = {}): WindowsAcl => ({
  ownerSid: ME,
  currentUserSid: ME,
  protected: true,
  rules: [
    { sid: ME, type: "Allow", rights: FULL, inherited: false },
    { sid: "S-1-5-18", type: "Allow", rights: FULL, inherited: false },
    { sid: "S-1-5-32-544", type: "Allow", rights: FULL, inherited: false }
  ],
  ...over
});

describe("Windows ACL evaluation (SIDs only)", () => {
  it("passes an owner-only protected ACL", () => {
    expect(evaluateWindowsAcl(acl())).toEqual([]);
  });

  it("rejects each widening or inheritance path", () => {
    const base = acl().rules;
    const cases: [Partial<WindowsAcl>, RegExp][] = [
      [
        { rules: [...base, { sid: "S-1-1-0", type: "Allow", rights: 0x1200a9, inherited: false }] },
        /S-1-1-0/
      ],
      [
        {
          rules: [
            ...base,
            { sid: "S-1-5-32-545", type: "Allow", rights: 0x1200a9, inherited: false }
          ]
        },
        /S-1-5-32-545/
      ],
      [
        {
          rules: [...base, { sid: "S-1-5-11", type: "Allow", rights: 0x1200a9, inherited: false }]
        },
        /S-1-5-11/
      ],
      [
        {
          rules: [
            ...base,
            { sid: "S-1-5-21-1-2-3-1004", type: "Allow", rights: FULL, inherited: false }
          ]
        },
        /1004/
      ],
      [{ rules: base.map((r) => ({ ...r, inherited: true })) }, /inherited rule/],
      [{ protected: false }, /inherits permissions/],
      [{ ownerSid: "S-1-5-32-544" }, /owner is/],
      [{ rules: base.filter((r) => r.sid !== ME) }, /full control/],
      [{ rules: [{ sid: ME, type: "Allow", rights: 0x1200a9, inherited: false }] }, /full control/]
    ];
    for (const [over, reason] of cases)
      expect(evaluateWindowsAcl(acl(over)).join("; ")).toMatch(reason);
  });

  it("tolerates deny rules, which only narrow access", () => {
    expect(
      evaluateWindowsAcl(
        acl({
          rules: [...acl().rules, { sid: "S-1-1-0", type: "Deny", rights: FULL, inherited: false }]
        })
      )
    ).toEqual([]);
  });
});

describe("POSIX mode evaluation", () => {
  it("requires the current owner and no group or other bits", () => {
    expect(evaluatePosixMode({ uid: 501, mode: 0o100600 }, 501)).toEqual([]);
    expect(evaluatePosixMode({ uid: 501, mode: 0o40700 }, 501)).toEqual([]);
    expect(evaluatePosixMode({ uid: 0, mode: 0o100600 }, 501)[0]).toMatch(/uid 0/);
    expect(evaluatePosixMode({ uid: 501, mode: 0o100640 }, 501)[0]).toMatch(/640/);
    expect(evaluatePosixMode({ uid: 501, mode: 0o40701 }, 501)[0]).toMatch(/701/);
  });
});

const secret = () => randomBytes(32).toString("base64url");
const identity = (over: Partial<LocalIdentity> = {}): LocalIdentity => ({
  version: 1,
  principalId: "local:0b8f3a52-6c1e-4b8a-9f3e-2d7c5a1b9e40",
  sessionKey: secret(),
  clientToken: secret(),
  operatorToken: secret(),
  epoch: 0,
  ...over
});
const roles = (p: ReturnType<LocalAuthenticator["resolve"]>) =>
  p ? [...p.roles].sort() : undefined;

describe("local authenticator", () => {
  it("grants client to the client token and both roles to the operator token", () => {
    const id = identity();
    const auth = new LocalAuthenticator(id);
    expect(roles(auth.resolve({ authorization: `Bearer ${id.clientToken}` }))).toEqual(["client"]);
    expect(roles(auth.resolve({ authorization: `Bearer ${id.operatorToken}` }))).toEqual([
      "client",
      "operator"
    ]);
    expect(auth.resolve({ authorization: `Bearer ${id.clientToken}` })).toMatchObject({
      principalId: id.principalId,
      via: "bearer"
    });
  });

  it("rejects unknown, malformed and near-miss bearer tokens", () => {
    const id = identity();
    const auth = new LocalAuthenticator(id);
    for (const authorization of [
      `Bearer ${secret()}`,
      `Bearer ${id.clientToken.slice(0, -1)}`,
      `Bearer ${id.clientToken}A`,
      `bearer ${id.clientToken}`,
      `Bearer  ${id.clientToken}`,
      `Basic ${id.clientToken}`,
      id.clientToken,
      "Bearer ",
      ""
    ])
      expect(auth.resolve({ authorization })).toBeUndefined();
    // A malformed Authorization header is not rescued by a valid session.
    expect(
      auth.resolve({ authorization: "Bearer x", sessionToken: auth.issueSession() })
    ).toBeUndefined();
    expect(auth.resolve({})).toBeUndefined();
  });

  it("accepts its own session and rejects tampering, foreign keys and bad shapes", () => {
    const id = identity();
    const auth = new LocalAuthenticator(id);
    const token = auth.issueSession();
    expect(auth.resolve({ sessionToken: token })).toMatchObject({ via: "session" });
    expect(roles(auth.resolve({ sessionToken: token }))).toEqual(["client", "operator"]);
    const [payload, mac] = token.split(".");
    const flip = (s: string) => (s[0] === "A" ? "B" : "A") + s.slice(1);
    for (const bad of [
      `${flip(payload)}.${mac}`,
      `${payload}.${flip(mac)}`,
      `${payload}.${mac}.x`,
      `${payload}`,
      `.${mac}`,
      `${payload}+.${mac}`,
      new LocalAuthenticator(identity()).issueSession(),
      "x".repeat(600)
    ])
      expect(auth.resolve({ sessionToken: bad })).toBeUndefined();
  });

  it("enforces the strict payload schema even under a valid signature", () => {
    const id = identity();
    const now = 1_800_000_000;
    const auth = new LocalAuthenticator(id, () => now);
    const sign = (body: object) => {
      const p = Buffer.from(JSON.stringify(body));
      const m = createHmac("sha256", Buffer.from(id.sessionKey, "base64url"))
        .update(p)
        .digest("base64url");
      return `${p.toString("base64url")}.${m}`;
    };
    const good = {
      v: 1,
      sid: randomBytes(16).toString("base64url"),
      pid: id.principalId,
      ep: 0,
      iat: now,
      exp: now + 60
    };
    expect(auth.resolve({ sessionToken: sign(good) })).toBeDefined();
    for (const body of [
      { ...good, extra: true },
      { ...good, v: 2 },
      { ...good, sid: "short" },
      { ...good, pid: "local:other" },
      { ...good, ep: 1 },
      { ...good, iat: now + 61 },
      { ...good, exp: now },
      // Issued slightly in the future (within skew) but expiring before it was issued.
      { ...good, iat: now + 30, exp: now + 10 },
      { ...good, iat: now + 30, exp: now + 30 },
      { ...good, iat: now - 10, exp: now - 10 + SESSION_MAX_AGE_SECONDS + 1 },
      { ...good, exp: "later" }
    ])
      expect(auth.resolve({ sessionToken: sign(body) })).toBeUndefined();
    const notJson = Buffer.from("not json");
    const mac = createHmac("sha256", Buffer.from(id.sessionKey, "base64url"))
      .update(notJson)
      .digest("base64url");
    expect(
      auth.resolve({ sessionToken: `${notJson.toString("base64url")}.${mac}` })
    ).toBeUndefined();
  });

  it("expires sessions after their lifetime", () => {
    const id = identity();
    let now = 1_800_000_000;
    const auth = new LocalAuthenticator(id, () => now);
    const token = auth.issueSession();
    now += SESSION_MAX_AGE_SECONDS - 1;
    expect(auth.resolve({ sessionToken: token })).toBeDefined();
    now += 1;
    expect(auth.resolve({ sessionToken: token })).toBeUndefined();
  });

  it("rotation via useIdentity invalidates old authenticators but keeps the principal", () => {
    const id = identity();
    const auth = new LocalAuthenticator(id);
    const session = auth.issueSession();
    const rotated = identity({ principalId: id.principalId, epoch: 1 });
    auth.useIdentity(rotated);
    expect(auth.resolve({ sessionToken: session })).toBeUndefined();
    expect(auth.resolve({ authorization: `Bearer ${id.clientToken}` })).toBeUndefined();
    expect(auth.resolve({ authorization: `Bearer ${rotated.clientToken}` })?.principalId).toBe(
      id.principalId
    );
    expect(() =>
      auth.useIdentity(identity({ principalId: "local:11111111-2222-4333-8444-555555555555" }))
    ).toThrow("LOCAL_PRINCIPAL_CHANGED");
  });

  it("keeps its own validated copy of the identity", () => {
    const id = identity();
    const original = { ...id };
    const auth = new LocalAuthenticator(id);
    const session = auth.issueSession();
    // Changing the caller's object afterwards must not change what is accepted.
    id.clientToken = secret();
    id.sessionKey = secret();
    id.epoch = 7;
    expect(auth.resolve({ authorization: `Bearer ${original.clientToken}` })).toBeDefined();
    expect(auth.resolve({ authorization: `Bearer ${id.clientToken}` })).toBeUndefined();
    expect(auth.resolve({ sessionToken: session })).toBeDefined();
    const rotated = identity({ principalId: original.principalId, epoch: 1 });
    auth.useIdentity(rotated);
    rotated.principalId = "local:11111111-2222-4333-8444-555555555555";
    expect(auth.principalId).toBe(original.principalId);
    // An invalid identity is refused rather than adopted.
    expect(() => new LocalAuthenticator({ ...original, clientToken: "short" })).toThrow();
  });

  it("returns independent role sets, so mutating one changes no later resolution", () => {
    const id = identity();
    const auth = new LocalAuthenticator(id);
    const first = auth.resolve({ authorization: `Bearer ${id.clientToken}` })!;
    (first.roles as Set<string>).add("operator");
    expect(roles(auth.resolve({ authorization: `Bearer ${id.clientToken}` }))).toEqual(["client"]);
    const session = auth.resolve({ sessionToken: auth.issueSession() })!;
    (session.roles as Set<string>).clear();
    expect(roles(auth.resolve({ sessionToken: auth.issueSession() }))).toEqual([
      "client",
      "operator"
    ]);
  });

  it("accepts only the canonical encoding of a session payload", () => {
    const id = identity();
    const auth = new LocalAuthenticator(id);
    const [payload] = auth.issueSession().split(".");
    // Find a payload whose last character carries unused bits, then flip them.
    const bytes = Buffer.from(payload, "base64url");
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const last = payload.at(-1)!;
    const alternatives = [...alphabet].filter(
      (c) => c !== last && Buffer.from(payload.slice(0, -1) + c, "base64url").equals(bytes)
    );
    expect(alternatives.length).toBeGreaterThan(0);
    const mac = createHmac("sha256", Buffer.from(id.sessionKey, "base64url"))
      .update(bytes)
      .digest("base64url");
    expect(auth.resolve({ sessionToken: `${payload}.${mac}` })).toBeDefined();
    expect(
      auth.resolve({ sessionToken: `${payload.slice(0, -1)}${alternatives[0]}.${mac}` })
    ).toBeUndefined();
  });

  it("validates the identity file format strictly", () => {
    expect(localIdentitySchema.safeParse(identity()).success).toBe(true);
    for (const bad of [
      { ...identity(), extra: 1 },
      { ...identity(), version: 2 },
      { ...identity(), principalId: "local:nope" },
      { ...identity(), clientToken: "short" },
      { ...identity(), epoch: -1 }
    ])
      expect(localIdentitySchema.safeParse(bad).success).toBe(false);
    // 43 characters whose last one sets bits beyond the 32 bytes: not canonical.
    const canonical = secret();
    const nonCanonical = [..."ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"]
      .map((c) => canonical.slice(0, -1) + c)
      .find((s) => s !== canonical && Buffer.from(s, "base64url").toString("base64url") !== s)!;
    expect(localIdentitySchema.safeParse({ ...identity(), sessionKey: nonCanonical }).success).toBe(
      false
    );
  });
});

describe("owner keys", () => {
  it("are canonical and unambiguous for any label", () => {
    expect(ownerKey("local:p", ["a/b", "c"])).not.toBe(ownerKey("local:p", ["a", "b/c"]));
    expect(ownerKey("local:p", ["a", "b"])).toBe('["local:p","a","b"]');
    expect(ownerKey("local:p", [])).not.toBe(ownerKey("local:p", [""]));
    expect(ownerKey("local:p/x", [])).not.toBe(ownerKey("local:p", ["x"]));
  });
});
