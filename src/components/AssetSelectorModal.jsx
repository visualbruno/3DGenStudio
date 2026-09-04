// components/AssetSelectorModal.jsx
import { useEffect, useMemo, useState } from 'react';
import { useProjects } from '../context/ProjectContext';
import { assetUrl } from '../config';
import TagFilter from './TagFilter';
import './AssetSelectorModal.css'; // we'll create a separate CSS or reuse AssetsPage.css

function formatDimensions(width, height) {
  if (!width || !height) return null;
  return `${width} × ${height}`;
}

function getAssetPreviewUrl(filename) {
  if (!filename) return null;
  return assetUrl(filename);
}

const ASSETS_PER_PAGE = 20;
// Meshes show 3 per row, so 21 (7 full rows) paginates more cleanly than 20.
const MESHES_PER_PAGE = 21;

// `multiple` turns the grid into a multi-select and makes onSelect receive an
// ARRAY. It is opt-in for a reason: six call sites rely on onSelect(oneAsset),
// so the single-select path below stays byte-identical.
export default function AssetSelectorModal({ assetType, onSelect, onClose, showEdits = false, multiple = false, title }) {
  const { getLibraryAssets, projects } = useProjects();
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedAssetKey, setSelectedAssetKey] = useState(null);
  const [selectedAssetKeys, setSelectedAssetKeys] = useState(() => new Set());
  const [currentPage, setCurrentPage] = useState(1);
  const [searchQuery, setSearchQuery] = useState('');
  const [projectFilter, setProjectFilter] = useState('all');
  const [tagFilter, setTagFilter] = useState([]);

  // Valid types: 'image', 'mesh', or 'brush'
  const validType = assetType === 'mesh' ? 'mesh' : (assetType === 'brush' ? 'brush' : 'image');

  const libraryKey = validType === 'mesh' ? 'meshes' : (validType === 'brush' ? 'brushes' : 'images');
  const titleLabel = validType === 'mesh' ? 'Mesh' : (validType === 'brush' ? 'Brush' : 'Image');
  const pluralLabel = validType === 'mesh' ? 'meshes' : (validType === 'brush' ? 'brushes' : 'images');
  const emptyIcon = validType === 'mesh' ? 'deployed_code' : (validType === 'brush' ? 'brush' : 'image_not_supported');
  const includeChildren = showEdits || validType === 'brush';

  const getAssetSelectorKey = (asset) => {
    if (!asset) return '';
    return asset.isChild ? `child:${asset.id}:${asset.filePath || asset.filename || asset.name}` : `asset:${asset.id}`;
  };

  useEffect(() => {
    async function loadAssets() {
      setLoading(true);
      try {
        const library = await getLibraryAssets();
        const filtered = library[libraryKey] || [];
        
        if (includeChildren) {
          // Flatten: include each parent asset and its children (edits/versions)
          const flattened = [];
          filtered.forEach(asset => {
            // Include the parent asset (as a selectable item)
            flattened.push({ ...asset, isChild: false, selectorKey: getAssetSelectorKey(asset) });
            
            const children = asset.children || asset.edits || [];
            children.forEach(child => {
              flattened.push({
                ...child,
                isChild: true,
                parentName: asset.name,
                // Ensure child has same asset type as parent
                type: asset.type,
                // Inherit the parent's project links so edits/versions filter with it
                projectId: child.projectId ?? asset.projectId,
                projectIds: child.projectIds ?? asset.projectIds,
                // Same for tags: tagging happens on the root, so an edit that
                // has none of its own is filtered by whatever its root carries.
                tags: (child.tags?.length ? child.tags : asset.tags) || [],
                selectorKey: getAssetSelectorKey({ ...child, isChild: true })
              });
            });
          });
          setAssets(flattened);
        } else {
          setAssets(filtered.map(asset => ({ ...asset, isChild: false, selectorKey: getAssetSelectorKey(asset) })));
        }
      } catch (err) {
        console.error('Failed to load assets for selector:', err);
      } finally {
        setLoading(false);
      }
    }
    loadAssets();
  }, [getLibraryAssets, includeChildren, libraryKey]);

  const normalizedSearch = searchQuery.trim().toLowerCase();

  const projectNameById = useMemo(
    () => new Map((projects || []).map(project => [String(project.id), project.name])),
    [projects]
  );

  // An asset can be linked to multiple projects, so resolve every project key it
  // belongs to (falling back to the single projectId, then "Unassigned").
  const getAssetProjectKeys = (asset) => {
    const ids = Array.isArray(asset?.projectIds) ? asset.projectIds : [];
    const keys = [...new Set(
      ids.filter(id => id !== null && id !== undefined).map(id => String(id))
    )];
    if (keys.length > 0) return keys;
    if (asset?.projectId !== null && asset?.projectId !== undefined) return [String(asset.projectId)];
    return ['__unassigned__'];
  };

  // Project options derived from the assets actually present, so the dropdown
  // never lists projects with nothing to show here.
  const projectFilterOptions = useMemo(() => {
    const keys = new Set();
    assets.forEach(asset => getAssetProjectKeys(asset).forEach(key => keys.add(key)));
    const options = Array.from(keys)
      .filter(key => key !== '__unassigned__')
      .map(key => ({ key, label: projectNameById.get(key) || `Project ${key}` }))
      .sort((left, right) => left.label.localeCompare(right.label));
    if (keys.has('__unassigned__')) options.push({ key: '__unassigned__', label: 'Unassigned' });
    return options;
  }, [assets, projectNameById]);

  // Drop a stale project filter when the available options no longer include it.
  useEffect(() => {
    if (projectFilter !== 'all' && !projectFilterOptions.some(option => option.key === projectFilter)) {
      setProjectFilter('all');
    }
  }, [projectFilter, projectFilterOptions]);

  // Tag options with counts, derived from what is actually listed here.
  const tagFilterOptions = useMemo(() => {
    const counts = new Map();
    assets.forEach(asset => {
      (asset.tags || []).forEach(tag => counts.set(tag, (counts.get(tag) || 0) + 1));
    });
    // Keep a selected tag listed even at count 0, so it stays unselectable-able
    // once it has filtered the list down to nothing.
    tagFilter.forEach(tag => { if (!counts.has(tag)) counts.set(tag, 0); });
    return Array.from(counts.entries())
      .map(([tag, count]) => ({ tag, count }))
      .sort((left, right) => right.count - left.count || left.tag.localeCompare(right.tag));
  }, [assets, tagFilter]);

  const filteredAssets = useMemo(() => {
    return assets.filter(asset => {
      if (normalizedSearch) {
        const haystack = `${asset.name || ''} ${asset.parentName || ''}`.toLowerCase();
        if (!haystack.includes(normalizedSearch)) return false;
      }
      if (projectFilter !== 'all' && !getAssetProjectKeys(asset).includes(projectFilter)) {
        return false;
      }
      // Every selected tag must be present — each one narrows the list.
      if (tagFilter.length > 0) {
        const tags = asset.tags || [];
        if (!tagFilter.every(tag => tags.includes(tag))) return false;
      }
      return true;
    });
  }, [assets, normalizedSearch, projectFilter, tagFilter]);

  useEffect(() => {
    setCurrentPage(1);
  }, [normalizedSearch, projectFilter, tagFilter]);

  const assetsPerPage = validType === 'mesh' ? MESHES_PER_PAGE : ASSETS_PER_PAGE;
  const totalPages = Math.max(1, Math.ceil(filteredAssets.length / assetsPerPage));
  const pageStart = (currentPage - 1) * assetsPerPage;
  const paginatedAssets = filteredAssets.slice(pageStart, pageStart + assetsPerPage);
  const pageRangeStart = filteredAssets.length === 0 ? 0 : pageStart + 1;
  const pageRangeEnd = Math.min(pageStart + assetsPerPage, filteredAssets.length);

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const handleSelectAsset = (assetKey) => {
    if (!multiple) {
      setSelectedAssetKey(assetKey);
      return;
    }
    // Click toggles, so the same mesh can be picked twice in a row for a
    // mirrored pair without reopening the modal.
    setSelectedAssetKeys(previous => {
      const next = new Set(previous);
      if (next.has(assetKey)) next.delete(assetKey); else next.add(assetKey);
      return next;
    });
  };

	const handleConfirm = () => {
    if (multiple) {
      // Ordered by the grid, not by click order — the list the caller appends
      // to should read the same way the user saw it.
      const chosen = assets.filter(a => selectedAssetKeys.has(a.selectorKey));
      if (chosen.length) onSelect(chosen);
      onClose();
      return;
    }
    if (selectedAssetKey) {
      const selectedAsset = assets.find(a => a.selectorKey === selectedAssetKey);
			onSelect(selectedAsset);
		}
		onClose();
	};

  const handleClose = () => {
    onClose();
  };

  const handleBackdropClick = (e) => {
    if (e.target === e.currentTarget) {
      handleClose();
    }
  };

  return (
    <div className="asset-selector-overlay" role="presentation" onClick={handleBackdropClick}>
      <div className="asset-selector-modal" role="dialog" aria-modal="true" aria-labelledby="asset-selector-title">
        <div className="asset-selector-header">
          <h2 id="asset-selector-title" className="asset-selector-title font-headline">
            {title || `Select ${titleLabel}`}
          </h2>
          <button type="button" className="asset-selector-close" onClick={handleClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

        {!loading && assets.length > 0 && (
          <div className="asset-selector-toolbar">
            <div className="asset-selector-search">
              <span className="material-symbols-outlined">search</span>
              <input
                type="text"
                className="asset-selector-search-input"
                value={searchQuery}
                onChange={event => setSearchQuery(event.target.value)}
                placeholder={`Search ${pluralLabel}`}
                autoFocus
              />
              {searchQuery && (
                <button
                  type="button"
                  className="asset-selector-search-clear"
                  onClick={() => setSearchQuery('')}
                  title="Clear search"
                >
                  <span className="material-symbols-outlined">close</span>
                </button>
              )}
            </div>
            {tagFilterOptions.length > 0 && (
              <TagFilter
                options={tagFilterOptions}
                selected={tagFilter}
                onChange={setTagFilter}
              />
            )}
            {projectFilterOptions.length > 0 && (
              <label className="asset-selector-project-select">
                <span className="material-symbols-outlined">filter_list</span>
                <select
                  className="asset-selector-project-select__input"
                  value={projectFilter}
                  onChange={event => setProjectFilter(event.target.value)}
                >
                  <option value="all">All projects</option>
                  {projectFilterOptions.map(option => (
                    <option key={option.key} value={option.key}>{option.label}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        )}

        <div className="asset-selector-body">
          {loading ? (
            <div className="asset-selector-loading">
              <span className="material-symbols-outlined asset-selector-spinner">progress_activity</span>
              <span>Loading assets...</span>
            </div>
          ) : assets.length === 0 ? (
            <div className="asset-selector-empty">
              <span className="material-symbols-outlined">{emptyIcon}</span>
              <span>No {pluralLabel} found in library.</span>
            </div>
          ) : filteredAssets.length === 0 ? (
            <div className="asset-selector-empty">
              <span className="material-symbols-outlined">search_off</span>
              <span>No {pluralLabel} match your filters.</span>
            </div>
          ) : (
            <>
							<div className={`asset-selector-grid asset-selector-grid--${validType}`}>
								{paginatedAssets.map(asset => {
                  const isSelected = multiple ? selectedAssetKeys.has(asset.selectorKey) : selectedAssetKey === asset.selectorKey;
                  const previewUrl = asset.thumbnailUrl || asset.url || getAssetPreviewUrl(asset.thumbnail || asset.filename);
									const dimensions = formatDimensions(asset.width, asset.height);
									const extension = asset.extension || (asset.filename?.split('.').pop() || '').toUpperCase();
									const isChild = asset.isChild;

									return (
										<div
                      key={asset.selectorKey}
											className={`asset-selector-card ${isSelected ? 'asset-selector-card--selected' : ''}`}
                      onClick={() => handleSelectAsset(asset.selectorKey)}
										>
                      <div className={`asset-selector-preview ${validType === 'mesh' ? 'asset-selector-preview--mesh' : 'asset-selector-preview--image'} ${validType === 'brush' ? 'asset-selector-preview--brush' : ''}`}>
												{validType !== 'mesh' ? (
													<img src={previewUrl} alt={asset.name} className="asset-selector-image" />
												) : (
													<div className="asset-selector-mesh-placeholder">
														{previewUrl ? (
															<img src={previewUrl} alt={asset.name} className="asset-selector-image" />
														) : (
															<>
																<span className="material-symbols-outlined asset-selector-mesh-icon">view_in_ar</span>
																<span className="asset-selector-mesh-label font-label">3D MESH</span>
															</>
														)}
													</div>
												)}
												{dimensions && (
													<span className="asset-selector-dimensions font-label">{dimensions}</span>
												)}
												{isChild && (
													<span className="asset-selector-child-badge font-label">
														{validType === 'mesh' ? 'VERSION' : 'EDIT'}
													</span>
												)}
											</div>
											<div className="asset-selector-info">
												<span className="asset-selector-name">{asset.name}</span>
												{(asset.tags || []).length > 0 && (
													<div className="asset-selector-tags">
														{(asset.tags || []).slice(0, 4).map(tag => (
															<span key={tag} className="asset-selector-tag">{tag}</span>
														))}
													</div>
												)}
												<div className="asset-selector-meta">
													<span className="asset-selector-badge">{extension}</span>
													{isChild && asset.parentName && (
														<span className="asset-selector-parent">from {asset.parentName}</span>
													)}
												</div>
											</div>
										</div>
									);
								})}
							</div>

              {filteredAssets.length > assetsPerPage && (
                <div className="asset-selector-pagination">
                  <div className="asset-selector-pagination-summary">
                    Showing {pageRangeStart}-{pageRangeEnd} of {filteredAssets.length}
                  </div>
                  <div className="asset-selector-pagination-controls">
                    <button
                      type="button"
                      className="asset-selector-page-btn"
                      onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
                      disabled={currentPage === 1}
                    >
                      Previous
                    </button>
                    <span className="asset-selector-page-indicator">Page {currentPage} / {totalPages}</span>
                    <button
                      type="button"
                      className="asset-selector-page-btn"
                      onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
                      disabled={currentPage === totalPages}
                    >
                      Next
                    </button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>

        <div className="asset-selector-footer">
          <button type="button" className="asset-selector-btn asset-selector-btn--secondary" onClick={handleClose}>
            Cancel
          </button>
          <button
            type="button"
            className="asset-selector-btn asset-selector-btn--primary"
            onClick={handleConfirm}
            disabled={loading || (multiple ? selectedAssetKeys.size === 0 : !selectedAssetKey)}
          >
            {multiple && selectedAssetKeys.size > 0 ? `Add ${selectedAssetKeys.size}` : 'Select'}
          </button>
        </div>
      </div>
    </div>
  );
}