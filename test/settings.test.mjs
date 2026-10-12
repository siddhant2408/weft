// Run: node test/settings.test.mjs
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const ctx = { URL };
vm.runInNewContext(readFileSync(new URL('../settings.js', import.meta.url), 'utf8') + ';this.S = MarginSettings;', ctx);
const { normaliseDomain: n, isExcluded: x } = ctx.S;

assert.equal(n('https://www.Example.com/path?q=1'), 'example.com');
assert.equal(n('  mail.google.com '), 'mail.google.com');
assert.equal(n('chase.com/'), 'chase.com');
assert.equal(n('# comment'), '');
assert.equal(n('not a domain'), '');
assert.equal(n('localhost'), '', 'single-label hosts rejected');

assert.ok(x('mail.google.com', ['mail.google.com']));
assert.ok(x('secure.chase.com', ['chase.com']), 'subdomains excluded');
assert.ok(x('www.chase.com', ['chase.com']));
assert.ok(!x('notchase.com', ['chase.com']), 'suffix must be a whole label');
assert.ok(!x('google.com', ['mail.google.com']), 'parent domain not excluded');
console.log('settings: all passed');
