import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import Header from '../components/Header'
import Footer from '../components/Footer'
import MeshPreviewDialog from '../components/MeshPreviewDialog'
import SettingsModal from '../components/SettingsModal'
import { useProjects } from '../context/ProjectContext'
import { createMeshThumbnailFile, isMeshFile } from '../utils/meshThumbnail'
import { parseAbrFile } from '../utils/brushAbr'
import './AssetsPage.css'

const ASSETS_PER_PAGE = 20
const COMFY_VALUE_TYPES = [
  { value: 'string', label: 'String' },
  { value: 'number', label: 'Number' },
  { value: 'boolean', label: 'Boolean' },
  { value: 'image', label: 'Image' },
  { value: 'video', label: 'Video' },
  { value: 'mesh', label: 'Mesh' }
]

const COMFY_TYPE_LABEL = Object.fromEntries(COMFY_VALUE_TYPES.map(option => [option.value, option.label]))

const ASSET_SECTIONS = [
  {
    key: 'images',
    label: 'Images',
    icon: 'image',
    path: 'assets/images',
    emptyIcon: 'image_not_supported',
    emptyMessage: 'No images found in `assets/images`.'
  },
  {
    key: 'meshes',
    label: 'Meshes',
    icon: 'deployed_code',
    path: 'assets/meshes',
    emptyIcon: 'deployed_code',
    emptyMessage: 'No meshes found in `assets/meshes`.'
  },
  {
    key: 'brushes',
    label: 'Brushes',
    icon: 'brush',
    path: 'assets/brushes',
    emptyIcon: 'brush',
    emptyMessage: 'No brushes found in `assets/brushes`.'
  },
  {
    key: 'workflows',
    label: 'Workflows',
    icon: 'account_tree',
    path: 'library/workflows',
    emptyIcon: 'account_tree',
    emptyMessage: 'No ComfyUI workflows imported yet.'
  }
]

function getDefaultValueType(item, isOutput = false) {
  if (item?.valueType) return item.valueType
  if (isOutput) return 'image'
  if (item?.type === 'boolean') return 'boolean'
  return item?.type === 'number' ? 'number' : 'string'
}

function createSelectionMap(items, getLabel, isOutput = false, selected = false) {
  return Object.fromEntries(
    items.map(item => [
      item.id || item.nodeId,
      {
        selected,
        name: getLabel(item),
        valueType: getDefaultValueType(item, isOutput)
      }
    ])
  )
}

function hydrateWorkflowSelection(workflow) {
  const parameterMap = new Map((workflow.parameters || []).map(parameter => [parameter.id, parameter]))
  const outputMap = new Map((workflow.outputs || []).map(output => [output.nodeId, output]))

  const inputs = Object.fromEntries(
    (workflow.availableInputs || []).map(input => {
      const selectedParameter = parameterMap.get(input.id)
      return [
        input.id,
        {
          selected: Boolean(selectedParameter),
          name: selectedParameter?.name || input.name,
          valueType: getDefaultValueType(selectedParameter || input)
        }
      ]
    })
  )

  const outputs = Object.fromEntries(
    (workflow.availableOutputs || []).map(output => {
      const selectedOutput = outputMap.get(output.nodeId)
      return [
        output.nodeId,
        {
          selected: Boolean(selectedOutput),
          name: selectedOutput?.name || output.nodeTitle,
          valueType: getDefaultValueType(selectedOutput || output, true)
        }
      ]
    })
  )

  return { inputs, outputs }
}

function formatDefaultValue(value) {
  if (value === null || value === undefined || value === '') return 'empty'
  if (typeof value === 'object') return JSON.stringify(value)
  return String(value)
}

function selectWorkflowItem(setter, key, name, valueType) {
  setter(prev => ({
    ...prev,
    [key]: {
      selected: true,
      name: prev[key]?.name || name,
      valueType: prev[key]?.valueType || valueType
    }
  }))
}

function deselectWorkflowItem(setter, key) {
  setter(prev => ({
    ...prev,
    [key]: {
      ...prev[key],
      selected: false
    }
  }))
}

function formatDimensions(width, height) {
  if (!width || !height) return null
  return `${width} × ${height}`
}

function getAssetChildren(asset) {
  return asset?.children || asset?.edits || []
}

function buildMeshEditorPath(asset, returnTo = '/assets') {
  const assetIdMatch = String(asset.id || '').match(/^library:(\d+)$/) || String(asset.id || '').match(/^(\d+)$/)
  const inheritedProjectId = asset.projectId || asset.parentProjectId || null
  const query = new URLSearchParams({
    assetId: assetIdMatch?.[1] || '',
    filePath: asset.filePath || asset.filename || '',
    url: asset.url || '',
    name: asset.name || 'Mesh',
    projectId: inheritedProjectId ? String(inheritedProjectId) : '',
    returnTo
  })

  return `/mesh-editor?${query.toString()}`
}

function buildImageEditorPath(asset, returnTo = '/assets') {
  const assetIdMatch = String(asset.id || '').match(/^library:(\d+)$/) || String(asset.id || '').match(/^(\d+)$/)
  const inheritedProjectId = asset.projectId || asset.parentProjectId || null
  const query = new URLSearchParams({
    assetId: assetIdMatch?.[1] || '',
    filePath: asset.filePath || asset.filename || '',
    url: asset.url || '',
    name: asset.name || 'Image',
    projectId: inheritedProjectId ? String(inheritedProjectId) : '',
    returnTo
  })

  return `/image-editor?${query.toString()}`
}

function WorkflowOptionSelector({
  title,
  items,
  selectedMap,
  getKey,
  getPrimaryText,
  getSecondaryText,
  onSelect,
  emptyMessage,
  searchPlaceholder
}) {
  const [isOpen, setIsOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')
  const containerRef = useRef(null)

  useEffect(() => {
    if (!isOpen) return undefined

    const handleClickOutside = event => {
      if (!containerRef.current?.contains(event.target)) {
        setIsOpen(false)
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen])

  const availableItems = useMemo(
    () => items.filter(item => !selectedMap[getKey(item)]?.selected),
    [getKey, items, selectedMap]
  )

  const filteredItems = useMemo(() => {
    const query = searchValue.trim().toLowerCase()
    if (!query) return availableItems

    return availableItems.filter(item => {
      const haystack = `${getPrimaryText(item)} ${getSecondaryText(item)}`.toLowerCase()
      return haystack.includes(query)
    })
  }, [availableItems, getPrimaryText, getSecondaryText, searchValue])

  const handleSelect = item => {
    onSelect(item)
    setSearchValue('')
    setIsOpen(false)
  }

  return (
    <div ref={containerRef} className="library-selector">
      <button
        type="button"
        className="library-selector__trigger"
        onClick={() => setIsOpen(prev => !prev)}
        aria-expanded={isOpen}
      >
        <span>{title}</span>
        <span className="material-symbols-outlined">{isOpen ? 'expand_less' : 'expand_more'}</span>
      </button>

      {isOpen && (
        <div className="library-selector__menu">
          <div className="library-selector__search">
            <span className="material-symbols-outlined">search</span>
            <input
              className="library-selector__search-input"
              value={searchValue}
              onChange={event => setSearchValue(event.target.value)}
              placeholder={searchPlaceholder}
              autoFocus
            />
          </div>

          <div className="library-selector__options">
            {filteredItems.length > 0 ? filteredItems.map(item => (
              <button
                key={getKey(item)}
                type="button"
                className="library-selector__option"
                onClick={() => handleSelect(item)}
              >
                <strong>{getPrimaryText(item)}</strong>
                <span>{getSecondaryText(item)}</span>
              </button>
            )) : (
              <div className="library-selector__empty">{availableItems.length === 0 ? emptyMessage : 'No matches found.'}</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default function AssetsPage() {
  const {
    projects,
    getLibraryAssets,
    importLibraryAssets,
    importBrushChildAssets,
    deleteLibraryAsset,
    renameLibraryAsset,
    renameAssetEdit,
    deleteAssetEdit,
    deleteAsset,
    getComfyWorkflows,
    inspectComfyWorkflow,
    importComfyWorkflow,
    updateComfyWorkflow
  } = useProjects()
  const navigate = useNavigate()
  const [libraryAssets, setLibraryAssets] = useState({ images: [], meshes: [], brushes: [] })
  const [loading, setLoading] = useState(true)
  const [showSettings, setShowSettings] = useState(false)
  const [activeSection, setActiveSection] = useState('images')
  const [currentPage, setCurrentPage] = useState(1)
  const [importing, setImporting] = useState(false)
  const [importFeedback, setImportFeedback] = useState(null)
  const [workflowLoading, setWorkflowLoading] = useState(true)
  const [workflowSaving, setWorkflowSaving] = useState(false)
  const [workflows, setWorkflows] = useState([])
  const [workflowName, setWorkflowName] = useState('')
  const [workflowJson, setWorkflowJson] = useState(null)
  const [inspectedWorkflow, setInspectedWorkflow] = useState(null)
  const [selectedInputs, setSelectedInputs] = useState({})
  const [selectedOutputs, setSelectedOutputs] = useState({})
  const [selectedInputOrder, setSelectedInputOrder] = useState([])
  const [selectedOutputOrder, setSelectedOutputOrder] = useState([])
  const [editingWorkflowId, setEditingWorkflowId] = useState(null)
  const [workflowEditorOpen, setWorkflowEditorOpen] = useState(false)
  const [workflowTypeFilter, setWorkflowTypeFilter] = useState('all')
  const [workflowFeedback, setWorkflowFeedback] = useState('')
  const [deletingWorkflowId, setDeletingWorkflowId] = useState(null)
  const [deletingAssetKey, setDeletingAssetKey] = useState(null)
  const [linkedAssetDialog, setLinkedAssetDialog] = useState(null)
  const [meshPreviewAsset, setMeshPreviewAsset] = useState(null)
  const [meshVersionsAsset, setMeshVersionsAsset] = useState(null)
  const [editPreviewAsset, setEditPreviewAsset] = useState(null)
  const [renamingAsset, setRenamingAsset] = useState(null)
  const [renamingAssetName, setRenamingAssetName] = useState('')
  const [renamingAssetKey, setRenamingAssetKey] = useState(null)
  const [renamingEdit, setRenamingEdit] = useState(null)
  const [renamingEditName, setRenamingEditName] = useState('')
  const [renamingEditKey, setRenamingEditKey] = useState(null)
  const [deletingEditKey, setDeletingEditKey] = useState(null)
  const [searchQuery, setSearchQuery] = useState('')
  const [projectFilter, setProjectFilter] = useState('all')
  const [groupByProject, setGroupByProject] = useState(false)
  const [collapsedGroups, setCollapsedGroups] = useState({})
  const assetFileInputRef = useRef(null)
  const workflowFileInputRef = useRef(null)

  const loadLibrary = useCallback(async () => {
    try {
      const data = await getLibraryAssets()
      setLibraryAssets(data)
    } catch (err) {
      console.error('Failed to load assets library:', err)
    } finally {
      setLoading(false)
    }
  }, [getLibraryAssets])

  const loadWorkflows = useCallback(async () => {
    try {
      setWorkflowLoading(true)
      const data = await getComfyWorkflows()
      setWorkflows(data)
    } catch (err) {
      console.error('Failed to load ComfyUI workflows:', err)
      setWorkflowFeedback(err.message || 'Failed to load ComfyUI workflows')
    } finally {
      setWorkflowLoading(false)
    }
  }, [getComfyWorkflows])

  useEffect(() => {
    loadLibrary()
    loadWorkflows()
  }, [loadLibrary, loadWorkflows])

  useEffect(() => {
    setCurrentPage(1)
  }, [activeSection, searchQuery, projectFilter])

  // Reset the project filter when switching type sections so a project
  // selected for Images doesn't silently hide everything under Meshes.
  useEffect(() => {
    setProjectFilter('all')
  }, [activeSection])

  const projectNameById = useMemo(
    () => new Map((projects || []).map(project => [String(project.id), project.name])),
    [projects]
  )

  const normalizedSearch = searchQuery.trim().toLowerCase()

  const matchesSearch = useCallback((name) => {
    if (!normalizedSearch) return true
    return String(name || '').toLowerCase().includes(normalizedSearch)
  }, [normalizedSearch])

  const getWorkflowOutputTypes = useCallback((workflow) => {
    const types = new Set()
    ;(workflow.outputs || []).forEach(output => types.add(getDefaultValueType(output, true)))
    return Array.from(types)
  }, [])

  // Filter chips, ordered by COMFY_VALUE_TYPES, limited to output types that
  // actually appear across the imported workflows (with a per-type count).
  const workflowTypeOptions = useMemo(() => {
    const counts = new Map()
    workflows.forEach(workflow => {
      getWorkflowOutputTypes(workflow).forEach(type => counts.set(type, (counts.get(type) || 0) + 1))
    })
    return COMFY_VALUE_TYPES
      .filter(option => counts.has(option.value))
      .map(option => ({ value: option.value, label: option.label, count: counts.get(option.value) }))
  }, [workflows, getWorkflowOutputTypes])

  // Drop a stale type filter (e.g. the last workflow of that type was deleted).
  useEffect(() => {
    if (workflowTypeFilter !== 'all' && !workflowTypeOptions.some(option => option.value === workflowTypeFilter)) {
      setWorkflowTypeFilter('all')
    }
  }, [workflowTypeFilter, workflowTypeOptions])

  const filteredWorkflows = useMemo(
    () => workflows
      .filter(workflow =>
        matchesSearch(workflow.name) &&
        (workflowTypeFilter === 'all' || getWorkflowOutputTypes(workflow).includes(workflowTypeFilter))
      )
      .sort((left, right) => String(left.name || '').localeCompare(String(right.name || ''), undefined, { sensitivity: 'base' })),
    [workflows, matchesSearch, workflowTypeFilter, getWorkflowOutputTypes]
  )

  const selectedInputCount = useMemo(
    () => Object.values(selectedInputs).filter(item => item.selected).length,
    [selectedInputs]
  )

  const selectedOutputCount = useMemo(
    () => Object.values(selectedOutputs).filter(item => item.selected).length,
    [selectedOutputs]
  )

  // Render selected inputs/outputs in explicit insertion order (newest first)
  // rather than the workflow's source order, so a freshly added item appears on top.
  const selectedInputItems = useMemo(() => {
    const byId = new Map((inspectedWorkflow?.inputs || []).map(input => [input.id, input]))
    return selectedInputOrder
      .map(id => byId.get(id))
      .filter(input => input && selectedInputs[input.id]?.selected)
  }, [inspectedWorkflow, selectedInputOrder, selectedInputs])

  const selectedOutputItems = useMemo(() => {
    const byId = new Map((inspectedWorkflow?.outputs || []).map(output => [output.nodeId, output]))
    return selectedOutputOrder
      .map(nodeId => byId.get(nodeId))
      .filter(output => output && selectedOutputs[output.nodeId]?.selected)
  }, [inspectedWorkflow, selectedOutputOrder, selectedOutputs])

  const activeConfig = ASSET_SECTIONS.find(section => section.key === activeSection) || ASSET_SECTIONS[0]
  const isWorkflowSection = activeSection === 'workflows'
  const sectionAssets = isWorkflowSection ? [] : (libraryAssets[activeConfig.key] || [])

  const getAssetProjectKey = useCallback((asset) => {
    if (asset?.projectId === null || asset?.projectId === undefined) return '__unassigned__'
    return String(asset.projectId)
  }, [])

  const matchesProjectFilter = useCallback((asset) => {
    if (projectFilter === 'all') return true
    return getAssetProjectKey(asset) === projectFilter
  }, [projectFilter, getAssetProjectKey])

  // Project options for the dropdown, derived from the assets actually present
  // in this section (plus an "Unassigned" bucket when relevant) so it stays
  // relevant per type and never lists projects with nothing to show here.
  const buildProjectFilterOptions = () => {
    if (isWorkflowSection) return []
    const keys = new Set(sectionAssets.map(getAssetProjectKey))
    const options = []
    Array.from(keys)
      .filter(key => key !== '__unassigned__')
      .map(key => ({ key, label: projectNameById.get(key) || `Project ${key}` }))
      .sort((left, right) => left.label.localeCompare(right.label))
      .forEach(option => options.push(option))
    if (keys.has('__unassigned__')) options.push({ key: '__unassigned__', label: 'Unassigned' })
    return options
  }
  const projectFilterOptions = buildProjectFilterOptions()

  const activeAssets = isWorkflowSection
    ? []
    : sectionAssets.filter(asset => matchesSearch(asset.name) && matchesProjectFilter(asset))

  // When grouping is on we split the (already filtered) assets into one block
  // per project, named projects first (alphabetical) and "Unassigned" last.
  const buildGroupedAssets = () => {
    if (!groupByProject || isWorkflowSection) return null
    const buckets = new Map()
    activeAssets.forEach(asset => {
      const key = getAssetProjectKey(asset)
      if (!buckets.has(key)) buckets.set(key, [])
      buckets.get(key).push(asset)
    })
    const groups = []
    Array.from(buckets.keys())
      .filter(key => key !== '__unassigned__')
      .map(key => ({ key, label: projectNameById.get(key) || `Project ${key}`, assets: buckets.get(key) }))
      .sort((left, right) => left.label.localeCompare(right.label))
      .forEach(group => groups.push(group))
    if (buckets.has('__unassigned__')) {
      groups.push({ key: '__unassigned__', label: 'Unassigned', assets: buckets.get('__unassigned__') })
    }
    return groups
  }
  const groupedAssets = buildGroupedAssets()

  const totalPages = Math.max(1, Math.ceil(activeAssets.length / ASSETS_PER_PAGE))
  const pageStart = (currentPage - 1) * ASSETS_PER_PAGE
  const paginatedAssets = activeAssets.slice(pageStart, pageStart + ASSETS_PER_PAGE)
  const pageRangeStart = activeAssets.length === 0 ? 0 : pageStart + 1
  const pageRangeEnd = Math.min(pageStart + ASSETS_PER_PAGE, activeAssets.length)

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages)
    }
  }, [currentPage, totalPages])

  const resetWorkflowState = () => {
    setWorkflowName('')
    setWorkflowJson(null)
    setInspectedWorkflow(null)
    setSelectedInputs({})
    setSelectedOutputs({})
    setSelectedInputOrder([])
    setSelectedOutputOrder([])
    setEditingWorkflowId(null)
  }

  const closeWorkflowEditor = () => {
    resetWorkflowState()
    setWorkflowEditorOpen(false)
  }

  const applySelectionToAll = (setter, selected) => {
    setter(prev => Object.fromEntries(
      Object.entries(prev).map(([key, value]) => [key, { ...value, selected }])
    ))
  }

  const handleAddInput = (input) => {
    selectWorkflowItem(setSelectedInputs, input.id, input.name, getDefaultValueType(input))
    setSelectedInputOrder(prev => (prev.includes(input.id) ? prev : [input.id, ...prev]))
  }

  const handleRemoveInput = (id) => {
    deselectWorkflowItem(setSelectedInputs, id)
    setSelectedInputOrder(prev => prev.filter(key => key !== id))
  }

  const handleAddOutput = (output) => {
    selectWorkflowItem(setSelectedOutputs, output.nodeId, output.nodeTitle, getDefaultValueType(output, true))
    setSelectedOutputOrder(prev => (prev.includes(output.nodeId) ? prev : [output.nodeId, ...prev]))
  }

  const handleRemoveOutput = (nodeId) => {
    deselectWorkflowItem(setSelectedOutputs, nodeId)
    setSelectedOutputOrder(prev => prev.filter(key => key !== nodeId))
  }

  const handleSelectAllInputs = (selected) => {
    applySelectionToAll(setSelectedInputs, selected)
    setSelectedInputOrder(selected ? (inspectedWorkflow?.inputs || []).map(input => input.id) : [])
  }

  const handleSelectAllOutputs = (selected) => {
    applySelectionToAll(setSelectedOutputs, selected)
    setSelectedOutputOrder(selected ? (inspectedWorkflow?.outputs || []).map(output => output.nodeId) : [])
  }

  const handleImportClick = () => {
    if (isWorkflowSection) {
      workflowFileInputRef.current?.click()
      return
    }

    assetFileInputRef.current?.click()
  }

  const handleAssetImportChange = async (event) => {
    const input = event.target
    const files = Array.from(input.files || [])

    if (files.length === 0) {
      return
    }

    setImporting(true)
    setImportFeedback(null)

    try {
      // Separate ABR files from regular asset files
      const abrFiles = activeSection === 'brushes' ? files.filter(f => f.name.toLowerCase().endsWith('.abr')) : []
      const regularFiles = files.filter(f => !f.name.toLowerCase().endsWith('.abr'))

      let totalImported = 0
      let totalSkipped = 0
      const abrFeedbackParts = []

      // Handle ABR files
      for (const abrFile of abrFiles) {
        try {
          const brushSamples = await parseAbrFile(abrFile)

          // Upload the first sample as the main brush asset
          const [mainBrush, ...childBrushes] = brushSamples
          const mainResult = await importLibraryAssets(
            [{ file: new File([mainBrush.pngFile], mainBrush.pngFile.name, { type: 'image/png' }) }],
            { assetType: 'brush' }
          )

          const mainAssetId = mainResult.imported?.[0]?.id
          totalImported += 1

          // Upload remaining samples as child brush edits
          if (childBrushes.length > 0 && mainAssetId) {
            const numericId = typeof mainAssetId === 'string'
              ? parseInt(mainAssetId.replace(/^library:/, ''), 10)
              : mainAssetId

            await importBrushChildAssets(
              numericId,
              childBrushes.map(b => new File([b.pngFile], b.pngFile.name, { type: 'image/png' }))
            )
          }

          const totalSamples = brushSamples.length
          abrFeedbackParts.push(
            totalSamples === 1
              ? `"${abrFile.name}": 1 brush`
              : `"${abrFile.name}": ${totalSamples} brushes (1 main + ${totalSamples - 1} edits)`
          )
        } catch (abrErr) {
          console.error(`Failed to import ABR file "${abrFile.name}":`, abrErr)
          abrFeedbackParts.push(`"${abrFile.name}": ${abrErr.message}`)
          totalSkipped += 1
        }
      }

      // Handle regular files (PNGs etc.)
      if (regularFiles.length > 0) {
        const assetsToImport = []

        for (const file of regularFiles) {
          let thumbnail = null

          if (isMeshFile(file.name)) {
            try {
              thumbnail = await createMeshThumbnailFile(file)
            } catch (err) {
              console.warn(`Failed to generate mesh thumbnail for ${file.name}:`, err)
            }
          }

          assetsToImport.push({ file, thumbnail })
        }

        const result = await importLibraryAssets(
          assetsToImport,
          activeSection === 'brushes' ? { assetType: 'brush' } : undefined
        )
        totalImported += result.imported?.length || 0
        totalSkipped += result.skipped?.length || 0
      }

      await loadLibrary()

      const feedbackParts = []
      if (regularFiles.length > 0 || abrFiles.length === 0) {
        if (totalImported > 0) feedbackParts.push(`Imported ${totalImported} asset${totalImported !== 1 ? 's' : ''}.`)
      }
      if (abrFeedbackParts.length > 0) feedbackParts.push(...abrFeedbackParts)
      if (totalSkipped > 0) feedbackParts.push(`${totalSkipped} file${totalSkipped !== 1 ? 's' : ''} skipped.`)

      setImportFeedback({
        type: totalSkipped > 0 && totalImported === 0 ? 'error' : totalSkipped > 0 ? 'warning' : 'success',
        message: feedbackParts.join(' ') || 'Import complete.'
      })
    } catch (err) {
      setImportFeedback({
        type: 'error',
        message: err.message || 'Failed to import assets.'
      })
    } finally {
      setImporting(false)
      input.value = ''
    }
  }

  const handleStartRenameEdit = (asset, edit) => {
    setRenamingEdit({ asset, edit })
    setRenamingEditName(edit.name || '')
    setImportFeedback(null)
  }

  const handleRenameEdit = async () => {
    if (!renamingEdit?.edit) {
      return
    }

    const nextName = renamingEditName.trim()
    if (!nextName) {
      setImportFeedback({
        type: 'error',
        message: 'Edit name cannot be empty.'
      })
      return
    }

    const editKey = renamingEdit.edit.filePath
    setRenamingEditKey(editKey)

    try {
      await renameAssetEdit({
        filePath: renamingEdit.edit.filePath,
        name: nextName
      })

      const data = await getLibraryAssets()
      setLibraryAssets(data)

      const refreshedAsset = (data.images || []).find(asset => asset.filename === renamingEdit.asset.filename)
      setEditPreviewAsset(refreshedAsset || null)
      setImportFeedback({
        type: 'success',
        message: `Edit renamed to ${nextName}.`
      })
      setRenamingEdit(null)
      setRenamingEditName('')
    } catch (err) {
      setImportFeedback({
        type: 'error',
        message: err.message || 'Failed to rename edit.'
      })
    } finally {
      setRenamingEditKey(null)
    }
  }

  const handleDeleteEdit = async (asset, edit) => {
    if (!edit?.filePath) {
      return
    }

    const confirmed = window.confirm(`Delete edit "${edit.name?.trim() || 'Unnamed edit'}"?`)
    if (!confirmed) {
      return
    }

    setDeletingEditKey(edit.filePath)
    setImportFeedback(null)

    try {
      await deleteAssetEdit({ filePath: edit.filePath })

      const data = await getLibraryAssets()
      setLibraryAssets(data)

      const refreshedAsset = (data.images || []).find(item => item.filename === asset.filename)
      setEditPreviewAsset(refreshedAsset || { ...asset, children: [], edits: [], childCount: 0, editCount: 0 })
      setImportFeedback({
        type: 'success',
        message: 'Edit deleted.'
      })
    } catch (err) {
      setImportFeedback({
        type: 'error',
        message: err.message || 'Failed to delete edit.'
      })
    } finally {
      setDeletingEditKey(null)
    }
  }

  const handleStartRenameAsset = (asset) => {
    setRenamingAsset(asset)
    setRenamingAssetName(asset.name || '')
    setImportFeedback(null)
  }

  const handleRenameAsset = async () => {
    if (!renamingAsset) {
      return
    }

    const nextName = renamingAssetName.trim()
    if (!nextName) {
      setImportFeedback({
        type: 'error',
        message: 'Asset name cannot be empty.'
      })
      return
    }

    const assetKey = `${renamingAsset.type}:${renamingAsset.filename}`
    setRenamingAssetKey(assetKey)

    try {
      await renameLibraryAsset({
        type: renamingAsset.type,
        filename: renamingAsset.filename,
        name: nextName
      })

      await loadLibrary()
      setImportFeedback({
        type: 'success',
        message: `${renamingAsset.name} renamed to ${nextName}.`
      })
      setRenamingAsset(null)
      setRenamingAssetName('')
    } catch (err) {
      setImportFeedback({
        type: 'error',
        message: err.message || 'Failed to rename asset.'
      })
    } finally {
      setRenamingAssetKey(null)
    }
  }

  const handleDeleteAsset = async (asset) => {
    const assetKey = `${asset.type}:${asset.filename}`
    setDeletingAssetKey(assetKey)
    setImportFeedback(null)

    try {
      await deleteLibraryAsset({
        type: asset.type,
        filename: asset.filename
      })

      await loadLibrary()
      setImportFeedback({
        type: 'success',
        message: `${asset.name} deleted.`
      })
    } catch (err) {
      if (err.status === 409) {
        setLinkedAssetDialog({
          asset,
          assetName: asset.name,
          projectId: err.details?.projectId,
          projectName: err.details?.projectName || null
        })
      } else {
        setImportFeedback({
          type: 'error',
          message: err.message || 'Failed to delete asset.'
        })
      }
    } finally {
      setDeletingAssetKey(null)
    }
  }

  const handleGoToProject = () => {
    if (!linkedAssetDialog?.projectId) {
      return
    }

    navigate(`/projects/${linkedAssetDialog.projectId}`)
    setLinkedAssetDialog(null)
  }

  const handleForceDeleteLinkedAsset = async () => {
    if (!linkedAssetDialog?.asset) {
      return
    }

    const asset = linkedAssetDialog.asset
    const assetKey = `${asset.type}:${asset.filename}`
    setDeletingAssetKey(assetKey)
    setImportFeedback(null)

    try {
      await deleteLibraryAsset({
        type: asset.type,
        filename: asset.filename,
        force: true
      })

      await loadLibrary()
      setLinkedAssetDialog(null)
      setImportFeedback({
        type: 'success',
        message: `${asset.name} deleted.`
      })
    } catch (err) {
      setImportFeedback({
        type: 'error',
        message: err.message || 'Failed to delete asset.'
      })
    } finally {
      setDeletingAssetKey(null)
    }
  }

  const handleDeleteWorkflow = async (workflow) => {
    setDeletingWorkflowId(workflow.id)
    setWorkflowFeedback('')

    try {
      await deleteAsset(workflow.id)

      if (editingWorkflowId === workflow.id) {
        resetWorkflowState()
      }

      await loadWorkflows()
      setWorkflowFeedback(`${workflow.name} deleted.`)
    } catch (err) {
      console.error('Failed to delete workflow:', err)
      setWorkflowFeedback(err.message || 'Failed to delete workflow')
    } finally {
      setDeletingWorkflowId(null)
    }
  }

  const handleWorkflowFileChange = async (event) => {
    const input = event.target
    const file = input.files?.[0]
    if (!file) return

    try {
      const fileText = await file.text()
      const parsedJson = JSON.parse(fileText)
      const inspection = await inspectComfyWorkflow(parsedJson)

      setWorkflowName(file.name.replace(/\.[^.]+$/, ''))
      setWorkflowJson(parsedJson)
      setInspectedWorkflow(inspection)
      setSelectedInputs(createSelectionMap(inspection.inputs, item => item.name))
      setSelectedOutputs(createSelectionMap(inspection.outputs, item => item.nodeTitle, true))
      setSelectedInputOrder([])
      setSelectedOutputOrder([])
      setEditingWorkflowId(null)
      setWorkflowEditorOpen(true)
      setWorkflowFeedback('')
    } catch (err) {
      console.error('Failed to inspect workflow file:', err)
      setWorkflowFeedback(err.message || 'Invalid workflow JSON file')
      resetWorkflowState()
    } finally {
      input.value = ''
    }
  }

  const handleEditWorkflow = (workflow) => {
    const hydratedSelection = hydrateWorkflowSelection(workflow)
    setWorkflowName(workflow.name)
    setWorkflowJson(workflow.workflowJson)
    setInspectedWorkflow({
      inputs: workflow.availableInputs || [],
      outputs: workflow.availableOutputs || []
    })
    setSelectedInputs(hydratedSelection.inputs)
    setSelectedOutputs(hydratedSelection.outputs)
    setSelectedInputOrder((workflow.parameters || []).map(parameter => parameter.id))
    setSelectedOutputOrder((workflow.outputs || []).map(output => output.nodeId))
    setEditingWorkflowId(workflow.id)
    setWorkflowEditorOpen(true)
    setWorkflowFeedback('')
  }

  const buildWorkflowPayload = () => {
    const parameters = (inspectedWorkflow?.inputs || [])
      .filter(input => selectedInputs[input.id]?.selected)
      .map(input => ({
        id: input.id,
        name: selectedInputs[input.id]?.name || input.name,
        valueType: selectedInputs[input.id]?.valueType || getDefaultValueType(input)
      }))

    const outputs = (inspectedWorkflow?.outputs || [])
      .filter(output => selectedOutputs[output.nodeId]?.selected)
      .map(output => ({
        nodeId: output.nodeId,
        name: selectedOutputs[output.nodeId]?.name || output.nodeTitle,
        valueType: selectedOutputs[output.nodeId]?.valueType || getDefaultValueType(output, true)
      }))

    return { parameters, outputs }
  }

  const handleSaveWorkflow = async () => {
    if (!workflowJson || !inspectedWorkflow) return

    const { parameters, outputs } = buildWorkflowPayload()

    if (outputs.length === 0) {
      setWorkflowFeedback('Select at least one ComfyUI output to save.')
      return
    }

    try {
      setWorkflowSaving(true)

      if (editingWorkflowId) {
        await updateComfyWorkflow(editingWorkflowId, {
          name: workflowName,
          parameters,
          outputs
        })
        setWorkflowFeedback('Workflow updated successfully.')
      } else {
        await importComfyWorkflow({
          name: workflowName,
          workflowJson,
          parameters,
          outputs
        })
        setWorkflowFeedback('Workflow imported successfully.')
      }

      resetWorkflowState()
      setWorkflowEditorOpen(false)
      await loadWorkflows()
    } catch (err) {
      console.error('Failed to save workflow:', err)
      setWorkflowFeedback(err.message || 'Failed to save workflow')
    } finally {
      setWorkflowSaving(false)
    }
  }

  const getSectionCount = (sectionKey) => {
    if (sectionKey === 'workflows') {
      return workflows.length
    }

    return libraryAssets[sectionKey]?.length || 0
  }

  const importButtonLabel = isWorkflowSection
    ? (workflowSaving ? 'Importing...' : 'Import JSON')
    : (importing ? 'Importing...' : 'Import')

  const importButtonDisabled = isWorkflowSection ? workflowSaving : importing

  const toggleGroupCollapse = (key) => {
    setCollapsedGroups(prev => ({ ...prev, [key]: !prev[key] }))
  }

  const renderAssetCard = (asset) => (
    <article key={asset.id} className={`asset-card ${activeSection === 'meshes' ? 'asset-card--mesh' : 'asset-card--image'}`}>
      {activeSection === 'images' || activeSection === 'brushes' ? (
        <div className={`asset-card__preview asset-card__preview--image ${activeSection === 'brushes' ? 'asset-card__preview--brush' : ''}`}>
          <img src={asset.url} alt={asset.name} className="asset-card__image" />
          {formatDimensions(asset.width, asset.height) && (
            <span className="asset-card__dimensions font-label">{formatDimensions(asset.width, asset.height)}</span>
          )}
          {activeSection === 'brushes' && (
            <span className="asset-card__mesh-tag font-label">BRUSH</span>
          )}
        </div>
      ) : (
        <div className={`asset-card__preview asset-card__preview--mesh ${asset.thumbnailUrl ? 'asset-card__preview--mesh-thumbnail' : ''}`}>
          {asset.thumbnailUrl ? (
            <>
              <img src={asset.thumbnailUrl} alt={`${asset.name} thumbnail`} className="asset-card__image" />
              <span className="asset-card__mesh-tag font-label">3D MESH</span>
            </>
          ) : (
            <>
              <span className="material-symbols-outlined asset-card__mesh-icon">view_in_ar</span>
              <span className="asset-card__mesh-label font-label">3D MESH</span>
            </>
          )}
        </div>
      )}
      <div className="asset-card__body">
        <div className="asset-card__title-row">
          <h3 className="asset-card__name">{asset.name}</h3>
          {activeSection === 'images' && (
            <button
              type="button"
              className="asset-card__icon-btn asset-card__icon-btn--edit"
              onClick={() => handleStartRenameAsset(asset)}
              disabled={renamingAssetKey === `${asset.type}:${asset.filename}`}
              title="Rename asset"
            >
              <span className="material-symbols-outlined">edit</span>
            </button>
          )}
        </div>
        <div className="asset-card__meta">
          <span className={`asset-card__badge ${activeSection === 'meshes' ? 'asset-card__badge--secondary' : ''}`}>{asset.extension}</span>
          <div className="asset-card__actions">
            {(activeSection === 'images' || activeSection === 'brushes') && getAssetChildren(asset).length > 0 && (
              <button
                type="button"
                className="asset-card__edits-btn"
                onClick={() => setEditPreviewAsset(asset)}
                title={activeSection === 'brushes' ? 'Show brush variants' : 'Show edits'}
              >
                <span className="material-symbols-outlined">history</span>
                {getAssetChildren(asset).length}
              </button>
            )}
            {activeSection === 'meshes' && getAssetChildren(asset).length > 0 && (
              <button
                type="button"
                className="asset-card__edits-btn"
                onClick={() => setMeshVersionsAsset(asset)}
                title="Show mesh versions"
              >
                <span className="material-symbols-outlined">history</span>
                {getAssetChildren(asset).length}
              </button>
            )}
            {activeSection === 'meshes' ? (
              <>
                <button type="button" className="asset-card__link asset-card__link-btn" onClick={() => setMeshPreviewAsset(asset)}>
                  OPEN
                </button>
                <button
                  type="button"
                  className="asset-card__link asset-card__link-btn"
                  onClick={() => navigate(buildMeshEditorPath(asset))}
                >
                  EDIT
                </button>
              </>
            ) : activeSection === 'images' ? (
              <>
                <a href={asset.url} target="_blank" rel="noreferrer" className="asset-card__link">OPEN</a>
                <button
                  type="button"
                  className="asset-card__link asset-card__link-btn"
                  onClick={() => navigate(buildImageEditorPath(asset))}
                >
                  EDIT
                </button>
              </>
            ) : (
              <a href={asset.url} target="_blank" rel="noreferrer" className="asset-card__link">OPEN</a>
            )}
            {activeSection !== 'images' && (
              <button
                type="button"
                className="asset-card__icon-btn asset-card__icon-btn--edit"
                onClick={() => handleStartRenameAsset(asset)}
                disabled={renamingAssetKey === `${asset.type}:${asset.filename}`}
                title="Rename asset"
              >
                <span className="material-symbols-outlined">edit</span>
              </button>
            )}
            <button
              type="button"
              className="asset-card__icon-btn"
              onClick={() => handleDeleteAsset(asset)}
              disabled={deletingAssetKey === `${asset.type}:${asset.filename}`}
              title="Delete asset"
            >
              <span className="material-symbols-outlined">delete</span>
            </button>
          </div>
        </div>
      </div>
    </article>
  )

  return (
    <div className="assets-layout">
      <Header
        showSearch
        onSettingsClick={() => setShowSettings(true)}
        searchValue={searchQuery}
        onSearchChange={setSearchQuery}
        searchPlaceholder={`Search ${activeConfig.label}`}
      />

      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      {linkedAssetDialog && (
        <div className="assets-dialog-overlay" role="presentation" onClick={() => setLinkedAssetDialog(null)}>
          <div className="assets-dialog" role="dialog" aria-modal="true" aria-labelledby="linked-asset-dialog-title" onClick={event => event.stopPropagation()}>
            <div className="assets-dialog__header">
              <h2 id="linked-asset-dialog-title" className="assets-dialog__title font-headline">Asset linked to a project</h2>
              <button type="button" className="assets-dialog__close" onClick={() => setLinkedAssetDialog(null)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="assets-dialog__body">
              <p>
                `{linkedAssetDialog.assetName}` is linked to
                {linkedAssetDialog.projectName ? ` ${linkedAssetDialog.projectName}` : ' a project'}.
                Remove it from the project before deleting the library asset.
              </p>
            </div>
            <div className="assets-dialog__actions">
              <button type="button" className="assets-dialog__btn assets-dialog__btn--secondary" onClick={() => setLinkedAssetDialog(null)}>
                Close
              </button>
              <button
                type="button"
                className="assets-dialog__btn assets-dialog__btn--danger"
                onClick={handleForceDeleteLinkedAsset}
                disabled={deletingAssetKey === `${linkedAssetDialog.asset?.type}:${linkedAssetDialog.asset?.filename}`}
              >
                Delete Anyway
              </button>
              <button type="button" className="assets-dialog__btn assets-dialog__btn--primary" onClick={handleGoToProject} disabled={!linkedAssetDialog.projectId}>
                Go to project
              </button>
            </div>
          </div>
        </div>
      )}

      {editPreviewAsset && (
        <div className="assets-dialog-overlay" role="presentation" onClick={() => setEditPreviewAsset(null)}>
          <div className="assets-dialog assets-dialog--viewer" role="dialog" aria-modal="true" aria-labelledby="asset-edits-dialog-title" onClick={event => event.stopPropagation()}>
            <div className="assets-dialog__header">
              <h2 id="asset-edits-dialog-title" className="assets-dialog__title font-headline">{editPreviewAsset.name} edits</h2>
              <button type="button" className="assets-dialog__close" onClick={() => setEditPreviewAsset(null)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="assets-dialog__body">
              {getAssetChildren(editPreviewAsset).length > 0 ? (
                <div className="asset-edits-grid">
                  {getAssetChildren(editPreviewAsset).map((edit, index) => (
                    <article key={`${edit.editId}-${edit.filePath}-${index}`} className="asset-edit-card">
                      <div className={`asset-edit-card__preview ${editPreviewAsset.type === 'brush' ? 'asset-edit-card__preview--brush' : ''}`}>
                        <img src={edit.url} alt={`${editPreviewAsset.name} ${edit.name?.trim() || `edit ${index + 1}`}`} className="asset-card__image" />
                        {formatDimensions(edit.width, edit.height) && (
                          <span className="asset-card__dimensions font-label">{formatDimensions(edit.width, edit.height)}</span>
                        )}
                      </div>
                      <div className="asset-edit-card__body">
                        <div className="asset-edit-card__details">
                          <span className="asset-edit-card__title">{edit.name?.trim() || `Edit ${index + 1}`}</span>
                          <button
                            type="button"
                            className="asset-card__icon-btn asset-card__icon-btn--edit"
                            onClick={() => handleStartRenameEdit(editPreviewAsset, edit)}
                            disabled={renamingEditKey === edit.filePath || deletingEditKey === edit.filePath}
                            title="Rename edit"
                          >
                            <span className="material-symbols-outlined">edit</span>
                          </button>
                        </div>
                        <div className="asset-card__actions">
                          <button
                            type="button"
                            className="asset-card__icon-btn"
                            onClick={() => handleDeleteEdit(editPreviewAsset, edit)}
                            disabled={deletingEditKey === edit.filePath || renamingEditKey === edit.filePath}
                            title="Delete edit"
                          >
                            <span className="material-symbols-outlined">delete</span>
                          </button>
                          <a href={edit.url} target="_blank" rel="noreferrer" className="asset-card__link">OPEN</a>
                          {editPreviewAsset.type === 'image' && (
                            <button
                              type="button"
                              className="asset-card__link asset-card__link-btn"
                              onClick={() => navigate(buildImageEditorPath({ ...edit, projectId: editPreviewAsset.projectId || edit.projectId }))}
                              title="Open in Image Editor"
                            >EDIT</button>
                          )}
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="assets-page__empty-state assets-page__empty-state--compact">
                  <span className="material-symbols-outlined">image_not_supported</span>
                  <span>No edits available for this asset.</span>
                </div>
              )}
            </div>
            <div className="assets-dialog__actions">
              <button type="button" className="assets-dialog__btn assets-dialog__btn--secondary" onClick={() => setEditPreviewAsset(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {meshVersionsAsset && (
        <div className="assets-dialog-overlay" role="presentation" onClick={() => setMeshVersionsAsset(null)}>
          <div className="assets-dialog assets-dialog--viewer" role="dialog" aria-modal="true" aria-labelledby="mesh-versions-dialog-title" onClick={event => event.stopPropagation()}>
            <div className="assets-dialog__header">
              <h2 id="mesh-versions-dialog-title" className="assets-dialog__title font-headline">{meshVersionsAsset.name} versions</h2>
              <button type="button" className="assets-dialog__close" onClick={() => setMeshVersionsAsset(null)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="assets-dialog__body">
              {getAssetChildren(meshVersionsAsset).length > 0 ? (
                <div className="asset-edits-grid">
                  {getAssetChildren(meshVersionsAsset).map((version, index) => (
                    <article key={`${version.filePath}-${index}`} className="asset-edit-card">
                      <div className={`asset-edit-card__preview asset-card__preview--mesh ${version.thumbnailUrl ? 'asset-card__preview--mesh-thumbnail' : ''}`}>
                        {version.thumbnailUrl ? (
                          <>
                            <img src={version.thumbnailUrl} alt={`${version.name?.trim() || `Version ${index + 1}`} thumbnail`} className="asset-card__image" />
                            <span className="asset-card__mesh-tag font-label">VERSION</span>
                          </>
                        ) : (
                          <>
                            <span className="material-symbols-outlined asset-card__mesh-icon">view_in_ar</span>
                            <span className="asset-card__mesh-label font-label">VERSION</span>
                          </>
                        )}
                      </div>
                      <div className="asset-edit-card__body">
                        <div className="asset-edit-card__details">
                          <span className="asset-edit-card__title">{version.name?.trim() || `Version ${index + 1}`}</span>
                        </div>
                        <div className="asset-card__actions">
                          <button type="button" className="asset-card__link asset-card__link-btn" onClick={() => setMeshPreviewAsset(version)}>
                            OPEN
                          </button>
                          <button type="button" className="asset-card__link asset-card__link-btn" onClick={() => navigate(buildMeshEditorPath(version))}>
                            EDIT
                          </button>
                        </div>
                      </div>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="library-empty-state">
                  <span className="material-symbols-outlined">deployed_code</span>
                  <span>No mesh versions available for this asset.</span>
                </div>
              )}
            </div>
            <div className="assets-dialog__actions">
              <button type="button" className="assets-dialog__btn assets-dialog__btn--secondary" onClick={() => setMeshVersionsAsset(null)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {renamingAsset && (
        <div className="assets-dialog-overlay" role="presentation" onClick={() => setRenamingAsset(null)}>
          <div className="assets-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-asset-dialog-title" onClick={event => event.stopPropagation()}>
            <div className="assets-dialog__header">
              <h2 id="rename-asset-dialog-title" className="assets-dialog__title font-headline">Rename asset</h2>
              <button type="button" className="assets-dialog__close" onClick={() => setRenamingAsset(null)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="assets-dialog__body">
              <div className="library-field">
                <label className="library-label">Asset Name</label>
                <input
                  className="library-input"
                  value={renamingAssetName}
                  onChange={event => setRenamingAssetName(event.target.value)}
                  placeholder="Enter a new asset name"
                  autoFocus
                />
              </div>
            </div>
            <div className="assets-dialog__actions">
              <button type="button" className="assets-dialog__btn assets-dialog__btn--secondary" onClick={() => setRenamingAsset(null)}>
                Cancel
              </button>
              <button type="button" className="assets-dialog__btn assets-dialog__btn--primary" onClick={handleRenameAsset} disabled={renamingAssetKey === `${renamingAsset.type}:${renamingAsset.filename}`}>
                {renamingAssetKey === `${renamingAsset.type}:${renamingAsset.filename}` ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {renamingEdit && (
        <div className="assets-dialog-overlay" role="presentation" onClick={() => setRenamingEdit(null)}>
          <div className="assets-dialog" role="dialog" aria-modal="true" aria-labelledby="rename-edit-dialog-title" onClick={event => event.stopPropagation()}>
            <div className="assets-dialog__header">
              <h2 id="rename-edit-dialog-title" className="assets-dialog__title font-headline">Rename edit</h2>
              <button type="button" className="assets-dialog__close" onClick={() => setRenamingEdit(null)}>
                <span className="material-symbols-outlined">close</span>
              </button>
            </div>
            <div className="assets-dialog__body">
              <div className="library-field">
                <label className="library-label">Edit Name</label>
                <input
                  className="library-input"
                  value={renamingEditName}
                  onChange={event => setRenamingEditName(event.target.value)}
                  placeholder="Enter a new edit name"
                  autoFocus
                />
              </div>
            </div>
            <div className="assets-dialog__actions">
              <button type="button" className="assets-dialog__btn assets-dialog__btn--secondary" onClick={() => setRenamingEdit(null)}>
                Cancel
              </button>
              <button type="button" className="assets-dialog__btn assets-dialog__btn--primary" onClick={handleRenameEdit} disabled={renamingEditKey === renamingEdit.edit.filePath}>
                {renamingEditKey === renamingEdit.edit.filePath ? 'Saving...' : 'Save'}
              </button>
            </div>
          </div>
        </div>
      )}

      {meshPreviewAsset && <MeshPreviewDialog asset={meshPreviewAsset} onClose={() => setMeshPreviewAsset(null)} />}

      {workflowEditorOpen && inspectedWorkflow && (
        <div className="assets-dialog-overlay" role="presentation" onClick={closeWorkflowEditor}>
          <div className="assets-dialog assets-dialog--workflow" role="dialog" aria-modal="true" aria-labelledby="workflow-editor-title" onClick={event => event.stopPropagation()}>
            <div className="assets-dialog__header workflow-editor__header">
              <div className="workflow-editor__heading">
                <span className="material-symbols-outlined">account_tree</span>
                <h2 id="workflow-editor-title" className="assets-dialog__title font-headline">{editingWorkflowId ? 'Edit Workflow' : 'Import Workflow'}</h2>
              </div>
              <div className="workflow-editor__topactions">
                <button
                  type="button"
                  className="library-btn library-btn--primary"
                  onClick={handleSaveWorkflow}
                  disabled={workflowSaving || !workflowName.trim()}
                >
                  {workflowSaving ? (editingWorkflowId ? 'Saving...' : 'Importing...') : (editingWorkflowId ? 'Update Workflow' : 'Save Workflow')}
                </button>
                <button type="button" className="assets-dialog__close" onClick={closeWorkflowEditor} title="Close">
                  <span className="material-symbols-outlined">close</span>
                </button>
              </div>
            </div>

            <div className="assets-dialog__body">
              {workflowFeedback && <div className="library-feedback">{workflowFeedback}</div>}

              <div className="library-field">
                <label className="library-label">Workflow Name</label>
                <input
                  className="library-input"
                  value={workflowName}
                  onChange={event => setWorkflowName(event.target.value)}
                  placeholder="Portrait Studio"
                  autoFocus
                />
              </div>

              <div className="library-config-grid">
                <section className="library-config-card">
                  <div className="library-config-card__header">
                    <div>
                      <h4>Inputs as Parameters</h4>
                      <span>{selectedInputCount} selected</span>
                    </div>
                    <div className="library-config-actions">
                      <button type="button" className="library-link-btn" onClick={() => handleSelectAllInputs(true)}>Select All</button>
                      <button type="button" className="library-link-btn" onClick={() => handleSelectAllInputs(false)}>Unselect All</button>
                    </div>
                  </div>

                  {inspectedWorkflow.inputs.length > 0 ? (
                    <div className="library-config-list">
                      <WorkflowOptionSelector
                        title="Add input"
                        items={inspectedWorkflow.inputs}
                        selectedMap={selectedInputs}
                        getKey={input => input.id}
                        getPrimaryText={input => input.label || input.name}
                        getSecondaryText={input => `${input.type} • default: ${formatDefaultValue(input.defaultValue)}`}
                        onSelect={handleAddInput}
                        emptyMessage="All inputs have already been selected."
                        searchPlaceholder="Search inputs"
                      />

                      {selectedInputItems.length > 0 ? (
                        <div className="library-selected-list">
                          {selectedInputItems.map(input => (
                            <div key={input.id} className="library-selected-item">
                              <div className="library-selected-item__header">
                                <div>
                                  <strong>{input.label || input.name}</strong>
                                  <span>{input.type} • default: {formatDefaultValue(input.defaultValue)}</span>
                                </div>
                                <button
                                  type="button"
                                  className="library-icon-btn"
                                  onClick={() => handleRemoveInput(input.id)}
                                  title="Remove input"
                                >
                                  <span className="material-symbols-outlined">delete</span>
                                </button>
                              </div>

                              <div className="library-config-fields">
                                <input
                                  className="library-input"
                                  value={selectedInputs[input.id]?.name || ''}
                                  onChange={event => setSelectedInputs(prev => ({
                                    ...prev,
                                    [input.id]: {
                                      ...prev[input.id],
                                      name: event.target.value
                                    }
                                  }))}
                                  placeholder="Parameter label"
                                />
                                <select
                                  className="library-input"
                                  value={selectedInputs[input.id]?.valueType || getDefaultValueType(input)}
                                  onChange={event => setSelectedInputs(prev => ({
                                    ...prev,
                                    [input.id]: {
                                      ...prev[input.id],
                                      valueType: event.target.value
                                    }
                                  }))}
                                >
                                  {COMFY_VALUE_TYPES.map(option => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                  ))}
                                </select>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="library-empty-inline">No inputs selected yet.</p>
                      )}
                    </div>
                  ) : (
                    <p className="library-empty-inline">No editable workflow inputs were detected.</p>
                  )}
                </section>

                <section className="library-config-card">
                  <div className="library-config-card__header">
                    <div>
                      <h4>Outputs to Save</h4>
                      <span>{selectedOutputCount} selected</span>
                    </div>
                    <div className="library-config-actions">
                      <button type="button" className="library-link-btn" onClick={() => handleSelectAllOutputs(true)}>Select All</button>
                      <button type="button" className="library-link-btn" onClick={() => handleSelectAllOutputs(false)}>Unselect All</button>
                    </div>
                  </div>

                  {inspectedWorkflow.outputs.length > 0 ? (
                    <div className="library-config-list">
                      <WorkflowOptionSelector
                        title="Add output"
                        items={inspectedWorkflow.outputs}
                        selectedMap={selectedOutputs}
                        getKey={output => output.nodeId}
                        getPrimaryText={output => output.label || output.nodeTitle}
                        getSecondaryText={output => output.classType}
                        onSelect={handleAddOutput}
                        emptyMessage="All outputs have already been selected."
                        searchPlaceholder="Search outputs"
                      />

                      {selectedOutputItems.length > 0 ? (
                        <div className="library-selected-list">
                          {selectedOutputItems.map(output => (
                            <div key={output.nodeId} className="library-selected-item">
                              <div className="library-selected-item__header">
                                <div>
                                  <strong>{output.label || output.nodeTitle}</strong>
                                  <span>{output.classType}</span>
                                </div>
                                <button
                                  type="button"
                                  className="library-icon-btn"
                                  onClick={() => handleRemoveOutput(output.nodeId)}
                                  title="Remove output"
                                >
                                  <span className="material-symbols-outlined">delete</span>
                                </button>
                              </div>

                              <div className="library-config-fields">
                                <input
                                  className="library-input"
                                  value={selectedOutputs[output.nodeId]?.name || ''}
                                  onChange={event => setSelectedOutputs(prev => ({
                                    ...prev,
                                    [output.nodeId]: {
                                      ...prev[output.nodeId],
                                      name: event.target.value
                                    }
                                  }))}
                                  placeholder="Output label"
                                />
                                <select
                                  className="library-input"
                                  value={selectedOutputs[output.nodeId]?.valueType || getDefaultValueType(output, true)}
                                  onChange={event => setSelectedOutputs(prev => ({
                                    ...prev,
                                    [output.nodeId]: {
                                      ...prev[output.nodeId],
                                      valueType: event.target.value
                                    }
                                  }))}
                                >
                                  {COMFY_VALUE_TYPES.map(option => (
                                    <option key={option.value} value={option.value}>{option.label}</option>
                                  ))}
                                </select>
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <p className="library-empty-inline">No outputs selected yet.</p>
                      )}
                    </div>
                  ) : (
                    <p className="library-empty-inline">No output nodes were detected.</p>
                  )}
                </section>
              </div>
            </div>
          </div>
        </div>
      )}

      <main className="assets-page">
        <div className="assets-page__container">
          <div className="assets-page__header">
            <div>
              <h1 className="assets-page__title font-headline">Assets Library</h1>
              <p className="assets-page__desc">Browse and import local files, meshes, and reusable ComfyUI workflows.</p>
            </div>
            <div className="assets-page__header-actions">
              <div className="assets-page__stats">
                <div className="assets-page__stat">
                  <span className="material-symbols-outlined">image</span>
                  <span>{libraryAssets.images.length} Images</span>
                </div>
                <div className="assets-page__stat">
                  <span className="material-symbols-outlined">deployed_code</span>
                  <span>{libraryAssets.meshes.length} Meshes</span>
                </div>
                <div className="assets-page__stat">
                  <span className="material-symbols-outlined">brush</span>
                  <span>{(libraryAssets.brushes || []).length} Brushes</span>
                </div>
                <div className="assets-page__stat">
                  <span className="material-symbols-outlined">account_tree</span>
                  <span>{workflows.length} Workflows</span>
                </div>
              </div>
              <button type="button" className="assets-page__import-btn" onClick={handleImportClick} disabled={importButtonDisabled}>
                <span className="material-symbols-outlined">upload_file</span>
                <span>{importButtonLabel}</span>
              </button>
            </div>
          </div>

          <input
            ref={assetFileInputRef}
            type="file"
            multiple
            className="assets-page__file-input"
            accept={activeSection === 'brushes' ? '.png,.abr' : '.png,.jpg,.jpeg,.webp,.gif,.bmp,.glb,.gltf,.obj,.fbx,.stl,.ply'}
            onChange={handleAssetImportChange}
          />

          <input
            ref={workflowFileInputRef}
            type="file"
            className="assets-page__file-input"
            accept="application/json,.json"
            onChange={handleWorkflowFileChange}
          />

          {loading ? (
            <div className="assets-page__loading">
              <span className="material-symbols-outlined assets-page__spinner">progress_activity</span>
              <span>Loading asset folders...</span>
            </div>
          ) : (
            <div className="assets-page__content">
              <aside className="assets-sidebar">
                {ASSET_SECTIONS.map(section => (
                  <button
                    key={section.key}
                    type="button"
                    className={`assets-sidebar__item ${activeSection === section.key ? 'assets-sidebar__item--active' : ''}`}
                    onClick={() => setActiveSection(section.key)}
                  >
                    <span className="material-symbols-outlined">{section.icon}</span>
                    <span className="assets-sidebar__label">{section.label}</span>
                    <span className="assets-sidebar__count">{getSectionCount(section.key)}</span>
                  </button>
                ))}
              </aside>

              <section className="assets-section">
                <div className="assets-section__header">
                  <div>
                    <h2 className="assets-section__title font-headline">{activeConfig.label}</h2>
                    <span className="assets-section__path font-label">{activeConfig.path}</span>
                  </div>
                  <div className="assets-section__summary">
                    <span>{isWorkflowSection ? `${filteredWorkflows.length} ${normalizedSearch || workflowTypeFilter !== 'all' ? 'matching' : 'total'} workflows` : `${activeAssets.length} ${normalizedSearch ? 'matching' : 'total'} assets`}</span>
                    {!isWorkflowSection && !groupByProject && <span>{pageRangeStart}-{pageRangeEnd || 0} shown</span>}
                    {!isWorkflowSection && projectFilterOptions.length > 0 && (
                      <div className="assets-section__controls">
                        <label className="assets-project-select">
                          <span className="material-symbols-outlined">filter_list</span>
                          <select
                            className="assets-project-select__input"
                            value={projectFilter}
                            onChange={event => setProjectFilter(event.target.value)}
                          >
                            <option value="all">All projects</option>
                            {projectFilterOptions.map(option => (
                              <option key={option.key} value={option.key}>{option.label}</option>
                            ))}
                          </select>
                        </label>
                        <button
                          type="button"
                          className={`assets-group-toggle ${groupByProject ? 'assets-group-toggle--active' : ''}`}
                          onClick={() => setGroupByProject(prev => !prev)}
                          title="Group assets by project"
                          aria-pressed={groupByProject}
                        >
                          <span className="material-symbols-outlined">dashboard</span>
                          <span>Group by project</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {!isWorkflowSection && importFeedback && (
                  <div className={`assets-page__feedback assets-page__feedback--${importFeedback.type}`}>
                    <span className="material-symbols-outlined">
                      {importFeedback.type === 'error' ? 'error' : importFeedback.type === 'warning' ? 'warning' : 'check_circle'}
                    </span>
                    <span>{importFeedback.message}</span>
                  </div>
                )}

                {isWorkflowSection ? (
                  <>
                    {workflowFeedback && <div className="library-feedback">{workflowFeedback}</div>}

                    {workflowTypeOptions.length > 0 && (
                      <div className="workflow-filterbar">
                        <span className="workflow-filterbar__label">
                          <span className="material-symbols-outlined">filter_list</span>
                          Output type
                        </span>
                        <div className="workflow-typefilter">
                          <button
                            type="button"
                            className={`workflow-typechip ${workflowTypeFilter === 'all' ? 'workflow-typechip--active' : ''}`}
                            onClick={() => setWorkflowTypeFilter('all')}
                          >
                            All <span className="workflow-typechip__count">{workflows.length}</span>
                          </button>
                          {workflowTypeOptions.map(option => (
                            <button
                              key={option.value}
                              type="button"
                              className={`workflow-typechip ${workflowTypeFilter === option.value ? 'workflow-typechip--active' : ''}`}
                              onClick={() => setWorkflowTypeFilter(option.value)}
                            >
                              {option.label} <span className="workflow-typechip__count">{option.count}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                    )}

                    {workflowLoading ? (
                      <div className="library-empty-state">
                        <span className="material-symbols-outlined library-spinner">progress_activity</span>
                        <span>Loading workflows...</span>
                      </div>
                    ) : filteredWorkflows.length > 0 ? (
                      <div className="workflow-grid">
                        {filteredWorkflows.map(workflow => {
                          const outputTypes = getWorkflowOutputTypes(workflow)
                          return (
                            <article key={workflow.id} className="workflow-card">
                              <div className="workflow-card__top">
                                <div className="workflow-card__heading">
                                  <span className="material-symbols-outlined workflow-card__icon">account_tree</span>
                                  <h4 className="workflow-card__name" title={workflow.name}>{workflow.name}</h4>
                                </div>
                                <div className="workflow-card__buttons">
                                  <button type="button" className="library-icon-btn" onClick={() => handleEditWorkflow(workflow)} title="Edit workflow">
                                    <span className="material-symbols-outlined">edit</span>
                                  </button>
                                  <button
                                    type="button"
                                    className="library-icon-btn"
                                    onClick={() => handleDeleteWorkflow(workflow)}
                                    title="Delete workflow"
                                    disabled={deletingWorkflowId === workflow.id}
                                  >
                                    <span className="material-symbols-outlined">delete</span>
                                  </button>
                                </div>
                              </div>

                              <div className="workflow-card__types">
                                {outputTypes.length > 0 ? outputTypes.map(type => (
                                  <span key={type} className={`workflow-type-badge workflow-type-badge--${type}`}>
                                    {COMFY_TYPE_LABEL[type] || type}
                                  </span>
                                )) : (
                                  <span className="workflow-type-badge workflow-type-badge--muted">No outputs</span>
                                )}
                              </div>

                              <div className="workflow-card__meta">
                                <span><strong>{workflow.parameters?.length || 0}</strong> params</span>
                                <span aria-hidden="true">·</span>
                                <span><strong>{workflow.outputs?.length || 0}</strong> outputs</span>
                              </div>
                            </article>
                          )
                        })}
                      </div>
                    ) : (
                      <div className="library-empty-state">
                        <span className="material-symbols-outlined">account_tree</span>
                        <span>{(normalizedSearch || workflowTypeFilter !== 'all') && workflows.length > 0 ? 'No workflows match your filters.' : 'No ComfyUI workflows imported yet.'}</span>
                      </div>
                    )}

                  </>
                ) : activeAssets.length > 0 ? (
                  groupByProject ? (
                    <div className="assets-project-groups">
                      {groupedAssets.map(group => (
                        <section key={group.key} className="assets-project-group">
                          <button
                            type="button"
                            className="assets-project-group__header"
                            onClick={() => toggleGroupCollapse(group.key)}
                            aria-expanded={!collapsedGroups[group.key]}
                          >
                            <span className="material-symbols-outlined assets-project-group__chevron">
                              {collapsedGroups[group.key] ? 'chevron_right' : 'expand_more'}
                            </span>
                            <span className="material-symbols-outlined">
                              {group.key === '__unassigned__' ? 'folder_off' : 'folder'}
                            </span>
                            <span className="assets-project-group__title">{group.label}</span>
                            <span className="assets-project-group__count">{group.assets.length}</span>
                          </button>
                          {!collapsedGroups[group.key] && (
                            <div className={`assets-grid ${activeSection === 'meshes' ? 'assets-grid--meshes' : 'assets-grid--images'}`}>
                              {group.assets.map(renderAssetCard)}
                            </div>
                          )}
                        </section>
                      ))}
                    </div>
                  ) : (
                  <>
                    <div className={`assets-grid ${activeSection === 'meshes' ? 'assets-grid--meshes' : 'assets-grid--images'}`}>
                      {paginatedAssets.map(renderAssetCard)}
                    </div>

                    <div className="assets-pagination">
                      <div className="assets-pagination__summary">
                        Showing {pageRangeStart}-{pageRangeEnd} of {activeAssets.length}
                      </div>
                      <div className="assets-pagination__controls">
                        <button type="button" className="assets-pagination__button" onClick={() => setCurrentPage(page => Math.max(1, page - 1))} disabled={currentPage === 1}>
                          Previous
                        </button>
                        <span className="assets-pagination__page">Page {currentPage} / {totalPages}</span>
                        <button type="button" className="assets-pagination__button" onClick={() => setCurrentPage(page => Math.min(totalPages, page + 1))} disabled={currentPage === totalPages}>
                          Next
                        </button>
                      </div>
                    </div>
                  </>
                  )
                ) : (
                  <div className="assets-page__empty-state">
                    <span className="material-symbols-outlined">{activeConfig.emptyIcon}</span>
                    <span>{normalizedSearch && sectionAssets.length > 0 ? `No ${activeConfig.label.toLowerCase()} match your search.` : activeConfig.emptyMessage}</span>
                  </div>
                )}
              </section>
            </div>
          )}
        </div>
      </main>

      <Footer />
    </div>
  )
}
