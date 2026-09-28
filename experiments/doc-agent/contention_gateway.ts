/** Experiment-only loopback gateway. Not installed in application startup. */
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { streamLines } from '../../src/providers/streaming';

export type Lane = 'foreground' | 'background';
export type Policy = 'concurrent' | 'fifo' | 'foreground-priority';
type Waiting = { lane: Lane; signal: AbortSignal; resolve: (release: () => void) => void; reject: (e: Error) => void; cancel: () => void };

/** One nonpreemptible slot; after three foreground admissions, serve a waiting background call. */
export class AdmissionGate {
  private busy = false;
  private foregroundRun = 0;
  private queue: Waiting[] = [];
  constructor(readonly policy: Policy, private readonly capacity = 32) {}
  acquire(lane: Lane, signal: AbortSignal): Promise<() => void> {
    if (signal.aborted) return Promise.reject(signal.reason);
    if (this.policy === 'concurrent') return Promise.resolve(() => {});
    if (this.queue.length >= this.capacity) return Promise.reject(new Error('CAPACITY_FULL'));
    return new Promise((resolve, reject) => {
      const entry: Waiting = { lane, signal, resolve, reject, cancel: () => {
        this.queue = this.queue.filter(x => x !== entry);
        reject(signal.reason);
      } };
      signal.addEventListener('abort', entry.cancel, { once: true });
      this.queue.push(entry); this.pump();
    });
  }
  private pump() {
    if (this.busy || !this.queue.length) return;
    const foreground = this.queue.findIndex(x => x.lane === 'foreground');
    const background = this.queue.findIndex(x => x.lane === 'background');
    const index = this.policy === 'fifo' ? 0 : background >= 0 && (foreground < 0 || this.foregroundRun >= 3) ? background : foreground;
    const entry = this.queue.splice(index, 1)[0];
    entry.signal.removeEventListener('abort', entry.cancel);
    this.foregroundRun = entry.lane === 'foreground' ? this.foregroundRun + 1 : 0;
    this.busy = true;
    let released = false;
    entry.resolve(() => {
      if (released) return;
      released = true; this.busy = false; this.pump();
    });
  }
}

export interface CallTiming {
  id: string; phase: string; lane: Lane; label: string;
  arrivedMs: number; readyMs?: number; admittedMs?: number; headersMs?: number;
  firstAnswerMs?: number; firstToolMs?: number; doneMs?: number; finishedMs?: number;
  admissionWaitMs?: number; firstAnswerLatencyMs?: number; elapsedMs?: number;
  status?: number; outcome?: string; finishReason?: string;
  usage?: Record<string, number>;
}

export async function startGateway(upstream: string, policy: Policy, timeoutMs = 120000) {
  const parsed = new URL(upstream);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw Error('Loopback HTTP upstream required');
  const records: CallTiming[] = [];
  const gate = new AdmissionGate(policy);
  const start = performance.now();
  const now = () => performance.now() - start;
  const controllers = new Set<AbortController>();
  const state = { phase: 'setup' };
  const server = createServer(async (req, res) => {
    const arrivedMs = now();
    const route = /^\/(foreground|background)\/([a-zA-Z0-9_-]+)(\/api\/(chat|tags|show|version|ps))$/.exec(req.url ?? '');
    if (!route || (route[4] === 'chat' ? req.method !== 'POST' : !['GET', 'POST'].includes(req.method ?? ''))) {
      res.writeHead(404); res.end(); return;
    }
    const controller = new AbortController(); controllers.add(controller);
    const timer = setTimeout(() => controller.abort(Error('DEADLINE')), timeoutMs);
    const stopUpload = () => { if (!req.complete) req.destroy(); };
    controller.signal.addEventListener('abort', stopUpload, { once: true });
    const disconnected = () => { if (!res.writableFinished) controller.abort(Error('CLIENT_CANCELLED')); };
    res.on('close', disconnected);
    let release: (() => void) | undefined;
    let record: CallTiming | undefined;
    if (route[4] === 'chat') {
      record = { id: randomUUID(), phase: state.phase, lane: route[1] as Lane, label: route[2], arrivedMs };
      records.push(record);
    }
    try {
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of req) {
        controller.signal.throwIfAborted();
        bytes += chunk.length;
        if (bytes > 1024 * 1024) throw Error('BODY_TOO_LARGE');
        chunks.push(Buffer.from(chunk));
      }
      const body = Buffer.concat(chunks);
      if (record) {
        const input = JSON.parse(body.toString());
        // All measured calls must stream so first-answer timing is meaningful.
        if (input.stream !== true) throw Error('STREAM_REQUIRED');
        record.readyMs = now();
        release = await gate.acquire(record.lane, controller.signal);
        controller.signal.throwIfAborted();
        record.admittedMs = now();
        record.admissionWaitMs = record.admittedMs - record.readyMs;
      }
      const response = await fetch(upstream.replace(/\/$/, '') + route[3], {
        method: req.method, body: body.length ? body : undefined,
        headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      });
      if (record) { record.headersMs = now(); record.status = response.status; }
      res.writeHead(response.status, { 'Content-Type': response.headers.get('content-type') ?? 'application/json' });
      if (!record || !response.ok) {
        res.end(Buffer.from(await response.arrayBuffer()));
        if (record) record.outcome = 'http_error';
      } else {
        let done = false;
        for await (const line of streamLines(response, controller.signal)) {
          if (!line.trim()) continue;
          const frame = JSON.parse(line);
          if (frame.error) throw Error('UPSTREAM_STREAM_ERROR');
          if (!frame.message || typeof frame.done !== 'boolean') throw Error('INVALID_STREAM');
          if (typeof frame.message.content === 'string' && frame.message.content.length && record.firstAnswerMs === undefined)
            record.firstAnswerMs = now();
          if (Array.isArray(frame.message.tool_calls) && frame.message.tool_calls.length && record.firstToolMs === undefined)
            record.firstToolMs = now();
          if (!res.write(line + '\n')) await once(res, 'drain', { signal: controller.signal });
          if (frame.done) {
            done = true; record.doneMs = now(); record.finishReason = frame.done_reason;
            record.usage = {};
            for (const key of ['total_duration', 'load_duration', 'prompt_eval_count', 'prompt_eval_cached_count', 'prompt_eval_duration', 'eval_count', 'eval_duration'])
              if (typeof frame[key] === 'number' && Number.isFinite(frame[key])) record.usage[key] = frame[key];
            break;
          }
        }
        if (!done) throw Error('MISSING_DONE');
        record.outcome = 'completed'; res.end();
      }
    } catch (error) {
      const message = controller.signal.aborted ? String(controller.signal.reason?.message) : error instanceof Error ? error.message : 'ERROR';
      // Never persist arbitrary parser/provider errors, which can contain payload text.
      const code = ['DEADLINE','CLIENT_CANCELLED','GATEWAY_CLOSED','CAPACITY_FULL','BODY_TOO_LARGE','STREAM_REQUIRED','UPSTREAM_STREAM_ERROR','INVALID_STREAM','MISSING_DONE','STREAM_TOO_LARGE'].includes(message) ? message : 'GATEWAY_ERROR';
      if (record) record.outcome = code;
      if (!res.headersSent && !res.destroyed) {
        res.writeHead(code === 'CAPACITY_FULL' ? 429 : 502, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'Experiment gateway request failed' }));
      } else res.destroy();
    } finally {
      if (record) {
        record.finishedMs = now(); record.elapsedMs = record.finishedMs - record.arrivedMs;
        if (record.firstAnswerMs !== undefined) record.firstAnswerLatencyMs = record.firstAnswerMs - record.arrivedMs;
      }
      release?.(); clearTimeout(timer); controllers.delete(controller); res.off('close', disconnected);
      controller.signal.removeEventListener('abort', stopUpload);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, records, state, async close() {
    for (const controller of controllers) controller.abort(Error('GATEWAY_CLOSED'));
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  } };
}
