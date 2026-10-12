// R4. Run: node test/url.test.mjs
import assert from 'node:assert/strict';
import { normaliseUrl as n } from '../url.js';

const base = 'https://example.com/post/hello';
for (const u of [
  'https://example.com/post/hello',
  'https://EXAMPLE.com/post/hello/',
  'https://example.com/post/hello#section-2',
  'https://example.com/post/hello?utm_source=x&utm_medium=y',
  'https://example.com/post/hello?fbclid=abc&ref=hn',
  'https://example.com:443/post/hello?mc_cid=1',
]) assert.equal(n(u), base, u);

assert.equal(n('https://a.com/p?b=2&a=1'), 'https://a.com/p?a=1&b=2', 'params sorted');
assert.equal(n('https://a.com/p?id=7&utm_source=x'), 'https://a.com/p?id=7', 'real params kept');
assert.equal(n('https://a.com/'), 'https://a.com', 'root');
assert.equal(n('https://www.a.com/x?utm_source=1', 'https://a.com/canon'), 'https://a.com/canon', 'same-site canonical wins');
assert.equal(n('https://a.com/x', 'https://evil.com/y'), 'https://a.com/x', 'cross-site canonical ignored');
assert.equal(n('https://a.com/x', 'javascript:alert(1)'), 'https://a.com/x', 'non-http canonical ignored');
assert.equal(n('https://a.com/x', '/rel'), 'https://a.com/rel', 'relative canonical resolved');
console.log('url: all passed');
