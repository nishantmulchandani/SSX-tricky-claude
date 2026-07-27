#!/usr/bin/env node
/**
 * Prints the course cross-section as ASCII, so the shape of the track can be
 * checked without wrestling a screenshot into the right camera angle.
 *
 *   node tools/xsection.mjs [z]
 */
import { heightAt, courseXAt, courseWidthAt, trackLimitAt } from '../src/world/terrain.js';

const z = +(process.argv[2] || -1500);
const cx = courseXAt(z);
const half = courseWidthAt(z) * 0.5;
const limit = trackLimitAt(z);

const span = Math.ceil(limit + 14);
const cols = [];
for (let dx = -span; dx <= span; dx += 1) cols.push({ dx, y: heightAt(cx + dx, z) });
const base = Math.min(...cols.map((c) => c.y));
const top = Math.max(...cols.map((c) => c.y));
const ROWS = 22;

console.log(`\ncross-section at z=${z}   centre x=${cx.toFixed(1)}   half-width=${half.toFixed(1)}m   wall at ${limit.toFixed(1)}m`);
console.log(`height range ${(top - base).toFixed(1)}m\n`);

const grid = [];
for (let r = 0; r < ROWS; r++) grid.push(new Array(cols.length).fill(' '));
for (let i = 0; i < cols.length; i++) {
  const t = (cols[i].y - base) / Math.max(0.001, top - base);
  const row = ROWS - 1 - Math.round(t * (ROWS - 1));
  const onPiste = Math.abs(cols[i].dx) <= half;
  const beyondWall = Math.abs(cols[i].dx) > limit;
  grid[row][i] = beyondWall ? '.' : onPiste ? '#' : '=';
}
for (const row of grid) console.log('  ' + row.join(''));
console.log('  ' + cols.map((c) => (c.dx === 0 ? '^' : ' ')).join(''));
console.log(`  # groomed racing line   = trough / berm   . beyond the wall\n`);

// Gradient of the trough at the edge of the racing line — how steep the
// transition is where a rider actually meets it.
const gAt = (dx) => (heightAt(cx + dx + 0.5, z) - heightAt(cx + dx - 0.5, z));
console.log(`  transition gradient at half-width : ${(Math.atan(gAt(half)) * 57.3).toFixed(0)} deg`);
console.log(`  gradient at the racing line       : ${(Math.atan(gAt(half * 0.4)) * 57.3).toFixed(0)} deg`);
console.log(`  rise across the ribbon            : ${(heightAt(cx + half, z) - heightAt(cx, z)).toFixed(1)} m\n`);
