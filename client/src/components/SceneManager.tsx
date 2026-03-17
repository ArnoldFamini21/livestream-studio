import { useState } from 'react';
import type { Scene, LayoutMode } from '@studio/shared';

interface SceneManagerProps {
  scenes: Scene[];
  activeSceneId: string | null;
  onSaveScene: (name: string) => void | Promise<void>;
  onApplyScene: (sceneId: string) => void;
  onDeleteScene: (sceneId: string) => void;
  onRenameScene: (sceneId: string, newName: string) => void;
}

const MAX_SCENES = 12;

const LAYOUT_LABELS: Record<LayoutMode, string> = {
  grid: 'Grid',
  spotlight: 'Spotlight',
  'side-by-side': 'Side by Side',
  pip: 'PiP',
  single: 'Single',
  featured: 'Featured',
};

const layoutIcons: Record<LayoutMode, React.ReactNode> = {
  grid: (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect x="1" y="1" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10" y="1" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="1" y="10" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10" y="10" width="7" height="7" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  spotlight: (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect x="1" y="1" width="16" height="11" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="1" y="14" width="4.5" height="3" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="6.75" y="14" width="4.5" height="3" rx="1" stroke="currentColor" strokeWidth="1.2" />
      <rect x="12.5" y="14" width="4.5" height="3" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  ),
  'side-by-side': (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect x="1" y="2" width="7.5" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="9.5" y="2" width="7.5" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  pip: (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect x="1" y="1" width="16" height="16" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="10" y="10" width="6" height="5" rx="1" fill="currentColor" opacity="0.5" stroke="currentColor" strokeWidth="1" />
    </svg>
  ),
  single: (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect x="2" y="2" width="14" height="14" rx="2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  featured: (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect x="1" y="2" width="11" height="14" rx="1.5" stroke="currentColor" strokeWidth="1.5" />
      <rect x="13.5" y="2" width="3.5" height="14" rx="1" stroke="currentColor" strokeWidth="1.2" />
    </svg>
  ),
};

function getBackgroundPreview(bg: Scene['background']): string {
  switch (bg.type) {
    case 'color':
      return bg.value;
    case 'gradient':
      return bg.value;
    case 'image':
      return `url(${bg.value}) center/cover no-repeat`;
    case 'none':
    default:
      return '#09090b';
  }
}

export function SceneManager({
  scenes,
  activeSceneId,
  onSaveScene,
  onApplyScene,
  onDeleteScene,
  onRenameScene,
}: SceneManagerProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);

  const atLimit = scenes.length >= MAX_SCENES;

  const handleSave = () => {
    const trimmed = newName.trim();
    if (!trimmed) return;
    onSaveScene(trimmed);
    setNewName('');
    setIsCreating(false);
  };

  const handleSaveKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') {
      setIsCreating(false);
      setNewName('');
    }
  };

  const handleRename = (sceneId: string) => {
    const trimmed = renameValue.trim();
    if (trimmed) {
      onRenameScene(sceneId, trimmed);
    }
    setRenamingId(null);
    setRenameValue('');
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent, sceneId: string) => {
    if (e.key === 'Enter') handleRename(sceneId);
    if (e.key === 'Escape') {
      setRenamingId(null);
      setRenameValue('');
    }
  };

  const startRename = (scene: Scene) => {
    setRenamingId(scene.id);
    setRenameValue(scene.name);
    setMenuOpenId(null);
  };

  const startDelete = (sceneId: string) => {
    setMenuOpenId(null);
    onDeleteScene(sceneId);
  };

  return (
    <div style={styles.container}>
      {/* Header */}
      <div style={styles.header}>
        <span style={styles.title}>Scenes</span>
        <span style={styles.count}>{scenes.length}/{MAX_SCENES}</span>
      </div>

      {/* Save button / inline input */}
      {isCreating ? (
        <div style={styles.createRow}>
          <input
            style={styles.nameInput}
            type="text"
            placeholder="Scene name..."
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={handleSaveKeyDown}
            onBlur={() => {
              if (!newName.trim()) {
                setIsCreating(false);
                setNewName('');
              }
            }}
            autoFocus
            maxLength={32}
          />
          <button style={styles.saveBtn} onClick={handleSave} disabled={!newName.trim()}>
            Save
          </button>
          <button
            style={styles.cancelBtn}
            onClick={() => {
              setIsCreating(false);
              setNewName('');
            }}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
              <line x1="18" y1="6" x2="6" y2="18" />
              <line x1="6" y1="6" x2="18" y2="18" />
            </svg>
          </button>
        </div>
      ) : (
        <button
          style={{
            ...styles.addBtn,
            ...(atLimit ? styles.addBtnDisabled : {}),
          }}
          onClick={() => !atLimit && setIsCreating(true)}
          disabled={atLimit}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          Save Current as Scene
        </button>
      )}

      {atLimit && (
        <span style={styles.limitNote}>Maximum of {MAX_SCENES} scenes reached.</span>
      )}

      {/* Scene list */}
      {scenes.length === 0 ? (
        <div style={styles.empty}>
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" style={{ opacity: 0.4 }}>
            <rect x="2" y="3" width="20" height="14" rx="2" />
            <path d="M8 21h8" />
            <path d="M12 17v4" />
          </svg>
          <span style={styles.emptyText}>
            No scenes saved yet. Save your current layout and background as a scene.
          </span>
        </div>
      ) : (
        <div style={styles.grid}>
          {scenes.map((scene) => {
            const isActive = scene.id === activeSceneId;
            const isMenuOpen = menuOpenId === scene.id;
            const isRenaming = renamingId === scene.id;

            return (
              <div
                key={scene.id}
                style={{
                  ...styles.card,
                  ...(isActive ? styles.cardActive : {}),
                }}
                onClick={() => {
                  if (!isRenaming) onApplyScene(scene.id);
                }}
              >
                {/* Background preview swatch */}
                <div
                  style={{
                    ...styles.swatch,
                    background: getBackgroundPreview(scene.background),
                  }}
                >
                  <div style={styles.layoutIcon}>
                    {layoutIcons[scene.layout]}
                  </div>
                  {/* Layout badge */}
                  <span style={styles.layoutBadge}>
                    {LAYOUT_LABELS[scene.layout]}
                  </span>
                </div>

                {/* Bottom area: name + menu */}
                <div style={styles.cardBottom}>
                  {isRenaming ? (
                    <input
                      style={styles.renameInput}
                      type="text"
                      value={renameValue}
                      onChange={(e) => setRenameValue(e.target.value)}
                      onKeyDown={(e) => handleRenameKeyDown(e, scene.id)}
                      onBlur={() => handleRename(scene.id)}
                      onClick={(e) => e.stopPropagation()}
                      autoFocus
                      maxLength={32}
                    />
                  ) : (
                    <span style={styles.sceneName} title={scene.name}>
                      {scene.name}
                    </span>
                  )}

                  {/* Menu trigger */}
                  <div style={{ position: 'relative' }}>
                    <button
                      style={styles.menuBtn}
                      onClick={(e) => {
                        e.stopPropagation();
                        setMenuOpenId(isMenuOpen ? null : scene.id);
                      }}
                      title="Scene options"
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                        <circle cx="12" cy="5" r="2" />
                        <circle cx="12" cy="12" r="2" />
                        <circle cx="12" cy="19" r="2" />
                      </svg>
                    </button>

                    {isMenuOpen && (
                      <div
                        style={styles.menu}
                        onClick={(e) => e.stopPropagation()}
                      >
                        <button
                          style={styles.menuItem}
                          onClick={() => startRename(scene)}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
                          </svg>
                          Rename
                        </button>
                        <button
                          style={{ ...styles.menuItem, ...styles.menuItemDanger }}
                          onClick={() => startDelete(scene.id)}
                        >
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
                            <polyline points="3 6 5 6 21 6" />
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                          </svg>
                          Delete
                        </button>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  title: {
    fontSize: 11,
    fontWeight: 600,
    color: 'var(--text-secondary)',
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
  },
  count: {
    fontSize: 10,
    fontWeight: 500,
    color: 'var(--text-muted)',
  },
  createRow: {
    display: 'flex',
    gap: 6,
    alignItems: 'center',
  },
  nameInput: {
    flex: 1,
    padding: '6px 10px',
    fontSize: 12,
    fontWeight: 500,
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius)',
    outline: 'none',
  },
  saveBtn: {
    padding: '6px 12px',
    fontSize: 11,
    fontWeight: 600,
    background: 'var(--accent)',
    color: '#fff',
    border: 'none',
    borderRadius: 'var(--radius)',
    cursor: 'pointer',
    whiteSpace: 'nowrap',
  },
  cancelBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 28,
    height: 28,
    background: 'none',
    border: '1px solid var(--border)',
    borderRadius: 'var(--radius)',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    padding: 0,
  },
  addBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 6,
    padding: '8px 12px',
    fontSize: 12,
    fontWeight: 500,
    background: 'var(--bg-tertiary)',
    color: 'var(--text-secondary)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius)',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
    width: '100%',
  },
  addBtnDisabled: {
    opacity: 0.4,
    cursor: 'not-allowed',
  },
  limitNote: {
    fontSize: 10,
    color: 'var(--text-muted)',
    textAlign: 'center',
  },
  empty: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: 8,
    padding: '20px 12px',
    textAlign: 'center',
  },
  emptyText: {
    fontSize: 11,
    color: 'var(--text-muted)',
    lineHeight: 1.5,
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(2, 1fr)',
    gap: 8,
  },
  card: {
    display: 'flex',
    flexDirection: 'column',
    background: 'var(--bg-surface)',
    borderRadius: 'var(--radius-lg)',
    border: '2px solid var(--border)',
    overflow: 'hidden',
    cursor: 'pointer',
    transition: 'all var(--transition-fast)',
  },
  cardActive: {
    borderColor: 'var(--accent)',
    boxShadow: '0 0 0 1px var(--accent)',
  },
  swatch: {
    position: 'relative',
    aspectRatio: '16 / 9',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  layoutIcon: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: 'rgba(255, 255, 255, 0.6)',
  },
  layoutBadge: {
    position: 'absolute',
    bottom: 4,
    right: 4,
    fontSize: 8,
    fontWeight: 700,
    color: 'rgba(255, 255, 255, 0.85)',
    background: 'rgba(0, 0, 0, 0.55)',
    padding: '2px 5px',
    borderRadius: 4,
    textTransform: 'uppercase',
    letterSpacing: '0.04em',
    lineHeight: 1,
  },
  cardBottom: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '6px 8px',
    gap: 4,
    minHeight: 30,
  },
  sceneName: {
    fontSize: 11,
    fontWeight: 500,
    color: 'var(--text-primary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    flex: 1,
  },
  renameInput: {
    flex: 1,
    padding: '2px 6px',
    fontSize: 11,
    fontWeight: 500,
    background: 'var(--bg-tertiary)',
    color: 'var(--text-primary)',
    border: '1px solid var(--accent)',
    borderRadius: 4,
    outline: 'none',
    minWidth: 0,
  },
  menuBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: 22,
    height: 22,
    background: 'none',
    border: 'none',
    color: 'var(--text-muted)',
    cursor: 'pointer',
    borderRadius: 4,
    padding: 0,
    flexShrink: 0,
  },
  menu: {
    position: 'absolute',
    top: '100%',
    right: 0,
    marginTop: 4,
    background: 'var(--bg-secondary)',
    border: '1px solid var(--border-strong)',
    borderRadius: 'var(--radius)',
    boxShadow: 'var(--shadow-md)',
    zIndex: 50,
    minWidth: 110,
    overflow: 'hidden',
  },
  menuItem: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    width: '100%',
    padding: '7px 10px',
    fontSize: 11,
    fontWeight: 500,
    background: 'none',
    border: 'none',
    color: 'var(--text-secondary)',
    cursor: 'pointer',
    textAlign: 'left',
  },
  menuItemDanger: {
    color: 'var(--danger)',
  },
};
