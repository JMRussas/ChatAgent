const { spawn } = require('node:child_process');
const { writeFileSync } = require('node:fs');
const mode = process.argv[2];
const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
if (mode === 'grandchild') { setInterval(() => {}, 1000); }
else if (mode === 'child') {
  const grandchild = spawn(process.execPath, [__filename, 'grandchild'], { stdio: 'ignore' });
  writeFileSync('descendants.json', JSON.stringify([process.pid, grandchild.pid]));
  setInterval(() => {}, 1000);
} else {
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => input += chunk);
  process.stdin.on('end', () => {
    if (mode === 'tree') {
      spawn(process.execPath, [__filename, 'child'], { stdio: 'ignore' });
      setInterval(() => {}, 1000); return;
    }
    if (mode === 'nonzero') { process.exitCode = 7; return; }
    if (mode === 'empty') return;
    if (mode === 'malformed') { process.stdout.write('{broken\n'); return; }
    if (mode === 'overflow') { process.stderr.write('private'.repeat(10000)); return; }
    if (mode === 'login') { emit({ type: 'error', code: 'AUTH_REQUIRED', secret: 'session-secret' }); return; }
    if (mode === 'quota') { emit({ type: 'error', code: 'QUOTA_EXHAUSTED' }); return; }
    if (mode === 'slow') { setTimeout(() => emit({ type: 'complete', text: 'done', finishReason: 'stop' }), 180); return; }
    const text = mode === 'echo' ? JSON.parse(input).context.systemInstruction : 'héllo';
    emit({ type: 'diagnostic', text: 'private banner' });
    process.stderr.write('session-secret');
    const frames = Buffer.from(JSON.stringify({ type: 'delta', text }) + '\n' + JSON.stringify({ type: 'complete', text, finishReason: 'stop' }) + '\n');
    // Byte chunks deliberately split both JSON and multibyte UTF-8.
    let i = 0;
    const timer = setInterval(() => { if (i === frames.length) clearInterval(timer); else process.stdout.write(frames.subarray(i, ++i)); }, 1);
  });
}
