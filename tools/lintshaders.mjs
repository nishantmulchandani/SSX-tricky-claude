#!/usr/bin/env node
/**
 * Static guard for the mistakes that have repeatedly taken this build down.
 *
 * These are cheap to check and expensive to hit: a stray backtick inside a GLSL
 * template literal silently terminates the JS string and blanks the entire
 * page, and the error it produces ("Unexpected identifier 'color'") points
 * nowhere near the real cause. This has cost four separate debugging sessions.
 *
 *   node tools/lintshaders.mjs
 */
import { readFileSync } from 'node:fs';
import { execSync } from 'node:child_process';

const files = execSync('git ls-files "src/**/*.js"', { encoding: 'utf8' })
  .split('\n').filter(Boolean);

// GLSL ES 3.0 reserved words that are legal-looking JS/GLSL identifiers.
// Using one as a variable name fails shader compilation with a message that
// does not name the file.
const RESERVED = [
  'patch', 'sample', 'subroutine', 'common', 'partition', 'active',
  'filter', 'resource', 'superp', 'input', 'output', 'buffer', 'shared',
  'precise', 'invariant', 'coherent', 'volatile', 'restrict', 'readonly',
  'writeonly', 'attribute', 'varying',
];

const problems = [];

for (const file of files) {
  const raw = readFileSync(file, 'utf8');
  // Escaped backticks are legal inside a template literal and must not be
  // flagged. Blank them out (preserving offsets) before any analysis.
  const src = raw.replace(/\\`/g, '\\x');

  // --- 1. backticks inside a tagged GLSL template literal ------------------
  // Walk the file, tracking whether we are inside a `...` template literal
  // that looks like shader source, and flag backticks that appear inside a
  // // or /* */ comment within it (those are the ones that terminate it).
  const lines = src.split('\n');
  let inTemplate = false;
  let templateStart = 0;
  let inBlockComment = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const ticks = (line.match(/`/g) || []).length;

    if (!inTemplate) {
      // A template opens on this line if it has an odd number of backticks.
      if (ticks % 2 === 1) { inTemplate = true; templateStart = i + 1; inBlockComment = false; }
      continue;
    }

    // Inside a template literal: look for comment lines carrying a backtick.
    const trimmed = line.trim();
    if (inBlockComment || trimmed.startsWith('*') || trimmed.startsWith('/*') || trimmed.startsWith('//')) {
      if (trimmed.startsWith('/*')) inBlockComment = !trimmed.includes('*/');
      else if (inBlockComment && trimmed.includes('*/')) inBlockComment = false;
      if (line.includes('`')) {
        problems.push({
          file, line: i + 1, kind: 'backtick-in-shader-comment',
          detail: `backtick inside a comment within the GLSL template opened at line ${templateStart} — this terminates the JS string`,
          text: trimmed.slice(0, 90),
        });
      }
      continue;
    }
    if (ticks % 2 === 1) inTemplate = false; // template closed
  }

  // --- 2. GLSL reserved words used as identifiers --------------------------
  // Only look inside template literals that mention GLSL-ish syntax.
  const shaderBlocks = src.match(/`[^`]*`/gs) || [];
  for (const block of shaderBlocks) {
    if (!/\b(vec[234]|float|gl_FragColor|void main)\b/.test(block)) continue;
    for (const word of RESERVED) {
      // declaration of a variable named after a reserved word
      const re = new RegExp(`\\b(?:float|int|uint|bool|vec[234]|ivec[234]|mat[234]|sampler2D)\\s+${word}\\b`);
      const m = block.match(re);
      if (m) {
        const idx = src.indexOf(m[0]);
        const line = src.slice(0, idx).split('\n').length;
        problems.push({
          file, line, kind: 'glsl-reserved-word',
          detail: `'${word}' is reserved in GLSL ES 3.0 and will fail shader compilation`,
          text: m[0],
        });
      }
    }
  }

  // --- 3. RawShaderMaterial preamble ordering ------------------------------
  // precision must be declared before any other declaration. Matching template
  // literal boundaries with a regex is unreliable — a backtick in an ordinary
  // JS comment is enough to throw the boundaries off — so this just checks
  // that a precision qualifier appears close before the declaration.
  const PC = /out\s+vec4\s+pc_FragColor/g;
  let m;
  while ((m = PC.exec(src)) !== null) {
    const window = src.slice(Math.max(0, m.index - 220), m.index);
    if (!/precision\s+\w+p\s+float/.test(window)) {
      const line = src.slice(0, m.index).split('\n').length;
      problems.push({
        file, line, kind: 'precision-after-declaration',
        detail: 'no precision qualifier declared before "out vec4 pc_FragColor" — GLSL ES 3.0 rejects it for RawShaderMaterial',
        text: m[0],
      });
    }
  }
}

console.log('=== SHADER LINT ===\n');
if (!problems.length) {
  console.log(` PASS  ${files.length} files, no known shader hazards\n`);
  console.log('RESULT: PASS');
  process.exit(0);
}

for (const p of problems) {
  console.log(` FAIL  ${p.file}:${p.line}  [${p.kind}]`);
  console.log(`         ${p.detail}`);
  if (p.text) console.log(`         > ${p.text}`);
}
console.log(`\n${problems.length} problem(s)`);
console.log('RESULT: FAIL');
process.exit(1);
