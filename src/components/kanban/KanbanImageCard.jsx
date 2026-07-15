import Viewer from '../Viewer'
import MeshGenApiOptions from './MeshGenApiOptions'
import ComfyTextButton from '../comfy/ComfyTextButton'
import {
  buildMeshEditorPath,
  canFetchHitemMeshResult,
  canFetchTencentMeshResult,
  canFetchTripoMeshResult,
  getWorkflowParameterValueType,
  isHitemMeshGenerationApi,
  isTencentMeshGenerationApi,
  isTripoMeshGenerationApi
} from '../../utils/kanbanHelpers'

// A single Kanban board card (image / image-edit / mesh-gen / mesh-edit / texturing).
// Presentational: all board state, derived selectors, and handlers are passed in
// via props (spread from the page's cardContext). Behavior is identical to the
// former inline `renderImageCard` in KanbanPage.
export default function KanbanImageCard({
  card,
  showAttributes = false,
  // board state
  projectId,
  imageCardPages,
  setImageCardPages,
  cardAttributesByCardId,
  imageEditDraft,
  draggedCard,
  imageEditPreviewIndexes,
  imageEditPendingCardId,
  imageEditProgressByCardId,
  attributeTypes,
  // derived selectors
  getCardRuntimeState,
  getCardPreviewItems,
  getCardImageSourceGroups,
  getCardMeshSourceGroups,
  getApiOptionsForCard,
  getWorkflowsForCard,
  getAssetEditDisplayItems,
  getAssetPreviewUrl,
  formatAssetDimensions,
  getWorkflowSourceOptionLabel,
  getAttributeOptionsForCard,
  getPromptOptionsForCard,
  getImageEditParameterBinding,
  resolveImageEditParameterValue,
  getCardFileSourceGroups,
  // handlers
  navigate,
  handleCardDragStart,
  handleCardDragEnd,
  openImageSourceMenu,
  handleRemoveImageCard,
  openMeshPreview,
  handleRemoveImage,
  handleImageEditPreviewStep,
  openImageEditActionMenu,
  handleGetAsyncMeshResult,
  handleImageEditDraftChange,
  handleImageEditParameterSourceChange,
  handleImageEditParameterValueChange,
  handleRunImageEdit,
  closeImageEditActionMenu,
  handleAddCustomAttribute,
  handleAttributeTypeChange,
  handleAttributeValueChange,
  handleAttributeValueBlur,
  handleDeleteCustomAttribute
}) {
  const runtimeState = getCardRuntimeState(card)
  const cardLocked = runtimeState?.status === 'processing' || runtimeState?.status === 'queued'
  const canFetchAsyncResult = canFetchTencentMeshResult(runtimeState) || canFetchTripoMeshResult(runtimeState) || canFetchHitemMeshResult(runtimeState)
  const displaySourceLabel = runtimeState?.source
    ? String(runtimeState.source).toUpperCase()
    : card.sourceLabel
  const displayMetaLabel = cardLocked
    ? (Number.isFinite(runtimeState?.progressPercent)
        ? `${runtimeState.progressPercent}%`
        : (runtimeState?.detail || card.metaLabel || 'Processing…'))
    : card.metaLabel
  const isMeshGenCard = card.kanbanColumnId === 3
  const isMeshEditCard = card.kanbanColumnId === 4
  const isTexturingCard = card.kanbanColumnId === 5
  const isRiggingCard = card.kanbanColumnId === 6
  const isMeshWorkflowCard = isMeshGenCard || isMeshEditCard || isTexturingCard || isRiggingCard
  const carouselItems = getCardPreviewItems(card, showAttributes)
  const useAssetCarousel = carouselItems.length > 0
  const previewAssets = isMeshWorkflowCard && (card.meshAssets?.length || 0) > 0 && !useAssetCarousel
    ? card.meshAssets
    : card.assets
  const totalPages = useAssetCarousel
    ? Math.max(1, carouselItems.length)
    : Math.max(1, Math.ceil(previewAssets.length / 4))
  const currentPage = Math.min(imageCardPages[card.id] || 0, totalPages - 1)
  const visibleAssets = useAssetCarousel
    ? carouselItems.slice(currentPage, currentPage + 1)
    : previewAssets.slice(currentPage * 4, currentPage * 4 + 4)
  const attributes = cardAttributesByCardId[card.id] || []
  const imageSourceGroups = getCardImageSourceGroups(card)
  const meshSourceGroups = getCardMeshSourceGroups(card)
  const availableActionApis = getApiOptionsForCard(card)
  const availableActionWorkflows = getWorkflowsForCard(card)
  const selectedActionWorkflow = availableActionWorkflows.find(workflow => workflow.id == imageEditDraft?.workflowId) || null
  const apiSourceGroups = isMeshEditCard || isTexturingCard || isRiggingCard ? meshSourceGroups : imageSourceGroups
  const apiSourceValueType = isMeshEditCard || isTexturingCard || isRiggingCard ? 'mesh' : 'image'

  return (
    <div
      className={`image-card ${draggedCard?.id === card.id ? 'image-card--dragging' : ''} ${cardLocked ? 'image-card--loading image-card--locked' : ''}`}
      id={`image-card-${card.id}`}
      draggable={!cardLocked}
      onDragStart={(event) => handleCardDragStart(event, card)}
      onDragEnd={handleCardDragEnd}
    >
      <div className="image-card__actions">
        {!showAttributes && (
          <button
            className="image-card__action-btn"
            disabled={cardLocked}
            onClick={(e) => {
              e.stopPropagation()
              openImageSourceMenu(card.id)
            }}
            title="Add more images"
          >
            <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>add_photo_alternate</span>
          </button>
        )}
        <button
          className="image-card__action-btn image-card__delete"
          disabled={cardLocked}
          onClick={(e) => {
            e.stopPropagation()
            handleRemoveImageCard(card.id, card.allAssets || card.assets)
          }}
          title="Remove card"
        >
          <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
        </button>
      </div>

      <div className={`image-card__thumb ${visibleAssets.length > 1 && !useAssetCarousel ? 'image-card__thumb--grid' : ''} ${useAssetCarousel ? 'image-card__thumb--carousel' : ''} ${cardLocked && visibleAssets.length === 0 ? 'image-card__thumb--loading' : ''}`}>
        {visibleAssets.length > 0 ? (
          visibleAssets.map(asset => {
            const displayItems = showAttributes && !useAssetCarousel && asset.type === 'image' ? getAssetEditDisplayItems(asset) : []
            const previewIndex = showAttributes
              ? Math.min(imageEditPreviewIndexes[asset.id] || 0, Math.max(0, displayItems.length - 1))
              : 0
            const previewItem = showAttributes ? (displayItems[previewIndex] || displayItems[0]) : asset
            const previewFilename = useAssetCarousel
              ? (asset.previewFilename || asset.filename)
              : (showAttributes ? previewItem?.filename : asset.filename)
            const previewName = useAssetCarousel
              ? asset.name
              : (showAttributes ? previewItem?.name : asset.name)
            const previewDimensions = useAssetCarousel
              ? formatAssetDimensions(asset.width, asset.height)
              : (showAttributes ? formatAssetDimensions(previewItem?.width, previewItem?.height) : formatAssetDimensions(asset.width, asset.height))
            const previewType = useAssetCarousel ? asset.assetType : asset.type
            const previewUrl = getAssetPreviewUrl(previewFilename)
            const sourceAsset = useAssetCarousel ? asset.asset : asset
            const modelUrl = getAssetPreviewUrl(sourceAsset?.filename)

            return (
            <div
              key={asset.key || asset.id}
              className={`image-card__thumb-item ${previewType === 'mesh' ? 'image-card__thumb-item--mesh' : ''}`}
              onClick={previewType === 'mesh' ? (event) => {
                event.stopPropagation()
                openMeshPreview(sourceAsset)
              } : undefined}
              role={previewType === 'mesh' ? 'button' : undefined}
              tabIndex={previewType === 'mesh' ? 0 : undefined}
              onKeyDown={previewType === 'mesh' ? (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                  event.preventDefault()
                  event.stopPropagation()
                  openMeshPreview(sourceAsset)
                }
              } : undefined}
            >
              {previewType === 'mesh' && previewUrl ? (
                asset.previewFilename ? (
                  <img
                    src={previewUrl}
                    alt={previewName}
                    className="image-card__thumb-image"
                  />
                ) : (
                  <Viewer
                    height="100%"
                    modelUrl={modelUrl}
                  />
                )
              ) : previewFilename ? (
                <img
                  src={previewUrl}
                  alt={previewName}
                  className="image-card__thumb-image"
                />
              ) : (
                <div className="image-card__thumb-placeholder">
                  <span className="material-symbols-outlined" style={{ fontSize: '32px', color: 'rgba(143,245,255,0.08)' }}>{previewType === 'mesh' ? 'deployed_code' : 'image'}</span>
                </div>
              )}

              {!showAttributes && !useAssetCarousel && (
                <button
                  className="image-card__thumb-remove"
                  disabled={cardLocked}
                  onClick={(e) => {
                    e.stopPropagation()
                    handleRemoveImage(asset.id)
                  }}
                  title="Remove image"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>close</span>
                </button>
              )}

              {previewType === 'mesh' && sourceAsset?.id && (
                <button
                  className="image-card__thumb-remove image-card__thumb-remove--left"
                  disabled={cardLocked}
                  onClick={(event) => {
                    event.stopPropagation()
                    handleRemoveImage(sourceAsset.id)
                  }}
                  title="Remove mesh"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>close</span>
                </button>
              )}

              {showAttributes && (
                <div className="image-card__thumb-caption font-label">
                  {previewName}
                </div>
              )}

              {previewType === 'image' && previewDimensions && (
                <div className={`image-card__thumb-dimensions font-label ${showAttributes ? 'image-card__thumb-dimensions--with-caption' : ''}`}>
                  {previewDimensions}
                </div>
              )}

              {useAssetCarousel && previewType === 'mesh' && (
                <div className="image-card__edit-preview-indicator font-label">
                  3D MESH
                </div>
              )}

              {useAssetCarousel && previewType === 'mesh' && sourceAsset?.id && [3, 4, 5].includes(card.kanbanColumnId) && (
                <button
                  type="button"
                  className="image-card__mesh-edit-btn"
                  disabled={cardLocked}
                  onClick={(event) => {
                    event.stopPropagation()
                    navigate(buildMeshEditorPath(sourceAsset, projectId, `/projects/${projectId}`))
                  }}
                  title="Edit mesh"
                >
                  <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>edit</span>
                  EDIT
                </button>
              )}

              {showAttributes && !useAssetCarousel && displayItems.length > 1 && (
                <>
                  <div className="image-card__edit-preview-indicator font-label">
                    {previewIndex === 0
                      ? `ORIGINAL • 1/${displayItems.length}`
                      : `EDIT ${previewIndex}/${displayItems.length - 1} • ${previewIndex + 1}/${displayItems.length}`}
                  </div>
                  <button
                    className="image-card__thumb-nav image-card__thumb-nav--prev"
                    onClick={(event) => {
                      event.stopPropagation()
                      handleImageEditPreviewStep(asset, -1)
                    }}
                    title="Previous image edit"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>chevron_left</span>
                  </button>
                  <button
                    className="image-card__thumb-nav image-card__thumb-nav--next"
                    onClick={(event) => {
                      event.stopPropagation()
                      handleImageEditPreviewStep(asset, 1)
                    }}
                    title="Next image edit"
                  >
                    <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>chevron_right</span>
                  </button>
                </>
              )}
            </div>
          )})
        ) : cardLocked ? (
          <div className="image-card__loading-state">
            <span className="material-symbols-outlined image-card__loading-spinner">progress_activity</span>
            <span className="font-label image-card__loading-label">
              {Number.isFinite(runtimeState?.progressPercent) ? `${runtimeState.progressPercent}%` : 'PROCESSING'}
            </span>
          </div>
        ) : (
          <div className="image-card__thumb-placeholder">
            <span className="material-symbols-outlined" style={{ fontSize: '32px', color: 'rgba(143,245,255,0.08)' }}>image</span>
          </div>
        )}

        {totalPages > 1 && (
          <>
            <button
              className="image-card__thumb-nav image-card__thumb-nav--prev"
              onClick={(e) => {
                e.stopPropagation()
                setImageCardPages(prev => ({
                  ...prev,
                  [card.id]: Math.max(0, currentPage - 1)
                }))
              }}
              disabled={cardLocked || currentPage === 0}
              title={useAssetCarousel ? 'Previous asset' : 'Previous images'}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>chevron_left</span>
            </button>
            <button
              className="image-card__thumb-nav image-card__thumb-nav--next"
              onClick={(e) => {
                e.stopPropagation()
                setImageCardPages(prev => ({
                  ...prev,
                  [card.id]: Math.min(totalPages - 1, currentPage + 1)
                }))
              }}
              disabled={cardLocked || currentPage >= totalPages - 1}
              title={useAssetCarousel ? 'Next asset' : 'Next images'}
            >
              <span className="material-symbols-outlined" style={{ fontSize: '18px' }}>chevron_right</span>
            </button>
            <div className="image-card__thumb-page-indicator font-label">
              {currentPage + 1}/{totalPages}
            </div>
          </>
        )}
      </div>

      <div className="image-card__info">
        <div className="image-card__row">
          <h3 className="image-card__name">{card.primaryDisplayAsset?.name || 'Untitled asset'}</h3>
          <div className="image-card__badges">
            {card.assets.length > 1 && (
              <span className="image-card__count font-label">{card.assets.length} IMAGES</span>
            )}
            <span
              className="image-card__source"
              style={{
                color: ['AI GEN', 'COMFYUI'].includes(displaySourceLabel) ? 'var(--primary)' : 'var(--on-surface-variant)',
                background: ['AI GEN', 'COMFYUI'].includes(displaySourceLabel) ? 'rgba(143,245,255,0.1)' : 'rgba(71,72,74,0.2)',
              }}
            >
              {displaySourceLabel}
            </span>
          </div>
        </div>
        <p className="image-card__meta font-label">{displayMetaLabel}</p>

        {runtimeState && (
          <div className="image-card__edit-progress">
            <p className="image-card__meta font-label">{runtimeState.detail || (cardLocked ? 'Processing…' : 'Last operation update')}</p>
            {runtimeState.currentNodeLabel && (
              <p className="image-card__meta font-label image-card__meta--loading-node">
                {runtimeState.currentNodeLabel}
              </p>
            )}
            {Number.isFinite(runtimeState.progressPercent) && (
              <div className="image-card__progress" aria-hidden="true">
                <div
                  className="image-card__progress-bar"
                  style={{ width: `${Math.max(0, Math.min(100, runtimeState.progressPercent || 0))}%` }}
                />
              </div>
            )}
          </div>
        )}

        {showAttributes && (
          <div className="image-card__attributes">
            <div className="image-card__edit-actions">
              <button className="image-card__edit-action-btn" onClick={() => openImageEditActionMenu(card)} disabled={cardLocked}>
                <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>play_arrow</span>
                Action
              </button>
              {canFetchAsyncResult && (
                <button className="image-card__edit-action-btn" onClick={() => handleGetAsyncMeshResult(card)} disabled={imageEditPendingCardId === card.id}>
                  <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>refresh</span>
                  GET RESULT
                </button>
              )}

              {imageEditDraft?.cardId === card.id && !imageEditDraft?.mode && imageEditPendingCardId !== card.id && (
                <div className="image-card__edit-action-menu">
                  <button className="image-card__edit-action-option" onClick={() => openImageEditActionMenu(card, 'api')}>
                    API
                  </button>
                  <button className="image-card__edit-action-option" onClick={() => openImageEditActionMenu(card, 'comfy')}>
                    ComfyUI
                  </button>
                </div>
              )}

              {imageEditDraft?.cardId === card.id && imageEditDraft?.mode && imageEditPendingCardId !== card.id && (
                <div className="image-card__edit-panel">
                  <div className="params-card__field">
                    <label className="params-card__label font-label">NAME</label>
                    <input
                      type="text"
                      className="params-card__input"
                      value={imageEditDraft.name}
                      onChange={event => handleImageEditDraftChange(card, 'name', event.target.value)}
                      placeholder="Enter edit name"
                      required
                    />
                  </div>

                  {imageEditDraft.mode === 'api' ? (
                    <>
                      <div className="params-card__field">
                        <label className="params-card__label font-label">{isMeshEditCard || isTexturingCard || isRiggingCard ? 'Mesh' : 'Image'}</label>
                        <select
                          className="image-card__attribute-select"
                          value={imageEditDraft.selectedAssetId}
                          onChange={event => handleImageEditDraftChange(card, 'selectedAssetId', event.target.value)}
                        >
                          {isMeshGenCard && (isTencentMeshGenerationApi(imageEditDraft.selectedApi) || isTripoMeshGenerationApi(imageEditDraft.selectedApi)) && (
                            <option value="">No image source (use prompt)</option>
                          )}
                          {apiSourceGroups.length === 0 && <option value="">{isMeshEditCard || isTexturingCard || isRiggingCard ? 'No meshes available' : 'No images available'}</option>}
                          {apiSourceGroups.map(group => (
                            <optgroup key={group.asset.id} label={group.asset.name}>
                              {group.options.map(option => (
                                <option key={option.value} value={option.value}>
                                  {getWorkflowSourceOptionLabel(apiSourceValueType, option)}
                                </option>
                              ))}
                            </optgroup>
                          ))}
                        </select>
                      </div>

                      <div className="params-card__field">
                        <label className="params-card__label font-label">API</label>
                        <select
                          className="image-card__attribute-select"
                          value={imageEditDraft.selectedApi}
                          onChange={event => handleImageEditDraftChange(card, 'selectedApi', event.target.value)}
                          disabled={availableActionApis.length === 0}
                        >
                          {availableActionApis.length === 0 && <option value="">No APIs available</option>}
                          {availableActionApis.map(api => (
                            <option key={api.id} value={api.id}>{api.name}</option>
                          ))}
                        </select>
                      </div>

                      {/* Hitem3D is image-only and does not take a prompt. */}
                      {!(isMeshGenCard && isHitemMeshGenerationApi(imageEditDraft.selectedApi)) && (
                      <div className="params-card__field">
                        <label className="params-card__label font-label">{isMeshGenCard && (isTencentMeshGenerationApi(imageEditDraft.selectedApi) || isTripoMeshGenerationApi(imageEditDraft.selectedApi)) ? 'Prompt' : 'Prompt Source'}</label>
                        {isMeshGenCard && (isTencentMeshGenerationApi(imageEditDraft.selectedApi) || isTripoMeshGenerationApi(imageEditDraft.selectedApi)) ? (
                          <div className="comfy-textfield-wrap">
                            <textarea
                              className="gen-prompt-input"
                              value={imageEditDraft.prompt || ''}
                              onChange={event => handleImageEditDraftChange(card, 'prompt', event.target.value)}
                              placeholder="Describe the mesh to generate"
                            />
                            <ComfyTextButton
                              className="comfy-text-btn--corner"
                              onResult={text => handleImageEditDraftChange(card, 'prompt', text)}
                            />
                          </div>
                        ) : (
                          <select
                            className="image-card__attribute-select"
                            value={imageEditDraft.promptSource}
                            onChange={event => handleImageEditDraftChange(card, 'promptSource', event.target.value)}
                          >
                            {getPromptOptionsForCard(card.id).map(option => (
                              <option key={option.id} value={option.id}>{option.label}</option>
                            ))}
                          </select>
                        )}
                      </div>
                      )}

                      {(!isMeshGenCard || (!isTencentMeshGenerationApi(imageEditDraft.selectedApi) && !isTripoMeshGenerationApi(imageEditDraft.selectedApi) && !isHitemMeshGenerationApi(imageEditDraft.selectedApi))) && imageEditDraft.promptSource === 'custom' && (
                        <div className="params-card__field">
                          <label className="params-card__label font-label">Custom Prompt</label>
                          <div className="comfy-textfield-wrap">
                            <textarea
                              className="gen-prompt-input"
                              value={imageEditDraft.customPrompt}
                              onChange={event => handleImageEditDraftChange(card, 'customPrompt', event.target.value)}
                              placeholder="Enter a custom prompt"
                            />
                            <ComfyTextButton
                              className="comfy-text-btn--corner"
                              onResult={text => handleImageEditDraftChange(card, 'customPrompt', text)}
                            />
                          </div>
                        </div>
                      )}

                      {isMeshGenCard && (
                        <MeshGenApiOptions
                          draft={imageEditDraft}
                          onChange={(field, value) => handleImageEditDraftChange(card, field, value)}
                        />
                      )}
                    </>
                  ) : (
                    <>
                      <div className="params-card__field">
                        <label className="params-card__label font-label">ComfyUI Workflow</label>
                        <select
                          className="image-card__attribute-select"
                          value={imageEditDraft.workflowId}
                          onChange={event => handleImageEditDraftChange(card, 'workflowId', event.target.value)}
                          disabled={availableActionWorkflows.length === 0}
                        >
                          {availableActionWorkflows.length === 0 && <option value="">No workflows available</option>}
                          {[...availableActionWorkflows].sort((a, b) => (a.name || '').localeCompare(b.name || '')).map(workflow => (
                            <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
                          ))}
                        </select>
                      </div>

                      {selectedActionWorkflow ? (
                        selectedActionWorkflow.parameters.map(parameter => {
                          const valueType = getWorkflowParameterValueType(parameter)
                          const binding = getImageEditParameterBinding(imageEditDraft, parameter)
                          const resolvedValue = resolveImageEditParameterValue(card, imageEditDraft, parameter)

                          if (['image', 'mesh'].includes(valueType)) {
                            const selectedAssetSource = binding.source || ''
                            const sourceGroups = getCardFileSourceGroups(card, valueType)

                            return (
                              <div key={parameter.id} className="params-card__field">
                                <label className="params-card__label font-label">{parameter.name} • {valueType.toUpperCase()}</label>
                                <select
                                  className="image-card__attribute-select"
                                  value={selectedAssetSource}
                                  onChange={event => handleImageEditParameterSourceChange(card, parameter, event.target.value)}
                                >
                                  {sourceGroups.map(group => (
                                    <optgroup key={group.asset.id} label={group.asset.name}>
                                      {group.options.map(option => (
                                        <option key={option.value} value={option.value}>
                                          {getWorkflowSourceOptionLabel(valueType, option)}
                                        </option>
                                      ))}
                                    </optgroup>
                                  ))}
                                </select>
                                <span className="image-card__param-hint">{parameter.label}</span>
                              </div>
                            )
                          }

                          if (valueType === 'boolean') {
                            return (
                              <div key={parameter.id} className="params-card__field">
                                <label className="params-card__label font-label">{parameter.name} • BOOLEAN</label>
                                <label className="params-card__checkbox-label">
                                  <div className={`params-card__checkbox ${binding.customValue ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`} onClick={() => handleImageEditParameterValueChange(card, parameter, !binding.customValue)}>
                                    {binding.customValue && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                                  </div>
                                  <span>{parameter.label || 'Toggle value'}</span>
                                </label>
                              </div>
                            )
                          }

                          const sourceOptions = getAttributeOptionsForCard(card.id, valueType === 'number' ? 'Number' : 'Text')

                          return (
                            <div key={parameter.id} className="params-card__field">
                              <label className="params-card__label font-label">{parameter.name} • {valueType.toUpperCase()}</label>
                              <select
                                className="image-card__attribute-select"
                                value={binding.source || 'custom'}
                                onChange={event => handleImageEditParameterSourceChange(card, parameter, event.target.value)}
                              >
                                {sourceOptions.map(option => (
                                  <option key={option.id} value={option.id}>{option.label}</option>
                                ))}
                              </select>
                              {valueType === 'string' ? (
                                <div className="comfy-textfield-wrap">
                                  <textarea
                                    className="gen-prompt-input image-card__param-textarea"
                                    value={binding.source === 'custom' ? (binding.customValue ?? '') : String(resolvedValue ?? '')}
                                    onChange={event => handleImageEditParameterValueChange(card, parameter, event.target.value)}
                                    disabled={binding.source !== 'custom'}
                                    placeholder={`Enter ${valueType} value`}
                                  />
                                  {binding.source === 'custom' && (
                                    <ComfyTextButton
                                      className="comfy-text-btn--corner"
                                      onResult={text => handleImageEditParameterValueChange(card, parameter, text)}
                                    />
                                  )}
                                </div>
                              ) : (
                                <input
                                  type={valueType === 'number' ? 'number' : 'text'}
                                  className="params-card__input"
                                  value={binding.source === 'custom' ? (binding.customValue ?? '') : String(resolvedValue ?? '')}
                                  onChange={event => handleImageEditParameterValueChange(card, parameter, event.target.value)}
                                  disabled={binding.source !== 'custom'}
                                  placeholder={`Enter ${valueType} value`}
                                />
                              )}
                              <span className="image-card__param-hint">{parameter.label}</span>
                            </div>
                          )
                        })
                      ) : (
                        <div className="image-card__asset-picker-empty image-card__asset-picker-empty--compact">
                          <span className="material-symbols-outlined">tune</span>
                          <span>{isMeshGenCard
                            ? 'No compatible ComfyUI workflow available for mesh generation.'
                            : isMeshEditCard
                              ? 'No compatible ComfyUI workflow available for mesh edits.'
                              : isTexturingCard
                                ? 'No compatible ComfyUI workflow available for mesh texturing.'
                              : isRiggingCard
                                ? 'No compatible ComfyUI workflow available for mesh rigging.'
                              : 'No compatible ComfyUI workflow available for image edits.'}</span>
                        </div>
                      )}

                      {(selectedActionWorkflow?.parameters || []).length > 0 && (
                        <label className="params-card__checkbox-label" style={{ marginTop: '0.5rem' }}>
                          <div className={`params-card__checkbox ${imageEditDraft.setAsDefault ? 'params-card__checkbox--checked' : 'params-card__checkbox--unchecked'}`} onClick={() => handleImageEditDraftChange(card, 'setAsDefault', !imageEditDraft.setAsDefault)}>
                            {imageEditDraft.setAsDefault && <span className="material-symbols-outlined" style={{ fontSize: '10px', color: 'var(--on-tertiary)', fontWeight: 700 }}>check</span>}
                          </div>
                          <span>Set as default</span>
                        </label>
                      )}
                    </>
                  )}

                  <div className="image-card__edit-panel-actions">
                    <button
                      className="gen-btn"
                      onClick={() => handleRunImageEdit(card)}
                      disabled={imageEditPendingCardId === card.id || !imageEditDraft.name?.trim()}
                    >
                      <span className="material-symbols-outlined">bolt</span>
                      {imageEditPendingCardId === card.id
                        ? `${imageEditProgressByCardId[card.id]?.progressPercent || 0}%`
                        : 'RUN ACTION'}
                    </button>
                    <button className="kanban-sidebar__nav-item" onClick={closeImageEditActionMenu} style={{ justifyContent: 'center' }}>
                      CANCEL
                    </button>
                  </div>

                  {imageEditPendingCardId === card.id && imageEditProgressByCardId[card.id] && (
                    <div className="image-card__edit-progress">
                      <p className="image-card__meta font-label">{imageEditProgressByCardId[card.id].detail}</p>
                      {imageEditProgressByCardId[card.id].currentNodeLabel && (
                        <p className="image-card__meta font-label image-card__meta--loading-node">
                          {imageEditProgressByCardId[card.id].currentNodeLabel}
                        </p>
                      )}
                      <div className="image-card__progress" aria-hidden="true">
                        <div
                          className="image-card__progress-bar"
                          style={{ width: `${Math.max(0, Math.min(100, imageEditProgressByCardId[card.id].progressPercent || 0))}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>

            <div className="image-card__attributes-header">
              <span className="image-card__attributes-title font-label">CUSTOM ATTRIBUTES</span>
              <button className="image-card__attribute-add" onClick={() => handleAddCustomAttribute(card.id)} disabled={cardLocked}>
                <span className="material-symbols-outlined" style={{ fontSize: '14px' }}>add</span>
                Add Custom Attribute
              </button>
            </div>

            {attributes.length > 0 ? (
              <div className="image-card__attribute-list">
                {attributes.map(attribute => {
                  const selectedType = attributeTypes.find(type => type.id === attribute.attributeTypeId)

                  return (
                    <div key={`${attribute.cardId}-${attribute.position}`} className="image-card__attribute-row">
                      <select
                        className="image-card__attribute-select"
                        value={attribute.attributeTypeId}
                        onChange={event => handleAttributeTypeChange(card.id, attribute.position, Number(event.target.value))}
                        disabled={cardLocked}
                      >
                        {attributeTypes.map(type => (
                          <option key={type.id} value={type.id}>{type.name}</option>
                        ))}
                      </select>

                      <input
                        type={selectedType?.name === 'Number' ? 'number' : 'text'}
                        className="image-card__attribute-input"
                        value={attribute.attributeValue || ''}
                        onChange={event => handleAttributeValueChange(card.id, attribute.position, event.target.value)}
                        onBlur={event => handleAttributeValueBlur(card.id, attribute.position, event.target.value)}
                        disabled={cardLocked}
                        placeholder={`Enter ${selectedType?.name?.toLowerCase() || 'attribute'} value`}
                      />

                      <button
                        className="image-card__attribute-delete"
                        onClick={() => handleDeleteCustomAttribute(card.id, attribute.position)}
                        disabled={cardLocked}
                        title="Delete attribute"
                      >
                        <span className="material-symbols-outlined" style={{ fontSize: '16px' }}>delete</span>
                      </button>
                    </div>
                  )
                })}
              </div>
            ) : (
              <div className="image-card__attribute-empty">
                No custom attributes yet.
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
