import { z } from 'zod';
import { toolHandler, createProgressReporter } from '../client.js';

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

export function registerActionTools(server, { api, notifyMutation }) {
  server.registerTool('generate_image', {
    title: 'Generate image',
    description: 'Generate an image with an external AI provider and save it as a project asset. selectedApi identifies the provider/model configured in Settings (e.g. Google/OpenAI image APIs or a custom_* API) — check get_settings for what is configured.',
    inputSchema: {
      projectId: z.number().int(),
      selectedApi: z.string().min(1).describe('Provider/model id from Settings (e.g. "google_gemini", "openai_gpt_image", or a custom_* id)'),
      prompt: z.string().min(1),
      name: z.string().min(1).describe('Name for the generated asset/card'),
      cardId: z.union([z.number().int(), z.string()]).optional().describe('Existing card/node to attach the result to')
    }
  }, toolHandler(async ({ projectId, ...body }) => {
    const result = await api.apiJson('POST', '/images/generate', { body: { projectId, ...body } });
    notifyMutation(projectId);
    return result;
  }));

  server.registerTool('edit_image', {
    title: 'Edit image (AI)',
    description: 'Edit an existing project image with an external AI provider (prompt-based edit). The result is saved as an edit of the source asset. For ComfyUI-based edits use run_workflow instead.',
    inputSchema: {
      projectId: z.number().int(),
      selectedApi: z.string().min(1),
      prompt: z.string().min(1),
      name: z.string().min(1),
      imageSource: z.union([z.number().int(), z.string()]).describe('Source image: asset id or stored filePath'),
      cardId: z.union([z.number().int(), z.string()]).optional()
    }
  }, toolHandler(async ({ projectId, ...body }) => {
    const result = await api.apiJson('POST', '/image-edits/api', { body: { projectId, ...body } });
    notifyMutation(projectId);
    return result;
  }));

  server.registerTool('generate_mesh', {
    title: 'Generate 3D mesh',
    description: 'Generate a 3D mesh from an image and/or prompt using Tencent Hunyuan, Tripo AI, or Hitem3D (selectedApi from Settings). Submits the job and polls the provider until the mesh is ready (streams MCP progress), then returns the saved mesh assets. Takes minutes — on timeout returns the job info so it can be re-polled by calling this tool\'s sibling get-result flow or checking list_assets later.',
    inputSchema: {
      projectId: z.number().int(),
      selectedApi: z.string().min(1).describe('Mesh provider id from Settings (Tencent / Tripo / Hitem3D / custom_*)'),
      name: z.string().min(1),
      prompt: z.string().optional().describe('Text prompt (Tencent/Tripo support text-to-3D)'),
      imageSource: z.union([z.number().int(), z.string()]).optional().describe('Source image: asset id or stored filePath (required for Hitem3D)'),
      cardId: z.union([z.number().int(), z.string()]).optional(),
      parentAssetId: z.number().int().optional(),
      options: z.record(z.string(), z.any()).default({}).describe('Provider options, e.g. Tencent: region, modelVersion, enablePBR, faceCount, generationType, polygonType; Tripo: modelVersion, texture, pbr, quad, faceLimit, …'),
      timeoutSeconds: z.number().int().min(30).max(3600).default(1200),
      pollIntervalSeconds: z.number().int().min(3).max(120).default(10)
    }
  }, toolHandler(async (args, extra) => {
    const {
      projectId, selectedApi, name, prompt, imageSource, cardId, parentAssetId,
      options = {}, timeoutSeconds = 1200, pollIntervalSeconds = 10
    } = args;
    const reportProgress = createProgressReporter(extra);

    const submit = await api.apiJson('POST', '/meshes/generate', {
      body: {
        projectId, selectedApi, name,
        ...(prompt ? { prompt } : {}),
        ...(imageSource !== undefined ? { imageSource } : {}),
        ...(cardId !== undefined ? { cardId } : {}),
        ...(parentAssetId !== undefined ? { parentAssetId } : {}),
        ...options
      }
    });
    notifyMutation(projectId);

    const pollRequest = buildMeshPollRequest(submit, {
      projectId,
      name,
      prompt: prompt || '',
      cardId: submit?.cardId ?? cardId ?? null,
      selectedApi,
      parentAssetId: parentAssetId ?? null
    });

    // Custom APIs respond synchronously — nothing to poll.
    if (!pollRequest) return submit;

    await reportProgress(0, 100, `${submit.provider} job submitted (${submit.jobId || submit.taskId})`);

    const deadline = Date.now() + timeoutSeconds * 1000;
    let lastStatus = submit;
    while (Date.now() < deadline) {
      await sleep(pollIntervalSeconds * 1000);
      lastStatus = await api.apiJson('POST', pollRequest.path, { body: pollRequest.body });

      if (lastStatus?.status === 'completed') {
        await reportProgress(100, 100, 'Mesh generation completed');
        notifyMutation(projectId);
        return lastStatus;
      }
      if (lastStatus?.status === 'error') {
        throw new Error(lastStatus.error || 'Mesh generation failed');
      }
      const percent = Number(lastStatus?.progressPercent);
      await reportProgress(
        Number.isFinite(percent) ? percent : 50,
        100,
        `${submit.provider} status: ${lastStatus?.jobStatus || lastStatus?.taskStatus || lastStatus?.status || 'processing'}`
      );
    }

    return {
      status: 'running',
      note: `Still processing after ${timeoutSeconds}s. The provider keeps working — re-run generate_mesh later is NOT needed; check the project with list_assets, or the card status with list_cards.`,
      submit,
      lastStatus
    };
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
