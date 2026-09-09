// Renders docs/VFX_ENGINE_MAPPING.md from vfx/engineMapping.js.
//
//     node tools/gen-vfx-mapping.mjs
//
// WHY GENERATED. The table says which of ~50 catalog entries arrive intact in
// Unity and Unreal, and it is read by three different audiences: an author
// deciding whether to use a block, a plugin author deciding what to implement,
// and this app's own compiler deciding which diagnostic to raise. A
// hand-maintained copy would drift the first time someone added a block, and
// the drift would be invisible until an importer was written against it.
//
// `npm run check:vfx` regenerates this and fails if the committed file differs,
// exactly as check:db does for db/names.js - so a stale table cannot be
// committed, and a build that would ship one fails instead.
//
// The generator writes LF unconditionally; see the note in
// tools/check-generated-db.mjs about .gitattributes and Windows runners.
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

import { buildEngineMapping, ENGINE_LABELS } from '../vfx/engineMapping.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'docs', 'VFX_ENGINE_MAPPING.md');

const BADGE = { native: 'yes', approx: 'approx', none: 'NO' };
const badge = (support) => BADGE[support] || support;

// Pipes inside a cell end the cell. Notes are prose written by whoever added a
// catalog entry, so they cannot be trusted not to contain one.
const cell = (text) => String(text ?? '').replace(/\|/g, '\\|').replace(/\r?\n/g, ' ');

function table(headers, rows) {
  const lines = [`| ${headers.join(' | ')} |`, `|${headers.map(() => '---').join('|')}|`];
  for (const row of rows) lines.push(`| ${row.map(cell).join(' | ')} |`);
  return lines.join('\n');
}

const mapping = buildEngineMapping();

const out = [];
out.push('# VFX engine mapping');
out.push('');
out.push('**Generated from `vfx/catalog.js` by `tools/gen-vfx-mapping.mjs`. Do not edit.**');
out.push('Run `node tools/gen-vfx-mapping.mjs` after changing a catalog entry, or');
out.push('`npm run check:vfx` to find out that you have not.');
out.push('');
out.push(`IR format: **${mapping.irFormat}**. Targets: ${mapping.targets.map((t) => `**${ENGINE_LABELS[t]}**`).join(' and ')}.`);
out.push('');
out.push('`yes` means a direct equivalent exists and parameters map one to one.');
out.push('`approx` means something close exists with different semantics, and the');
out.push('importer reports it. `NO` means no equivalent: the importer drops it and');
out.push('says so. Compatibility is surfaced at **author** time - every block and');
out.push('operator carries these flags in the editor, and setting a target raises a');
out.push('real diagnostic - so nothing here should be a surprise at import time.');
out.push('');

out.push('## Coverage');
out.push('');
out.push(table(
  ['Engine', 'Native', 'Approximate', 'Unsupported'],
  mapping.targets.map((target) => [
    ENGINE_LABELS[target],
    mapping.summary[target].native,
    mapping.summary[target].approx,
    mapping.summary[target].none,
  ]),
));
out.push('');

out.push('## What survives, and what does not');
out.push('');
out.push('The contract is **' + mapping.determinism.contract + '**');
out.push('');
out.push('Surviving exactly:');
out.push('');
for (const line of mapping.determinism.survives) out.push(`- ${line}`);
out.push('');
out.push('Not surviving:');
out.push('');
for (const line of mapping.determinism.doesNotSurvive) out.push(`- ${line}`);
out.push('');

out.push('## Blocks');
out.push('');
// Grouped by the context they run in, because that is how an author meets them
// and how a plugin author has to implement them - a Unity Initialize block and
// an Update block are different kinds of object.
const byContext = new Map();
for (const block of mapping.blocks) {
  for (const context of block.contexts) {
    if (!byContext.has(context)) byContext.set(context, []);
    byContext.get(context).push(block);
  }
}
for (const [context, blocks] of byContext) {
  out.push(`### ${context.charAt(0).toUpperCase()}${context.slice(1)}`);
  out.push('');
  out.push(table(
    ['Block', 'id', 'Unity', 'Unreal', 'Notes'],
    blocks.map((b) => [
      b.label,
      `\`${b.id}\``,
      badge(b.unity),
      badge(b.unreal),
      b.note + (b.assetProps.length
        ? ` Asset slots: ${b.assetProps.map((p) => `${p.name} (${p.type})`).join(', ')}.`
        : ''),
    ]),
  ));
  out.push('');
}

out.push('## Operators');
out.push('');
out.push(table(
  ['Operator', 'id', 'Unity', 'Unreal', 'Notes'],
  mapping.operators.map((o) => [o.label, `\`${o.id}\``, badge(o.unity), badge(o.unreal), o.note]),
));
out.push('');

out.push('## Event triggers');
out.push('');
out.push('Each trigger declares the **payload** it carries, which is what lets a');
out.push('child system inherit the right attributes without special-casing.');
out.push('');
out.push(table(
  ['Trigger', 'id', 'Payload', 'Unity', 'Unreal', 'Notes'],
  mapping.events.map((e) => [
    e.label, `\`${e.id}\``, e.payload.join(', ') || '-', badge(e.unity), badge(e.unreal), e.note,
  ]),
));
out.push('');

out.push('## Property value modes');
out.push('');
out.push('Every block property supports these, so the answer is the same wherever');
out.push('the mode is offered.');
out.push('');
out.push(table(
  ['Mode', 'Unity', 'Unreal', 'Notes'],
  mapping.valueModes.map((m) => [m.label, badge(m.unity), badge(m.unreal), m.note]),
));
out.push('');

out.push('## Render modes');
out.push('');
out.push(table(
  ['Mode', 'Unity', 'Unreal', 'Notes'],
  mapping.renderModes.map((m) => [`\`${m.mode}\``, badge(m.unity), badge(m.unreal), m.note]),
));
out.push('');

fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${out.join('\n')}\n`, 'utf8');
process.stdout.write(`wrote ${path.relative(ROOT, OUT)}\n`);
