import { scopedOwnerKey, type Authenticator, type Principal } from "../../src/auth/authenticator";

/** The owner key a label becomes for allowAllTestAuth's principal, for direct store access. */
export const testOwner = (...labels: string[]) => scopedOwnerKey("local:test", labels);

/**
 * TEST ONLY. Treats every request as the installation owner, so suites that test
 * other behaviour keep their requests unchanged. Authentication itself is tested
 * against the real LocalAuthenticator (tests/integration/httpAuth.test.ts and the
 * browser suite). Production code cannot import this file.
 */
export const allowAllTestAuth: Authenticator = {
  resolve: (): Principal => ({
    principalId: "local:test",
    roles: new Set(["client", "operator"]),
    via: "bearer"
  })
};
