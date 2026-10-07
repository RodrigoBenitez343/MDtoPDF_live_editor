// ============================================================================
// files.js — pure helpers for Library management (rename / move / duplicate /
// trash). No DOM, no Neutralino here: loaded before app.js in the browser and
// also runnable under Node for its self-check:
//   node app/resources/js/files.js
// ============================================================================
(function (factory) {
  'use strict';
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (typeof self !== 'undefined') self.FilesUtil = api;
  else if (typeof window !== 'undefined') window.FilesUtil = api;
})(function () {
  'use strict';

  function basename(path) {
    return path.split(/[\\/]/).pop();
  }

  function dirname(path) {
    const i = Math.max(path.lastIndexOf('\\'), path.lastIndexOf('/'));
    return i < 0 ? '' : path.slice(0, i);
  }

  function extname(name) {
    const i = name.lastIndexOf('.');
    return i > 0 ? name.slice(i) : '';
  }

  function stem(name) {
    const ext = extname(name);
    return ext ? name.slice(0, -ext.length) : name;
  }

  // First free "name.ext" / "name (2).ext" / … not present in existingNames
  // (case-insensitive, so it stays correct on Windows).
  function uniqueChildName(existingNames, filename) {
    const taken = new Set(existingNames.map((n) => n.toLowerCase()));
    if (!taken.has(filename.toLowerCase())) return filename;
    const ext = extname(filename);
    const base = stem(filename);
    for (let i = 2; ; i++) {
      const candidate = base + ' (' + i + ')' + ext;
      if (!taken.has(candidate.toLowerCase())) return candidate;
    }
  }

  // True when child is parent itself or lives under it. ci = case-insensitive.
  function isUnder(parent, child, ci) {
    const norm = (p) => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '');
    let a = norm(parent);
    let b = norm(child);
    if (ci) { a = a.toLowerCase(); b = b.toLowerCase(); }
    return b === a || b.startsWith(a + '/');
  }

  return { basename, dirname, extname, stem, uniqueChildName, isUnder };
});

// ─── self-check: node app/resources/js/files.js ───
if (typeof module !== 'undefined' && require.main === module) {
  const assert = require('assert');
  const F = module.exports;
  assert.strictEqual(F.uniqueChildName([], 'a.md'), 'a.md');
  assert.strictEqual(F.uniqueChildName(['a.md'], 'a.md'), 'a (2).md');
  assert.strictEqual(F.uniqueChildName(['a.md', 'a (2).md'], 'a.md'), 'a (3).md');
  assert.strictEqual(F.uniqueChildName(['A.MD'], 'a.md'), 'a (2).md'); // case-insensitive
  assert.strictEqual(F.uniqueChildName(['README'], 'readme'), 'readme (2)');
  assert.strictEqual(F.uniqueChildName(['notes'], 'notes'), 'notes (2)');
  assert.strictEqual(F.extname('a.b.md'), '.md');
  assert.strictEqual(F.stem('a.b.md'), 'a.b');
  assert.strictEqual(F.extname('README'), '');
  assert.ok(F.isUnder('C:\\Docs', 'C:\\Docs\\sub\\x.md', true));
  assert.ok(!F.isUnder('C:\\Docs', 'C:\\Docs2\\x.md', true));
  assert.ok(F.isUnder('C:\\Docs', 'c:\\docs\\x', true));   // case-insensitive
  assert.ok(!F.isUnder('C:\\Docs', 'c:\\docs\\x', false)); // case-sensitive
  assert.ok(F.isUnder('/docs', '/docs', false));           // self
  assert.ok(F.isUnder('/docs', '/docs/a', false));
  assert.ok(!F.isUnder('/docs', '/other/a', false));
  console.log('files.js self-check: OK');
}
