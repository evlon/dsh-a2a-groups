#!/usr/bin/env node
// Assert that `final: true` appears exactly once, on the last frame, in the
// streamed A2A response. This is the invariant a naive server gets wrong: `final`
// marks the end of the STREAM, not a terminal state, and emitting it early
// truncates every correct client.
//
//   node probe-stream.mjs [gatewayBase] [agent] [apiKey]

const base = process.argv[2] ?? 'http://127.0.0.1:3000';
const agent = process.argv[3] ?? 'mock-a2a';
const key = process.argv[4] ?? 'sk-dev-niukl-2026';

const body = {
  jsonrpc: '2.0',
  id: `probe-${Date.now()}`,
  method: 'SendStreamingMessage',
  params: {
    message: {
      role: 'user',
      messageId: `msg-${Date.now()}`,
      parts: [{ kind: 'text', text: 'stream please' }],
      metadata: { skill: 'slow' },
    },
  },
};

const res = await fetch(`${base}/a2a/${agent}`, {
  method: 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': key,
    'A2A-Version': '1.0',
    'X-Forwarded-Proto': 'http',
  },
  body: JSON.stringify(body),
});

if (!res.ok) {
  console.log(`status: ${res.status}`);
  console.log((await res.text()).slice(0, 400));
  process.exit(1);
}

/** @type {{state: string|undefined, final: boolean, kind: string}[]} */
const frames = [];
let buffer = '';
const decoder = new TextDecoder();

for await (const chunk of res.body) {
  buffer += decoder.decode(chunk, { stream: true });
  let split;
  while ((split = buffer.indexOf('\n\n')) !== -1) {
    const block = buffer.slice(0, split);
    buffer = buffer.slice(split + 2);
    for (const line of block.split('\n')) {
      if (!line.startsWith('data:')) continue;
      const payload = JSON.parse(line.slice(5).trim());
      const result = payload.result ?? {};
      const kind = Object.keys(result)[0] ?? '?';
      const inner = result[kind] ?? {};
      frames.push({
        kind,
        state: inner.status?.state ?? inner.status?.state,
        final: inner.final === true,
      });
    }
  }
}

for (const [index, frame] of frames.entries()) {
  console.log(`${String(index).padStart(2)}  ${frame.kind.padEnd(15)} ${(frame.state ?? '-').padEnd(24)} final=${frame.final}`);
}

const finalIndexes = frames.map((frame, index) => (frame.final ? index : -1)).filter((index) => index >= 0);
const last = frames.length - 1;

let failed = 0;
const check = (label, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}`);
  if (!ok) failed += 1;
};
check(`exactly one frame claims final (saw ${finalIndexes.length})`, finalIndexes.length === 1);
check('the final frame is the last one', finalIndexes[0] === last);
check('every earlier frame has final:false', frames.slice(0, last).every((frame) => frame.final === false));
check('the last state is a terminal state', /COMPLETED|FAILED|CANCELED|REJECTED/.test(frames[last]?.state ?? ''));
check('an artifact was delivered before the end', frames.some((frame) => frame.kind === 'artifactUpdate'));

console.log(`frames: ${frames.length}, failures: ${failed}`);
process.exit(failed === 0 ? 0 : 1);
