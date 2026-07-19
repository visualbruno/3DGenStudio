import { z } from 'zod';
import { toolHandler, createProgressReporter } from '../client.js';
import { attachResultsToNode, resolveNodeTarget } from '../nodeResults.js';

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// Map the submit response of POST /api/meshes/generate to the matching
// provider poll endpoint and its request body.
function buildMeshPollRequest(submit, base) {
  const provider = String(submit?.provider || '').toLowerCase();
  if (provider.includes('tencent')) {
    return {
      path: '/meshes/generate/tencent/result',
      body: { ...base, jobId: submit.jobId, region: submit.region }
    };
  }
  if (provider.includes('tripo')) {
    return { path: '/meshes/generate/tripo/result', body: { ...base, taskId: submit.taskId } };
  }
  if (provider.includes('hitem')) {
    return { path: '/meshes/generate/hitem/result', body: { ...base, taskId: submit.taskId, jobId: submit.jobId } };
  }
  return null;
}

// Fixed mesh-generation provider ids the backend dispatches on
// (see src/utils/kanbanHelpers.js). Each typed tool below hardwires one, so a
// client only supplies parameters — no need to know the id.
const TENCENT_MESH_API_ID = 'tencent_meshgeneration';
const TRIPO_MESH_API_ID = 'tripo_meshgeneration';
const HITEM_MESH_API_ID = 'hitem_meshgeneration';

// Typed provider option shapes. These mirror the request-body keys and defaults
// that server.js reads for each provider (normalize{Tencent,Tripo,Hitem}
// MeshGenerationInput) 1:1, so a client sees every knob with its enum/range and
// default instead of an opaque options blob. Keep in sync with server.js and
// src/utils/kanbanHelpers.js.
const TENCENT_MESH_OPTIONS = {
  region: z.enum(['ap-singapore', 'eu-frankfurt', 'na-siliconvalley']).describe('Tencent Cloud region — REQUIRED (no default).'),
  modelVersion: z.enum(['3.0', '3.1']).default('3.0').describe('Hunyuan3D model version. LowPoly generation requires 3.0.'),
  generationType: z.enum(['Normal', 'LowPoly', 'Geometry']).default('Normal').describe('Generation mode. LowPoly requires modelVersion 3.0.'),
  polygonType: z.enum(['triangle', 'quadrilaterial']).default('triangle').describe('Polygon type — only applied when generationType is LowPoly.'),
  faceCount: z.number().int().min(3000).max(1500000).default(500000).describe('Target face count (3000–1,500,000).'),
  enablePBR: z.boolean().default(false).describe('Generate a PBR-ready mesh.')
};

const TRIPO_MESH_OPTIONS = {
  modelVersion: z.enum(['v2.0-20240919', 'v2.5-20250123', 'v3.0-20250812', 'v3.1-20260211', 'Turbo-v1.0-20250506', 'P1-20260311']).default('v2.5-20250123').describe('Tripo model version. The P1 model ignores enableImageAutofix/textureAlignment/orientation/quad/smartLowPoly/generateParts/geometryQuality.'),
  modelSeed: z.number().int().optional().describe('Geometry RNG seed (optional; omit for random).'),
  enableImageAutofix: z.boolean().default(false).describe('Fix the input image before generation (ignored by P1).'),
  faceLimit: z.number().int().min(1000).optional().describe('Max face count (>=1000; optional).'),
  texture: z.boolean().default(true).describe('Generate texture maps. Incompatible with generateParts=true.'),
  pbr: z.boolean().default(true).describe('Export a PBR model. Incompatible with generateParts=true.'),
  textureSeed: z.number().int().optional().describe('Texture RNG seed (optional).'),
  textureAlignment: z.enum(['original_image', 'geometry']).default('original_image').describe('Texture alignment (ignored by P1).'),
  textureQuality: z.enum(['standard', 'detailed']).default('standard').describe('Texture quality.'),
  autoSize: z.boolean().default(false).describe('Auto-fit scale to real-world size.'),
  orientation: z.enum(['default', 'align_image']).default('default').describe('Output orientation (ignored by P1).'),
  quad: z.boolean().default(false).describe('Generate a quad mesh (ignored by P1). Incompatible with generateParts=true.'),
  smartLowPoly: z.boolean().default(false).describe('Optimize for low poly (ignored by P1).'),
  generateParts: z.boolean().default(false).describe('Split into semantic parts (ignored by P1). Incompatible with texture/pbr/quad=true.'),
  exportUv: z.boolean().default(true).describe('Include UVs in the output.'),
  geometryQuality: z.enum(['standard', 'detailed']).default('standard').describe('Geometry quality — only applied for v3.0/v3.1 models.')
};

const HITEM_MESH_OPTIONS = {
  hitemModel: z.enum(['hitem3dv1.5', 'hitem3dv2.0', 'hitem3dv2.1']).default('hitem3dv2.1').describe('Hitem3D model version.'),
  hitemResolution: z.enum(['512', '1024', '1536', '1536pro', '1536fast']).optional().describe('Resolution. Valid per model: v1.5/v2.0 = 512/1024/1536/1536pro; v2.1 = 1536fast/1536pro. Invalid/omitted falls back to the model default.'),
  hitemRequestType: z.union([z.literal(1), z.literal(3)]).default(3).describe('1 = mesh only, 3 = textured mesh.'),
  hitemFace: z.number().int().min(100000).max(2000000).default(300000).describe('Target face count (100,000–2,000,000).'),
  hitemPbr: z.boolean().default(false).describe('Generate a PBR-ready mesh.')
};

// Poll a provider's mesh-result endpoint until the job completes, errors, or the
// timeout elapses — streaming MCP progress and attaching results to a graph node
// on completion. The mesh is only persisted server-side once a poll sees the job
// complete, so this loop IS what finishes an async job. Returns the completed
// result, throws on provider error, or returns {status:'running'} on timeout.
async function pollMeshResult(api, notifyMutation, {
  pollRequest, providerLabel, projectId, nodeId, selectedApi, timeoutSeconds, pollIntervalSeconds, pollFirst = false
}, reportProgress) {
  const deadline = Date.now() + timeoutSeconds * 1000;
  let lastStatus = null;
  let first = true;
  while (Date.now() < deadline) {
    if (!(first && pollFirst)) await sleep(pollIntervalSeconds * 1000);
    first = false;
    lastStatus = await api.apiJson('POST', pollRequest.path, { body: pollRequest.body });

    if (lastStatus?.status === 'completed') {
      await reportProgress(100, 100, 'Mesh generation completed');
      let nodeAttachment = null;
      if (nodeId && Array.isArray(lastStatus.assets) && lastStatus.assets.length > 0) {
        nodeAttachment = await attachResultsToNode(api, {
          projectId,
          nodeId,
          assets: lastStatus.assets.map(asset => ({ ...asset, type: asset?.type || 'mesh' })),
          metadata: { lastAction: 'mesh-generation', selectedApi }
        });
      }
      notifyMutation(projectId);
      return nodeAttachment ? { ...lastStatus, nodeAttachment } : lastStatus;
    }
    if (lastStatus?.status === 'error') {
      throw new Error(lastStatus.error || 'Mesh generation failed');
    }
    const percent = Number(lastStatus?.progressPercent ?? lastStatus?.progress);
    await reportProgress(
      Number.isFinite(percent) ? percent : 50,
      100,
      `${providerLabel} status: ${lastStatus?.jobStatus || lastStatus?.taskStatus || lastStatus?.status || 'processing'}`
    );
  }
  return { status: 'running', lastStatus };
}

// Core submit-and-poll runner shared by generate_mesh and the typed
// generate_mesh_{tencent,tripo,hitem} tools: submit the provider job, poll to
// completion (streaming MCP progress), attach results to a graph node when
// asked, and return the saved assets (or job info on timeout).
async function runMeshGeneration(api, notifyMutation, args, extra) {
  const {
    projectId, selectedApi, name, prompt, imageSource, nodeId, cardId, parentAssetId,
    options = {}, timeoutSeconds = 1200, pollIntervalSeconds = 10
  } = args;
  const reportProgress = createProgressReporter(extra);

  // Route a graph-node target to the node; never send a node id as a kanban
  // cardId. targetNodeId gets the final mesh attached (via pollMeshResult).
  const { nodeId: targetNodeId, cardId: kanbanCardId } = await resolveNodeTarget(api, projectId, { nodeId, cardId });

  const submit = await api.apiJson('POST', '/meshes/generate', {
    body: {
      projectId, selectedApi, name,
      ...(prompt ? { prompt } : {}),
      ...(imageSource !== undefined ? { imageSource } : {}),
      ...(kanbanCardId !== undefined && kanbanCardId !== null ? { cardId: kanbanCardId } : {}),
      ...(parentAssetId !== undefined ? { parentAssetId } : {}),
      ...options
    }
  });
  notifyMutation(projectId);

  const pollRequest = buildMeshPollRequest(submit, {
    projectId,
    name,
    prompt: prompt || '',
    cardId: submit?.cardId ?? kanbanCardId ?? null,
    selectedApi,
    parentAssetId: parentAssetId ?? null
  });

  // Custom APIs respond synchronously — nothing to poll.
  if (!pollRequest) return submit;

  await reportProgress(0, 100, `${submit.provider} job submitted (${submit.jobId || submit.taskId})`);

  const outcome = await pollMeshResult(api, notifyMutation, {
    pollRequest,
    providerLabel: submit.provider,
    projectId,
    nodeId: targetNodeId,
    selectedApi,
    timeoutSeconds,
    pollIntervalSeconds
  }, reportProgress);

  if (outcome.status === 'running') {
    // Timed out with the job still on the provider. The mesh is NOT saved until a
    // result poll sees completion, so hand back the job ids for get_mesh_result.
    // Surface the resolved node target so a follow-up get_mesh_result can pass
    // nodeId and still land the mesh on the intended node.
    return {
      status: 'running',
      note: `Still processing after ${timeoutSeconds}s. The provider keeps working, but the mesh is only saved once a result poll sees it finish — call get_mesh_result with the ids below to retrieve it when ready${targetNodeId ? ' (pass nodeId to attach it to the graph node)' : ''}. Do NOT re-run generation (that starts a new job).`,
      provider: submit.provider,
      selectedApi,
      projectId,
      name,
      ...(targetNodeId ? { nodeId: targetNodeId } : {}),
      ...(submit.jobId ? { jobId: submit.jobId } : {}),
      ...(submit.taskId ? { taskId: submit.taskId } : {}),
      ...(submit.region ? { region: submit.region } : {}),
      ...(submit.cardId ? { cardId: submit.cardId } : {}),
      lastStatus: outcome.lastStatus
    };
  }
  return outcome;
}

export function registerActionTools(server, { api, notifyMutation }) {
  server.registerTool('generate_image', {
    title: 'Generate image',
    description: 'Generate an image with an external AI provider and save it as a project asset. selectedApi identifies the provider/model configured in Settings (e.g. Google/OpenAI image APIs or a custom_* API) — check get_settings for what is configured. In graph projects pass nodeId so the result is displayed on that node (cardId is for kanban cards; a graph node id passed as cardId is auto-routed to that node).',
    inputSchema: {
      projectId: z.number().int(),
      selectedApi: z.string().min(1).describe('Provider/model id from Settings (e.g. "google_gemini", "openai_gpt_image", or a custom_* id)'),
      prompt: z.string().min(1),
      name: z.string().min(1).describe('Name for the generated asset/card'),
      nodeId: z.number().int().optional().describe('Graph node to attach the result to'),
      cardId: z.union([z.number().int(), z.string()]).optional().describe('Existing kanban card to attach the result to')
    }
  }, toolHandler(async ({ projectId, nodeId, ...body }) => {
    // A graph node id may arrive as nodeId or (mistakenly) as cardId — route it
    // to the node and keep only a real kanban cardId in the request body.
    const { nodeId: targetNodeId, cardId: kanbanCardId } = await resolveNodeTarget(api, projectId, { nodeId, cardId: body.cardId });
    const result = await api.apiJson('POST', '/images/generate', { body: { projectId, ...body, cardId: kanbanCardId } });
    let nodeAttachment = null;
    if (targetNodeId) {
      nodeAttachment = await attachResultsToNode(api, {
        projectId,
        nodeId: targetNodeId,
        assets: [{ ...result, type: result?.type || 'image' }],
        metadata: { lastAction: 'image-api' }
      });
    }
    notifyMutation(projectId);
    return nodeAttachment ? { ...result, nodeAttachment } : result;
  }));

  server.registerTool('edit_image', {
    title: 'Edit image (AI)',
    description: 'Edit an existing project image with an external AI provider (prompt-based edit). The result is saved as an edit of the source asset. In graph projects pass nodeId so the result is displayed on that node (cardId is for kanban cards; a graph node id passed as cardId is auto-routed to that node). For ComfyUI-based edits use run_workflow instead.',
    inputSchema: {
      projectId: z.number().int(),
      selectedApi: z.string().min(1),
      prompt: z.string().min(1),
      name: z.string().min(1),
      imageSource: z.union([z.number().int(), z.string()]).describe('Source image: asset id or stored filePath'),
      nodeId: z.number().int().optional().describe('Graph node to attach the result to'),
      cardId: z.union([z.number().int(), z.string()]).optional()
    }
  }, toolHandler(async ({ projectId, nodeId, ...body }) => {
    const { nodeId: targetNodeId, cardId: kanbanCardId } = await resolveNodeTarget(api, projectId, { nodeId, cardId: body.cardId });
    const result = await api.apiJson('POST', '/image-edits/api', { body: { projectId, ...body, cardId: kanbanCardId } });
    let nodeAttachment = null;
    const savedEdits = Array.isArray(result?.savedEdits) ? result.savedEdits : [];
    if (targetNodeId && savedEdits.length > 0) {
      nodeAttachment = await attachResultsToNode(api, {
        projectId,
        nodeId: targetNodeId,
        assets: savedEdits.map(edit => ({ id: edit.id, name: edit.name || body.name, type: 'image' })),
        metadata: { lastAction: 'image-edit-api' }
      });
    }
    notifyMutation(projectId);
    return nodeAttachment ? { ...result, nodeAttachment } : result;
  }));

  server.registerTool('generate_mesh', {
    title: 'Generate 3D mesh',
    description: 'Generate a 3D mesh from an image and/or prompt using Tencent Hunyuan, Tripo AI, or Hitem3D (selectedApi from Settings). Submits the job and polls the provider until the mesh is ready (streams MCP progress), then returns the saved mesh assets. In graph projects pass nodeId so the mesh is displayed on that node (cardId is for kanban cards; a graph node id passed as cardId is auto-routed to that node). Takes minutes — on timeout returns the job info so it can be re-polled by calling this tool\'s sibling get-result flow or checking list_assets later.',
    inputSchema: {
      projectId: z.number().int(),
      selectedApi: z.string().min(1).describe('Mesh provider id from Settings (Tencent / Tripo / Hitem3D / custom_*)'),
      name: z.string().min(1),
      prompt: z.string().optional().describe('Text prompt (Tencent/Tripo support text-to-3D)'),
      imageSource: z.union([z.number().int(), z.string()]).optional().describe('Source image: asset id or stored filePath (required for Hitem3D)'),
      nodeId: z.number().int().optional().describe('Graph node to attach the generated mesh to (graph projects). The correct way to fill a node; a graph node id passed as cardId is auto-routed here.'),
      cardId: z.union([z.number().int(), z.string()]).optional(),
      parentAssetId: z.number().int().optional(),
      options: z.record(z.string(), z.any()).default({}).describe('Provider options, e.g. Tencent: region, modelVersion, enablePBR, faceCount, generationType, polygonType; Tripo: modelVersion, texture, pbr, quad, faceLimit, …. Prefer the dedicated generate_mesh_tencent / generate_mesh_tripo / generate_mesh_hitem tools, which document and validate every option.'),
      timeoutSeconds: z.number().int().min(30).max(3600).default(1200),
      pollIntervalSeconds: z.number().int().min(3).max(120).default(10)
    }
  }, toolHandler((args, extra) => runMeshGeneration(api, notifyMutation, args, extra)));

  server.registerTool('generate_mesh_tencent', {
    title: 'Generate 3D mesh (Tencent Hunyuan3D)',
    description: 'Generate a 3D mesh with Tencent Cloud Hunyuan3D and save it as a project asset. Provide EITHER prompt (text-to-3D) OR imageSource (image-to-3D), not both. Every Tencent parameter is exposed under `options` with its enum/range and default; region is required. Submits and polls until ready (streams progress), returning the saved mesh assets (or job info on timeout). Requires Tencent Cloud credentials configured in Settings.',
    inputSchema: {
      projectId: z.number().int(),
      name: z.string().min(1),
      prompt: z.string().optional().describe('Text prompt (text-to-3D). Provide this OR imageSource.'),
      imageSource: z.union([z.number().int(), z.string()]).optional().describe('Source image: asset id or stored filePath (image-to-3D). Provide this OR prompt.'),
      options: z.object(TENCENT_MESH_OPTIONS).describe('Tencent Hunyuan3D parameters (region is required).'),
      nodeId: z.number().int().optional().describe('Graph node to attach the generated mesh to (graph projects). The correct way to fill a node; a graph node id passed as cardId is auto-routed here.'),
      cardId: z.union([z.number().int(), z.string()]).optional(),
      parentAssetId: z.number().int().optional(),
      timeoutSeconds: z.number().int().min(30).max(3600).default(1200),
      pollIntervalSeconds: z.number().int().min(3).max(120).default(10)
    }
  }, toolHandler((args, extra) => runMeshGeneration(api, notifyMutation, { ...args, selectedApi: TENCENT_MESH_API_ID }, extra)));

  server.registerTool('generate_mesh_tripo', {
    title: 'Generate 3D mesh (Tripo AI)',
    description: 'Generate a 3D mesh with Tripo AI and save it as a project asset. Provide EITHER prompt (text-to-3D) OR imageSource (image-to-3D), not both. Every Tripo parameter is exposed under `options` with its enum/range and default. Note: the P1 model ignores several options, and generateParts is incompatible with texture/pbr/quad. Submits and polls until ready (streams progress), returning the saved mesh assets (or job info on timeout). Requires a Tripo AI API key configured in Settings.',
    inputSchema: {
      projectId: z.number().int(),
      name: z.string().min(1),
      prompt: z.string().optional().describe('Text prompt (text-to-3D). Provide this OR imageSource.'),
      imageSource: z.union([z.number().int(), z.string()]).optional().describe('Source image: asset id or stored filePath (image-to-3D). Provide this OR prompt.'),
      options: z.object(TRIPO_MESH_OPTIONS).default({}).describe('Tripo AI parameters (all optional; unset keys use their default).'),
      nodeId: z.number().int().optional().describe('Graph node to attach the generated mesh to (graph projects). The correct way to fill a node; a graph node id passed as cardId is auto-routed here.'),
      cardId: z.union([z.number().int(), z.string()]).optional(),
      parentAssetId: z.number().int().optional(),
      timeoutSeconds: z.number().int().min(30).max(3600).default(1200),
      pollIntervalSeconds: z.number().int().min(3).max(120).default(10)
    }
  }, toolHandler((args, extra) => runMeshGeneration(api, notifyMutation, { ...args, selectedApi: TRIPO_MESH_API_ID }, extra)));

  server.registerTool('generate_mesh_hitem', {
    title: 'Generate 3D mesh (Hitem3D)',
    description: 'Generate a 3D mesh with Hitem3D from an image and save it as a project asset. imageSource is REQUIRED (Hitem3D is image-to-3D only). Every Hitem3D parameter is exposed under `options` with its enum/range and default. Submits and polls until ready (streams progress), returning the saved mesh assets (or job info on timeout). Requires Hitem3D access/secret keys configured in Settings.',
    inputSchema: {
      projectId: z.number().int(),
      name: z.string().min(1),
      imageSource: z.union([z.number().int(), z.string()]).describe('Source image: asset id or stored filePath — REQUIRED.'),
      options: z.object(HITEM_MESH_OPTIONS).default({}).describe('Hitem3D parameters (all optional; unset keys use their default).'),
      nodeId: z.number().int().optional().describe('Graph node to attach the generated mesh to (graph projects). The correct way to fill a node; a graph node id passed as cardId is auto-routed here.'),
      cardId: z.union([z.number().int(), z.string()]).optional(),
      parentAssetId: z.number().int().optional(),
      timeoutSeconds: z.number().int().min(30).max(3600).default(1200),
      pollIntervalSeconds: z.number().int().min(3).max(120).default(10)
    }
  }, toolHandler((args, extra) => runMeshGeneration(api, notifyMutation, { ...args, selectedApi: HITEM_MESH_API_ID }, extra)));

  server.registerTool('get_mesh_result', {
    title: 'Get mesh generation result',
    description: 'Retrieve and finish an async mesh-generation job (Tencent / Tripo / Hitem3D) — use this when the original generate_mesh* call returned {status:"running"} after timing out. The generated mesh is NOT saved to the project until a result poll sees the job complete, so this tool is required to recover a timed-out job (list_assets will not show it before then). It polls the provider until the mesh is ready, saves it, and returns the assets. Pass the ids from the timeout payload: Tripo/Hitem3D use taskId; Tencent uses jobId + region. It is safe to call repeatedly.',
    inputSchema: {
      projectId: z.number().int(),
      name: z.string().min(1).describe('The same name the job was submitted with (used to save the asset)'),
      provider: z.enum(['tencent', 'tripo', 'hitem']).describe('Provider the job was submitted to'),
      taskId: z.string().optional().describe('Tripo AI / Hitem3D job id (from the timeout payload)'),
      jobId: z.string().optional().describe('Tencent Cloud job id (from the timeout payload)'),
      region: z.enum(['ap-singapore', 'eu-frankfurt', 'na-siliconvalley']).optional().describe('Tencent Cloud region the job was submitted in (required for Tencent)'),
      selectedApi: z.string().optional().describe('Provider id override (defaults to the standard id for the provider)'),
      prompt: z.string().optional().describe('Original prompt (stored in asset metadata; optional)'),
      cardId: z.union([z.number().int(), z.string()]).optional().describe('Kanban card the job is attached to (from the timeout payload)'),
      parentAssetId: z.number().int().optional().describe('Save the result as a version of this asset'),
      nodeId: z.number().int().optional().describe('Graph node to attach the result to (graph projects)'),
      timeoutSeconds: z.number().int().min(5).max(3600).default(600),
      pollIntervalSeconds: z.number().int().min(3).max(120).default(10)
    }
  }, toolHandler(async (args, extra) => {
    const {
      projectId, name, provider, taskId, jobId, region, selectedApi, prompt,
      cardId, parentAssetId, nodeId, timeoutSeconds = 600, pollIntervalSeconds = 10
    } = args;
    const reportProgress = createProgressReporter(extra);

    const providerIds = { tencent: TENCENT_MESH_API_ID, tripo: TRIPO_MESH_API_ID, hitem: HITEM_MESH_API_ID };
    const providerLabels = { tencent: 'Tencent Cloud', tripo: 'Tripo AI', hitem: 'Hitem3D' };
    const effectiveSelectedApi = selectedApi || providerIds[provider];
    const providerLabel = providerLabels[provider];

    if (provider === 'tencent' && (!jobId || !region)) {
      throw new Error('Tencent result lookup requires both jobId and region (from the timeout payload).');
    }
    if ((provider === 'tripo' || provider === 'hitem') && !taskId) {
      throw new Error(`${providerLabel} result lookup requires taskId (from the timeout payload).`);
    }

    // buildMeshPollRequest keys off the provider label substring and the ids.
    const pollRequest = buildMeshPollRequest(
      { provider: providerLabel, jobId, taskId, region },
      { projectId, name, prompt: prompt || '', cardId: cardId ?? null, selectedApi: effectiveSelectedApi, parentAssetId: parentAssetId ?? null }
    );
    if (!pollRequest) throw new Error(`Unknown mesh provider: ${provider}`);

    const outcome = await pollMeshResult(api, notifyMutation, {
      pollRequest,
      providerLabel,
      projectId,
      nodeId,
      selectedApi: effectiveSelectedApi,
      timeoutSeconds,
      pollIntervalSeconds,
      pollFirst: true
    }, reportProgress);

    if (outcome.status === 'running') {
      return {
        status: 'running',
        note: `Still processing after ${timeoutSeconds}s. Call get_mesh_result again with the same ids to keep waiting.`,
        provider: providerLabel,
        projectId,
        name,
        ...(jobId ? { jobId } : {}),
        ...(taskId ? { taskId } : {}),
        ...(region ? { region } : {}),
        lastStatus: outcome.lastStatus
      };
    }
    return outcome;
  }));

  server.registerTool('edit_mesh', {
    title: 'Edit mesh (AI)',
    description: 'Edit an existing project mesh through a configured custom mesh-edit API (selectedApi must be a custom_* id from Settings).',
    inputSchema: {
      projectId: z.number().int(),
      selectedApi: z.string().min(1),
      prompt: z.string().min(1),
      name: z.string().min(1),
      meshSource: z.union([z.number().int(), z.string()]).describe('Source mesh: asset id or stored filePath'),
      cardId: z.union([z.number().int(), z.string()]).optional()
    }
  }, toolHandler(async ({ projectId, ...body }) => {
    const result = await api.apiJson('POST', '/meshes/edit', { body: { projectId, ...body } });
    notifyMutation(projectId);
    return result;
  }));

  server.registerTool('texture_mesh', {
    title: 'Texture mesh (AI)',
    description: 'Texture an existing project mesh through a configured custom texturing API (selectedApi must be a custom_* id from Settings). For ComfyUI-based texturing use run_workflow.',
    inputSchema: {
      projectId: z.number().int(),
      selectedApi: z.string().min(1),
      prompt: z.string().min(1),
      name: z.string().min(1),
      meshSource: z.union([z.number().int(), z.string()]),
      cardId: z.union([z.number().int(), z.string()]).optional()
    }
  }, toolHandler(async ({ projectId, ...body }) => {
    const result = await api.apiJson('POST', '/meshes/texture', { body: { projectId, ...body } });
    notifyMutation(projectId);
    return result;
  }));

  server.registerTool('rig_mesh_api', {
    title: 'Rig mesh (external API)',
    description: 'Rig an existing project mesh through a configured custom rigging API (selectedApi must be a custom_* id from Settings). For the built-in local Auto Rig service use run_mesh_tool with operation "auto_rig".',
    inputSchema: {
      projectId: z.number().int(),
      selectedApi: z.string().min(1),
      prompt: z.string().min(1),
      name: z.string().min(1),
      meshSource: z.union([z.number().int(), z.string()]),
      cardId: z.union([z.number().int(), z.string()]).optional()
    }
  }, toolHandler(async ({ projectId, ...body }) => {
    const result = await api.apiJson('POST', '/meshes/rigging', { body: { projectId, ...body } });
    notifyMutation(projectId);
    return result;
  }));
}
