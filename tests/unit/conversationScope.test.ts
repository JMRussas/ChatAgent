import { it, expect } from "vitest";
import { conversationScopeSchema, scopeForModel } from "../../src/app/conversationScope";
it("keeps explicit topic scope while excluding expired reference content", () => {
  const scope = conversationScopeSchema.parse({path:["Sports","football","NFL","Example"],entity:{provider:"test",id:"1",name:"Example"},reference:{resultId:"00000000-0000-4000-8000-000000000000",sourceUrl:"https://example.invalid",observedAt:"2026-09-30T00:00:00.000Z",expiresAt:"2026-09-30T01:00:00.000Z",revision:"v",fields:{abbreviation:"EXPIRED_CANARY"}}});
  expect(scopeForModel(scope,Date.parse("2026-09-30T00:30:00Z"))?.referenceStatus).toBe("attached");
  const expired=scopeForModel(scope,Date.parse("2026-09-30T01:00:00Z"));
  expect(expired?.path).toEqual(scope.path); expect(expired?.referenceStatus).toBe("expired");
  expect(JSON.stringify(expired)).not.toContain("EXPIRED_CANARY");
  expect(scope.reference?.fields.abbreviation).toBe("EXPIRED_CANARY");
});
