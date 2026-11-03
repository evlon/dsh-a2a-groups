#!/usr/bin/env node
/**
 * Channel directory verification, end to end through the gateway.
 *
 * The property that matters: a person who is NOT a member can discover what a
 * host offers, and still learn nothing about who is in it or what was said. The
 * tests below assert both halves — the listing works, and the boundaries hold.
 *
 *   node scripts/aisix-dev/probe-directory.mjs
 */

const GATEWAY = process.env.A2A_GATEWAY ?? 'http://127.0.0.1:3000/a2a';
const KEY = process.env.A2A_KEY ?? 'sk-dev-niukl-2026';
const HOST = process.env.A2A_HOST_AGENT ?? 'dsh-groups';

const headers = {
  'x-api-key': KEY,
  'x-forwarded-proto': 'http',
  'content-type': 'application/json',
  'a2a-version': '1.0',
};

let failures = 0;
const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail === '' ? '' : `  (${detail})`}`);
  if (!ok) failures += 1;
};

async function call(skill, data = {}, text = skill) {
  const response = await fetch(`${GATEWAY}/${HOST}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `d-${Math.random().toString(36).slice(2)}`,
      method: 'SendMessage',
      params: {
        message: {
          role: 'user',
          messageId: `m-${Math.random().toString(36).slice(2)}`,
          parts: [{ kind: 'text', text }],
          metadata: { skill, data },
        },
      },
    }),
  });
  const body = await response.json();
  if (body.error) {
    const error = new Error(`${skill}: ${body.error.message}`);
    error.code = body.error.data?.code ?? body.error.code;
    throw error;
  }
  const task = body.result.task;
  return {
    text: (task.artifacts ?? []).flatMap((a) => a.parts ?? []).map((p) => p.text ?? '').join('\n'),
    data: task.metadata?.result,
  };
}

// ---------------------------------------------------------------------------
console.log('1. the directory is browsable WITHOUT a credential');
//
// No memberKey anywhere in this call: that is the point. A person who has not
// joined anything must be able to see what a host offers, or the invite flow has
// no first step.
const listing = await call('group/directory', {});
check('directory answered', listing.data !== undefined, 'ok');
check('directory returns a total', typeof listing.data?.total === 'number', `${listing.data?.total}`);
const rows = listing.data?.groups ?? [];
check('directory lists groups', Array.isArray(rows), `${rows.length} group(s)`);

if (rows.length > 0) {
  const first = rows[0];
  const fields = Object.keys(first).sort();
  console.log(`   fields: ${fields.join(', ')}`);
  check('a row carries what a person needs to decide', first.name !== undefined && first.memberCount !== undefined
    && first.joinPolicy !== undefined, first.name);
  // The boundaries. Each of these is a field that must NOT exist.
  check('no member identities', first.members === undefined && first.memberIds === undefined, 'absent');
  check('no feed content', first.feed === undefined && first.entries === undefined && first.lastMessage === undefined,
    'absent');
  check('no owner identity', first.owner === undefined, 'absent');
  check('no invite token', first.invite === undefined && first.token === undefined, 'absent');
}

// ---------------------------------------------------------------------------
console.log('\n2. the raw response never carries a credential or a member name');
const raw = JSON.stringify(listing.data);
check('no memberKey in the directory', !/mk_[A-Za-z0-9_-]{10,}/.test(raw), 'no key pattern');
check('no password field', !raw.includes('passwordHash') && !raw.includes('"password"'), 'no password');
check('no key hash', !raw.includes('keyHash'), 'no hash');

// ---------------------------------------------------------------------------
console.log('\n3. search narrows the listing');
// A keyword unique to THIS run: earlier runs leave groups behind, and a shared
// word like "验证" would match all of them, making "narrower" impossible to show.
const uniqueKeyword = `kw${Date.now().toString(36)}`;
const created = await call('group/create', {
  name: `目录验证群-${uniqueKeyword}`,
  topic: `搜索关键字 ${uniqueKeyword}`,
});
const groupId = /groupId\s*:\s*(\S+)/.exec(created.text)?.[1];
check('a group was created to search for', groupId !== undefined, groupId);

const byKeyword = await call('group/directory', { query: uniqueKeyword });
check('search by a unique keyword finds exactly that group',
  (byKeyword.data?.groups ?? []).length === 1
  && byKeyword.data.groups[0].groupId === groupId, 'found one');

// Compare against the listing taken AFTER the create: `listing` above was read
// before this group existed, so comparing to it would assert that creating a group
// shrinks the directory.
const fullNow = await call('group/directory', {});
check('search returns no more rows than the full listing',
  (byKeyword.data?.total ?? 0) <= (fullNow.data?.total ?? 0),
  `${byKeyword.data?.total} <= ${fullNow.data?.total}`);
check('the unique keyword is genuinely narrower than the whole host',
  (byKeyword.data?.total ?? 0) < (fullNow.data?.total ?? 0),
  `${byKeyword.data?.total} of ${fullNow.data?.total}`);

const byNothing = await call('group/directory', { query: 'zzz-no-such-group-zzz' });
check('a search with no match returns an empty page', (byNothing.data?.groups ?? []).length === 0, 'empty');

// ---------------------------------------------------------------------------
console.log('\n4. paging is bounded');
const paged = await call('group/directory', { limit: 2 });
check('a page respects its limit', (paged.data?.groups ?? []).length <= 2, `${paged.data?.returned} rows`);
check('hasMore is reported', typeof paged.data?.hasMore === 'boolean', String(paged.data?.hasMore));

// ---------------------------------------------------------------------------
console.log('\n5. an unlisted group does not appear, and cannot be probed');
const secret = await call('group/create', {
  name: `秘密群-${Date.now() % 100000}`,
  topic: '不应该出现在目录里',
  // `visibility` sits at the top of the payload, not under a nested `settings`
  // object: the skill owns the settings it accepts, and a caller passing a free-form
  // `settings` bag would be able to set fields the store validates separately.
  visibility: 'unlisted',
});
const secretId = /groupId\s*:\s*(\S+)/.exec(secret.text)?.[1];
check('the unlisted group was created', secretId !== undefined, secretId);

const afterSecret = await call('group/directory', {});
check('the unlisted group is absent from the directory',
  !(afterSecret.data?.groups ?? []).some((group) => group.groupId === secretId), 'absent');
check('searching for it by name finds nothing',
  (await call('group/directory', { query: '秘密群' })).data?.groups?.length === 0, 'no oracle');

// ---------------------------------------------------------------------------
console.log('\n6. the directory agrees with a member\'s own view on the countable facts');
const memberId = /memberId:\s*(\S+)/.exec(created.text)?.[1];
const memberKey = /ownerKey:\s*(\S+)/.exec(created.text)?.[1];
const selfView = await call('group/members', { groupId, memberId, memberKey });
const dirRow = (afterSecret.data?.groups ?? []).find((group) => group.groupId === groupId);
check('member count agrees', dirRow?.memberCount === (selfView.data?.members ?? []).length,
  `${dirRow?.memberCount} vs ${(selfView.data?.members ?? []).length}`);
check('the directory still exposes no member name it did not before',
  !JSON.stringify(afterSecret.data).includes('群主'), 'no names');

console.log(`\ndirectory: ${failures === 0 ? 'OK' : `${failures} FAILED`}`);
if (failures > 0) process.exitCode = 1;
