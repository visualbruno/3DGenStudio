// Attach generated assets to a graph node, mirroring what GraphPage does after
// a run completes (applyNodeResult + spawnAdditionalResultNodes): the first
// result becomes the node's asset (that's what the node card displays); every
// additional result becomes a new node stacked below, wired to the same
// incoming reference edges so it can be used the same way.

const VERTICAL_STEP = 580; // collapsed node card height (~480px) + gap
const NODE_TYPE_BY_ASSET_TYPE = { image: 'Image', mesh: 'Mesh' };

// Decide where a generated result should land. Graph nodes are filled via
// `nodeId` (→ attachResultsToNode → the node's own asset); kanban cards via
// `cardId`. Clients sometimes pass a graph node id as `cardId`, which the kanban
// path can't attach to a node (and worse, silently creates an orphaned card), so
// promote such an id to a node target here. Returns the resolved target; a node
// target never also carries a kanban cardId.
//
// Safe because graph nodes and kanban cards are unique rows in one `Cards` table:
// an id that matches a graph node IS that node, not a card.
export async function resolveNodeTarget(api, projectId, { nodeId, cardId } = {}) {
  if (nodeId !== undefined && nodeId !== null && nodeId !== '') {
    return { nodeId: Number(nodeId), cardId: undefined };
  }

  if (cardId !== undefined && cardId !== null && cardId !== '' && projectId) {
    const numeric = Number(cardId);
    if (Number.isInteger(numeric)) {
      const nodes = await api.apiJson('GET', '/graph/nodes', { query: { projectId } }).catch(() => []);
      const isGraphNode = (Array.isArray(nodes) ? nodes : []).some(node => Number(node?.id) === numeric);
      if (isGraphNode) {
        return { nodeId: numeric, cardId: undefined };
      }
    }
  }

  return { nodeId: undefined, cardId };
}

// List the assets feeding a node's inputs: for each incoming edge whose source
// node holds an asset, the asset id + type (ordered by input connector so the
// result is deterministic). Lets a workflow run fill its image/mesh parameters
// from what the node is wired to — mirroring the GraphPage, which binds each
// file parameter to the connected input of the matching type — and pick the
// parent asset (image edit / mesh version) by matching the output type.
export async function resolveNodeInputAssets(api, projectId, nodeId) {
  if (!nodeId || projectId === undefined || projectId === null) {
    return [];
  }

  const [nodes, connections] = await Promise.all([
    api.apiJson('GET', '/graph/nodes', { query: { projectId } }).catch(() => []),
    api.apiJson('GET', '/graph/connections', { query: { projectId } }).catch(() => [])
  ]);
  const nodeList = Array.isArray(nodes) ? nodes : [];
  const incomingEdges = (Array.isArray(connections) ? connections : [])
    .filter(connection => Number(connection?.targetNodeId) === Number(nodeId))
    .sort((a, b) => String(a?.inputId || '').localeCompare(String(b?.inputId || '')));

  const inputs = [];
  for (const edge of incomingEdges) {
    const sourceNode = nodeList.find(node => Number(node?.id) === Number(edge.sourceNodeId));
    const assetId = sourceNode?.assetId ?? sourceNode?.asset?.id ?? null;
    if (assetId) {
      inputs.push({
        assetId: Number(assetId),
        type: String(sourceNode?.asset?.type || '').toLowerCase() || null,
        connectorId: edge.inputId || null
      });
    }
  }

  return inputs;
}

export async function attachResultsToNode(api, { projectId, nodeId, assets, metadata = {} }) {
  const usable = (Array.isArray(assets) ? assets : [assets]).filter(asset =>
    asset?.id && NODE_TYPE_BY_ASSET_TYPE[String(asset.type || '').toLowerCase()]
  );
  if (!nodeId || usable.length === 0) {
    return { attached: false };
  }

  const [nodes, connections] = await Promise.all([
    api.apiJson('GET', '/graph/nodes', { query: { projectId } }),
    api.apiJson('GET', '/graph/connections', { query: { projectId } })
  ]);
  const targetNode = (Array.isArray(nodes) ? nodes : []).find(node => Number(node?.id) === Number(nodeId));
  if (!targetNode) {
    throw new Error(`nodeId ${nodeId} not found in project ${projectId} — the generated assets are saved, use get_graph to find valid node ids.`);
  }

  const [firstAsset, ...extraAssets] = usable;
  const updatedNode = await api.apiJson('PUT', `/graph/nodes/${nodeId}`, {
    body: {
      projectId,
      assetId: firstAsset.id,
      name: firstAsset.name || targetNode.name,
      status: null,
      progress: null,
      metadata
    }
  });

  // Additional results: new nodes below the target, re-wired to the target's
  // incoming edges (same handles) so they carry the same references.
  const incomingEdges = (Array.isArray(connections) ? connections : [])
    .filter(connection => Number(connection?.targetNodeId) === Number(nodeId));
  const baseX = Number(targetNode.xPos) || 0;
  const baseY = Number(targetNode.yPos) || 0;

  const additionalNodes = [];
  for (let index = 0; index < extraAssets.length; index += 1) {
    const asset = extraAssets[index];
    const nodeTypeName = NODE_TYPE_BY_ASSET_TYPE[String(asset.type).toLowerCase()];
    const createdNode = await api.apiJson('POST', '/graph/nodes', {
      body: {
        projectId,
        nodeTypeName,
        name: asset.name || nodeTypeName,
        xPos: baseX,
        yPos: baseY + ((index + 1) * VERTICAL_STEP),
        assetId: asset.id,
        metadata: { createdFromNodeId: Number(nodeId) }
      }
    });
    additionalNodes.push(createdNode);

    for (const edge of incomingEdges) {
      await api.apiJson('POST', '/graph/connections', {
        body: {
          projectId,
          sourceNodeId: edge.sourceNodeId,
          targetNodeId: createdNode.id,
          inputId: edge.inputId || 'input-0',
          outputId: edge.outputId || 'output-0'
        }
      }).catch(() => null); // an unwirable edge shouldn't lose the result node
    }
  }

  return {
    attached: true,
    node: updatedNode,
    additionalNodeIds: additionalNodes.map(node => node.id)
  };
}
