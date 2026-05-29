import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import Header from '../components/Header'
import Footer from '../components/Footer'
import SettingsModal from '../components/SettingsModal'
import MarkdownContent from '../components/MarkdownContent'
import { useProjects } from '../context/ProjectContext'
import './WikiPage.css'

const ICON_SUGGESTIONS = [
  'description', 'article', 'menu_book', 'rocket_launch', 'folder_special',
  'view_kanban', 'account_tree', 'inventory_2', 'image', 'deployed_code',
  'brush', 'schema', 'edit_square', 'photo_filter', 'view_in_ar',
  'settings', 'vpn_key', 'lan', 'lightbulb', 'bug_report', 'star', 'bookmark'
]

const VIDEO_EXTENSIONS = ['mp4', 'webm', 'ogg', 'mov', 'm4v']

function formatTimestamp(value) {
  if (!value) return ''
  try {
    return new Date(value).toLocaleString(undefined, {
      year: 'numeric', month: 'short', day: 'numeric',
      hour: '2-digit', minute: '2-digit'
    })
  } catch {
    return ''
  }
}

function collectDescendantIds(tree, rootId, acc = new Set()) {
  const find = (nodes) => {
    for (const node of nodes) {
      if (node.id === rootId) {
        const gather = (n) => {
          acc.add(n.id)
          n.children?.forEach(gather)
        }
        node.children?.forEach(gather)
        return true
      }
      if (node.children && find(node.children)) return true
    }
    return false
  }
  find(tree)
  return acc
}

function flattenTree(tree) {
  const out = []
  const walk = (nodes, depth) => {
    nodes.forEach(node => {
      out.push({ ...node, depth })
      if (node.children?.length) walk(node.children, depth + 1)
    })
  }
  walk(tree, 0)
  return out
}

function WikiTreeNode({
  node, depth, activeId, expanded, onToggle, onSelect,
  onAddChild, onDelete, onMove, siblingsCount, index, busy, authorMode
}) {
  const hasChildren = node.children && node.children.length > 0
  const isExpanded = expanded.has(node.id)
  const isActive = node.id === activeId

  return (
    <li className="wiki-tree__item">
      <div
        className={`wiki-tree__row ${isActive ? 'wiki-tree__row--active' : ''}`}
        style={{ paddingLeft: `${depth * 14 + 8}px` }}
        onClick={() => onSelect(node.id)}
      >
        <button
          type="button"
          className={`wiki-tree__chevron ${hasChildren ? '' : 'wiki-tree__chevron--hidden'}`}
          onClick={(event) => { event.stopPropagation(); onToggle(node.id) }}
          tabIndex={hasChildren ? 0 : -1}
          aria-label={isExpanded ? 'Collapse' : 'Expand'}
        >
          <span className="material-symbols-outlined">{isExpanded ? 'expand_more' : 'chevron_right'}</span>
        </button>
        <span className="material-symbols-outlined wiki-tree__icon">{node.icon || 'description'}</span>
        <span className="wiki-tree__label">{node.title}</span>

        {authorMode && (
          <span className="wiki-tree__actions" onClick={(event) => event.stopPropagation()}>
            <button type="button" className="wiki-tree__action" title="Move up" disabled={busy || index === 0} onClick={() => onMove(node, -1)}>
              <span className="material-symbols-outlined">arrow_upward</span>
            </button>
            <button type="button" className="wiki-tree__action" title="Move down" disabled={busy || index === siblingsCount - 1} onClick={() => onMove(node, 1)}>
              <span className="material-symbols-outlined">arrow_downward</span>
            </button>
            <button type="button" className="wiki-tree__action" title="Add subpage" disabled={busy} onClick={() => onAddChild(node.id)}>
              <span className="material-symbols-outlined">add</span>
            </button>
            <button type="button" className="wiki-tree__action wiki-tree__action--danger" title="Delete page" disabled={busy} onClick={() => onDelete(node)}>
              <span className="material-symbols-outlined">delete</span>
            </button>
          </span>
        )}
      </div>

      {hasChildren && isExpanded && (
        <ul className="wiki-tree__children">
          {node.children.map((child, childIndex) => (
            <WikiTreeNode
              key={child.id}
              node={child}
              depth={depth + 1}
              activeId={activeId}
              expanded={expanded}
              onToggle={onToggle}
              onSelect={onSelect}
              onAddChild={onAddChild}
              onDelete={onDelete}
              onMove={onMove}
              siblingsCount={node.children.length}
              index={childIndex}
              busy={busy}
              authorMode={authorMode}
            />
          ))}
        </ul>
      )}
    </li>
  )
}

export default function WikiPage() {
  const {
    getWikiConfig, getWikiPages, getWikiPage, createWikiPage, updateWikiPage,
    moveWikiPage, deleteWikiPage, uploadWikiMedia
  } = useProjects()
  const navigate = useNavigate()
  const { pageId } = useParams()

  const [tree, setTree] = useState([])
  const [pages, setPages] = useState([])
  const [expanded, setExpanded] = useState(() => new Set())
  const [currentPage, setCurrentPage] = useState(null)
  const [loadingTree, setLoadingTree] = useState(true)
  const [loadingPage, setLoadingPage] = useState(false)
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState('read')
  const [showSettings, setShowSettings] = useState(false)
  const [search, setSearch] = useState('')
  const [feedback, setFeedback] = useState(null)
  const [uploading, setUploading] = useState(false)
  const [authorMode, setAuthorMode] = useState(false)

  // Edit buffers
  const [draftTitle, setDraftTitle] = useState('')
  const [draftIcon, setDraftIcon] = useState('')
  const [draftContent, setDraftContent] = useState('')

  const textareaRef = useRef(null)
  const imageInputRef = useRef(null)
  const videoInputRef = useRef(null)

  const activeId = pageId ? Number(pageId) : null

  const showFeedback = useCallback((type, message) => {
    setFeedback({ type, message })
  }, [])

  useEffect(() => {
    if (!feedback) return undefined
    const timer = setTimeout(() => setFeedback(null), 4000)
    return () => clearTimeout(timer)
  }, [feedback])

  const loadTree = useCallback(async () => {
    const data = await getWikiPages()
    setTree(data.tree || [])
    setPages(data.pages || [])
    return data
  }, [getWikiPages])

  // Initial load
  useEffect(() => {
    let active = true
    ;(async () => {
      try {
        setLoadingTree(true)
        const [config, data] = await Promise.all([getWikiConfig(), loadTree()])
        if (!active) return
        setAuthorMode(Boolean(config?.authorMode))
        // Expand root nodes by default
        setExpanded(new Set((data.tree || []).map(node => node.id)))
        if (!pageId && data.tree?.length) {
          navigate(`/wiki/${data.tree[0].id}`, { replace: true })
        }
      } catch (err) {
        if (active) showFeedback('error', err.message || 'Failed to load wiki')
      } finally {
        if (active) setLoadingTree(false)
      }
    })()
    return () => { active = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Load selected page content
  useEffect(() => {
    if (!activeId) {
      setCurrentPage(null)
      return undefined
    }
    let active = true
    ;(async () => {
      try {
        setLoadingPage(true)
        const page = await getWikiPage(activeId)
        if (!active) return
        setCurrentPage(page)
        setMode('read')
      } catch (err) {
        if (active) showFeedback('error', err.message || 'Failed to load page')
      } finally {
        if (active) setLoadingPage(false)
      }
    })()
    return () => { active = false }
  }, [activeId, getWikiPage, showFeedback])

  const isDirty = mode === 'edit' && currentPage && (
    draftTitle !== currentPage.title ||
    (draftIcon || '') !== (currentPage.icon || '') ||
    draftContent !== currentPage.content
  )

  const confirmDiscardIfDirty = useCallback(() => {
    if (isDirty) {
      return window.confirm('Discard unsaved changes?')
    }
    return true
  }, [isDirty])

  const handleSelect = (id) => {
    if (id === activeId) return
    if (!confirmDiscardIfDirty()) return
    navigate(`/wiki/${id}`)
  }

  const handleToggle = (id) => {
    setExpanded(prev => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  const enterEditMode = () => {
    if (!currentPage) return
    setDraftTitle(currentPage.title)
    setDraftIcon(currentPage.icon || '')
    setDraftContent(currentPage.content || '')
    setMode('edit')
  }

  const cancelEdit = () => {
    if (!confirmDiscardIfDirty()) return
    setMode('read')
  }

  const handleSave = async () => {
    if (!currentPage) return
    try {
      setBusy(true)
      const updated = await updateWikiPage(currentPage.id, {
        title: draftTitle,
        icon: draftIcon || null,
        content: draftContent
      })
      setCurrentPage(updated)
      await loadTree()
      setMode('read')
      showFeedback('success', 'Page saved.')
    } catch (err) {
      showFeedback('error', err.message || 'Failed to save page')
    } finally {
      setBusy(false)
    }
  }

  const handleCreate = async (parentId) => {
    try {
      setBusy(true)
      const page = await createWikiPage({
        parentId: parentId ?? null,
        title: 'Untitled Page',
        icon: 'description',
        content: '# Untitled Page\n\nStart writing here…'
      })
      await loadTree()
      if (parentId) {
        setExpanded(prev => new Set(prev).add(parentId))
      }
      navigate(`/wiki/${page.id}`)
      showFeedback('success', 'Page created.')
    } catch (err) {
      showFeedback('error', err.message || 'Failed to create page')
    } finally {
      setBusy(false)
    }
  }

  const handleDelete = async (node) => {
    const confirmed = window.confirm(
      `Delete "${node.title}"${node.children?.length ? ' and all its subpages' : ''}? This cannot be undone.`
    )
    if (!confirmed) return
    try {
      setBusy(true)
      await deleteWikiPage(node.id)
      const data = await loadTree()
      if (activeId === node.id || collectDescendantIds(tree, node.id).has(activeId)) {
        const firstRoot = data.tree?.[0]
        navigate(firstRoot ? `/wiki/${firstRoot.id}` : '/wiki', { replace: true })
      }
      showFeedback('success', 'Page deleted.')
    } catch (err) {
      showFeedback('error', err.message || 'Failed to delete page')
    } finally {
      setBusy(false)
    }
  }

  const handleMove = async (node, direction) => {
    try {
      setBusy(true)
      await moveWikiPage(node.id, { parentId: node.parentId ?? null, position: node.position + direction })
      await loadTree()
    } catch (err) {
      showFeedback('error', err.message || 'Failed to move page')
    } finally {
      setBusy(false)
    }
  }

  // ── Editor helpers ────────────────────────────────────────────────
  const applyToSelection = (transform) => {
    const textarea = textareaRef.current
    if (!textarea) return
    const start = textarea.selectionStart
    const end = textarea.selectionEnd
    const value = draftContent
    const { text, selStart, selEnd } = transform(value, start, end)
    setDraftContent(text)
    requestAnimationFrame(() => {
      textarea.focus()
      textarea.setSelectionRange(selStart, selEnd)
    })
  }

  const wrapSelection = (before, after, placeholder = '') => {
    applyToSelection((value, start, end) => {
      const selected = value.slice(start, end) || placeholder
      const text = value.slice(0, start) + before + selected + after + value.slice(end)
      return { text, selStart: start + before.length, selEnd: start + before.length + selected.length }
    })
  }

  const prefixLines = (prefix) => {
    applyToSelection((value, start, end) => {
      const lineStart = value.lastIndexOf('\n', start - 1) + 1
      const segment = value.slice(lineStart, end)
      const replaced = segment.split('\n').map(line => prefix + line).join('\n')
      const text = value.slice(0, lineStart) + replaced + value.slice(end)
      return { text, selStart: lineStart, selEnd: lineStart + replaced.length }
    })
  }

  const insertAtCursor = (snippet) => {
    applyToSelection((value, start, end) => {
      const text = value.slice(0, start) + snippet + value.slice(end)
      const pos = start + snippet.length
      return { text, selStart: pos, selEnd: pos }
    })
  }

  const handleMediaFile = async (file) => {
    if (!file) return
    try {
      setUploading(true)
      const result = await uploadWikiMedia(file)
      const snippet = result.kind === 'video'
        ? `\n<video src="${result.url}" controls width="100%"></video>\n`
        : `\n![${result.name?.replace(/\.[^.]+$/, '') || 'image'}](${result.url})\n`
      insertAtCursor(snippet)
      showFeedback('success', `${result.kind === 'video' ? 'Video' : 'Image'} inserted.`)
    } catch (err) {
      showFeedback('error', err.message || 'Failed to upload media')
    } finally {
      setUploading(false)
    }
  }

  const handlePaste = (event) => {
    const items = event.clipboardData?.items
    if (!items) return
    for (const item of items) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          event.preventDefault()
          handleMediaFile(file)
          return
        }
      }
    }
  }

  const handleDrop = (event) => {
    const file = event.dataTransfer?.files?.[0]
    if (file && (file.type.startsWith('image/') || file.type.startsWith('video/'))) {
      event.preventDefault()
      handleMediaFile(file)
    }
  }

  const TOOLBAR = [
    { icon: 'format_bold', title: 'Bold', action: () => wrapSelection('**', '**', 'bold text') },
    { icon: 'format_italic', title: 'Italic', action: () => wrapSelection('*', '*', 'italic text') },
    { icon: 'title', title: 'Heading', action: () => prefixLines('## ') },
    { icon: 'format_list_bulleted', title: 'Bulleted list', action: () => prefixLines('- ') },
    { icon: 'format_list_numbered', title: 'Numbered list', action: () => prefixLines('1. ') },
    { icon: 'format_quote', title: 'Quote', action: () => prefixLines('> ') },
    { icon: 'code', title: 'Inline code', action: () => wrapSelection('`', '`', 'code') },
    { icon: 'data_object', title: 'Code block', action: () => wrapSelection('\n```\n', '\n```\n', 'code') },
    { icon: 'link', title: 'Link', action: () => wrapSelection('[', '](https://)', 'link text') },
    { icon: 'horizontal_rule', title: 'Divider', action: () => insertAtCursor('\n\n---\n\n') },
  ]

  const flatPages = useMemo(() => flattenTree(tree), [tree])
  const searchResults = useMemo(() => {
    const query = search.trim().toLowerCase()
    if (!query) return null
    return flatPages.filter(node => node.title.toLowerCase().includes(query))
  }, [search, flatPages])

  const breadcrumb = useMemo(() => {
    if (!currentPage) return []
    const byId = new Map(pages.map(p => [p.id, p]))
    const chain = []
    let cursor = byId.get(currentPage.id)
    while (cursor) {
      chain.unshift(cursor)
      cursor = cursor.parentId ? byId.get(cursor.parentId) : null
    }
    return chain
  }, [currentPage, pages])

  return (
    <div className="assets-layout">
      <Header onSettingsClick={() => setShowSettings(true)} />
      {showSettings && <SettingsModal onClose={() => setShowSettings(false)} />}

      <main className="wiki-page">
        <aside className="wiki-sidebar">
          <div className="wiki-sidebar__head">
            <div className="wiki-sidebar__title-row">
              <span className="material-symbols-outlined">menu_book</span>
              <h2 className="wiki-sidebar__title font-headline">Wiki</h2>
              {!authorMode && (
                <span className="wiki-readonly-badge" title="Editing is disabled on this installation">
                  <span className="material-symbols-outlined">lock</span>
                  Read-only
                </span>
              )}
            </div>
            {authorMode && (
              <button
                type="button"
                className="wiki-sidebar__new"
                onClick={() => handleCreate(null)}
                disabled={busy}
                title="Create a new top-level page"
              >
                <span className="material-symbols-outlined">add</span>
                New Page
              </button>
            )}
          </div>

          <div className="wiki-sidebar__search">
            <span className="material-symbols-outlined">search</span>
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search pages"
            />
            {search && (
              <button type="button" className="wiki-sidebar__search-clear" onClick={() => setSearch('')}>
                <span className="material-symbols-outlined">close</span>
              </button>
            )}
          </div>

          <div className="wiki-sidebar__scroll">
            {loadingTree ? (
              <div className="wiki-sidebar__empty">
                <span className="material-symbols-outlined wiki-spin">progress_activity</span>
                Loading…
              </div>
            ) : searchResults ? (
              searchResults.length ? (
                <ul className="wiki-tree wiki-tree--flat">
                  {searchResults.map(node => (
                    <li key={node.id} className="wiki-tree__item">
                      <div
                        className={`wiki-tree__row ${node.id === activeId ? 'wiki-tree__row--active' : ''}`}
                        onClick={() => handleSelect(node.id)}
                      >
                        <span className="material-symbols-outlined wiki-tree__icon">{node.icon || 'description'}</span>
                        <span className="wiki-tree__label">{node.title}</span>
                      </div>
                    </li>
                  ))}
                </ul>
              ) : (
                <div className="wiki-sidebar__empty">No pages match “{search}”.</div>
              )
            ) : tree.length ? (
              <ul className="wiki-tree">
                {tree.map((node, index) => (
                  <WikiTreeNode
                    key={node.id}
                    node={node}
                    depth={0}
                    activeId={activeId}
                    expanded={expanded}
                    onToggle={handleToggle}
                    onSelect={handleSelect}
                    onAddChild={handleCreate}
                    onDelete={handleDelete}
                    onMove={handleMove}
                    siblingsCount={tree.length}
                    index={index}
                    busy={busy}
                    authorMode={authorMode}
                  />
                ))}
              </ul>
            ) : (
              <div className="wiki-sidebar__empty">
                <span className="material-symbols-outlined">auto_stories</span>
                No pages yet. Create your first one.
              </div>
            )}
          </div>
        </aside>

        <section className="wiki-content">
          {feedback && (
            <div className={`wiki-feedback wiki-feedback--${feedback.type}`}>
              <span className="material-symbols-outlined">
                {feedback.type === 'error' ? 'error' : feedback.type === 'success' ? 'check_circle' : 'info'}
              </span>
              <span>{feedback.message}</span>
            </div>
          )}

          {loadingPage ? (
            <div className="wiki-content__placeholder">
              <span className="material-symbols-outlined wiki-spin">progress_activity</span>
              Loading page…
            </div>
          ) : !currentPage ? (
            <div className="wiki-content__placeholder">
              <span className="material-symbols-outlined">auto_stories</span>
              <h2>Welcome to the Wiki</h2>
              <p>{authorMode ? 'Select a page from the left, or create a new one to get started.' : 'Select a page from the left to start reading.'}</p>
              {authorMode && (
                <button type="button" className="wiki-btn wiki-btn--primary" onClick={() => handleCreate(null)} disabled={busy}>
                  <span className="material-symbols-outlined">add</span> New Page
                </button>
              )}
            </div>
          ) : mode === 'read' ? (
            <article className="wiki-article">
              <div className="wiki-article__toolbar">
                <nav className="wiki-breadcrumb">
                  {breadcrumb.map((crumb, index) => (
                    <span key={crumb.id} className="wiki-breadcrumb__item">
                      {index > 0 && <span className="wiki-breadcrumb__sep">/</span>}
                      <button
                        type="button"
                        className={index === breadcrumb.length - 1 ? 'wiki-breadcrumb__current' : ''}
                        onClick={() => handleSelect(crumb.id)}
                      >
                        {crumb.title}
                      </button>
                    </span>
                  ))}
                </nav>
                {authorMode && (
                  <div className="wiki-article__actions">
                    <button type="button" className="wiki-btn" onClick={() => handleCreate(currentPage.id)} disabled={busy}>
                      <span className="material-symbols-outlined">add</span> Subpage
                    </button>
                    <button type="button" className="wiki-btn wiki-btn--primary" onClick={enterEditMode}>
                      <span className="material-symbols-outlined">edit</span> Edit
                    </button>
                  </div>
                )}
              </div>

              <header className="wiki-article__header">
                <span className="material-symbols-outlined wiki-article__icon">{currentPage.icon || 'description'}</span>
                <div>
                  <h1 className="wiki-article__title font-headline">{currentPage.title}</h1>
                  {currentPage.updatedAt && (
                    <p className="wiki-article__meta">Last updated {formatTimestamp(currentPage.updatedAt)}</p>
                  )}
                </div>
              </header>

              <MarkdownContent content={currentPage.content} />
            </article>
          ) : (
            <div className="wiki-editor">
              <div className="wiki-editor__bar">
                <div className="wiki-editor__title-fields">
                  <div className="wiki-icon-field">
                    <span className="material-symbols-outlined wiki-icon-field__preview">{draftIcon || 'description'}</span>
                    <input
                      className="wiki-input wiki-input--icon"
                      value={draftIcon}
                      onChange={(event) => setDraftIcon(event.target.value)}
                      placeholder="icon"
                      list="wiki-icon-suggestions"
                      title="Material Symbols icon name"
                    />
                    <datalist id="wiki-icon-suggestions">
                      {ICON_SUGGESTIONS.map(icon => <option key={icon} value={icon} />)}
                    </datalist>
                  </div>
                  <input
                    className="wiki-input wiki-input--title"
                    value={draftTitle}
                    onChange={(event) => setDraftTitle(event.target.value)}
                    placeholder="Page title"
                  />
                </div>
                <div className="wiki-editor__bar-actions">
                  <button type="button" className="wiki-btn" onClick={cancelEdit} disabled={busy}>Cancel</button>
                  <button type="button" className="wiki-btn wiki-btn--primary" onClick={handleSave} disabled={busy || !draftTitle.trim()}>
                    <span className="material-symbols-outlined">save</span>
                    {busy ? 'Saving…' : 'Save'}
                  </button>
                </div>
              </div>

              <div className="wiki-toolbar">
                {TOOLBAR.map(item => (
                  <button key={item.title} type="button" className="wiki-toolbar__btn" title={item.title} onClick={item.action}>
                    <span className="material-symbols-outlined">{item.icon}</span>
                  </button>
                ))}
                <span className="wiki-toolbar__divider" />
                <button type="button" className="wiki-toolbar__btn wiki-toolbar__btn--accent" title="Insert image" disabled={uploading} onClick={() => imageInputRef.current?.click()}>
                  <span className="material-symbols-outlined">add_photo_alternate</span>
                </button>
                <button type="button" className="wiki-toolbar__btn wiki-toolbar__btn--accent" title="Insert video" disabled={uploading} onClick={() => videoInputRef.current?.click()}>
                  <span className="material-symbols-outlined">movie</span>
                </button>
                {uploading && <span className="wiki-toolbar__status"><span className="material-symbols-outlined wiki-spin">progress_activity</span> Uploading…</span>}

                <input
                  ref={imageInputRef}
                  type="file"
                  accept="image/*"
                  hidden
                  onChange={(event) => { handleMediaFile(event.target.files?.[0]); event.target.value = '' }}
                />
                <input
                  ref={videoInputRef}
                  type="file"
                  accept={VIDEO_EXTENSIONS.map(ext => `.${ext}`).join(',')}
                  hidden
                  onChange={(event) => { handleMediaFile(event.target.files?.[0]); event.target.value = '' }}
                />
              </div>

              <div className="wiki-editor__panes">
                <textarea
                  ref={textareaRef}
                  className="wiki-editor__textarea"
                  value={draftContent}
                  onChange={(event) => setDraftContent(event.target.value)}
                  onPaste={handlePaste}
                  onDrop={handleDrop}
                  onDragOver={(event) => event.preventDefault()}
                  placeholder="Write in Markdown. Paste or drop an image to embed it."
                  spellCheck
                />
                <div className="wiki-editor__preview">
                  <div className="wiki-editor__preview-label">Preview</div>
                  <MarkdownContent content={draftContent} />
                </div>
              </div>
            </div>
          )}
        </section>
      </main>

      <Footer />
    </div>
  )
}
