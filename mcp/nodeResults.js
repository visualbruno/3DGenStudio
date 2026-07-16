// Attach generated assets to a graph node, mirroring what GraphPage does after
// a run completes (applyNodeResult + spawnAdditionalResultNodes): the first
// result becomes the node's asset (that's what the node card displays); every
// additional result becomes a new node stacked below, wired to the same
// incoming reference edges so it can be used the same way.

const VERTICAL_STEP = 580; // collapsed node card height (~480px) + gap
const NODE_TYPE_BY_ASSET_TYPE = { image: 'Image', mesh: 'Mesh' };

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
