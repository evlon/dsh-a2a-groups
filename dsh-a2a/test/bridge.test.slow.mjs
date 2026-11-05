/**
 * `lib/bridge.js` 的行为测试。
 *
 * 全部用 `node:http` 在 `listen(0)` 上起一个真的假上游，再用真的 `fetch` 打过去：
 * 只有这样才能证明「跨 chunk 分帧」「请求头真的发出去了」「SSE 真的能读」这类
 * 行为，用 mock 的 fetch 去断言只会测到自己的写法。
 *
 * 覆盖的坑（都是真实踩过的）：
 *   - 一帧被拆到两个 TCP chunk（`data: {"result":` / `{"task":…}}`）；
 *   - 多行 `data:` 要用 `\n` 拼；
 *   - 心跳注释 `:` 不能被当成空帧（否则半帧会被提前派发）；
 *   - `\r\n` 换行；
 *   - `[DONE]` 非标准结束标记；
 *   - 中文字符跨 chunk 边界（UTF-8 一个字符 3 字节）；
 *   - 卡片 url 是 https 但 baseUrl 是 http。
 *
 * @module dsh-a2a/test/bridge
 */

import { test } from 'vitest';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

import { createBridge, A2aClientError, maskSecret, createSseParser } from '../lib/core/bridge.js';

/* -------------------------------------------------------------------------- */
/* 假上游                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 起一个可编程的假 A2A 上游。
 *
 * `handler(ctx)` 里可以读到补丁后的请求体与请求头，并自己决定怎么写响应——
 * `streamChunks` 让测试能精确控制「一帧怎么被切开」。
 *
 * @param {(ctx: object) => (void|Promise<void>)} handler - 请求处理器。
 * @returns {Promise<{baseUrl: string, close: () => Promise<void>, hits: Array<object>}>}
 */
async function startUpstream(handler) {
  const hits = [];
  const server = createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      let body;
      try {
        body = raw === '' ? undefined : JSON.parse(raw);
      } catch {
        body = undefined;
      }
      const hit = { method: req.method, url: req.url, headers: req.headers, body, raw };
      hits.push(hit);
      Promise.resolve(handler({ req, res, ...hit })).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: String(err?.message ?? err) }));
      });
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    baseUrl: `http://127.0.0.1:${port}/a2a`,
    hits,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** 发一张卡片。 */
function cardResponse(res, card) {
  const text = JSON.stringify(card);
  res.writeHead(200, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** 一张标准卡片。 */
function sampleCard(overrides = {}) {
  return {
    name: 'test-agent',
    description: 'a fake A2A 1.0 agent',
    url: 'http://placeholder',
    version: '0.1.0',
    protocolVersion: '1.0',
    preferredTransport: 'JSONRPC',
    capabilities: { streaming: true },
    defaultInputModes: ['text/plain'],
    defaultOutputModes: ['text/plain'],
    supportedInterfaces: [],
    skills: [{ id: 'ping', name: 'Ping', description: 'health check' }],
    ...overrides,
  };
}

/** 一个一元成功响应（1.0 的 oneof 包装）。 */
function unaryTaskBody(id, { text = 'ok', state = 'TASK_STATE_COMPLETED', taskId = 'task-1' } = {}) {
  return {
    jsonrpc: '2.0',
    id,
    result: {
      task: {
        id: taskId,
        contextId: 'ctx-1',
        status: { state, timestamp: new Date().toISOString() },
        artifacts: [{ artifactId: 'a1', name: 'reply', parts: [{ kind: 'text', text }] }],
      },
    },
  };
}

/* -------------------------------------------------------------------------- */
/* discover                                                                    */
/* -------------------------------------------------------------------------- */

test('discover reads the well-known card and then serves it from cache', async () => {
  const upstream = await startUpstream(({ res }) => cardResponse(res, sampleCard({ url: '' })));
  try {
    const bridge = createBridge({ config: { client: { cardTtlMs: 60000 } } });
    const card = await bridge.discover({ baseUrl: upstream.baseUrl });

    assert.equal(card.name, 'test-agent');
    assert.equal(card.protocolVersion, '1.0');
    assert.equal(upstream.hits.length, 1);
    assert.equal(upstream.hits[0].method, 'GET');
    assert.equal(upstream.hits[0].url, '/a2a/.well-known/agent-card.json');

    // 第二次必须命中缓存：再打上游就是行为错误（演示时会多一倍延迟）。
    const again = await bridge.discover({ baseUrl: upstream.baseUrl });
    assert.equal(again.name, 'test-agent');
    assert.equal(upstream.hits.length, 1, 'the second discover must not hit the upstream');
  } finally {
    await upstream.close();
  }
});

test('discover refetches after the card TTL expires', async () => {
  const upstream = await startUpstream(({ res }) => cardResponse(res, sampleCard({ url: '' })));
  try {
    let clockNow = 1000;
    const bridge = createBridge({
      config: { client: { cardTtlMs: 500 } },
      clock: () => clockNow,
    });
    await bridge.discover({ baseUrl: upstream.baseUrl });
    assert.equal(upstream.hits.length, 1);

    clockNow += 400;
    await bridge.discover({ baseUrl: upstream.baseUrl });
    assert.equal(upstream.hits.length, 1, 'still inside the TTL window');

    clockNow += 200; // 累计 600 > 500
    await bridge.discover({ baseUrl: upstream.baseUrl });
    assert.equal(upstream.hits.length, 2, 'expired cache must refetch');
  } finally {
    await upstream.close();
  }
});

test('invalidate drops the cached card for that target only', async () => {
  const upstream = await startUpstream(({ res }) => cardResponse(res, sampleCard({ url: '' })));
  try {
    const bridge = createBridge({ config: { client: { cardTtlMs: 60000 } } });
    await bridge.discover({ baseUrl: upstream.baseUrl });
    assert.equal(upstream.hits.length, 1);

    bridge.invalidate(upstream.baseUrl);
    await bridge.discover({ baseUrl: upstream.baseUrl });
    assert.equal(upstream.hits.length, 2, 'invalidate must force a refetch');

    bridge.invalidateAll();
    await bridge.discover({ baseUrl: upstream.baseUrl });
    assert.equal(upstream.hits.length, 3);
  } finally {
    await upstream.close();
  }
});

test('a card url that is https while baseUrl is http is reconciled to baseUrl with a warning', async () => {
  const warnings = [];
  const logger = { warn: (message) => warnings.push(message) };
  const upstream = await startUpstream(({ res, req }) => {
    // 这就是 AISIX 在请求没带 X-Forwarded-Proto 时的真实行为：假设前面有 TLS。
    const host = req.headers.host;
    cardResponse(res, sampleCard({ url: `https://${host.replace(/:\d+$/, ':3000')}/a2a` }));
  });
  try {
    const bridge = createBridge({ config: { client: { cardTtlMs: 60000 } }, logger });
    const card = await bridge.discover({ baseUrl: upstream.baseUrl });

    // 关键行为：不抛错，且把 url 收敛到实测可用的地址。
    assert.equal(card.url, upstream.baseUrl);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /https/);
    assert.match(warnings[0], /forwardProto/);

    // 警告只提醒一次：每条消息都刷一行日志会淹掉真正的问题。
    await bridge.discover({ baseUrl: upstream.baseUrl });
    bridge.invalidate(upstream.baseUrl);
    await bridge.discover({ baseUrl: upstream.baseUrl });
    assert.equal(warnings.length, 1, 'the scheme mismatch must be warned about once per target');
  } finally {
    await upstream.close();
  }
});

test('an https card url on a different host is left alone and only warned about', async () => {
  const warnings = [];
  const upstream = await startUpstream(({ res }) => {
    cardResponse(res, sampleCard({ url: 'https://gateway.example.com/a2a/agent-a' }));
  });
  try {
    const bridge = createBridge({ config: { client: { cardTtlMs: 60000 } }, logger: { warn: (m) => warnings.push(m) } });
    const card = await bridge.discover({ baseUrl: upstream.baseUrl });
    // 网关可能把 url 改写成对外域名，我们无权替它改；但要提醒配置者。
    assert.equal(card.url, 'https://gateway.example.com/a2a/agent-a');
    assert.equal(warnings.length, 1);
  } finally {
    await upstream.close();
  }
});

test('discover requests the card under the agent path when agent is given', async () => {
  const upstream = await startUpstream(({ res }) => cardResponse(res, sampleCard({ url: '' })));
  try {
    const bridge = createBridge({ config: { client: { cardTtlMs: 60000 } } });
    await bridge.discover({ baseUrl: upstream.baseUrl, agent: 'group-7f3a1c' });
    assert.equal(upstream.hits[0].url, '/a2a/group-7f3a1c/.well-known/agent-card.json');
  } finally {
    await upstream.close();
  }
});

/* -------------------------------------------------------------------------- */
/* send                                                                        */
/* -------------------------------------------------------------------------- */

test('send uses SendMessage, sends A2A-Version and x-api-key, and extracts the artifact text', async () => {
  const upstream = await startUpstream(({ res, body }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(unaryTaskBody(body.id, { text: 'hello from the far side' })));
  });
  try {
    const bridge = createBridge({ config: { client: { apiKey: 'sk-test-secret', timeoutMs: 5000 } } });
    const result = await bridge.send(
      { baseUrl: upstream.baseUrl },
      { text: '你好', skill: 'session/ask', contextId: 'ctx-abc' },
    );

    assert.equal(result.state, 'completed');
    assert.equal(result.wireState, 'TASK_STATE_COMPLETED');
    assert.equal(result.text, 'hello from the far side');
    assert.equal(result.taskId, 'task-1');
    assert.equal(result.contextId, 'ctx-1');

    const hit = upstream.hits[0];
    assert.equal(hit.method, 'POST');
    assert.equal(hit.body.jsonrpc, '2.0');
    assert.equal(hit.body.method, 'SendMessage', 'A2A 1.0 uses PascalCase method names');
    assert.match(hit.body.id, /^[0-9a-f-]{36}$/);
    assert.equal(hit.headers['a2a-version'], '1.0');
    assert.equal(hit.headers['x-api-key'], 'sk-test-secret');
    assert.equal(hit.headers['content-type'], 'application/json');

    // 请求消息的形状必须与契约 §1 一致。
    const message = hit.body.params.message;
    assert.equal(message.role, 'user');
    assert.match(message.messageId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(message.parts, [{ kind: 'text', text: '你好' }]);
    assert.equal(message.contextId, 'ctx-abc');
    assert.equal(message.metadata.skill, 'session/ask');
  } finally {
    await upstream.close();
  }
});

test('send defaults the skill to session/ask and puts data under metadata.data', async () => {
  const upstream = await startUpstream(({ res, body }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(unaryTaskBody(body.id)));
  });
  try {
    const bridge = createBridge({ config: { client: { timeoutMs: 5000 } } });
    await bridge.send({ baseUrl: upstream.baseUrl }, { data: { groupId: 'g-1', sinceSeq: 4 } });
    const message = upstream.hits[0].body.params.message;
    assert.equal(message.metadata.skill, 'session/ask');
    assert.deepEqual(message.metadata.data, { groupId: 'g-1', sinceSeq: 4 });
  } finally {
    await upstream.close();
  }
});

test('send omits an empty text part but keeps the envelope valid', async () => {
  const upstream = await startUpstream(({ res, body }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(unaryTaskBody(body.id)));
  });
  try {
    const bridge = createBridge({ config: { client: { timeoutMs: 5000 } } });
    await bridge.send({ baseUrl: upstream.baseUrl }, { skill: 'ping' });
    const message = upstream.hits[0].body.params.message;
    assert.deepEqual(message.parts, [], 'a body-less call must not carry an empty text part');
    assert.equal(message.metadata.skill, 'ping');
  } finally {
    await upstream.close();
  }
});

test('send prefers the reply artifact when a task carries several', async () => {
  const upstream = await startUpstream(({ res, body }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        task: {
          id: 't-9',
          status: { state: 'TASK_STATE_COMPLETED' },
          artifacts: [
            { artifactId: 'a1', name: 'feed', parts: [{ kind: 'text', text: '{"entries":[]}' }] },
            { artifactId: 'a2', name: 'reply', parts: [{ kind: 'text', text: '这条是给人看的' }] },
          ],
        },
      },
    }));
  });
  try {
    const bridge = createBridge({ config: { client: { timeoutMs: 5000 } } });
    const result = await bridge.send({ baseUrl: upstream.baseUrl }, { text: 'x' });
    assert.equal(result.text, '这条是给人看的', 'a group call returns several artifacts; reply is the human-facing one');
    assert.equal(result.artifacts.length, 2);
  } finally {
    await upstream.close();
  }
});

test('send understands a bare result.message reply (no task yet)', async () => {
  const upstream = await startUpstream(({ res, body }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      result: { message: { role: 'agent', messageId: 'm-1', parts: [{ kind: 'text', text: 'quick answer' }] } },
    }));
  });
  try {
    const bridge = createBridge({ config: { client: { timeoutMs: 5000 } } });
    const result = await bridge.send({ baseUrl: upstream.baseUrl }, { text: 'x' });
    assert.equal(result.text, 'quick answer');
    assert.equal(result.taskId, undefined);
    // 没有 task 就没有「进行中」可言，对端已经答完了。
    assert.equal(result.state, 'completed');
  } finally {
    await upstream.close();
  }
});

/* -------------------------------------------------------------------------- */
/* 错误分类                                                                    */
/* -------------------------------------------------------------------------- */

test('a 401 becomes A2aClientError kind=auth', async () => {
  const upstream = await startUpstream(({ res }) => {
    res.writeHead(401, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing or invalid credential' }));
  });
  try {
    const bridge = createBridge({ config: { client: { timeoutMs: 5000 } } });
    await assert.rejects(
      () => bridge.send({ baseUrl: upstream.baseUrl }, { text: 'x' }),
      (err) => {
        assert.ok(err instanceof A2aClientError);
        assert.equal(err.kind, 'auth');
        assert.equal(err.status, 401);
        return true;
      },
    );
  } finally {
    await upstream.close();
  }
});

test('a 403 becomes A2aClientError kind=permission', async () => {
  const upstream = await startUpstream(({ res }) => {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'agent not allowed for this key' }));
  });
  try {
    const bridge = createBridge({ config: { client: { timeoutMs: 5000 } } });
    await assert.rejects(
      () => bridge.discover({ baseUrl: upstream.baseUrl }),
      (err) => {
        assert.equal(err.kind, 'permission');
        assert.equal(err.status, 403);
        return true;
      },
    );
  } finally {
    await upstream.close();
  }
});

test('JSON-RPC -32003 becomes A2aClientError kind=version', async () => {
  const upstream = await startUpstream(({ res, body }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32003, message: 'unsupported A2A-Version: 1.0' } }));
  });
  try {
    const bridge = createBridge({ config: { client: { timeoutMs: 5000 } } });
    await assert.rejects(
      () => bridge.send({ baseUrl: upstream.baseUrl }, { text: 'x' }),
      (err) => {
        assert.equal(err.kind, 'version');
        assert.equal(err.code, -32003);
        return true;
      },
    );
  } finally {
    await upstream.close();
  }
});

test('-32001 and -32002 map to auth and permission respectively', async () => {
  let code = -32001;
  const upstream = await startUpstream(({ res, body }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code, message: 'nope' } }));
  });
  try {
    const bridge = createBridge({ config: { client: { timeoutMs: 5000 } } });
    await assert.rejects(() => bridge.send({ baseUrl: upstream.baseUrl }, { text: 'x' }), (err) => err.kind === 'auth');
    code = -32002;
    await assert.rejects(() => bridge.send({ baseUrl: upstream.baseUrl }, { text: 'x' }), (err) => err.kind === 'permission');
  } finally {
    await upstream.close();
  }
});

test('an unknown JSON-RPC error stays kind=rpc and carries the business code', async () => {
  const upstream = await startUpstream(({ res, body }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      error: { code: -32004, message: 'business rejection', data: { code: 'rate_limited' } },
    }));
  });
  try {
    const bridge = createBridge({ config: { client: { timeoutMs: 5000 } } });
    await assert.rejects(
      () => bridge.send({ baseUrl: upstream.baseUrl }, { text: 'x' }),
      (err) => {
        assert.equal(err.kind, 'rpc');
        assert.equal(err.code, -32004);
        assert.equal(err.data, 'rate_limited', 'the stable sub-code must survive for the caller');
        return true;
      },
    );
  } finally {
    await upstream.close();
  }
});

test('an unreachable upstream becomes kind=network', async () => {
  // 起一个再关掉，拿到一个确定没人听的端口。
  const dead = await startUpstream(({ res }) => res.end());
  const baseUrl = dead.baseUrl;
  await dead.close();

  const bridge = createBridge({ config: { client: { timeoutMs: 2000 } } });
  await assert.rejects(
    () => bridge.send({ baseUrl }, { text: 'x' }),
    (err) => {
      assert.equal(err.kind, 'network');
      return true;
    },
  );
});

test('a missing or non-http baseUrl is rejected before any network call', async () => {
  const bridge = createBridge({ config: {} });
  await assert.rejects(() => bridge.send({}, { text: 'x' }), (err) => err.code === 'bad_target');
  await assert.rejects(() => bridge.send({ baseUrl: 'ws://nope' }, { text: 'x' }), (err) => err.code === 'bad_target');
  await assert.rejects(() => bridge.send({ baseUrl: 'not a url' }, { text: 'x' }), (err) => err.code === 'bad_target');
});

test('errors never leak the plaintext api key', async () => {
  process.env.A2A_TEST_KEY = 'sk-should-never-appear';
  const upstream = await startUpstream(({ res }) => {
    res.writeHead(401, { 'content-type': 'text/plain' });
    res.end('denied');
  });
  try {
    const bridge = createBridge({ config: { client: { apiKey: 'sk-should-never-appear', timeoutMs: 5000 } } });
    await assert.rejects(
      () => bridge.send({ baseUrl: upstream.baseUrl }, { text: 'x' }),
      (err) => {
        assert.equal(err.message.includes('sk-should-never-appear'), false, 'the error message must not carry the credential');
        return true;
      },
    );
    // 脱敏形式本身要稳定：同一把 key 永远得到同一个短标识。
    assert.equal(maskSecret('sk-should-never-appear'), maskSecret('sk-should-never-appear'));
    assert.match(maskSecret('sk-should-never-appear'), /^sha256:[0-9a-f]{8}$/);
    assert.equal(maskSecret('').includes('sha256'), false);
  } finally {
    await upstream.close();
  }
});

/* -------------------------------------------------------------------------- */
/* SSE 解析（单元）                                                            */
/* -------------------------------------------------------------------------- */

test('the SSE parser handles split frames, multi-line data, comments and CRLF', () => {
  const frames = [];
  const parser = createSseParser((payload) => frames.push(payload));

  // 一帧被切成两半；中间夹一个心跳注释；然后是多行 data；最后是 CRLF 帧。
  parser.push('data: {"result":');
  parser.push('{"statusUpdate":{"status":{"state":"TASK_STATE_WORKING"}}}}\n\n');
  assert.equal(frames.length, 1, 'a frame split across pushes must be dispatched exactly once');
  assert.match(frames[0], /TASK_STATE_WORKING/);

  parser.push(': keep-alive\n\n');
  assert.equal(frames.length, 1, 'a comment line is not a frame');

  parser.push('data: line-one\ndata: line-two\r\n\r\n');
  assert.equal(frames.length, 2);
  assert.equal(frames[1], 'line-one\nline-two', 'multi-line data joins with \\n');

  // 没有空行结尾的末帧要靠 flush 交出来。
  parser.push('data: tail');
  parser.flush();
  assert.equal(frames.length, 3);
  assert.equal(frames[2], 'tail');
});

test('the SSE parser survives a frame split inside a multi-byte character', () => {
  const frames = [];
  const parser = createSseParser((payload) => frames.push(payload));

  const frame = Buffer.from('data: {"result":{"x":"中文测试"}}\n\n', 'utf8');
  // 在「中」的字节中间切开：这正是 TextDecoder 必须用 stream:true 的原因。
  const splitAt = frame.indexOf(Buffer.from('中', 'utf8')) + 1;
  const decoder = new TextDecoder('utf-8');
  parser.push(decoder.decode(frame.subarray(0, splitAt), { stream: true }));
  parser.push(decoder.decode(frame.subarray(splitAt), { stream: true }));
  parser.push(decoder.decode());

  assert.equal(frames.length, 1);
  assert.match(frames[0], /中文测试/, 'the multi-byte character must survive the chunk boundary');
});

/* -------------------------------------------------------------------------- */
/* stream                                                                      */
/* -------------------------------------------------------------------------- */

test('stream parses a chunk-split SSE stream, ignores comments, and stops at final:true', async () => {
  const events = [];
  const upstream = await startUpstream(({ req, res, body }) => {
    assert.equal(body.method, 'SendStreamingMessage', 'streaming uses the PascalCase streaming method');
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });

    const event = (payload) => JSON.stringify({ jsonrpc: '2.0', id: body.id, result: payload });
    const submitted = event({ statusUpdate: { taskId: 't-1', status: { state: 'TASK_STATE_SUBMITTED' }, final: false } });
    const working = event({ statusUpdate: { taskId: 't-1', status: { state: 'TASK_STATE_WORKING' }, final: false } });
    const artifact = event({
      artifactUpdate: { taskId: 't-1', artifact: { artifactId: 'a1', name: 'reply', parts: [{ kind: 'text', text: '答案' }] }, append: false, lastChunk: true },
    });
    const final = event({ statusUpdate: { taskId: 't-1', status: { state: 'TASK_STATE_COMPLETED' }, final: true } });

    // 第一帧故意从中间切开，中间再插一个心跳注释。
    const head = `data: ${submitted}\n\n`;
    const cut = Math.floor(head.length / 2);
    res.write(head.slice(0, cut));
    setTimeout(() => {
      res.write(head.slice(cut));
      res.write(': heartbeat\n\n');
      res.write(`data: ${working}\n\n`);
      // 把 artifact 那帧也切开，并且切在 JSON 中间。
      const artifactFrame = `data: ${artifact}\n\n`;
      const artifactCut = artifactFrame.indexOf('答案') + 1;
      res.write(artifactFrame.slice(0, artifactCut));
      setTimeout(() => {
        res.write(artifactFrame.slice(artifactCut));
        // 标准之外的 [DONE] 也要容忍。
        res.write('data: [DONE]\n\n');
        res.write(`data: ${final}\n\n`);
        res.end();
      }, 30);
    }, 30);
  });

  try {
    const bridge = createBridge({ config: { client: { timeoutMs: 5000 } } });
    const outcome = await bridge.stream(
      { baseUrl: upstream.baseUrl },
      { skill: 'session/ask', text: '问题', onEvent: (event) => events.push(event) },
    );

    assert.equal(outcome.taskId, 't-1');
    assert.equal(outcome.state, 'completed');
    assert.equal(outcome.final, true);
    assert.equal(outcome.text, '答案', 'the artifact text must survive being split mid-JSON');

    const types = events.map((event) => event.type);
    assert.deepEqual(types.filter((type) => type === 'status'), ['status', 'status', 'status']);
    assert.deepEqual(types.filter((type) => type === 'artifact'), ['artifact']);
    const states = events.filter((event) => event.type === 'status').map((event) => event.state);
    assert.deepEqual(states, ['submitted', 'working', 'completed']);
    assert.equal(events.at(-1).final, true);
    assert.equal(upstream.hits[0].headers['a2a-version'], '1.0');
  } finally {
    await upstream.close();
  }
});

test('stream uses CRLF line endings and appends artifact chunks marked append:true', async () => {
  const events = [];
  const upstream = await startUpstream(({ res, body }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (payload) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: payload })}\r\n\r\n`;
    res.write(frame({ artifactUpdate: { taskId: 't-2', artifact: { artifactId: 'a1', name: 'reply', parts: [{ kind: 'text', text: '第一段' }] }, append: false } }));
    res.write(frame({ artifactUpdate: { taskId: 't-2', artifact: { artifactId: 'a1', name: 'reply', parts: [{ kind: 'text', text: '第二段' }] }, append: true } }));
    res.write(frame({ statusUpdate: { taskId: 't-2', status: { state: 'TASK_STATE_COMPLETED' }, final: true } }));
    res.end();
  });
  try {
    const bridge = createBridge({ config: { client: { timeoutMs: 5000 } } });
    const outcome = await bridge.stream({ baseUrl: upstream.baseUrl }, { text: 'x', onEvent: (e) => events.push(e) });
    assert.equal(outcome.text, '第一段第二段', 'append:true must concatenate, not replace');
    assert.equal(events.filter((event) => event.type === 'artifact').length, 2);
    assert.equal(outcome.state, 'completed');
  } finally {
    await upstream.close();
  }
});

test('stream treats a JSON content-type as a collapsed unary result', async () => {
  const upstream = await startUpstream(({ res, body }) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(unaryTaskBody(body.id, { text: '塌缩成一元' })));
  });
  try {
    const bridge = createBridge({ config: { client: { timeoutMs: 5000 } } });
    const outcome = await bridge.stream({ baseUrl: upstream.baseUrl }, { text: 'x' });
    assert.equal(outcome.text, '塌缩成一元');
    assert.equal(outcome.final, true);
    assert.equal(outcome.state, 'completed');
  } finally {
    await upstream.close();
  }
});

test('stream reconnects with sinceSeq when the connection drops mid-way', async () => {
  const events = [];
  let attempt = 0;
  const upstream = await startUpstream(({ res, body }) => {
    attempt += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (payload) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: payload })}\n\n`;

    if (attempt === 1) {
      // 第一轮：吐两条就硬断（模拟网关掐断长连）。先让这两帧真的发出去再断，
      // 否则测到的是「socket 缓冲区被丢弃」而不是「断了之后能不能续上」。
      res.write(frame({ artifactUpdate: { taskId: 't-3', artifact: { artifactId: 'f1', name: 'feed', parts: [{ kind: 'text', text: 'first' }] }, append: false, metadata: { seq: 1 } } }));
      res.write(frame({ artifactUpdate: { taskId: 't-3', artifact: { artifactId: 'f2', name: 'feed', parts: [{ kind: 'text', text: 'second' }] }, append: false, metadata: { seq: 2 } } }));
      setTimeout(() => res.destroy(), 40); // 异常 EOF
      return;
    }
    // 第二轮：应该带着 sinceSeq=2 回来。
    res.write(frame({ artifactUpdate: { taskId: 't-3', artifact: { artifactId: 'f3', name: 'feed', parts: [{ kind: 'text', text: 'third' }] }, append: false, metadata: { seq: 3 } } }));
    res.write(frame({ statusUpdate: { taskId: 't-3', status: { state: 'TASK_STATE_COMPLETED' }, final: true } }));
    res.end();
  });
  try {
    const bridge = createBridge({
      config: { client: { timeoutMs: 5000, reconnectAttempts: 3 } },
    });
    const outcome = await bridge.stream(
      { baseUrl: upstream.baseUrl },
      { skill: 'group/subscribe', sinceSeq: 0, onEvent: (e) => events.push(e) },
    );

    assert.equal(outcome.reconnects, 1);
    assert.equal(upstream.hits.length, 2, 'a dropped resumable stream must reconnect exactly once here');
    assert.equal(upstream.hits[1].body.params.message.metadata.data.sinceSeq, 2, 'the reconnect must resume from the last seq seen');

    const reconnect = events.find((event) => event.type === 'reconnect');
    assert.ok(reconnect !== undefined, 'the caller must be told about the reconnect');
    assert.equal(reconnect.attempt, 1);
    assert.match(outcome.text, /third/);
    assert.equal(outcome.final, true);
  } finally {
    await upstream.close();
  }
});

test('stream gives up after the configured number of reconnects', async () => {
  let attempts = 0;
  const upstream = await startUpstream(({ res }) => {
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"result":{"artifactUpdate":{"artifact":{"artifactId":"a","parts":[{"kind":"text","text":"x"}]}}}}\n\n');
    res.destroy();
  });
  try {
    const bridge = createBridge({ config: { client: { timeoutMs: 5000, reconnectAttempts: 1 } } });
    await assert.rejects(
      () => bridge.stream({ baseUrl: upstream.baseUrl }, { skill: 'group/subscribe', sinceSeq: 0 }),
      (err) => {
        assert.equal(err.kind, 'network');
        return true;
      },
    );
    // 首次 + 1 次重连 = 2 次；再试探就是预算算错了。
    assert.equal(attempts, 2);
  } finally {
    await upstream.close();
  }
});

test('stream does not reconnect a stream that was never resumable', async () => {
  let attempts = 0;
  const upstream = await startUpstream(({ res }) => {
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.destroy();
  });
  try {
    const bridge = createBridge({ config: { client: { timeoutMs: 5000, reconnectAttempts: 3 } } });
    await assert.rejects(
      () => bridge.stream({ baseUrl: upstream.baseUrl }, { text: 'one shot' }),
      (err) => err.kind === 'network',
    );
    assert.equal(attempts, 1, 'without sinceSeq a reconnect would replay events, so it must not happen');
  } finally {
    await upstream.close();
  }
});

test('stream surfaces an in-band JSON-RPC error instead of retrying', async () => {
  let attempts = 0;
  const upstream = await startUpstream(({ res }) => {
    attempts += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write('data: {"jsonrpc":"2.0","id":"1","error":{"code":-32001,"message":"bad member key"}}\n\n');
    res.end();
  });
  try {
    const bridge = createBridge({ config: { client: { timeoutMs: 5000, reconnectAttempts: 3 } } });
    await assert.rejects(
      () => bridge.stream({ baseUrl: upstream.baseUrl }, { skill: 'group/subscribe', sinceSeq: 0 }),
      (err) => {
        assert.equal(err.kind, 'auth');
        assert.equal(err.code, -32001);
        return true;
      },
    );
    assert.equal(attempts, 1, 'an auth failure must not be retried');
  } finally {
    await upstream.close();
  }
});

test('stream survives a multi-byte character split across HTTP chunks', async () => {
  // 真字节级切分：`res.write(Buffer)` 直接把一个 UTF-8 字符劈成两个 TCP chunk，
  // 这正是 TextDecoder 必须 `{stream:true}` 的原因。用字符串切分会切在字符边界上，
  // 测不出这个坑。
  const upstream = await startUpstream(({ res, body }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = `data: ${JSON.stringify({
      jsonrpc: '2.0',
      id: body.id,
      result: {
        artifactUpdate: { taskId: 't-8', artifact: { artifactId: 'a1', name: 'reply', parts: [{ kind: 'text', text: '中文测试✅' }] }, append: false },
      },
    })}\n\n`;
    const bytes = Buffer.from(frame, 'utf8');
    const marker = Buffer.from('中文测试', 'utf8');
    const at = bytes.indexOf(marker) + 2; // 落在「中」的第 3 个字节里
    res.write(bytes.subarray(0, at));
    setTimeout(() => {
      res.write(bytes.subarray(at));
      res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { statusUpdate: { taskId: 't-8', status: { state: 'TASK_STATE_COMPLETED' }, final: true } } })}\n\n`);
      res.end();
    }, 25);
  });
  try {
    const bridge = createBridge({ config: { client: { timeoutMs: 5000 } } });
    const outcome = await bridge.stream({ baseUrl: upstream.baseUrl }, { text: 'x' });
    assert.equal(outcome.text, '中文测试✅', 'a multi-byte character split across chunks must not be corrupted');
    assert.equal(outcome.final, true);
  } finally {
    await upstream.close();
  }
});

test('stream keeps reading when a non-terminal frame falsely claims final:true', async () => {
  // 真实报文里的坑（scripts/aisix-dev/mock-agent.mjs:151 就是这么写的：
  // `final: state !== 'TASK_STATE_WORKING'`），第一帧 submitted 就带 final:true。
  // 照抄那个标记会让正常的流在第一帧后静默截断。
  const events = [];
  const upstream = await startUpstream(({ res, body }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const frame = (payload) => `data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: payload })}\n\n`;
    res.write(frame({ statusUpdate: { taskId: 't-7', status: { state: 'TASK_STATE_SUBMITTED' }, final: true } }));
    res.write(frame({ statusUpdate: { taskId: 't-7', status: { state: 'TASK_STATE_WORKING' }, final: true } }));
    res.write(frame({ artifactUpdate: { taskId: 't-7', artifact: { artifactId: 'a1', name: 'reply', parts: [{ kind: 'text', text: '迟到但没丢' }] }, append: false } }));
    res.write(frame({ statusUpdate: { taskId: 't-7', status: { state: 'TASK_STATE_COMPLETED' }, final: true } }));
    res.end();
  });
  try {
    const bridge = createBridge({ config: { client: { timeoutMs: 5000 } } });
    const outcome = await bridge.stream({ baseUrl: upstream.baseUrl }, { text: 'x', onEvent: (e) => events.push(e) });
    assert.equal(events.filter((event) => event.type === 'status').length, 3, 'all three status frames must be delivered');
    assert.equal(outcome.text, '迟到但没丢', 'the artifact after the bogus final frame must not be lost');
    assert.equal(outcome.state, 'completed');
    // 对外只报「真的结束了」：前两帧不是。
    const finals = events.filter((event) => event.type === 'status').map((event) => event.final);
    assert.deepEqual(finals, [false, false, true]);
  } finally {
    await upstream.close();
  }
});

test('an onEvent callback that throws propagates instead of causing a silent reconnect', async () => {
  let connections = 0;
  const upstream = await startUpstream(({ res, body }) => {
    connections += 1;
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { artifactUpdate: { taskId: 't-6', artifact: { artifactId: 'a', name: 'feed', parts: [{ kind: 'text', text: 'one' }] } } } })}\n\n`);
    res.end();
  });
  try {
    const bridge = createBridge({ config: { client: { timeoutMs: 5000, reconnectAttempts: 3 } } });
    const boom = new Error('the consumer failed');
    await assert.rejects(
      () => bridge.stream({ baseUrl: upstream.baseUrl }, { skill: 'group/subscribe', sinceSeq: 0, onEvent: () => { throw boom; } }),
      (err) => {
        assert.equal(err, boom, 'the consumer error must surface unchanged');
        return true;
      },
    );
    // 重连会把已经投过的 feed 条目再投一遍，这是群场景里最不能接受的重复消息。
    assert.equal(connections, 1);
  } finally {
    await upstream.close();
  }
});

test('stream stops with an idle timeout when the upstream goes silent', async () => {
  const upstream = await startUpstream(({ res, body }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { statusUpdate: { taskId: 't-5', status: { state: 'TASK_STATE_WORKING' }, final: false } } })}\n\n`);
    // 然后一直不说话，也不关连接。
  });
  try {
    const bridge = createBridge({ config: { client: { reconnectAttempts: 0 } } });
    const startedAt = Date.now();
    await assert.rejects(
      () => bridge.stream({ baseUrl: upstream.baseUrl }, { text: 'x', timeoutMs: 120 }),
      (err) => {
        assert.equal(err.kind, 'network');
        assert.equal(err.code, 'idle_timeout');
        return true;
      },
    );
    assert.ok(Date.now() - startedAt < 3000, 'the idle timeout must fire promptly');
  } finally {
    await upstream.close();
  }
});

test('a caller abort stops the stream with kind=network code=aborted', async () => {
  const upstream = await startUpstream(({ res, body }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { statusUpdate: { taskId: 't-4', status: { state: 'TASK_STATE_WORKING' }, final: false } } })}\n\n`);
  });
  try {
    const controller = new AbortController();
    const bridge = createBridge({ config: { client: { reconnectAttempts: 3 } } });
    setTimeout(() => controller.abort(), 80);
    await assert.rejects(
      () => bridge.stream({ baseUrl: upstream.baseUrl }, { skill: 'group/subscribe', sinceSeq: 0, signal: controller.signal }),
      (err) => {
        assert.equal(err.kind, 'network');
        assert.equal(err.code, 'aborted', 'an abort is the caller\'s own decision, not a transient fault to retry');
        return true;
      },
    );
  } finally {
    await upstream.close();
  }
});

test('stream sends x-api-key and X-Forwarded-Proto when configured', async () => {
  const upstream = await startUpstream(({ res, body }) => {
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    res.write(`data: ${JSON.stringify({ jsonrpc: '2.0', id: body.id, result: { statusUpdate: { taskId: 't', status: { state: 'TASK_STATE_COMPLETED' }, final: true } } })}\n\n`);
    res.end();
  });
  try {
    const bridge = createBridge({
      config: { client: { apiKey: 'sk-gw', forwardProto: 'http', timeoutMs: 5000 } },
    });
    await bridge.stream({ baseUrl: upstream.baseUrl }, { text: 'x' });
    const headers = upstream.hits[0].headers;
    assert.equal(headers['x-api-key'], 'sk-gw');
    assert.equal(headers['x-forwarded-proto'], 'http');
  } finally {
    await upstream.close();
  }
});
