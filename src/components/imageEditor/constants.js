// Static configuration shared across Image Editor components.
// Extracted from ImageEditorPage.jsx.

export const PAINT_BLEND_MODES = [
  { value: 'source-over', label: 'Normal' },
  { value: 'multiply', label: 'Multiply' },
  { value: 'screen', label: 'Screen' },
  { value: 'overlay', label: 'Overlay' },
  { value: 'darken', label: 'Darken' },
  { value: 'lighten', label: 'Lighten' }
]

export const TOOLS = {
  edit: [
    { id: 'crop', label: 'Crop', icon: 'crop' },
    { id: 'resize', label: 'Resize', icon: 'open_in_full' },
    { id: 'adjust', label: 'Levels / Contrast / Saturation', icon: 'tune' },
    { id: 'filters', label: 'Blur / Sharpen', icon: 'blur_on' },
    { id: 'shadow-remover', label: 'Shadow Remover', icon: 'light_mode' },
    { id: 'seamless', label: 'Seamless (tileable)', icon: 'grid_view' }
  ],
  paint: [
    { id: 'paint', label: 'Brush / Image Brush', icon: 'brush' }
  ],
  ai: [
    { id: 'mask', label: 'Mask + ComfyUI', icon: 'auto_fix_high' },
    { id: 'comfyui', label: 'ComfyUI', icon: 'auto_awesome' }
  ]
}
