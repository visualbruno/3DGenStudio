// Textual invariants of the VFX source, checked by READING it rather than by
// importing it.
//
//     node src/utils/vfx/source.test.mjs
//
// WHY THIS FILE IMPORTS NOTHING IT CHECKS. Everything here is a PARSE-time
// failure, and a test that imports the broken module throws on its own import -
// before any check inside it can run. The first version of the backtick guard
// lived in render.test.mjs, which imports materials.js for a dozen other
// reasons, so reintroducing the bug produced a stack trace from the module
// loader and the guard never executed. Verified by putting the bug back and
// watching it not fire.
//
// So: read the bytes, assert on the text, import nothing.

import { readFile } from 'node:fs/promises';

let failures = 0;

function check(label, ok, detail = '') {
  if (!ok) failures += 1;
  console.log(`${label.padEnd(58)} ${ok ? 'ok  ' : '*** FAIL ***'} ${detail}`);
}

// The character this file is about, named rather than written, so the checks
// are not themselves a way to break the file that holds them.
const BACKTICK = String.fromCharCode(96);

const materials = await readFile(new URL('./materials.js', import.meta.url), 'utf8');

console.log('\n--- Shader template literals ---');
{
  // A BACKTICK INSIDE A GLSL COMMENT TERMINATES THE TEMPLATE LITERAL.
  //
  // The shaders are JS template literals, so naming a variable in prose the
  // natural way - with backticks around it - turns the rest of the shader into
  // JavaScript and the module stops parsing. It has happened TWICE, both times
  // while adding a render mode, and both times the symptom was a SyntaxError
  // pointing at an English word in a comment.
  const offenders = [];
  for (const name of ['VERTEX_HEAD', 'VERTEX_BODY', 'FRAGMENT']) {
    const opener = `const ${name} = /* glsl */${BACKTICK}`;
    const at = materials.indexOf(opener);
    if (at < 0) {
      offenders.push(`${name}: not found - renamed?`);
      continue;
    }
    const start = at + opener.length;
    // The statement ends at the first backtick-semicolon pair. Anything between
    // the opening backtick and that point which is itself a backtick has closed
    // the literal early.
    const end = materials.indexOf(`${BACKTICK};`, start);
    const body = materials.slice(start, end < 0 ? materials.length : end);
    if (body.includes(BACKTICK)) {
      const line = materials.slice(0, start + body.indexOf(BACKTICK)).split('\n').length;
      offenders.push(`${name}: backtick on line ${line}`);
    }
  }
  check('no backtick appears inside a shader template literal',
    offenders.length === 0, offenders.join('; '));

  // And the literals are all still there, so a rename cannot make the check
  // above pass by finding nothing to look at.
  check('  and all three shader literals were found',
    !offenders.some((entry) => entry.includes('renamed')));
}

console.log('\n--- Render modes ---');
{
  // Every mode the catalog offers must either have a shader path or be
  // explicitly reported. A mode that silently falls through to billboard is the
  // bug I_TRAIL_UNSUPPORTED exists for - `point` was in the dropdown for four
  // phases and did nothing at all.
  //
  // Read textually, for the same reason as above: this file must stay usable
  // when materials.js does not parse.
  const catalog = await readFile(new URL('../../../vfx/catalog.js', import.meta.url), 'utf8');
  const offered = /options: \[('billboard'[^\]]*)\]/.exec(catalog);
  check('the output mode list was found', Boolean(offered));
  if (offered) {
    const modes = offered[1].split(',').map((entry) => entry.trim().replace(/'/g, ''));
    const defines = new Set(
      [...materials.matchAll(/defines\.MODE_([A-Z]+)/g)].map((m) => m[1].toLowerCase()),
    );
    // Billboard is the else-branch and has no define, by design.
    defines.add('billboard');
    // Reported rather than implemented - the diagnostic has to exist.
    const diagnostics = await readFile(new URL('../../../vfx/diagnostics.js', import.meta.url), 'utf8');
    const reported = new Set();
    if (diagnostics.includes('I_TRAIL_UNSUPPORTED')) reported.add('trail');

    const silent = modes.filter((mode) => !defines.has(mode) && !reported.has(mode));
    check('every offered render mode is implemented or reported',
      silent.length === 0,
      silent.length
        ? `${silent.join(', ')} silently fall back to billboard`
        : `${modes.join(', ')} (${reported.size} reported)`);
  }
}

console.log('\n--- Drag surfaces ---');
{
  // THE RULE: AN IMPERATIVE DRAG PREVIEW NEVER WRITES A PROPERTY REACT WRITES.
  //
  // THE BUG THIS EXISTS FOR. A timeline clip dragged sideways collapsed, on
  // release, to a ~24px stub - two 8px handles, a 6px minimum body and a
  // hairline, i.e. an element with no width at all. The drag previewed itself
  // with `element.style.left/width` and then cleared both to '' at pointer-up
  // "so React's render owns the geometry again". React does not work that way:
  // it diffs the style props it rendered LAST against the ones it is rendering
  // NOW, never against the DOM. After a move (which changes `at` and not
  // `duration`) the width string was identical, React skipped it, and the '' we
  // had just written survived - until some unrelated render happened to change
  // the width string, which is why it sometimes appeared to heal itself a
  // second later. Two earlier fixes to the drag ARITHMETIC did nothing, because
  // the arithmetic was never wrong.
  //
  // The fix is structural: React sets --vfx-clip-at / --vfx-clip-w from the
  // document, the drag adds --vfx-clip-dx / --vfx-clip-dw, and the stylesheet
  // composes them with calc(). Clearing a property React has never written
  // cannot be skipped by a diff, because there is no diff.
  //
  // Checked textually because the failure is a rendered pixel, which no
  // headless test can see - but the line of code that causes it is right here
  // in the text, and it is the kind of line someone reaches for again.
  const files = [
    'components/vfx/VfxTimeline.jsx',
    'components/vfx/VfxSplitter.jsx',
    'components/vfx/VfxCurveEditor.jsx',
    'components/vfx/VfxGradientEditor.jsx',
    'hooks/useVfxBlockDrag.js',
  ];
  const offenders = [];
  for (const file of files) {
    const text = await readFile(new URL(`../../${file}`, import.meta.url), 'utf8');
    // Comments are stripped first, or this very explanation would fail the
    // check it is explaining.
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1');
    for (const match of code.matchAll(/\.style\.(left|top|width|height)\s*=/g)) {
      // A canvas is the one exemption, and a permanent one: its CSS size has to
      // be written next to its backing-store size for DPR scaling, and React
      // renders neither - so there is no second writer to disagree with.
      const before = code.slice(Math.max(0, match.index - 12), match.index);
      if (/canvas$/.test(before)) continue;
      const line = code.slice(0, match.index).split('\n').length;
      offenders.push(`${file}:${line} writes style.${match[1]}`);
    }
  }
  check('no drag writes a geometry property React also renders',
    offenders.length === 0, offenders.join('; '));

  // And the composition the timeline replaced it with is actually in place, so
  // the check above cannot pass by the drag preview having been deleted.
  const timeline = await readFile(
    new URL('../../components/vfx/VfxTimeline.jsx', import.meta.url), 'utf8');
  const css = await readFile(
    new URL('../../components/vfx/VfxTimeline.css', import.meta.url), 'utf8');
  check('  the clip drag offsets a custom property instead',
    timeline.includes("setProperty('--vfx-clip-dx'")
    && timeline.includes("setProperty('--vfx-clip-dw'"));
  check('  and drops it with removeProperty, not by clearing left/width',
    timeline.includes("removeProperty('--vfx-clip-dx'")
    && timeline.includes("removeProperty('--vfx-clip-dw'"));
  check('  React writes only --vfx-clip-at and --vfx-clip-w',
    timeline.includes("'--vfx-clip-at'") && timeline.includes("'--vfx-clip-w'"));
  check('  and the stylesheet composes the two with calc()',
    /left:\s*calc\(var\(--vfx-clip-at[^)]*\)\s*\+\s*var\(--vfx-clip-dx\)\)/.test(css)
    && /width:\s*calc\(var\(--vfx-clip-w[^)]*\)\s*\+\s*var\(--vfx-clip-dw\)\)/.test(css));
  // Registered, so an unset delta is a real 0px rather than an unresolved var()
  // that would invalidate the whole declaration.
  check('  the deltas are registered as lengths with a 0px initial value',
    /@property --vfx-clip-dx \{[^}]*syntax: '<length>'[^}]*initial-value: 0px;/.test(css)
    && /@property --vfx-clip-dw \{[^}]*syntax: '<length>'[^}]*initial-value: 0px;/.test(css));
}

console.log('\n--- React Flow board ---');
{
  const board = await readFile(
    new URL('../../components/vfx/VfxBoard.jsx', import.meta.url), 'utf8');

  // A CONTROLLED `nodes` PROP NEEDS onNodesChange OR NOTHING MOVES.
  //
  // React Flow applies a node change itself only when it owns the array
  // (`defaultNodes`). With a controlled `nodes` prop, `triggerNodeChanges`
  // calls onNodesChange and applies nothing - so with no handler at all, every
  // position change a drag produced went into the void and a dragged node did
  // not follow the cursor: it stayed put until pointer-up committed the edit
  // and then jumped. The comment on <ReactFlow> asserted the opposite for two
  // phases; it was a guess.
  check('the board handles onNodesChange', /onNodesChange=\{/.test(board));
  check('  and only applies position changes from it',
    /change\.type !== 'position'/.test(board));

  // TIDY MUST MEASURE THE NODES REACT FLOW MEASURED, NOT THE ONES WE BUILT.
  //
  // `measured` is written into React Flow's internal nodeLookup
  // (updateNodeInternals sets it on the INTERNAL node), never onto the user
  // node. Tidy used to read `node.measured` off the array toFlowNodes builds,
  // where that field has never existed - so every node measured zero,
  // autoLayout fell back to a uniform 160px row for all of them, and a stage
  // with eight blocks overlapped the one below it. Which is the bug Tidy exists
  // to fix, reported as Tidy causing it.
  check('Tidy measures through getInternalNode',
    /getInternalNode\(id\)\?\.measured/.test(board));
  check('  and never reads measured off the derived nodes array',
    !/nodes\.map\(node => \[node\.id, node\]\)/.test(board));

  // A DRAG MOVES ONLY WHAT YOU GRABBED. React Flow drags the pointed node
  // together with anything `selected` (getDragItems in @xyflow/system), which
  // is right where selection is a deliberate multi-select and wrong here, where
  // `selected` means "the node open in the Parameters panel" - clicking
  // Initialize to edit it and then dragging Update would move Initialize too.
  // Only reachable at all now that a drag moves anything on screen.
  check('a drag previews only the node it started on',
    /onNodeDragStart=\{/.test(board)
    && /dragOrigin\.current = node\.id/.test(board)
    && /change\.id !== dragOrigin\.current/.test(board));
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
