import { createServer, type IncomingMessage } from "node:http";
import { connect, type AddressInfo } from "node:net";
import { afterEach, expect, it } from "vitest";
import { checkExactOrigin, extractCredentials } from "../../src/auth/credentials";

// Real Node parsing: the plain headers object hides repeated Authorization and
// Host headers, so extraction must use headersDistinct. These requests are sent
// as raw bytes because fetch merges or refuses repeated headers itself.
const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function receive(rawHeaders: string): Promise<IncomingMessage> {
  let resolveRequest!: (req: IncomingMessage) => void;
  const received = new Promise<IncomingMessage>((r) => (resolveRequest = r));
  const server = createServer((req, res) => {
    resolveRequest(req);
    res.end();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  closers.push(() => new Promise<void>((r) => server.close(() => r())));
  const { port } = server.address() as AddressInfo;
  const socket = connect(port, "127.0.0.1");
  socket.on("error", () => undefined);
  socket.write(`GET /models HTTP/1.1\r\n${rawHeaders}Connection: close\r\n\r\n`);
  closers.push(async () => void socket.destroy());
  return received;
}

it("a repeated Authorization header is unusable even though Node keeps only the first", async () => {
  const req = await receive(
    "Host: 127.0.0.1\r\nAuthorization: Bearer first\r\nAuthorization: Bearer second\r\n"
  );
  // The evidence the plain object would hide.
  expect(req.headers.authorization).toBe("Bearer first");
  expect(extractCredentials(req.headersDistinct)).toEqual({ authorization: "" });
});

it("repeated Cookie headers are combined, so a second session cookie is detected", async () => {
  const req = await receive(
    "Host: 127.0.0.1\r\nCookie: ca_session=one\r\nCookie: ca_session=two\r\n"
  );
  expect(extractCredentials(req.headersDistinct)).toEqual({});
  const single = await receive("Host: 127.0.0.1\r\nCookie: theme=dark; ca_session=one\r\n");
  expect(extractCredentials(single.headersDistinct)).toEqual({ sessionToken: "one" });
});

it("a repeated Host header makes the origin check fail", async () => {
  const req = await receive(
    "Host: 127.0.0.1:3000\r\nHost: evil.example\r\nOrigin: http://127.0.0.1:3000\r\n"
  );
  expect(req.headers.host).toBe("127.0.0.1:3000");
  expect(checkExactOrigin(req.headersDistinct)).toBe("mismatch");
  const ok = await receive("Host: 127.0.0.1:3000\r\nOrigin: http://127.0.0.1:3000\r\n");
  expect(checkExactOrigin(ok.headersDistinct)).toBe("same-origin");
});
