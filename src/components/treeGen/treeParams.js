// The parameter panel's schema, mirroring the service's TreeSpec.
//
// Space colonization has ~25 meaningful parameters and putting all of them on
// screen is how a generator reads as a tech demo. Exactly eight are marked
// `basic`; everything else lives behind Advanced, and the presets carry the
// complexity so most users never open it.
//
// `path` is the dotted location in the spec, which is also the key the sparse
// override patch is built from — so a control never has to know anything about
// the spec's shape beyond its own path.

export const CROWN_SHAPES = [
  { value: 'ellipsoid', label: 'Ellipsoid — generic deciduous' },
  { value: 'sphere', label: 'Sphere' },
  { value: 'hemisphere', label: 'Hemisphere — broad canopy' },
  { value: 'cone', label: 'Cone — conifer' },
  { value: 'inverted_cone', label: 'Inverted cone — vase / elm' },
  { value: 'cylinder', label: 'Cylinder — columnar poplar' },
  { value: 'umbrella', label: 'Umbrella — palm crest' },
]

// group: which section it appears under. basic: shown before Advanced is opened.
export const TREE_PARAMS = [
  // --- Skeleton ---------------------------------------------------------
  { path: 'height', group: 'Skeleton', label: 'Height', unit: 'm',
    type: 'number', min: 0.2, max: 60, step: 0.1, basic: true,
    hint: 'Trunk base to crown top. Every other size is a ratio of this, so a tree scales without re-tuning.' },
  { path: 'crown.shape', group: 'Skeleton', label: 'Crown shape',
    type: 'select', options: CROWN_SHAPES, basic: true,
    hint: 'The envelope branches grow to fill. This is what makes a species readable at a glance.' },
  { path: 'crown.radius_ratio', group: 'Skeleton', label: 'Crown width',
    type: 'number', min: 0.05, max: 1.2, step: 0.01, basic: true,
    hint: 'Crown radius as a fraction of height.' },
  { path: 'crown.base_ratio', group: 'Skeleton', label: 'Trunk clearance',
    type: 'number', min: 0, max: 0.9, step: 0.01, basic: true,
    hint: 'Where the crown starts. 0 gives a bush with no clear trunk.' },
  { path: 'skeleton.attractors', group: 'Skeleton', label: 'Branch density',
    type: 'number', min: 100, max: 20000, step: 100, basic: true,
    hint: 'Attraction points sampled in the crown. More points, more branches — and more time.' },
  { path: 'crown.top_ratio', group: 'Skeleton', label: 'Crown top', type: 'number',
    min: 0.1, max: 1, step: 0.01 },
  { path: 'crown.shell_bias', group: 'Skeleton', label: 'Shell bias', type: 'number',
    min: -1, max: 1, step: 0.05,
    hint: '+1 packs growth into the outer canopy, −1 into the core.' },
  { path: 'crown.offset_x', group: 'Skeleton', label: 'Crown offset X', type: 'number',
    min: -1, max: 1, step: 0.01 },
  { path: 'crown.offset_z', group: 'Skeleton', label: 'Crown offset Z', type: 'number',
    min: -1, max: 1, step: 0.01 },
  { path: 'crown.shell_thickness', group: 'Skeleton', label: 'Umbrella thickness', type: 'number',
    min: 0.05, max: 1, step: 0.01, hint: 'Only used by the umbrella crown.' },

  // --- Branching --------------------------------------------------------
  { path: 'branching.trunk_radius_ratio', group: 'Branching', label: 'Trunk thickness',
    type: 'number', min: 0.002, max: 0.2, step: 0.001, basic: true,
    hint: 'Trunk radius as a fraction of height. Radii are solved by the branching law, then scaled to match this.' },
  { path: 'branching.radius_exponent', group: 'Branching', label: 'Branch law exponent',
    type: 'number', min: 1.2, max: 4, step: 0.05,
    hint: "da Vinci's rule: r_parent^n = Σ r_child^n. Lower n gives finer twigs." },
  { path: 'branching.root_flare', group: 'Branching', label: 'Root flare',
    type: 'number', min: 0, max: 4, step: 0.05 },
  { path: 'branching.root_flare_ratio', group: 'Branching', label: 'Flare length',
    type: 'number', min: 0, max: 0.5, step: 0.005 },
  { path: 'branching.tip_radius_ratio', group: 'Branching', label: 'Minimum tip radius',
    type: 'number', min: 0, max: 0.02, step: 0.0001 },
  { path: 'branching.max_order', group: 'Branching', label: 'Max branch order',
    type: 'number', min: 1, max: 16, step: 1,
    hint: 'Branches deeper than this are culled. Also the LOD lever.' },
  { path: 'skeleton.tropism.1', group: 'Branching', label: 'Gravitropism',
    type: 'number', min: -1, max: 1, step: 0.01,
    hint: 'Positive reaches for light, negative weeps. This one value is most of what separates an oak from a willow.' },
  { path: 'skeleton.randomness', group: 'Branching', label: 'Randomness',
    type: 'number', min: 0, max: 1.5, step: 0.01 },
  { path: 'skeleton.trunk_wobble', group: 'Branching', label: 'Trunk wobble',
    type: 'number', min: 0, max: 1, step: 0.01 },
  { path: 'skeleton.attraction_ratio', group: 'Branching', label: 'Attraction distance',
    type: 'number', min: 0.05, max: 2, step: 0.01,
    hint: 'How far a branch tip senses an attraction point, relative to the crown radius.' },
  { path: 'skeleton.kill_ratio', group: 'Branching', label: 'Kill distance',
    type: 'number', min: 0.3, max: 4, step: 0.05,
    hint: 'How close a branch must get to consume a point. Sensitive: too large and the tree never leaves the trunk.' },
  { path: 'skeleton.step_ratio', group: 'Branching', label: 'Growth step',
    type: 'number', min: 0.005, max: 0.3, step: 0.001,
    hint: 'Smaller steps give finer branches and cost proportionally more time.' },
  { path: 'skeleton.smoothing', group: 'Branching', label: 'Smoothing passes',
    type: 'number', min: 0, max: 12, step: 1 },

  // --- Foliage ----------------------------------------------------------
  { path: 'foliage.enabled', group: 'Foliage', label: 'Foliage', type: 'boolean', basic: true },
  { path: 'foliage.max_cards', group: 'Foliage', label: 'Leaf budget',
    type: 'number', min: 0, max: 40000, step: 100, basic: true,
    hint: 'A hard cap on emitted cards. Placements above it are thinned evenly, never truncated on one side.' },
  { path: 'foliage.size_ratio', group: 'Foliage', label: 'Leaf size',
    type: 'number', min: 0.002, max: 0.25, step: 0.001, basic: true,
    hint: 'Card width as a fraction of tree height.' },
  { path: 'foliage.mode', group: 'Foliage', label: 'Mode', type: 'select',
    options: [
      { value: 'clusters', label: 'Clusters — a fan of cards per placement' },
      { value: 'cards', label: 'Single cards — highest quality, worst cost' },
    ] },
  { path: 'foliage.cluster_cards', group: 'Foliage', label: 'Cards per cluster',
    type: 'number', min: 2, max: 8, step: 1 },
  { path: 'foliage.cluster_spread', group: 'Foliage', label: 'Cluster spread',
    type: 'number', min: 0, max: 2, step: 0.05 },
  { path: 'foliage.aspect', group: 'Foliage', label: 'Leaf aspect',
    type: 'number', min: 0.1, max: 8, step: 0.05 },
  { path: 'foliage.align_ratio', group: 'Foliage', label: 'Align to branch',
    type: 'number', min: 0, max: 1, step: 0.05,
    hint: '0 = a leaf sticking out sideways, 1 = a frond running along the branch. Palms need this near 1.' },
  { path: 'foliage.droop_deg', group: 'Foliage', label: 'Droop', unit: '°',
    type: 'number', min: -90, max: 90, step: 1 },
  { path: 'foliage.tilt_jitter_deg', group: 'Foliage', label: 'Tilt jitter', unit: '°',
    type: 'number', min: 0, max: 180, step: 1 },
  { path: 'foliage.size_jitter', group: 'Foliage', label: 'Size jitter',
    type: 'number', min: 0, max: 1, step: 0.05 },
  { path: 'foliage.spacing_ratio', group: 'Foliage', label: 'Leaf spacing',
    type: 'number', min: 0.002, max: 0.3, step: 0.001 },
  { path: 'foliage.min_order', group: 'Foliage', label: 'Min branch order',
    type: 'number', min: 0, max: 16, step: 1,
    hint: 'Only branches this deep and beyond carry leaves.' },
  { path: 'foliage.max_radius_ratio', group: 'Foliage', label: 'Max host radius',
    type: 'number', min: 0, max: 0.05, step: 0.0005,
    hint: 'Only branches thinner than this carry leaves, so leaves never sprout from the trunk.' },
  { path: 'foliage.spherical_normals', group: 'Foliage', label: 'Spherical normals',
    type: 'number', min: 0, max: 1, step: 0.05,
    hint: 'Blends leaf normals toward the crown-outward direction. The single biggest visual win — flat card normals read as dead cardboard.' },
  { path: 'foliage.atlas_cols', group: 'Foliage', label: 'Atlas columns',
    type: 'number', min: 1, max: 16, step: 1 },
  { path: 'foliage.atlas_rows', group: 'Foliage', label: 'Atlas rows',
    type: 'number', min: 1, max: 16, step: 1 },
  { path: 'foliage.double_sided', group: 'Foliage', label: 'Double sided', type: 'boolean' },

  // --- Output -----------------------------------------------------------
  { path: 'bark.junction_mode', group: 'Output', label: 'Junctions', type: 'select',
    options: [
      { value: 'sink', label: 'Sink — fast, texture hides the seam' },
      { value: 'clean', label: 'Clean — boolean union, watertight' },
    ],
    hint: 'Clean unions every branch into one closed solid (for printing or physics). It costs ~1s and re-derives the UVs.' },
  { path: 'bark.radial_max', group: 'Output', label: 'Trunk sides',
    type: 'number', min: 3, max: 64, step: 1 },
  { path: 'bark.radial_min', group: 'Output', label: 'Twig sides',
    type: 'number', min: 3, max: 32, step: 1 },
  { path: 'bark.radial_falloff', group: 'Output', label: 'Sides falloff',
    type: 'number', min: 0.05, max: 2, step: 0.05 },
  { path: 'bark.uv_tile', group: 'Output', label: 'Bark UV tile', unit: 'm',
    type: 'number', min: 0.02, max: 10, step: 0.01,
    hint: 'World length that maps to one tile of the bark texture.' },
  { path: 'bark.uv_mode', group: 'Output', label: 'Bark UV mode', type: 'select',
    options: [
      { value: 'normalized', label: 'Normalized — perfect tiling' },
      { value: 'world', label: 'World — uniform texel density' },
    ] },
  { path: 'bark.junction_flare', group: 'Output', label: 'Junction flare',
    type: 'number', min: 1, max: 3, step: 0.05 },
  { path: 'bark.cap_tips', group: 'Output', label: 'Cap branch tips', type: 'boolean' },
  { path: 'output.wind_colors', group: 'Output', label: 'Bake wind data (engine)', type: 'boolean',
    hint: 'Writes wind data to vertex colours for an engine wind shader: R branch phase, G stiffness, '
      + 'B leaf flutter, A hierarchy weight. glTF treats vertex colour as a base-colour multiplier, so the '
      + 'tree looks wrong in plain glTF viewers with this on. The viewport here ignores it either way.' },
  { path: 'output.lods', group: 'Output', label: 'LOD levels',
    type: 'number', min: 0, max: 4, step: 1,
    hint: 'Extra levels for Download LODs. Each is regenerated from the SAME skeleton — fewer branch sides, whole '
      + 'twig generations dropped, fewer but larger leaf cards — so branches never move between levels.' },
  { path: 'output.impostor', group: 'Output', label: 'Bake impostor', type: 'boolean',
    hint: 'A grid of pre-rendered views plus a quad, for the distance where even the cheapest mesh is wasted. '
      + 'Needs an impostor shader in your engine to sample it view-dependently.' },
  { path: 'output.impostor_grid', group: 'Output', label: 'Impostor views per axis',
    type: 'number', min: 2, max: 16, step: 1, hint: '8 means an 8x8 grid, so 64 views.' },
  { path: 'output.impostor_tile', group: 'Output', label: 'Impostor view size', unit: 'px',
    type: 'number', min: 32, max: 512, step: 32,
    hint: 'Pixels per view. Views per axis x this is the atlas size.' },
  { path: 'output.engine', group: 'Output', label: 'Engine preset', type: 'select',
    options: [
      { value: 'generic', label: 'Generic (metres, Y-up)' },
      { value: 'unity', label: 'Unity' },
      { value: 'unreal', label: 'Unreal (centimetres, Z-up)' },
      { value: 'godot', label: 'Godot' },
    ] },
]

export const PARAM_GROUPS = ['Skeleton', 'Branching', 'Foliage', 'Output']

// Which parameters, when changed, actually alter the SKELETON. Only these need
// a preview refresh — nudging leaf size or UV tiling cannot move a branch, and
// re-running the skeleton for them would waste the whole latency budget.
export function affectsSkeleton(path) {
  return path === 'height'
    || path.startsWith('crown.')
    || path.startsWith('skeleton.')
    || path.startsWith('branching.')
}
