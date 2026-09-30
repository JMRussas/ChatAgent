import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import type { ChatService } from "./chatService";

export interface ShutdownConfig { graceMs: number; timeoutMs: number }
export function loadShutdownConfig(env: NodeJS.ProcessEnv = process.env): ShutdownConfig {
  const graceMs = Number(env.SHUTDOWN_GRACE_MS ?? 5000), timeoutMs = Number(env.SHUTDOWN_TIMEOUT_MS ?? 10000);
  if (!Number.isSafeInteger(graceMs) || graceMs < 0 || !Number.isSafeInteger(timeoutMs) || timeoutMs <= graceMs || timeoutMs > 2147483647)
    throw new Error("SHUTDOWN_TIMEOUT_MS must be a positive integer greater than nonnegative SHUTDOWN_GRACE_MS");
  return { graceMs, timeoutMs };
}
export interface RuntimeHandle { server: Server; address: AddressInfo; shutdown(): Promise<void> }
interface ShutdownHooks {
  config: ShutdownConfig;
  stopBackground(): void;
  stopInternal(): Promise<void>;
  persist(): Promise<void>;
  onTimeout?(): void;
}
export function createRuntimeHandle(server: Server & { closeStreams(): void }, service: ChatService, hooks: ShutdownHooks): RuntimeHandle {
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("RUNTIME_NOT_LISTENING");
  let shutdown: Promise<void> | undefined;
  let closed: Promise<void> | undefined;
  const close = () => closed ??= new Promise<void>((resolve, reject) => {
    server.closeStreams();
    server.close(error => error && (error as NodeJS.ErrnoException).code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
    server.closeIdleConnections();
    server.closeAllConnections();
  });
  return { server, address, shutdown: () => {
    if (shutdown) return shutdown;
    service.stopAccepting();
    hooks.stopBackground();
    let deadline: ReturnType<typeof setTimeout>;
    let grace: ReturnType<typeof setTimeout> | undefined;
    const errors: unknown[] = [];
    const capture = async (work: () => Promise<void>) => { try { await work(); } catch (error) { errors.push(error); } };
    const work = (async () => {
      await capture(hooks.stopInternal);
      await Promise.race([service.whenIdle(), new Promise<void>(resolve => { grace = setTimeout(resolve, hooks.config.graceMs); })]);
      if (grace) clearTimeout(grace);
      await capture(() => service.cancelRemaining());
      await capture(() => service.whenIdle());
      // A context/selection operation may have finished after cancellation began.
      await capture(() => service.cancelRemaining());
      await capture(() => service.discardPending());
      server.closeStreams();
      await capture(hooks.persist);
      await capture(close);
      if (errors.length) throw new AggregateError(errors, "RUNTIME_SHUTDOWN_FAILED");
    })();
    const timeout = new Promise<never>((_, reject) => {
      deadline = setTimeout(() => {
        if (grace) clearTimeout(grace);
        try { hooks.onTimeout?.(); } catch { /* Timeout remains the terminal shutdown error. */ }
        void service.cancelRemaining().catch(() => undefined);
        void close().catch(() => undefined);
        reject(new Error("RUNTIME_SHUTDOWN_TIMEOUT"));
      }, hooks.config.timeoutMs);
    });
    shutdown = Promise.race([work, timeout]).finally(() => { clearTimeout(deadline); if (grace) clearTimeout(grace); });
    return shutdown;
  } };
}
