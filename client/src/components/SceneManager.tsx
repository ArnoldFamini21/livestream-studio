import { useRef, useState } from 'react';
import '../styles/scenes.css';
import type { Scene, LayoutMode } from '@studio/shared';
import {
  getBackgroundPreview,
  PRODUCTION_SCENE_PACK_TEMPLATE_IDS,
  PRODUCTION_SCENE_TEMPLATE_CARDS,
} from '../utils/productionSceneTemplates.ts';
import {
  getScenePreviewLogoPosition,
  getScenePreviewOverlays,
  getScenePreviewTiles,
} from '../utils/scenePreview.ts';
import type { ProductionSceneTemplate } from '../utils/productionSceneTemplates.ts';
import type { SceneOrderDirection } from '../utils/sceneOrder.ts';
import {
  SCENE_TRANSITION_PRESETS,
  validateSceneStingerFile,
  type SceneStingerClip,
  type SceneTransitionPresetId,
} from '../utils/sceneTransitions.ts';
import {
  getMediaShareLayoutLabel,
  STUDIO_LAYOUT_LABELS,
} from '../utils/layoutPresets.ts';

export type { ProductionSceneTemplate } from '../utils/productionSceneTemplates.ts';

interface SceneManagerProps {
  scenes: Scene[];
  activeSceneId: string | null;
  sceneTransitionPreset: SceneTransitionPresetId;
  sceneStingerClip: SceneStingerClip | null;
  onSceneTransitionPresetChange: (presetId: SceneTransitionPresetId) => void;
  onSceneStingerClipChange: (clip: SceneStingerClip | null) => void;
  onSaveScene: (name: string) => void | Promise<void>;
  onCreateTemplateScene: (
    template: ProductionSceneTemplate
  ) => void | Promise<void>;
  onCreateProductionScenePack: () => void | Promise<void>;
  onApplyScene: (sceneId: string) => void;
  onDeleteScene: (sceneId: string) => void;
  onRenameScene: (sceneId: string, newName: string) => void;
  onUpdateScene: (sceneId: string) => void | Promise<void>;
  onDuplicateScene: (sceneId: string) => void;
  onReorderScene: (sceneId: string, direction: SceneOrderDirection) => void;
  onExportScenePack: () => void;
  onImportScenePack: (file: File) => void | Promise<void>;
  scenePackMessage?: string | null;
}

const MAX_SCENES = 12;

function getSceneLayoutLabel(
  scene: Pick<Scene, 'activeMedia' | 'layout'>
): string {
  return scene.activeMedia?.assetId
    ? getMediaShareLayoutLabel(scene.layout)
    : STUDIO_LAYOUT_LABELS[scene.layout];
}

const layoutIcons: Record<LayoutMode, React.ReactNode> = {
  grid: (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect
        x="1"
        y="1"
        width="7"
        height="7"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x="10"
        y="1"
        width="7"
        height="7"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x="1"
        y="10"
        width="7"
        height="7"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x="10"
        y="10"
        width="7"
        height="7"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  ),
  spotlight: (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect
        x="1"
        y="1"
        width="16"
        height="11"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x="1"
        y="14"
        width="4.5"
        height="3"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect
        x="6.75"
        y="14"
        width="4.5"
        height="3"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
      <rect
        x="12.5"
        y="14"
        width="4.5"
        height="3"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  ),
  'side-by-side': (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect
        x="1"
        y="2"
        width="7.5"
        height="14"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x="9.5"
        y="2"
        width="7.5"
        height="14"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  ),
  pip: (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect
        x="1"
        y="1"
        width="16"
        height="16"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x="10"
        y="10"
        width="6"
        height="5"
        rx="1"
        fill="currentColor"
        opacity="0.5"
        stroke="currentColor"
        strokeWidth="1"
      />
    </svg>
  ),
  single: (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect
        x="2"
        y="2"
        width="14"
        height="14"
        rx="2"
        stroke="currentColor"
        strokeWidth="1.5"
      />
    </svg>
  ),
  featured: (
    <svg width="16" height="16" viewBox="0 0 18 18" fill="none">
      <rect
        x="1"
        y="2"
        width="11"
        height="14"
        rx="1.5"
        stroke="currentColor"
        strokeWidth="1.5"
      />
      <rect
        x="13.5"
        y="2"
        width="3.5"
        height="14"
        rx="1"
        stroke="currentColor"
        strokeWidth="1.2"
      />
    </svg>
  ),
};

export function SceneManager({
  scenes,
  activeSceneId,
  sceneTransitionPreset,
  sceneStingerClip,
  onSceneTransitionPresetChange,
  onSceneStingerClipChange,
  onSaveScene,
  onCreateTemplateScene,
  onCreateProductionScenePack,
  onApplyScene,
  onDeleteScene,
  onRenameScene,
  onUpdateScene,
  onDuplicateScene,
  onReorderScene,
  onExportScenePack,
  onImportScenePack,
  scenePackMessage,
}: SceneManagerProps) {
  const [isCreating, setIsCreating] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showTemplates, setShowTemplates] = useState(false);
  const [busy, setBusy] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const addButtonRef = useRef<HTMLButtonElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const [newName, setNewName] = useState('');
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [menuOpenId, setMenuOpenId] = useState<string | null>(null);
  const [stingerUrl, setStingerUrl] = useState('');
  const [stingerMessage, setStingerMessage] = useState<string | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const stingerInputRef = useRef<HTMLInputElement>(null);

  const atLimit = scenes.length >= MAX_SCENES;
  const scenePackSlots = Math.max(
    0,
    Math.min(
      PRODUCTION_SCENE_PACK_TEMPLATE_IDS.length,
      MAX_SCENES - scenes.length
    )
  );
  const runCreation = async (action: () => void | Promise<void>) => {
    if (busy || atLimit) return;
    setBusy(true);
    setActionError(null);
    try {
      await action();
      setNewName('');
      setIsCreating(false);
      setShowTemplates(false);
      requestAnimationFrame(() => addButtonRef.current?.focus());
    } catch {
      setActionError('This scene could not be saved. Please try again.');
    } finally {
      setBusy(false);
    }
  };

  const handleSave = () => {
    const trimmed = newName.trim();
    if (trimmed) void runCreation(() => onSaveScene(trimmed));
  };

  const handleSaveKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') handleSave();
    if (e.key === 'Escape') {
      setIsCreating(false);
      setNewName('');
    }
  };

  const focusSceneOptions = (sceneId: string) => {
    requestAnimationFrame(() =>
      document.getElementById(`scene-menu-${sceneId}`)?.focus()
    );
  };

  const handleRename = (sceneId: string) => {
    const trimmed = renameValue.trim();
    if (trimmed) {
      onRenameScene(sceneId, trimmed);
    }
    setRenamingId(null);
    setRenameValue('');
    focusSceneOptions(sceneId);
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent, sceneId: string) => {
    if (e.key === 'Enter') handleRename(sceneId);
    if (e.key === 'Escape') {
      setRenamingId(null);
      setRenameValue('');
      focusSceneOptions(sceneId);
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

  const startDuplicate = (sceneId: string) => {
    if (atLimit) return;
    setMenuOpenId(null);
    onDuplicateScene(sceneId);
  };

  const startUpdate = (sceneId: string) => {
    setMenuOpenId(null);
    onUpdateScene(sceneId);
  };

  const handleImportScenePack = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    if (file) void onImportScenePack(file);
    e.currentTarget.value = '';
  };

  const getStingerNameFromUrl = (url: string): string => {
    try {
      const parsed = new URL(url);
      const pathname = parsed.pathname.split('/').filter(Boolean).pop();
      return pathname
        ? decodeURIComponent(pathname).slice(0, 80)
        : parsed.hostname;
    } catch {
      return 'Stinger clip';
    }
  };

  const handleStingerUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.currentTarget.files?.[0];
    e.currentTarget.value = '';
    if (!file) return;

    const issue = validateSceneStingerFile(file);
    if (issue) {
      setStingerMessage(issue);
      return;
    }

    onSceneStingerClipChange({
      name: file.name,
      url: URL.createObjectURL(file),
      source: 'upload',
      mimeType: file.type || undefined,
    });
    onSceneTransitionPresetChange('stinger');
    setStingerMessage('Stinger video ready for this session.');
  };

  const handleStingerUrl = () => {
    const trimmed = stingerUrl.trim();
    if (!trimmed) return;
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
        setStingerMessage('Use an http or https video URL.');
        return;
      }
    } catch {
      setStingerMessage('Enter a valid video URL.');
      return;
    }

    onSceneStingerClipChange({
      name: getStingerNameFromUrl(trimmed),
      url: trimmed,
      source: 'url',
      mimeType: 'video/url',
    });
    onSceneTransitionPresetChange('stinger');
    setStingerUrl('');
    setStingerMessage('Stinger URL saved for this studio.');
  };

  return (
    <div
      className="scene-library"
      onKeyDown={(event) => {
        if (event.key !== 'Escape') return;
        if (isCreating) addButtonRef.current?.focus();
        else if (showSettings) settingsButtonRef.current?.focus();
        else if (menuOpenId) focusSceneOptions(menuOpenId);
        setIsCreating(false);
        setShowSettings(false);
        setShowTemplates(false);
        setMenuOpenId(null);
      }}
    >
      <div className="scene-toolbar">
        <button
          ref={addButtonRef}
          type="button"
          className="scene-add"
          disabled={atLimit || busy}
          aria-expanded={isCreating}
          aria-controls="scene-create"
          onClick={() => {
            setIsCreating(!isCreating);
            setShowSettings(false);
            setMenuOpenId(null);
            setActionError(null);
          }}
        >
          <span aria-hidden="true">＋</span> Add scene
        </button>
        <button
          ref={settingsButtonRef}
          type="button"
          className="scene-icon-button"
          aria-label="Scene settings"
          aria-expanded={showSettings}
          aria-controls="scene-settings"
          onClick={() => {
            setShowSettings(!showSettings);
            setIsCreating(false);
            setMenuOpenId(null);
          }}
        >
          <svg
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="currentColor"
          >
            <circle cx="5" cy="12" r="2" />
            <circle cx="12" cy="12" r="2" />
            <circle cx="19" cy="12" r="2" />
          </svg>
        </button>
      </div>

      {isCreating && (
        <section
          id="scene-create"
          className="scene-disclosure"
          aria-label="Add scene"
        >
          <label htmlFor="new-scene-name">Save your current stage</label>
          <div className="scene-input-row">
            <input
              id="new-scene-name"
              type="text"
              placeholder="Scene name"
              value={newName}
              maxLength={32}
              autoFocus
              disabled={busy}
              onChange={(event) => setNewName(event.target.value)}
              onKeyDown={handleSaveKeyDown}
            />
            <button
              type="button"
              className="scene-primary"
              disabled={!newName.trim() || busy || atLimit}
              onClick={handleSave}
            >
              {busy ? 'Saving…' : 'Save'}
            </button>
          </div>
          <button
            type="button"
            className="scene-text-button"
            aria-expanded={showTemplates}
            aria-controls="scene-templates"
            onClick={() => setShowTemplates(!showTemplates)}
          >
            Browse templates{' '}
            <span aria-hidden="true">{showTemplates ? '−' : '+'}</span>
          </button>
          {showTemplates && (
            <div id="scene-templates" className="scene-templates">
              {PRODUCTION_SCENE_TEMPLATE_CARDS.map((template) => (
                <button
                  key={template.id}
                  type="button"
                  disabled={atLimit || busy}
                  className="scene-template"
                  onClick={() =>
                    void runCreation(() => onCreateTemplateScene(template.id))
                  }
                >
                  <span
                    className="scene-template-preview"
                    aria-hidden="true"
                    style={{
                      background: getBackgroundPreview(template.background),
                    }}
                  >
                    {layoutIcons[template.layout]}
                  </span>
                  <span>{template.name}</span>
                </button>
              ))}
              <button
                type="button"
                className="scene-text-button scene-pack-add"
                disabled={!scenePackSlots || busy}
                onClick={() => void runCreation(onCreateProductionScenePack)}
              >
                Add show pack <span>{scenePackSlots} scenes</span>
              </button>
            </div>
          )}
        </section>
      )}

      {showSettings && (
        <section
          id="scene-settings"
          className="scene-disclosure"
          aria-label="Scene settings"
        >
          <label htmlFor="scene-transition">Transition</label>
          <select
            id="scene-transition"
            value={sceneTransitionPreset}
            onChange={(event) =>
              onSceneTransitionPresetChange(
                event.target.value as SceneTransitionPresetId
              )
            }
          >
            {SCENE_TRANSITION_PRESETS.map((preset) => (
              <option key={preset.id} value={preset.id}>
                {preset.label}
              </option>
            ))}
          </select>
          {sceneTransitionPreset === 'stinger' && (
            <div className="scene-stinger">
              <input
                ref={stingerInputRef}
                type="file"
                accept="video/*,.webm,.mp4,.mov,.m4v"
                hidden
                onChange={handleStingerUpload}
              />
              <button
                type="button"
                className="scene-secondary"
                onClick={() => stingerInputRef.current?.click()}
              >
                Upload transition video
              </button>
              <div className="scene-input-row">
                <input
                  type="url"
                  aria-label="Transition video URL"
                  placeholder="Or paste a video link"
                  value={stingerUrl}
                  onChange={(event) => setStingerUrl(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') handleStingerUrl();
                  }}
                />
                <button
                  type="button"
                  className="scene-secondary"
                  disabled={!stingerUrl.trim()}
                  onClick={handleStingerUrl}
                >
                  Add
                </button>
              </div>
              {sceneStingerClip && (
                <div className="scene-stinger-file">
                  <span title={sceneStingerClip.name}>
                    {sceneStingerClip.name}
                  </span>
                  <button
                    type="button"
                    className="scene-text-button"
                    aria-label="Remove stinger clip"
                    onClick={() => {
                      onSceneStingerClipChange(null);
                      setStingerMessage('Transition video removed.');
                    }}
                  >
                    Remove
                  </button>
                </div>
              )}
              {stingerMessage && (
                <p className="scene-note" role="status">
                  {stingerMessage}
                </p>
              )}
            </div>
          )}
          <div className="scene-pack-actions">
            <button
              type="button"
              className="scene-secondary"
              disabled={atLimit}
              onClick={() => importInputRef.current?.click()}
            >
              Import scenes
            </button>
            <button
              type="button"
              className="scene-secondary"
              disabled={!scenes.length}
              onClick={onExportScenePack}
            >
              Export scenes
            </button>
          </div>
        </section>
      )}
      <input
        ref={importInputRef}
        type="file"
        accept=".json,application/json"
        hidden
        onChange={handleImportScenePack}
      />
      {actionError && (
        <p className="scene-note" role="alert">
          {actionError}
        </p>
      )}
      {scenePackMessage && (
        <p className="scene-note" role="status">
          {scenePackMessage}
        </p>
      )}
      {atLimit && (
        <p className="scene-note">All {MAX_SCENES} scene slots are in use.</p>
      )}

      {scenes.length === 0 ? (
        !isCreating &&
        !showSettings && (
          <div className="scene-empty">
            <svg
              aria-hidden="true"
              width="30"
              height="30"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.25"
            >
              <rect x="3" y="4" width="18" height="16" rx="3" />
              <path d="M3 10h18" />
            </svg>
            <p>Your show, scene by scene.</p>
            <span>Save a stage setup to switch to it anytime.</span>
          </div>
        )
      ) : (
        <div className="scene-list" aria-label="Saved scenes">
          {scenes.map((scene, index) => (
            <div
              key={scene.id}
              className={`scene-row${scene.id === activeSceneId ? ' is-active' : ''}`}
            >
              {renamingId === scene.id ? (
                <div className="scene-rename">
                  <label htmlFor="rename-scene-name">Scene name</label>
                  <input
                    id="rename-scene-name"
                    value={renameValue}
                    maxLength={32}
                    autoFocus
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => handleRenameKeyDown(event, scene.id)}
                  />
                  <div className="scene-input-row">
                    <button
                      type="button"
                      className="scene-primary"
                      disabled={!renameValue.trim()}
                      onClick={() => handleRename(scene.id)}
                    >
                      Save name
                    </button>
                    <button
                      type="button"
                      className="scene-secondary"
                      onClick={() => {
                        setRenamingId(null);
                        focusSceneOptions(scene.id);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <div className="scene-row-main">
                  <button
                    type="button"
                    className="scene-apply"
                    aria-label={`Switch to ${scene.name}`}
                    aria-pressed={scene.id === activeSceneId}
                    onClick={() => {
                      onApplyScene(scene.id);
                      setMenuOpenId(null);
                    }}
                  >
                    <span
                      className="scene-thumbnail"
                      aria-hidden="true"
                      style={{
                        background: getBackgroundPreview(scene.background),
                      }}
                    >
                      <ScenePreviewThumbnail scene={scene} />
                    </span>
                    <span className="scene-row-copy">
                      <span className="scene-name" title={scene.name}>
                        {scene.name}
                      </span>
                      <span className="scene-meta">
                        {scene.id === activeSceneId
                          ? 'Selected'
                          : getSceneLayoutLabel(scene)}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className="scene-icon-button"
                    id={`scene-menu-${scene.id}`}
                    aria-label={`Options for ${scene.name}`}
                    aria-expanded={menuOpenId === scene.id}
                    aria-controls={`scene-options-${scene.id}`}
                    onClick={() => {
                      setMenuOpenId(menuOpenId === scene.id ? null : scene.id);
                      setShowSettings(false);
                      setIsCreating(false);
                    }}
                  >
                    <svg
                      aria-hidden="true"
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="currentColor"
                    >
                      <circle cx="5" cy="12" r="2" />
                      <circle cx="12" cy="12" r="2" />
                      <circle cx="19" cy="12" r="2" />
                    </svg>
                  </button>
                </div>
              )}
              {menuOpenId === scene.id && (
                <div
                  id={`scene-options-${scene.id}`}
                  className="scene-row-actions"
                  role="group"
                  aria-label={`Options for ${scene.name}`}
                >
                  <button type="button" onClick={() => startRename(scene)}>
                    Rename
                  </button>
                  <button type="button" onClick={() => startUpdate(scene.id)}>
                    Update from stage
                  </button>
                  <button
                    type="button"
                    disabled={atLimit}
                    onClick={() => startDuplicate(scene.id)}
                  >
                    Duplicate
                  </button>
                  <button
                    type="button"
                    disabled={index === 0}
                    onClick={() => onReorderScene(scene.id, 'earlier')}
                  >
                    Move up
                  </button>
                  <button
                    type="button"
                    disabled={index === scenes.length - 1}
                    onClick={() => onReorderScene(scene.id, 'later')}
                  >
                    Move down
                  </button>
                  <button
                    type="button"
                    className="scene-delete"
                    onClick={() => startDelete(scene.id)}
                  >
                    Delete
                  </button>
                </div>
              )}
            </div>
          ))}
          <p className="scene-count">
            {scenes.length} of {MAX_SCENES} scenes
          </p>
        </div>
      )}
    </div>
  );
}

function ScenePreviewThumbnail({ scene }: { scene: Scene }) {
  const tiles = getScenePreviewTiles(scene.layout, {
    pipCorner: scene.pipCorner,
    mediaActive: Boolean(scene.activeMedia?.assetId),
  });
  const overlays = getScenePreviewOverlays(scene);
  const hasMediaTile = tiles.some((tile) => tile.media);
  const cameraRadius =
    scene.cameraShape === 'circle'
      ? 999
      : scene.cameraShape === 'square'
        ? 4
        : scene.cameraShape === 'rounded'
          ? 8
          : 3;

  return (
    <div
      data-testid="scene-preview-thumbnail"
      style={styles.scenePreviewFrame}
      aria-label={`Preview of ${scene.name}`}
    >
      {tiles.map((tile, index) => (
        <span
          key={`${scene.id}-preview-tile-${index}`}
          data-preview-tile="true"
          style={{
            ...styles.scenePreviewTile,
            ...(tile.primary ? styles.scenePreviewTilePrimary : {}),
            ...(tile.floating ? styles.scenePreviewTileFloating : {}),
            ...(tile.media ? styles.scenePreviewMediaTile : {}),
            left: tile.left,
            top: tile.top,
            width: tile.width,
            height: tile.height,
            borderRadius: tile.media ? 6 : cameraRadius,
            borderColor:
              tile.media || tile.primary
                ? scene.brandColor
                : 'rgba(255, 255, 255, 0.24)',
          }}
        >
          {tile.media ? (
            <>
              <span
                style={{
                  ...styles.scenePreviewMediaDeckHeader,
                  background: scene.brandColor,
                }}
              />
              <span style={styles.scenePreviewMediaDeckLine} />
              <span
                style={{
                  ...styles.scenePreviewMediaDeckLine,
                  width: '48%',
                  top: '45%',
                }}
              />
              <span
                style={{
                  ...styles.scenePreviewMediaDeckLine,
                  width: '34%',
                  top: '58%',
                  opacity: 0.32,
                }}
              />
            </>
          ) : (
            <span
              style={{
                ...styles.scenePreviewTileAccent,
                background: scene.brandColor,
                opacity: tile.primary ? 0.82 : 0.44,
              }}
            />
          )}
        </span>
      ))}

      {overlays.banner && (
        <span
          style={{ ...styles.scenePreviewBanner, background: scene.brandColor }}
        />
      )}
      {overlays.timer && <span style={styles.scenePreviewTimer} />}
      {overlays.lowerThird && (
        <span
          style={{
            ...styles.scenePreviewLowerThird,
            borderColor: scene.brandColor,
          }}
        />
      )}
      {overlays.ticker && <span style={styles.scenePreviewTicker} />}
      {overlays.media && !hasMediaTile && (
        <span
          style={{ ...styles.scenePreviewMedia, borderColor: scene.brandColor }}
        />
      )}
      {overlays.widget && <span style={styles.scenePreviewWidget} />}
      {overlays.logo && (
        <span
          style={{
            ...styles.scenePreviewLogo,
            ...getScenePreviewLogoPosition(
              scene.logoPlacement,
              scene.logoPosition
            ),
          }}
        />
      )}
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  scenePreviewFrame: {
    position: 'absolute',
    inset: 0,
    overflow: 'hidden',
  },
  scenePreviewTile: {
    position: 'absolute',
    display: 'block',
    borderWidth: 1,
    borderStyle: 'solid',
    background: 'rgba(15, 23, 42, 0.58)',
    boxShadow: 'inset 0 0 0 1px rgba(255, 255, 255, 0.05)',
    overflow: 'hidden',
  },
  scenePreviewTilePrimary: {
    borderWidth: 1.5,
    background: 'rgba(15, 23, 42, 0.72)',
  },
  scenePreviewTileFloating: {
    boxShadow:
      '0 7px 16px rgba(0, 0, 0, 0.32), inset 0 0 0 1px rgba(255, 255, 255, 0.07)',
  },
  scenePreviewMediaTile: {
    background:
      'linear-gradient(135deg, rgba(248, 250, 252, 0.9), rgba(226, 232, 240, 0.74))',
    boxShadow:
      '0 7px 18px rgba(0, 0, 0, 0.22), inset 0 0 0 1px rgba(15, 23, 42, 0.08)',
  },
  scenePreviewTileAccent: {
    position: 'absolute',
    left: '18%',
    right: '18%',
    bottom: '17%',
    height: 3,
    borderRadius: 999,
  },
  scenePreviewMediaDeckHeader: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    height: 4,
    opacity: 0.78,
  },
  scenePreviewMediaDeckLine: {
    position: 'absolute',
    left: '16%',
    top: '32%',
    width: '58%',
    height: 3,
    borderRadius: 999,
    background: 'rgba(15, 23, 42, 0.52)',
  },
  scenePreviewBanner: {
    position: 'absolute',
    left: '8%',
    right: '8%',
    top: '8%',
    height: 7,
    borderRadius: 999,
    boxShadow: '0 4px 10px rgba(0, 0, 0, 0.22)',
  },
  scenePreviewTimer: {
    position: 'absolute',
    top: '9%',
    right: '9%',
    width: 18,
    height: 8,
    borderRadius: 999,
    background: 'rgba(255, 255, 255, 0.82)',
    boxShadow: '0 4px 10px rgba(0, 0, 0, 0.2)',
  },
  scenePreviewLowerThird: {
    position: 'absolute',
    left: '10%',
    bottom: '22%',
    width: '42%',
    height: 10,
    borderRadius: 999,
    borderWidth: 1,
    borderStyle: 'solid',
    background: 'rgba(2, 6, 23, 0.72)',
    boxShadow: '0 7px 16px rgba(0, 0, 0, 0.24)',
  },
  scenePreviewTicker: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    height: 8,
    background: 'rgba(2, 6, 23, 0.82)',
    borderTop: '1px solid rgba(255, 255, 255, 0.12)',
  },
  scenePreviewMedia: {
    position: 'absolute',
    left: '13%',
    top: '18%',
    width: '55%',
    height: '34%',
    borderRadius: 5,
    borderWidth: 1,
    borderStyle: 'solid',
    background: 'rgba(248, 250, 252, 0.16)',
    boxShadow: 'inset 0 0 0 1px rgba(15, 23, 42, 0.22)',
  },
  scenePreviewWidget: {
    position: 'absolute',
    left: '31%',
    top: '34%',
    width: '38%',
    height: '24%',
    borderRadius: 6,
    border: '1px dashed rgba(255, 255, 255, 0.52)',
    background: 'rgba(2, 6, 23, 0.42)',
    boxShadow: '0 8px 16px rgba(0, 0, 0, 0.22)',
  },
  scenePreviewLogo: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 3,
    background: 'rgba(255, 255, 255, 0.86)',
    boxShadow: '0 4px 10px rgba(0, 0, 0, 0.24)',
  },
};
