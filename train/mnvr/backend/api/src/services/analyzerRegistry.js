/**
 * The list of AI models (analyzers) a camera can run, read LIVE from
 *   backend/ai/analytics/analyzers/__init__.py   (the REGISTRY dict)
 * so that adding / removing / renaming an analyzer there is all it takes: the
 * camera Settings drop-down follows it. The file is parsed as text (never
 * imported), so no Python, torch or model weights are needed by the API.
 *
 * Understood forms inside REGISTRY = { ... }:
 *     FallLeanAnalyzer.name: FallLeanAnalyzer,     -> the class's `name = "..."`
 *     "smoke": SmokeAnalyzer,                      -> literal key
 * Lines starting with # are ignored. An optional `label = "Nice name"` in the
 * analyzer class is shown in the drop-down instead of the prettified name.
 * Override the folder with ANALYZERS_DIR.
 */
const fs = require('fs');
const path = require('path');

const DIR = process.env.ANALYZERS_DIR
  ? path.resolve(process.env.ANALYZERS_DIR)
  : path.resolve(__dirname, '../../../ai/analytics/analyzers');

const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const stripComments = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).map((l) => l.replace(/\s+#.*$/, '')).join('\n');
const pretty = (n) => n.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());

// class attribute (name / label) inside `class <cls>` of <module>.py
function classAttr(mod, cls, attr) {
  const src = read(path.join(DIR, `${mod}.py`));
  if (!src) return null;
  const start = src.search(new RegExp(`^class\\s+${cls}\\b`, 'm'));
  if (start < 0) return null;
  const rest = src.slice(start + 1);
  const next = rest.search(/^class\s+\w+/m);
  const body = next < 0 ? rest : rest.slice(0, next);
  const m = body.match(new RegExp(`^\\s+${attr}\\s*(?::\\s*str\\s*)?=\\s*['"]([^'"]+)['"]`, 'm'));
  return m ? m[1] : null;
}

function listAnalyzers() {
  const raw = read(path.join(DIR, '__init__.py'));
  if (!raw) return [];
  const src = stripComments(raw);
  const modOf = {};                                   // class -> module file
  for (const m of src.matchAll(/^\s*from\s+(?:[\w.]*\.)?(\w+)\s+import\s+([^\n(]+)/gm)) {
    for (const part of m[2].split(',')) {
      const [cls, alias] = part.trim().split(/\s+as\s+/);
      if (cls) { modOf[alias || cls] = m[1]; }
    }
  }
  const block = src.match(/REGISTRY\s*(?::[^=]+)?=\s*\{([\s\S]*?)\n\s*\}/);
  if (!block) return [];
  const out = []; const seen = new Set();
  for (const m of block[1].matchAll(/(?:['"](\w+)['"]|(\w+)\.name)\s*:\s*(\w+)/g)) {
    const cls = m[3];
    const mod = modOf[m[2] || cls] || modOf[cls];
    const name = m[1] || (mod && classAttr(mod, m[2], 'name'));
    if (!name || seen.has(name)) continue;
    seen.add(name);
    out.push({ name, label: (mod && classAttr(mod, cls, 'label')) || pretty(name) });
  }
  return out;
}

module.exports = { listAnalyzers, ANALYZERS_DIR: DIR };
