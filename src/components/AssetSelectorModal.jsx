// components/AssetSelectorModal.jsx
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useProjects } from '../context/ProjectContext';
import './AssetSelectorModal.css'; // we'll create a separate CSS or reuse AssetsPage.css

function formatDimensions(width, height) {
  if (!width || !height) return null;
  return `${width} × ${height}`;
}

function getAssetPreviewUrl(filename) {
  if (!filename) return null;
  return `http://localhost:3001/assets/${encodeURI(filename)}`;
}

const ASSETS_PER_PAGE = 20;

export default function AssetSelectorModal({ assetType, onSelect, onClose, showEdits = false }) {
  const { getLibraryAssets } = useProjects();
  const [assets, setAssets] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selectedAssetId, setSelectedAssetId] = useState(null);
  const [currentPage, setCurrentPage] = useState(1);

  // Valid types: 'image', 'mesh', or 'brush'
  const validType = assetType === 'mesh' ? 'mesh' : (assetType === 'brush' ? 'brush' : 'image');

  const libraryKey = validType === 'mesh' ? 'meshes' : (validType === 'brush' ? 'brushes' : 'images');
  const titleLabel = validType === 'mesh' ? 'Mesh' : (validType === 'brush' ? 'Brush' : 'Image');
  const pluralLabel = validType === 'mesh' ? 'meshes' : (validType === 'brush' ? 'brushes' : 'images');
  const emptyIcon = validType === 'mesh' ? 'deployed_code' : (validType === 'brush' ? 'brush' : 'image_not_supported');

  useEffect(() => {
    async function loadAssets() {
      setLoading(true);
      try {
        const library = await getLibraryAssets();
        const filtered = library[libraryKey] || [];
        
        if (showEdits) {
          // Flatten: include each parent asset and its children (edits/versions)
          const flattened = [];
          filtered.forEach(asset => {
            // Include the parent asset (as a selectable item)
            flattened.push({ ...asset, isChild: false });
            
            const children = asset.children || asset.edits || [];
            children.forEach(child => {
              flattened.push({
                ...child,
                isChild: true,
                parentName: asset.name,
                // Ensure child has same asset type as parent
                type: asset.type
              });
            });
          });
          setAssets(flattened);
        } else {
          setAssets(filtered);
        }
      } catch (err) {
        console.error('Failed to load assets for selector:', err);
      } finally {
        setLoading(false);
      }
    }
    loadAssets();
  }, [getLibraryAssets, libraryKey, showEdits]);

  const totalPages = Math.max(1, Math.ceil(assets.length / ASSETS_PER_PAGE));
  const pageStart = (currentPage - 1) * ASSETS_PER_PAGE;
  const paginatedAssets = assets.slice(pageStart, pageStart + ASSETS_PER_PAGE);
  const pageRangeStart = assets.length === 0 ? 0 : pageStart + 1;
  const pageRangeEnd = Math.min(pageStart + ASSETS_PER_PAGE, assets.length);

  const handleSelectAsset = (assetId) => {
    setSelectedAssetId(assetId);
  };

	const handleConfirm = () => {
		if (selectedAssetId) {
			const selectedAsset = assets.find(a => a.id === selectedAssetId);
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
            Select {titleLabel}
          </h2>
          <button type="button" className="asset-selector-close" onClick={handleClose}>
            <span className="material-symbols-outlined">close</span>
          </button>
        </div>

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
          ) : (
            <>
							<div className={`asset-selector-grid asset-selector-grid--${validType}`}>
								{paginatedAssets.map(asset => {
									const isSelected = selectedAssetId === asset.id;
									const previewUrl = asset.thumbnailUrl || asset.url;
									const dimensions = formatDimensions(asset.width, asset.height);
									const extension = asset.extension || (asset.filename?.split('.').pop() || '').toUpperCase();
									const isChild = asset.isChild;

									return (
										<div
											key={asset.id}
											className={`asset-selector-card ${isSelected ? 'asset-selector-card--selected' : ''}`}
											onClick={() => handleSelectAsset(asset.id)}
										>
											<div className={`asset-selector-preview ${validType === 'mesh' ? 'asset-selector-preview--mesh' : 'asset-selector-preview--image'}`}>
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

              {assets.length > ASSETS_PER_PAGE && (
                <div className="asset-selector-pagination">
                  <div className="asset-selector-pagination-summary">
                    Showing {pageRangeStart}-{pageRangeEnd} of {assets.length}
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
            disabled={!selectedAssetId || loading}
          >
            Select
          </button>
        </div>
      </div>
    </div>
  );
}