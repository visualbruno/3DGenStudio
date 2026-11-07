// The Workspace modules, in rail order. Image, Mesh, Retopo, UV and Texture are built; the others
// open a draft panel describing what they will do.
export const WORKSPACE_MODULES = [
  { id: 'image', label: 'Image', icon: 'imagesmode', ready: true },
  { id: 'mesh', label: 'Mesh', icon: 'deployed_code', ready: true },
  { id: 'retopo', label: 'Retopo', icon: 'grid_4x4', ready: true },
  { id: 'uv', label: 'UV', icon: 'view_quilt', ready: true },
  { id: 'texture', label: 'Texture', icon: 'texture', ready: true },
  { id: 'rig', label: 'Rig', icon: 'accessibility_new', ready: false }
]

// What each module not built yet is going to do, shown in its draft panel.
export const MODULE_DRAFTS = {
  rig: {
    title: 'Rig',
    summary: 'Add a skeleton and skin weights to the selected mesh, then animate it.',
    points: [
      'Auto Rig with the usual presets',
      'Animations from the reference library, Kimodo text-to-motion and MoCap',
      'The rigged mesh is saved as a version of the source mesh'
    ]
  }
}
