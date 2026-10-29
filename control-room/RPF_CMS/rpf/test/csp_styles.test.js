/**
 * The dashboard is served with `style-src 'self'`: the browser silently IGNORES <style> tags and style="..." attributes that
 * script adds, so a pop-up styled that way shows up as plain text (jsdom does not enforce this, a real browser does).
 * This test keeps every style in styles.css and every dynamic value on the CSSOM. No database needed.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const app = fs.readFileSync(path.join(__dirname, '..', 'public', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(__dirname, '..', 'public', 'styles.css'), 'utf8');
const server = fs.readFileSync(path.join(__dirname, '..', 'src', 'server.js'), 'utf8');

test('styles come from styles.css only (CSP style-src self)', () => {
  assert.match(server, /style-src 'self'/, 'the policy this test protects');
  assert.ok(!/h\('style'/.test(app) && !/createElement\('style'\)/.test(app), 'no <style> tags created by script');
  assert.ok(!/setAttribute\('style'/.test(app), 'no style attributes set with setAttribute');
  assert.match(app, /k === 'style'\) el\.style\.cssText/, 'h() applies style props through the CSSOM');
});

test('every class the pop-ups, tabs and detail panels rely on is defined in styles.css', () => {
  for (const c of ['.ntoast', '.ntoasts', '.subtab', '.subtabs', '.notif-item', '.nic', '.drawer.v2', '.dh', '.ring', '.steps', '.step', '.dtab', '.dbody', '.dfoot', '.fact', '.facts', '.banner', '.rq', '.feed', '.fe', '.empty2', '.card2'])
    assert.ok(css.includes(c), `styles.css defines ${c}`);
});
