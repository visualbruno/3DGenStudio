// Benchmark the shape rigger (animation/shapeRig.js) against hand-made rigs.
//
// Every bundled mesh2motion rig (resources/animations) is a hand-rigged
// creature. Strip its skin, rig it again from the shape alone - no labels, no
// hints, the fully automatic path - and compare with the original:
//   * labels:   which of the original chains (describe_rig on the hand rig)
//               came back under the same label;
//   * placement: for each matched chain, the mean nearest-point distance
//               between the two chains' centre lines, as a % of body size
//               (joint COUNT differs by design, the line they sit on should not);
//   * facing:   the forward axis of each (a flipped facing swaps every _L/_R);
//   * bending:  deformation-test problems (45 degree bends / twists) on the
//               original rig vs the rebuilt one.
//
// Needs the Mesh Tools service (/meshes/shape-skeleton).
//   node tools/bench-shape-rig.mjs [--url http://127.0.0.1:8200] [--only horse,spider]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRig } from '../animation/index.js';
import { deformationTest } from '../animation/inspect.js';
import { readStaticMesh, soupGlb } from '../animation/rigid.js';
import { buildShapeRig, stripSkin } from '../animation/shapeRig.js';
import { restJointWorlds } from '../animation/gltfRig.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const opt = (name, fallback) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : fallback; };
const url = opt('url', 'http://127.0.0.1:8200');
const only = opt('only', '').split(',').filter(Boolean);
const SPECIES = ['human-base', 'fox', 'horse', 'bird', 'dragon', 'kaiju', 'shark', 'snake', 'spider'].filter(s => !only.length || only.includes(s));

function chainLine(rig, description, label) {
  const chain = description.chains.find(c => c.label === label);
  if (!chain) return null;
  const P = restJointWorlds(rig).map(m => [m.elements[12], m.elements[13], m.elements[14]]);
  // The chain's own joints only (a hand-made pelvis may hang from a floor-level root).
  const pts = chain.bones.map(b => P[rig.jointByName.get(b)]);
  // A one-joint chain (a humanoid's Neck) is a point: compare it as a line of zero length.
  return pts.length >= 2 ? pts : (pts.length ? [pts[0], pts[0]] : null);
}

function resample(points, n = 11) {
  const arcs = [0];
  for (let i = 1; i < points.length; i += 1) arcs.push(arcs[i - 1] + Math.hypot(...points[i].map((v, k) => v - points[i - 1][k])));
  const L = arcs.at(-1) || 1;
  const out = [];
  for (let s = 0; s < n; s += 1) {
    const a = (s / (n - 1)) * L;
    let i = 0;
    while (i < arcs.length - 2 && arcs[i + 1] < a) i += 1;
    const t = arcs[i + 1] > arcs[i] ? (a - arcs[i]) / (arcs[i + 1] - arcs[i]) : 0;
    out.push(points[i].map((v, k) => v + (points[i + 1][k] - v) * t));
  }
  return out;
}

const rows = [];
for (const species of SPECIES) {
  const original = fs.readFileSync(path.join(ROOT, 'resources', 'animations', `${species}-animations.glb`));
  const gt = openRig(original);
  const bare = stripSkin(original);
  const form = new FormData();
  form.append('meshFile', new Blob([soupGlb(readStaticMesh(bare))]), 'shape.glb');
  const t0 = Date.now();
  const res = await fetch(`${url}/meshes/shape-skeleton`, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`${species}: shape skeleton failed (HTTP ${res.status}) - is the Mesh Tools service running at ${url}?`);
  const payload = await res.json();
  const built = buildShapeRig(bare, payload, {});
  const ms = Date.now() - t0;
  const ours = openRig(built.buffer, built.profile);
  // Body size, not height: a snake is 20x longer than it is tall.
  const height = Math.max(gt.description.size.height, gt.description.size.length) || 1;
  const gtChains = gt.description.chains.filter(c => !['helper', 'extra', 'part'].includes(c.kind));
  const matched = [];
  for (const c of gtChains) {
    const a = chainLine(gt.rig, gt.description, c.label);
    const b = chainLine(ours.rig, ours.description, c.label);
    if (!a || !b) continue;
    // Symmetric nearest-point distance between the two centre lines: blind
    // to which end a chain starts from (a snake's body may be listed either way).
    const ra = resample(a, 21);
    const rb = resample(b, 21);
    const near = (p, set) => Math.min(...set.map(q => Math.hypot(...p.map((v, k) => v - q[k]))));
    const err = (ra.reduce((s, p) => s + near(p, rb), 0) + rb.reduce((s, p) => s + near(p, ra), 0)) / (ra.length + rb.length);
    matched.push({ label: c.label, err: (100 * err) / height });
  }
  const dGt = deformationTest(gt.rig, gt.description);
  const dOurs = deformationTest(ours.rig, ours.description);
  const row = {
    species,
    plan: `${gt.description.bodyPlan} -> ${ours.description.bodyPlan}`,
    facing: `${gt.description.frame.forward} -> ${ours.description.frame.forward}`,
    labels: `${matched.length}/${gtChains.length}`,
    missing: gtChains.map(c => c.label).filter(l => !matched.some(m => m.label === l)).join(' ') || '-',
    placementPct: matched.length ? Math.round((matched.reduce((s, m) => s + m.err, 0) / matched.length) * 10) / 10 : null,
    worst: matched.sort((x, y) => y.err - x.err).slice(0, 2).map(m => `${m.label} ${m.err.toFixed(1)}%`).join(', '),
    bones: `${gt.rig.joints.length} -> ${built.bones}`,
    bendProblems: `${dGt.problems.length} -> ${dOurs.problems.length}`,
    ms
  };
  rows.push(row);
  console.log(JSON.stringify(row));
}
const scored = rows.filter(r => r.placementPct !== null);
console.log(`\nmean placement error ${(scored.reduce((s, r) => s + r.placementPct, 0) / Math.max(1, scored.length)).toFixed(1)}% of body size over ${scored.length} species`);
