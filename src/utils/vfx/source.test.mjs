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

console.log('\n--- Asset wiring ---');
{
  const page = await readFile(
    new URL('../../pages/VfxEditorPage.jsx', import.meta.url), 'utf8');

  // ASSETS MUST LOAD WHEN THE LIBRARY ARRIVES, NOT ONLY WHEN THE DOCUMENT DOES.
  //
  // THE BUG: opening a SAVED effect drew it with no textures and no emitter
  // mesh until the author touched any property. The two loader effects in
  // useVfxRuntime were keyed on the graph hash alone, while `resolveUrl` is
  // built from the asset library the page fetches asynchronously - so the
  // document usually won the race, every asset resolved to null, the
  // `size === 0` early return fired, and nothing re-ran when the library
  // landed. Touching a property recompiled the graph, changed the hash and ran
  // the loaders again - by which time the library was there. That is why it
  // looked like the mesh needed "a property change to apply".
  //
  // Checked in the source because the failure is a RACE: both orderings are
  // valid React, only one of them is broken, and which one you get depends on
  // how fast the library endpoint answers.
  const runtimeHook = await readFile(
    new URL('../../hooks/useVfxRuntime.js', import.meta.url), 'utf8');
  const depsOf = (loader) => {
    const at = runtimeHook.indexOf(loader);
    if (at < 0) return null;
    // The dependency array closing this effect: the first `}, [ ... ])` after
    // the loader call.
    const match = /\}, \[([^\]]*)\]\)/.exec(runtimeHook.slice(at));
    return match ? match[1].split(',').map((d) => d.trim()).filter(Boolean) : null;
  };
  for (const loader of ['loadVfxTextures(ir', 'loadVfxMeshes(ir']) {
    const deps = depsOf(loader);
    check(`${loader.replace('(ir', '')} re-runs when the resolver arrives`,
      Boolean(deps) && deps.includes('resolveUrl'),
      deps ? deps.join(', ') : 'effect not found');
  }
  // The mesh loader installs samplers INTO the runtime, so one handed to a
  // runtime that has since been replaced is a sampler nothing will read.
  check('  and the mesh loader also follows the runtime it fills',
    (depsOf('loadVfxMeshes(ir') || []).includes('runtime'),
    (depsOf('loadVfxMeshes(ir') || []).join(', '));
  // `ir` must stay OUT: it is a new object on every recompile, including ones
  // the hash deliberately ignores, so keying on it would reload every texture
  // when the author moved a node.
  check('  while `ir` stays out, so tidying the board reloads nothing',
    !(depsOf('loadVfxTextures(ir') || []).includes('ir'),
    (depsOf('loadVfxTextures(ir') || []).join(', '));

  // And the page hands over no resolver at all until the library has answered,
  // so the runtime waits rather than burning a pass on one that resolves
  // nothing. An empty array cannot express "not loaded yet".
  check('the page withholds the resolver until the library has answered',
    /libraryReady \? makeAssetResolver/.test(page));
  check('  including when the fetch errors, or it would wait for ever',
    /\.finally\(\(\) => \{[\s\S]{0,400}?setLibraryReady\(true\)/.test(page));

  // EDITS AND VERSIONS ARE SELECTABLE. AssetSelectorModal hides them unless
  // asked, so the sprite picker offered only ROOT images - and a sprite is very
  // often an edit rather than the original: the generated image cropped, its
  // background removed, its channels adjusted.
  check('the asset picker offers edits and versions',
    /<AssetSelectorModal[\s\S]*?showEdits[\s\S]*?\/>/.test(page));

  // ONE RESOLVER SERVES TEXTURES AND MESHES. useVfxRuntime hands the same
  // function to loadVfxTextures and loadVfxMeshes, so a resolver built from the
  // image listing alone made every mesh asset unresolvable - loadVfxMeshes put
  // it straight into `failed` and the mesh renderer had nothing to draw, with
  // no error reported anywhere.
  check('the asset resolver is built from images AND meshes',
    /makeAssetResolver\(\[\.\.\.libraryImages, \.\.\.libraryMeshes\]\)/.test(page));
  const runtime = await readFile(
    new URL('../../hooks/useVfxRuntime.js', import.meta.url), 'utf8');
  check('  and it really is the one both loaders get',
    /loadVfxTextures\(ir, \{ resolveUrl \}\)/.test(runtime)
    && /loadVfxMeshes\(ir, \{ resolveUrl \}\)/.test(runtime));

  // The writer and the resolver must derive an id the SAME way, or a picked
  // asset is stored under an id nothing can look up again. A root's listing id
  // is `library:<n>` and an edit's is a bare number.
  check('the picked id comes from vfxAssetId, not hand-parsed',
    /const numericId = vfxAssetId\(asset\)/.test(page)
    && !/String\(asset\.id\)\.replace\('library:'/.test(page));
  check('  and the label map is indexed the same way',
    /indexLibraryAssets\(\[\.\.\.libraryImages, \.\.\.libraryMeshes\]\)/.test(page));
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

console.log('\n--- A newly created asset reaches the effect ---');
{
  // THE BUG: generating a sprite uploaded it, wired it into the Output, and
  // changed nothing on screen. The asset LISTING is fetched when the page
  // opens, so an asset created DURING the session is not in it - `resolveUrl`
  // answered null, loadVfxTextures found nothing, and the batch fell back to
  // the built-in sprite. Silently, because that fallback is the correct
  // behaviour for a texture that genuinely is not there.
  //
  // Fixed by reacting to the DOCUMENT rather than to the generate button, so
  // every route that can introduce a new reference is covered by one mechanism:
  // the sprite panel, the asset picker, a template, an effect an agent saved in
  // another window.
  const pageSource = await readFile(
    new URL('../../pages/VfxEditorPage.jsx', import.meta.url), 'utf8');

  check('the page can reload the asset library',
    /const reloadLibrary = useCallback/.test(pageSource));
  check('  and notices ids the listing has never heard of',
    /const missingAssetKey = useMemo/.test(pageSource)
    && /!known\.has\(Number\(match\[1\]\)\)/.test(pageSource));
  // KEYED ON THE MISSING SET, not on the document: a genuinely deleted asset
  // stays missing after the reload, so an unchanged key means the effect does
  // not run again. Keying on `doc` would reload on every keystroke for ever.
  check('  reloading once per new unknown id, not once per render',
    /\}, \[libraryReady, missingAssetKey, reloadLibrary\]\)/.test(pageSource));

  // A LOAD FAILURE IS NOT A COMPILE DIAGNOSTIC. The compiler is pure and knows
  // nothing about whether the bytes arrived, so the only place this can be
  // reported is the page - and both loaders had always returned a `failed` list
  // that nothing read.
  const hook = await readFile(
    new URL('../../hooks/useVfxRuntime.js', import.meta.url), 'utf8');
  check('the runtime hook reports which assets failed to load',
    /failedAssets/.test(hook) && /return \{ runtime, batches, textures, meshes, failedAssets \}/.test(hook));
  check('  from both loaders, not just one',
    (hook.match(/setFailed\('(texture|mesh)', result\.failed\)/g) || []).length === 2,
    String((hook.match(/setFailed\('(texture|mesh)', result\.failed\)/g) || []).length));
  check('  and the page shows them', /failedAssets\.length > 0 && \(/.test(pageSource));
  check('    naming the asset rather than an id the author never sees',
    /assetLabelFor\(doc, entry\.assetId\)/.test(pageSource));
}

console.log('\n--- The sprite panel workflow filter ---');
{
  // A WORKFLOW PARAMETER CARRIES `type` AND `valueType`; AN OUTPUT CARRIES ONLY
  // `valueType`.
  //
  // THE BUG: the panel filtered on `output.type === 'image'`, which is a field
  // outputs do not have. It matched nothing, the dropdown read "No image
  // workflows in the library", and the library held six perfectly good
  // text-to-image workflows. Guessing a field name is what caused it, so the
  // fix is one reader that accepts either spelling - and this checks the panel
  // uses that reader everywhere rather than reintroducing a bare `.type`.
  const panel = await readFile(
    new URL('../../components/vfx/VfxSpritePanel.jsx', import.meta.url), 'utf8');
  const code = panel
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  check('the panel reads a type through one helper',
    /const typeOf = \(entry\) => entry\?\.valueType \|\| entry\?\.type/.test(code));
  // No bare `.type ===` comparisons left anywhere, which is the shape that
  // failed. `typeOf(...) === 'string'` is fine; `p.type === 'string'` is not.
  const bare = [...code.matchAll(/\w+\.type\s*===/g)].map((m) => m[0]);
  check('  and nowhere compares a bare .type', bare.length === 0, bare.join(' '));
  check('  including the prompt parameter lookup',
    /find\(p => typeOf\(p\) === 'string'\)/.test(code));
  check('  and the output check', /typeOf\(output\) === 'image'/.test(code));

  // An empty dropdown has to say WHICH empty it is. "No image workflows"
  // reads as "your library has none" when the truth was "the filter is broken",
  // and that ambiguity is what made the bug hard to report.

  // EVERY PARAMETER IS AUTHORABLE, not just the prompt. A sprite workflow has a
  // seed, a step count, a sampler and a resolution like any other, and offering
  // only a prompt box meant every sprite came out of the same dice roll with no
  // way to change it. The field is the one the image editor, graph and kanban
  // panels use, so enum parameters arrive as dropdowns and there is no fourth
  // implementation of "render a ComfyUI parameter" to keep in step.
  check('the panel renders parameters with the shared field',
    /import WorkflowParameterField from '\.\.\/imageEditor\/controls\/WorkflowParameterField'/
      .test(code)
    && /<WorkflowParameterField/.test(code));
  check('  over the selected workflow’s whole parameter list',
    /\(workflow\.parameters \|\| \[\]\)[\s\S]{0,400}\.map\(parameter =>/.test(code));

  // AND THE RUN SENDS THEM. Rendering a seed field that the run then ignores is
  // worse than not offering one, because the author watches the value change
  // and the image not change. An untouched field resolves to the workflow's own
  // saved default rather than to '' - an empty seed or step count is a failed
  // run or a noise image, which is the trap ImageEditorPage already documents.
  check('the run sends every parameter, not just the prompt',
    /for \(const parameter of workflow\.parameters \|\| \[\]\)/.test(code)
    && /inputs\[parameter\.id\] = values\[parameter\.id\] \?\? parameter\.defaultValue \?\? ''/
      .test(code));
  check('  while still appending the black background to the prompt',
    /inputs\[promptParam\.id\] = `\$\{prompt\.trim\(\)\}, \$\{BLACK_BACKGROUND\}`/.test(code));

  // Parameter ids are `<nodeId>.<inputKey>`, so "6.text" appears in most of
  // these workflows meaning something different in each. Values must not carry
  // across a change of workflow or one workflow's step count silently lands on
  // another's sampler.
  check('  and switching workflow drops the previous values',
    /const selectWorkflow = \(id\) => \{[\s\S]{0,120}setValues\(\{\}\)/.test(code));

  // SORTED BY NAME. The library returns them in insertion order, which tells
  // the author nothing when the dropdown holds a dozen entries.
  check('the workflow list is sorted by name',
    /usable\.sort\(\(a, b\) => String\(a\.name \|\| ''\)\.localeCompare\(String\(b\.name \|\| ''\)\)\)/
      .test(code));

  check('an empty dropdown distinguishes an empty library from no match',
    /No ComfyUI workflows in the library/.test(panel)
    && /None of \$\{considered\} workflows is text-to-image/.test(panel));
}

console.log('\n--- The shortcuts sheet ---');
{
  // A SHEET THAT DOCUMENTS A KEY THE APP DOES NOT HANDLE IS WORSE THAN NO
  // SHEET: the reader tries it, nothing happens, and they stop trusting the
  // rest of the list. `Alt + arrow` was in the plan and had never been built -
  // writing this file is what surfaced that, and it is now implemented rather
  // than merely documented.
  const sheet = await readFile(
    new URL('../../components/vfx/VfxShortcuts.jsx', import.meta.url), 'utf8');
  const page = await readFile(
    new URL('../../pages/VfxEditorPage.jsx', import.meta.url), 'utf8');
  const row = await readFile(
    new URL('../../components/vfx/VfxBlockRow.jsx', import.meta.url), 'utf8');

  const claims = (key) => sheet.includes(key);
  check('the sheet claims the keys it should', ['Space', 'Ctrl / Cmd + Z', 'Escape', 'Alt']
    .every(claims));

  // Each claim, against the handler that has to honour it.
  check('  Space is handled', /event\.code === 'Space'/.test(page));
  check('  undo and redo are handled',
    /toLowerCase\(\) === 'z'/.test(page) && /toLowerCase\(\) === 'y'/.test(page));
  check('  Escape is handled', /event\.key === 'Escape'/.test(page));
  // The one the sheet found missing.
  check('  Alt + arrow really reorders a block',
    /event\.altKey/.test(row) && /actions\.moveBlock\(block\.id, index \+ delta\)/.test(row));
  check('  and the sheet itself opens on ?', /event\.key === '\?'/.test(page));
}

console.log('\n--- Mute and solo ---');
{
  // THEY ARE PREVIEW STATE, NOT DOCUMENT STATE, and everything that renders
  // them has to agree about that.
  //
  // THE BUG: clicking Mute or Solo did nothing visible. The action writes into
  // the page's `preview` map on purpose - mute and solo must NEVER reach the
  // document, because the compiler drops a disabled system from the IR, so
  // writing them would restart the whole effect, which is the opposite of what
  // muting one system is for. But the timeline rendered from `system.enabled`
  // and `system.solo`, document fields nothing ever writes. The runtime was
  // being muted correctly the whole time; the icons just never moved.
  const timeline = await readFile(
    new URL('../../components/vfx/VfxTimeline.jsx', import.meta.url), 'utf8');
  const code = timeline
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1');

  check('the timeline reads mute and solo from the preview map',
    /const stateOf = system => preview\[system\.id\]/.test(code));
  for (const field of ['system.enabled', 'system.solo']) {
    check(`  and never from ${field}`, !code.includes(field), field);
  }
  const pageSource = await readFile(
    new URL('../../pages/VfxEditorPage.jsx', import.meta.url), 'utf8');
  check('  and the page actually hands it over',
    /<VfxTimeline[\s\S]*?preview=\{preview\}/.test(pageSource));

  // A muted emitter must stop DRAWING, not only spawning. Stopping spawns alone
  // means a four-second lifetime takes four seconds to look muted, which is
  // indistinguishable from a broken button.
  const batchSource = await readFile(new URL('./batch.js', import.meta.url), 'utf8');
  check('a muted emitter is skipped by the write loop',
    /for \(const emitter of sources\) \{[\s\S]{0,900}?if \(emitter\.muted\) continue;/.test(batchSource));
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

  // THE FLOW SOCKETS ARE ON THE SIDE EDGES, NOT THE TOP AND BOTTOM.
  //
  // A context node grows DOWNWARD as blocks are added. With the sockets on the
  // top and bottom the chain ran along that same axis, so every block added to
  // a stage pushed the next stage further away and the board had to be
  // re-tidied to stay readable. Sideways, the two axes are perpendicular.
  //
  // Checked in the source because the failure is a rendered layout: the
  // positions are two identifiers in a component and nothing else would notice
  // them being changed back.
  const contextNode = await readFile(
    new URL('../../components/vfx/VfxContextNode.jsx', import.meta.url), 'utf8');
  const flowHandles = [...contextNode.matchAll(
    /position=\{Position\.(\w+)\}[\s\S]{0,120}?id="(flow-in|flow-out)"/g)];
  check('both flow sockets were found', flowHandles.length === 2,
    flowHandles.map((m) => `${m[2]}:${m[1]}`).join(' '));
  check('  flow-in is on the left and flow-out on the right',
    flowHandles.some((m) => m[2] === 'flow-in' && m[1] === 'Left')
    && flowHandles.some((m) => m[2] === 'flow-out' && m[1] === 'Right'),
    flowHandles.map((m) => `${m[2]}:${m[1]}`).join(' '));

  // And they are pinned to the header. React Flow centres a left/right handle
  // at 50% of the node's height, which on a six-block stage lands exactly on a
  // block row's own property socket - those are on the left edge too.
  const nodeCss = await readFile(
    new URL('../../components/vfx/VfxContextNode.css', import.meta.url), 'utf8');
  check('  and pinned to the header rather than centred on the node',
    /\.vfx-node__flow\.react-flow__handle \{[^}]*top: \d+px;/.test(nodeCss));

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

// ---------------------------------------------------------------------------
console.log('\n--- Shader uniforms are declared in the stage that reads them ---');
// ---------------------------------------------------------------------------
//
// A UNIFORM READ IN A STAGE THAT DOES NOT DECLARE IT IS A COMPILE ERROR, and it
// takes the WHOLE EFFECT down: the program never links, so nothing draws at all
// - not the textured particles, not the untextured ones. The browser reports
// only "Fragment shader is not compiled" and the viewport is empty.
//
// THE BUG: `uBlackPoint` was declared beside `uTiles`, which lives in the
// VERTEX shader because the flipbook cell maths runs there. It is read in the
// FRAGMENT shader.
//
// The test written for that property asserted the shader TEXT contained the
// line, and that the line came before the colour multiply. Both were true the
// whole time the shader was broken. Presence is not scope, so check scope.
{
  const stageOf = (name) => {
    const opener = `const ${name} = /* glsl */${BACKTICK}`;
    const at = materials.indexOf(opener);
    if (at < 0) return null;
    const start = at + opener.length;
    const end = materials.indexOf(`${BACKTICK};`, start);
    return materials.slice(start, end < 0 ? materials.length : end);
  };

  // The vertex program is the head and the body concatenated - see
  // buildVertexShader - so a uniform declared in either is in scope for both.
  const vertexHead = stageOf('VERTEX_HEAD');
  const vertexBody = stageOf('VERTEX_BODY');
  const fragment = stageOf('FRAGMENT');
  check('both shader stages were found',
    Boolean(vertexHead && vertexBody && fragment));
  const vertex = `${vertexHead || ''}\n${vertexBody || ''}`;

  // Comments come out first: these shaders explain their own uniforms by name
  // in prose, and a mention is not a use.
  const stripComments = (src) => src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ');

  const DECLARATION = /uniform\s+\w+\s+(u\w+)\s*;/g;

  const undeclared = (rawSource, label) => {
    const source = stripComments(rawSource);
    const declared = new Set([...source.matchAll(DECLARATION)].map((m) => m[1]));
    // Every `uSomething` the stage still mentions once its own declarations are
    // removed. Our uniforms are all named uXxx; three's injected ones are not.
    const used = new Set(
      [...source.replace(DECLARATION, ' ').matchAll(/\bu[A-Z]\w*/g)].map((m) => m[0]),
    );
    return [...used].filter((name) => !declared.has(name)).map((name) => `${label}:${name}`);
  };

  const missing = [...undeclared(vertex, 'vertex'), ...undeclared(fragment, 'fragment')];
  check('every uniform is declared in the stage that reads it',
    missing.length === 0, missing.join(' '));

  // And the guard is not vacuous - it has to be finding real uniforms, and in
  // particular the one that taught it the lesson.
  const fragmentUniforms = [...stripComments(fragment || '').matchAll(DECLARATION)]
    .map((m) => m[1]);
  check('  the fragment stage really declares several',
    fragmentUniforms.length >= 4, fragmentUniforms.join(' '));
  check('  including the one this guard was written for',
    fragmentUniforms.includes('uBlackPoint'), fragmentUniforms.join(' '));
}

// ---------------------------------------------------------------------------
console.log('\n--- The preview canvas is opaque ---');
// ---------------------------------------------------------------------------
//
// ADDITIVE PARTICLES REQUIRE AN OPAQUE RENDER TARGET. A transparent canvas is
// composited as PREMULTIPLIED alpha - a colour channel may not exceed the alpha
// it is premultiplied by, and browsers clamp when it does - and no pair of
// blend factors survives that:
//
//   alpha written by the preset (SrcAlpha, One)  ->  a sprite with no alpha
//     channel drives the canvas alpha to 1 across the whole quad while adding
//     no colour, so its black background becomes an opaque BLACK BOX that hides
//     the page backdrop.
//   alpha left alone (Zero, One)                 ->  alpha stays 0, the
//     compositor clamps the glow to it, and particles appear ONLY where
//     something else already wrote alpha. With the grid on, the effect drew as
//     a crosshatch; with the grid off, nothing at all.
//
// Both were observed on one effect, hours apart, and each looked like a
// different bug. The fix is the destination, so that is what is checked here.
// This cannot be caught from the material: `createParticleMaterial` is correct
// in both cases.
{
  const viewport = await readFile(
    new URL('../../components/vfx/VfxViewport.jsx', import.meta.url), 'utf8');

  check('the preview canvas asks for an opaque context',
    /gl=\{\{[^}]*alpha:\s*false/.test(viewport));

  // And having taken the page's CSS backdrop out of the picture, the scene has
  // to paint one - or the viewport is plain black and the grid floats in a void
  // that looks like a failed render.
  check('  and the scene paints the ground the CSS used to',
    /scene\.background\s*=\s*new THREE\.Color\(/.test(viewport));

  // The thumbnail path renders offscreen with its own scene and never had this
  // problem, which is why saved cards looked right while the live preview did
  // not. Keep it that way: it is the same requirement, met independently.
  const thumb = await readFile(new URL('../vfxThumbnail.js', import.meta.url), 'utf8');
  check('  and the thumbnail renderer is opaque too',
    /scene\.background\s*=\s*new THREE\.Color\(/.test(thumb));
}

console.log(`\n${failures ? `${failures} failure(s)` : 'all checks passed'}`);
process.exit(failures ? 1 : 0);
