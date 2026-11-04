/**
 * Tests for the invite link format: encoding, decoding, and the prompt template.
 *
 * The link is a cross-party wire format, so these tests are written against the
 * *literal* contract string (field order `v,gw,agent,g,t,n,e`) rather than
 * against whatever `buildLink` happens to produce — an assertion that only
 * round-trips our own encoder would pass even if both directions drifted away
 * from CONTRACT §2.6. There is also one assertion that the prompt text contains
 * the exact `/a2a-join <link>` line, because a user's paste-and-send path
 * depends on it byte for byte.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  InviteLinkError,
  LINK_PREFIX,
  MAX_LINK_CHARS,
  buildLink,
  buildPrompt,
  parseLink,
  randomPassword,
  randomToken,
} from '../lib/core/invite.js';

const EXPIRES = Date.parse('2026-11-10T09:00:00.000Z');
const EXPIRES_ISO = '2026-11-10T09:00:00.000Z';
const BEFORE_EXPIRY = Date.parse('2026-11-03T09:00:00.000Z');

/** The canonical link, built by hand from the contract's field order. */
const CANONICAL =
  'agent-a2a://group?v=1&gw=https%3A%2F%2Fgw.ict.cmcc&agent=group-7f3a1c&g=g-7f3a1c&t=tok_abc&n=%E5%8F%91%E7%A5%A8%E9%87%8D%E6%9E%84&e=2026-11-10T09%3A00%3A00.000Z';

// ---------------------------------------------------------------------------
// buildLink
// ---------------------------------------------------------------------------

test('buildLink emits the contract field order and nothing else', () => {
  const link = buildLink({
    groupId: 'g-7f3a1c',
    token: 'tok_abc',
    gatewayBase: 'https://gw.ict.cmcc',
    agent: 'group-7f3a1c',
    name: '发票重构',
    expiresAt: EXPIRES,
  });

  assert.equal(link.startsWith(`${LINK_PREFIX}?`), true);
  const url = new URL(link);
  assert.equal(url.protocol, 'agent-a2a:');
  assert.equal(url.host, 'group');
  // Field order is what a human reads in the prompt and what the UI shows.
  assert.deepEqual(
    [...url.searchParams.keys()],
    ['v', 'gw', 'agent', 'g', 't', 'n', 'e'],
  );
  assert.equal(url.searchParams.get('v'), '1');
  assert.equal(url.searchParams.get('gw'), 'https://gw.ict.cmcc');
  assert.equal(url.searchParams.get('agent'), 'group-7f3a1c');
  assert.equal(url.searchParams.get('g'), 'g-7f3a1c');
  assert.equal(url.searchParams.get('t'), 'tok_abc');
  assert.equal(url.searchParams.get('n'), '发票重构');
  assert.equal(url.searchParams.get('e'), EXPIRES_ISO);
});

test('buildLink normalizes a trailing slash on the gateway and accepts ISO or Date expiry', () => {
  const fromIso = buildLink({
    groupId: 'g-1',
    token: 't1',
    gatewayBase: 'https://gw.ict.cmcc/',
    agent: 'a',
    expiresAt: EXPIRES_ISO,
  });
  const fromDate = buildLink({
    groupId: 'g-1',
    token: 't1',
    gatewayBase: 'https://gw.ict.cmcc',
    agent: 'a',
    expiresAt: new Date(EXPIRES),
  });
  assert.equal(new URL(fromIso).searchParams.get('gw'), 'https://gw.ict.cmcc');
  assert.equal(fromIso, fromDate, 'the same invite must not have two spellings');
});

test('buildLink omits name and expiry rather than emitting empty parameters', () => {
  const link = buildLink({ groupId: 'g-1', token: 't1', gatewayBase: 'http://gw:3000/a2a', agent: 'a' });
  const url = new URL(link);
  assert.equal(url.searchParams.has('n'), false);
  assert.equal(url.searchParams.has('e'), false);
  assert.deepEqual([...url.searchParams.keys()], ['v', 'gw', 'agent', 'g', 't']);
});

test('buildLink refuses an empty required field instead of building a broken link', () => {
  assert.throws(
    () => buildLink({ groupId: '', token: 't1', gatewayBase: 'http://gw', agent: 'a' }),
    (error) => error instanceof InviteLinkError && error.code === 'incomplete_link',
  );
  assert.throws(
    () => buildLink({ groupId: 'g-1', token: '   ', gatewayBase: 'http://gw', agent: 'a' }),
    (error) => error instanceof InviteLinkError && error.code === 'incomplete_link',
  );
});

// ---------------------------------------------------------------------------
// parseLink: the happy paths
// ---------------------------------------------------------------------------

test('parseLink decodes every field of the contract-shaped link', () => {
  const parsed = parseLink(CANONICAL, { now: BEFORE_EXPIRY });
  assert.equal(parsed.version, 1);
  assert.equal(parsed.gatewayBase, 'https://gw.ict.cmcc');
  assert.equal(parsed.agent, 'group-7f3a1c');
  assert.equal(parsed.groupId, 'g-7f3a1c');
  assert.equal(parsed.token, 'tok_abc');
  assert.equal(parsed.name, '发票重构');
  assert.equal(parsed.expiresAt, EXPIRES);
  assert.equal(parsed.expiresAtIso, EXPIRES_ISO);
  assert.equal(parsed.expired, false);
});

test('parseLink round-trips what buildLink produced', () => {
  const link = buildLink({
    groupId: 'g-roundtrip',
    token: 'inv_abcdefghijklmnop',
    gatewayBase: 'http://192.168.3.7:3000/a2a',
    agent: 'group-roundtrip',
    name: '一个 带空格 的群名',
    expiresAt: EXPIRES,
  });
  const parsed = parseLink(link);
  assert.equal(parsed.groupId, 'g-roundtrip');
  assert.equal(parsed.token, 'inv_abcdefghijklmnop');
  assert.equal(parsed.gatewayBase, 'http://192.168.3.7:3000/a2a');
  assert.equal(parsed.name, '一个 带空格 的群名');
});

test('parseLink accepts unescaped UTF-8 in the group name', () => {
  const raw =
    'agent-a2a://group?v=1&gw=https://gw.ict.cmcc&agent=g-1&g=g-1&t=tok&n=发票重构攻坚&e=2026-11-10T09:00:00.000Z';
  assert.equal(parseLink(raw).name, '发票重构攻坚');
});

test('parseLink finds the link inside the prose a user actually pastes', () => {
  const prose = `用 a2a_group_join 加入这个群：${CANONICAL} ，群密码：abc123 。`;
  const parsed = parseLink(prose);
  assert.equal(parsed.token, 'tok_abc');
  assert.equal(parsed.groupId, 'g-7f3a1c');
  assert.equal(parsed.raw, CANONICAL, 'the trailing Chinese comma must not be swallowed');
});

test('parseLink finds the link inside the /a2a-join command line', () => {
  const parsed = parseLink(`/a2a-join ${CANONICAL}`);
  assert.equal(parsed.token, 'tok_abc');
});

test('parseLink reports an expiry as expired without refusing to parse it', () => {
  const parsed = parseLink(CANONICAL, { now: EXPIRES + 1 });
  assert.equal(parsed.expired, true);
  assert.equal(parsed.groupId, 'g-7f3a1c', 'an expired link still parses: the host owns the refusal');
});

test('parseLink accepts the direct-url form from PLAN §5.2', () => {
  const parsed = parseLink('agent-a2a://group?v=1&url=http%3A%2F%2F127.0.0.1%3A3091%2Fa2a&g=g-1&t=tok');
  assert.equal(parsed.url, 'http://127.0.0.1:3091/a2a');
  assert.equal(parsed.gatewayBase, undefined);
});

// ---------------------------------------------------------------------------
// parseLink: the failures, each with a readable message
// ---------------------------------------------------------------------------

test('parseLink rejects a non-link with a message that says what a link looks like', () => {
  assert.throws(
    () => parseLink('帮我把这个群加一下'),
    (error) =>
      error instanceof InviteLinkError &&
      error.code === 'bad_link' &&
      error.message.includes('agent-a2a://group'),
  );
});

test('parseLink rejects the wrong scheme and the wrong host', () => {
  assert.throws(
    () => parseLink('https://example.com/?v=1&g=g-1&t=tok&gw=http://gw&agent=a'),
    (error) => error.code === 'bad_link' && error.message.includes('不是群邀请链接'),
  );
  assert.throws(
    () => parseLink('agent-a2a://channel?v=1&g=g-1&t=tok&gw=http://gw&agent=a'),
    (error) => error.code === 'bad_link',
  );
});

test('parseLink rejects a missing or wrong version, naming the version it saw', () => {
  assert.throws(
    () => parseLink('agent-a2a://group?gw=http://gw&agent=a&g=g-1&t=tok'),
    (error) => error.code === 'unsupported_version' && error.message.includes('v=1'),
  );
  assert.throws(
    () => parseLink('agent-a2a://group?v=2&gw=http://gw&agent=a&g=g-1&t=tok'),
    (error) => error.code === 'unsupported_version' && error.message.includes('v=2'),
  );
});

test('parseLink names the field that is missing', () => {
  assert.throws(
    () => parseLink('agent-a2a://group?v=1&gw=http://gw&agent=a&t=tok'),
    (error) => error.code === 'incomplete_link' && error.message.includes('群 id'),
  );
  assert.throws(
    () => parseLink('agent-a2a://group?v=1&gw=http://gw&agent=a&g=g-1'),
    (error) => error.code === 'incomplete_link' && error.message.includes('邀请令牌'),
  );
  assert.throws(
    () => parseLink('agent-a2a://group?v=1&g=g-1&t=tok&agent=a'),
    (error) => error.code === 'incomplete_link' && error.message.includes('网关'),
  );
});

test('parseLink rejects an unparseable expiry instead of silently ignoring it', () => {
  assert.throws(
    () => parseLink('agent-a2a://group?v=1&gw=http://gw&agent=a&g=g-1&t=tok&e=not-a-date'),
    (error) => error.code === 'bad_expiry',
  );
});

test('parseLink rejects non-string input and absurdly long input', () => {
  for (const value of [undefined, null, 42, {}, ['a']]) {
    assert.throws(() => parseLink(value), (error) => error.code === 'bad_link');
  }
  const huge = `${LINK_PREFIX}?v=1&g=g-1&t=${'x'.repeat(MAX_LINK_CHARS * 2)}&gw=http://gw&agent=a`;
  assert.throws(() => parseLink(huge), (error) => error.code === 'bad_link' && error.message.includes('过长'));
});

test('an InviteLinkError never carries a token in its details', () => {
  let caught;
  try {
    parseLink('agent-a2a://group?v=1&gw=http://gw&agent=a&t=tok_secret_value');
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof InviteLinkError);
  assert.equal(JSON.stringify(caught.details).includes('tok_secret_value'), false);
  assert.equal(caught.message.includes('tok_secret_value'), false);
});

// ---------------------------------------------------------------------------
// buildPrompt: verbatim contract text
// ---------------------------------------------------------------------------

test('buildPrompt reproduces the contract prompt, including the /a2a-join line', () => {
  const link = buildLink({
    groupId: 'g-1',
    token: 'tok',
    gatewayBase: 'http://gw:3000/a2a',
    agent: 'a',
    name: '发票重构',
    expiresAt: EXPIRES,
  });
  const prompt = buildPrompt({ name: '发票重构', link, expiresAt: EXPIRES });
  const lines = prompt.split('\n');

  assert.equal(lines[0], '我在 DSH 里建了个协作群「发票重构」，邀请你加入。');
  assert.equal(lines[1], '');
  assert.equal(lines[2], '把下面这一行贴到你的 DSH 会话里直接发送即可：');
  assert.equal(lines[3], `/a2a-join ${link}`);
  assert.equal(lines[4], '');
  assert.equal(lines[5], '也可以直接用自然语言让我加群：');
  // No password clause: the token is the only credential, and the prompt must not
  // imply a second secret a colleague would then wait for.
  assert.equal(lines[6], `  用 a2a_group_join 加入这个群：${link}`);
  assert.equal(lines[7], '');
  assert.equal(
    lines[8],
    '入群后：群里有人发言或派活时会自动出现在你会话里（左侧「收到任务消息」卡片），',
  );
  assert.equal(lines[9], '直接回复就是在群里回话。想静音用 a2a_group_inbox off，想退出用 a2a_group_leave。');
  assert.match(lines[10], /前有效/);
  assert.match(lines[10], /可以随时撤销/);
  assert.equal(lines.length, 11);
  // Nothing about uses or passwords may leak into the text a colleague reads.
  assert.equal(/最多可用|群密码/.test(prompt), false);
});

test('buildPrompt says a permanent invite never expires, instead of printing a date', () => {
  const prompt = buildPrompt({ name: 'x', link: 'agent-a2a://group?v=1&g=g&t=t' });
  assert.equal(prompt.includes('长期有效'), true);
  assert.equal(prompt.includes('群密码'), false);
});

test('buildPrompt omits the password clause instead of printing an empty one', () => {
  const link = 'agent-a2a://group?v=1&gw=http://gw&agent=a&g=g-1&t=tok';
  const prompt = buildPrompt({ name: 'x', link, maxUses: 1 });
  assert.equal(prompt.includes('群密码'), false);
  assert.equal(prompt.includes('用 a2a_group_join 加入这个群：' + link), true);
});

test('buildPrompt treats a group name containing ${} as literal text', () => {
  const prompt = buildPrompt({ name: '群${process.env.HOME}', link: 'agent-a2a://group?x', maxUses: 1 });
  assert.equal(prompt.includes('群${process.env.HOME}'), true);
});

test('the prompt it emits parses back into the invite', () => {
  const link = buildLink({
    groupId: 'g-prompt',
    token: 'inv_tok',
    gatewayBase: 'https://gw.ict.cmcc',
    agent: 'group-prompt',
    name: '群名',
    expiresAt: EXPIRES,
  });
  const prompt = buildPrompt({ name: '群名', link, password: 'pw', expiresAt: EXPIRES, maxUses: 3 });
  const parsed = parseLink(prompt);
  assert.equal(parsed.groupId, 'g-prompt');
  assert.equal(parsed.token, 'inv_tok');
});

// ---------------------------------------------------------------------------
// Secret generation
// ---------------------------------------------------------------------------

test('randomToken is URL-safe, unguessable and never repeats', () => {
  const seen = new Set();
  for (let index = 0; index < 200; index += 1) {
    const token = randomToken();
    assert.match(token, /^[A-Za-z0-9_-]+$/u);
    assert.equal(token.length, 32, '24 random bytes in base64url');
    seen.add(token);
  }
  assert.equal(seen.size, 200);
});

test('randomPassword avoids confusable glyphs and honours the length', () => {
  const password = randomPassword(24);
  assert.equal(password.length, 24);
  assert.match(password, /^[A-Za-z0-9]+$/u);
  for (const glyph of ['O', '0', 'I', 'l', '1']) {
    assert.equal(password.includes(glyph), false, `generated password must not contain ${glyph}`);
  }
});

test('randomPassword clamps a nonsense length instead of returning a short password', () => {
  assert.equal(randomPassword(0).length, 12);
  assert.equal(randomPassword(-5).length, 12);
  assert.equal(randomPassword('abc').length, 12);
  assert.equal(randomPassword(2).length, 4, 'a 4-character floor even if asked for less');
});

// ---------------------------------------------------------------------------
// readability
//
// A colleague pastes this into WeChat and somebody on the other end decides whether to trust it.
// `%3A%2F%2F` is `://`, and a link that looks like machine noise arriving unsolicited is a link a
// reasonable person hesitates over. The escaping is reduced, not the format: every field and the
// parser stay the same.

test('the gateway address is written as an address, not as percent-escapes', () => {
  const link = buildLink({
    groupId: 'g-1',
    token: 'inv_x',
    gatewayBase: 'http://gw:3000/a2a',
    agent: 'agent-group-host',
  });
  assert.ok(link.includes('gw=http://gw:3000/a2a'), link);
  assert.ok(!link.includes('%3A%2F%2F'), `no escaped scheme: ${link}`);
});

test('an @ in the gateway address is left literal too', () => {
  // A gateway behind basic auth would carry one, and `%40` reads as noise for the same reason.
  const link = buildLink({
    groupId: 'g-1',
    token: 'inv_x',
    gatewayBase: 'http://user@host:3000/a2a',
    agent: 'agent-group-host',
  });
  assert.ok(link.includes('user@host'), link);
  assert.ok(!link.includes('%40'), link);
});

test('non-ASCII stays escaped, because a URI cannot carry it raw', () => {
  const link = buildLink({
    groupId: 'g-1',
    token: 'inv_x',
    gatewayBase: 'http://gw/a2a',
    agent: 'agent-group-host',
    name: '发票服务重构',
  });
  // The point is that the reduction did not go TOO far: an unescaped Chinese name would be an
  // invalid URI that some clients silently truncate.
  assert.ok(!link.includes('发票'), `must stay escaped: ${link}`);
  assert.equal(parseLink(link).name, '发票服务重构');
});

test('the readable form parses back to exactly the same fields', () => {
  // The whole change is only safe because `URLSearchParams.get` decodes both spellings.
  const input = {
    groupId: 'g-abc',
    token: 'inv_tok',
    gatewayBase: 'http://127.0.0.1:3000/a2a',
    agent: 'agent-group-host',
    name: '发票服务重构',
    expiresAt: '2026-11-11T04:13:26.358Z',
  };
  const back = parseLink(buildLink(input));
  assert.equal(back.groupId, input.groupId);
  assert.equal(back.token, input.token);
  assert.equal(back.gatewayBase, input.gatewayBase);
  assert.equal(back.agent, input.agent);
  assert.equal(back.name, input.name);
  assert.equal(new Date(back.expiresAt).toISOString(), input.expiresAt);
});

test('field order is unchanged, so two links for one group are diffable', () => {
  const link = buildLink({
    groupId: 'g-1',
    token: 'inv_x',
    gatewayBase: 'http://gw/a2a',
    agent: 'agent-group-host',
    name: 'A',
  });
  const order = [...link.matchAll(/(?:^|[?&])([a-z]+)=/gu)].map((match) => match[1]);
  assert.deepEqual(order, ['v', 'gw', 'agent', 'g', 't', 'n']);
});