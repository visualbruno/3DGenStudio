// Worker-thread entry for analyze_shape / build_rig (see runShapeRigTask).
//
// Rigging a 300k-triangle generated mesh is seconds of synchronous work -
// perception, weight binding with visibility rays, the bend test, the images.
// Over /mcp and for the in-app "Animate with AI" agent these tools run INSIDE
// the app's backend process, so on the main thread they would freeze every
// request it serves; they also outlived the backend's 5 s keep-alive, so the
// save that followed was written into a socket the server had closed
// (ECONNABORTED). Everything CPU-bound runs here; the tool only does I/O.
import { Buffer } from 'node:buffer';
import { parentPort, workerData } from 'node:worker_threads';
import { analyzeShapeMesh, branchTable, buildShapeRig, renderShapeAnalysis } from './shapeRig.js';
import { openRig, renderRigViews, inspectRig } from './index.js';
import { restJointWorlds } from './gltfRig.js';

const toBuffer = bytes => Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);

function analyze({ buffer, payload, options, numberAll }) {
  const a = analyzeShapeMesh(toBuffer(buffer), payload, options);
  const d = a.pass.description;
  const png = renderShapeAnalysis(a.mesh, a.table, d, { shape: a.shape, numberAll, numberDetails: numberAll });
  return {
    png,
    table: a.table,
    template: a.template,
    collapsed: Boolean(a.shape.core?.collapsed),
    detached: a.shape.detached.length,
    loopsCut: a.shape.cut.length,
    description: { bodyPlan: d.bodyPlan, forward: d.frame.forward, forwardReason: d.frame.forwardReason, size: d.size }
  };
}

function build({ buffer, payload, options }) {
  const built = buildShapeRig(toBuffer(buffer), payload, options);
  const { rig, description } = openRig(built.buffer, built.profile);
  const report = inspectRig(rig, description, { deformation: true });
  // Name the two ends of the body on the image: a head on the tail is the
  // mistake to catch at a glance (it also swaps every left and right).
  const P = restJointWorlds(rig).map(m => [m.elements[12], m.elements[13], m.elements[14]]);
  const ends = description.chains.filter(c => c.kind === 'head' || c.kind === 'tail').map(c => ({
    p: P[rig.jointByName.get(c.bones[c.bones.length - 1])], text: c.kind, colour: [255, 255, 255]
  }));
  const rendered = renderRigViews(rig, description, { skeleton: true, labels: ends });
  return {
    buffer: built.buffer,
    profile: built.profile,
    template: built.template,
    naming: built.naming,
    bones: built.bones,
    chains: built.chains,
    weights: built.weights,
    notes: built.notes,
    collapsed: Boolean(built.analysis.shape.core?.collapsed),
    table: branchTable(built.analysis.shape, built.analysis.pass),
    png: rendered.png,
    legend: rendered.legend,
    report: { verdict: report.verdict, issues: report.issues, stats: report.stats },
    description: { bodyPlan: description.bodyPlan, forward: description.frame.forward }
  };
}

try {
  const result = workerData.task === 'build' ? build(workerData) : analyze(workerData);
  parentPort.postMessage({ type: 'done', result });
} catch (err) {
  parentPort.postMessage({ type: 'error', message: err?.message || String(err) });
}
