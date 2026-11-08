import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import type { BroadcastOrientation, CustomLayout, CustomLayoutSlot, CustomLayoutSlotShape } from '@studio/shared';
import '../styles/custom-layout-editor.css';
import { useDialogFocus } from '../hooks/useDialogFocus.ts';
import {
  addCustomLayoutSlot,
  CUSTOM_LAYOUT_TEMPLATES,
  createCustomLayoutFromTemplate,
  duplicateCustomLayout,
  duplicateCustomLayoutSlot,
  getCustomLayoutSlotRadius,
  MAX_CUSTOM_LAYOUT_SLOTS,
  MAX_CUSTOM_LAYOUTS,
  moveCustomLayoutSlot,
  nudgeCustomLayoutSlot,
  removeCustomLayoutSlot,
  resizeCustomLayoutSlot,
  restackCustomLayoutSlot,
  updateCustomLayoutSlot,
  upsertCustomLayout,
  type CustomLayoutResizeHandle,
  type CustomLayoutTemplateId,
} from '../utils/customLayouts.ts';

export interface CustomLayoutEditorProps {
  orientation: BroadcastOrientation;
  layouts: CustomLayout[];
  /** The layout the stage shows when the Custom layout is on. */
  activeLayoutId: string | null;
  /** People on stage, for pinning a camera slot to someone. */
  stageParticipants: Array<{ id: string; name: string }>;
  onLayoutsChange: (layouts: CustomLayout[]) => void;
  onUseLayout: (layoutId: string) => void;
  onClose: () => void;
}

const HANDLES: CustomLayoutResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const SHAPES: Array<{ id: CustomLayoutSlotShape; label: string }> = [
  { id: 'rect', label: 'Square corners' },
  { id: 'rounded', label: 'Rounded' },
  { id: 'circle', label: 'Circle' },
];

interface DragState {
  pointerId: number;
  slotId: string;
  handle: CustomLayoutResizeHandle | null;
  startX: number;
  startY: number;
  start: CustomLayoutSlot;
}

function slotLabel(slot: CustomLayoutSlot, layout: CustomLayout, names: Map<string, string>): string {
  if (slot.kind === 'content') return 'Content';
  const cameraIndex = layout.slots.filter((item) => item.kind === 'camera').findIndex((item) => item.id === slot.id) + 1;
  const pinned = slot.participantId ? names.get(slot.participantId) : null;
  return pinned ? `Camera ${cameraIndex} · ${pinned}` : `Camera ${cameraIndex}`;
}

export function CustomLayoutEditor({
  orientation,
  layouts,
  activeLayoutId,
  stageParticipants,
  onLayoutsChange,
  onUseLayout,
  onClose,
}: CustomLayoutEditorProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<DragState | null>(null);
  const [selectedLayoutId, setSelectedLayoutId] = useState<string | null>(activeLayoutId || layouts[0]?.id || null);
  const [draft, setDraft] = useState<CustomLayout | null>(() => layouts.find((layout) => layout.id === (activeLayoutId || layouts[0]?.id)) || null);
  const [selectedSlotId, setSelectedSlotId] = useState<string | null>(null);
  const [guides, setGuides] = useState<{ x: number[]; y: number[] }>({ x: [], y: [] });
  const [templateId, setTemplateId] = useState<CustomLayoutTemplateId>('content-two-cameras');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  useDialogFocus(panelRef, onClose);

  const saved = layouts.find((layout) => layout.id === selectedLayoutId) || null;
  const dirty = Boolean(draft && saved && JSON.stringify(draft) !== JSON.stringify(saved)) || Boolean(draft && !saved);
  const names = useMemo(() => new Map(stageParticipants.map((person) => [person.id, person.name])), [stageParticipants]);
  const selectedSlot = draft?.slots.find((slot) => slot.id === selectedSlotId) || null;
  const surfaceOrientation = draft?.orientation || orientation;

  const selectLayout = useCallback((id: string) => {
    setSelectedLayoutId(id);
    setDraft(layouts.find((layout) => layout.id === id) || null);
    setSelectedSlotId(null);
    setConfirmDelete(false);
    setStatus(null);
  }, [layouts]);

  // Keep the draft when the saved list changes under it (e.g. a brand kit was applied).
  useEffect(() => {
    if (selectedLayoutId && !layouts.some((layout) => layout.id === selectedLayoutId) && draft?.id !== selectedLayoutId) {
      const next = layouts[0] || null;
      setSelectedLayoutId(next?.id || null);
      setDraft(next);
    }
  }, [draft?.id, layouts, selectedLayoutId]);

  const commit = (next: CustomLayout, message: string) => {
    onLayoutsChange(upsertCustomLayout(layouts, next));
    setSelectedLayoutId(next.id);
    setDraft(next);
    setStatus(message);
  };

  const createFromTemplate = () => {
    if (layouts.length >= MAX_CUSTOM_LAYOUTS) {
      setStatus(`You can keep up to ${MAX_CUSTOM_LAYOUTS} layouts. Delete one to add another.`);
      return;
    }
    const layout = createCustomLayoutFromTemplate(templateId, orientation, layouts.map((item) => item.name));
    commit(layout, `Added ${layout.name}.`);
    setSelectedSlotId(layout.slots[0]?.id || null);
  };

  const duplicateLayout = () => {
    if (!draft) return;
    if (layouts.length >= MAX_CUSTOM_LAYOUTS) {
      setStatus(`You can keep up to ${MAX_CUSTOM_LAYOUTS} layouts.`);
      return;
    }
    const copy = duplicateCustomLayout(draft, layouts.map((item) => item.name));
    commit(copy, `Duplicated as ${copy.name}.`);
  };

  const deleteLayout = () => {
    if (!saved) return;
    const remaining = layouts.filter((layout) => layout.id !== saved.id);
    onLayoutsChange(remaining);
    const next = remaining[0] || null;
    setSelectedLayoutId(next?.id || null);
    setDraft(next);
    setSelectedSlotId(null);
    setConfirmDelete(false);
    setStatus(`Deleted ${saved.name}.`);
  };

  const editDraft = (update: (layout: CustomLayout) => CustomLayout) => {
    setDraft((current) => (current ? update(current) : current));
    setStatus(null);
  };

  const toSurfaceDelta = (dxPx: number, dyPx: number) => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0 || rect.height <= 0) return { dx: 0, dy: 0 };
    return { dx: dxPx / rect.width, dy: dyPx / rect.height };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLElement>, slot: CustomLayoutSlot, handle: CustomLayoutResizeHandle | null) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
    setSelectedSlotId(slot.id);
    dragRef.current = { pointerId: event.pointerId, slotId: slot.id, handle, startX: event.clientX, startY: event.clientY, start: slot };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !draft) return;
    const { dx, dy } = toSurfaceDelta(event.clientX - drag.startX, event.clientY - drag.startY);
    // Hold Alt to place freely (no grid, no guides).
    const options = event.altKey ? { grid: false, guides: false } : {};
    const others = draft.slots.filter((slot) => slot.id !== drag.slotId);
    const edit = drag.handle
      ? resizeCustomLayoutSlot(drag.start, drag.handle, dx, dy, others, draft.orientation, options)
      : moveCustomLayoutSlot(drag.start, dx, dy, others, options);
    setGuides({ x: edit.guidesX, y: edit.guidesY });
    editDraft((layout) => ({ ...layout, slots: layout.slots.map((slot) => (slot.id === drag.slotId ? edit.slot : slot)) }));
  };

  const endDrag = (event: ReactPointerEvent<HTMLElement>) => {
    if (dragRef.current?.pointerId !== event.pointerId) return;
    dragRef.current = null;
    setGuides({ x: [], y: [] });
  };

  const onSlotKeyDown = (event: ReactKeyboardEvent<HTMLElement>, slot: CustomLayoutSlot) => {
    if (!draft) return;
    const nudged = nudgeCustomLayoutSlot(slot, event.key, event.shiftKey);
    if (nudged) {
      event.preventDefault();
      event.stopPropagation();
      editDraft((layout) => ({ ...layout, slots: layout.slots.map((item) => (item.id === slot.id ? nudged : item)) }));
      return;
    }
    if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      editDraft((layout) => removeCustomLayoutSlot(layout, slot.id));
      setSelectedSlotId(null);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'd') {
      event.preventDefault();
      event.stopPropagation();
      const result = duplicateCustomLayoutSlot(draft, slot.id);
      if (result) {
        setDraft(result.layout);
        setSelectedSlotId(result.slotId);
      }
    }
  };

  const addSlot = (kind: 'camera' | 'content') => {
    if (!draft) return;
    const result = addCustomLayoutSlot(draft, kind);
    if (!result) {
      setStatus(kind === 'content' ? 'A layout has one content box.' : `A layout can have up to ${MAX_CUSTOM_LAYOUT_SLOTS} boxes.`);
      return;
    }
    setDraft(result.layout);
    setSelectedSlotId(result.slotId);
    setStatus(null);
  };

  const save = () => {
    if (!draft) return;
    const name = draft.name.trim();
    if (!name) {
      setStatus('Give the layout a name.');
      return;
    }
    commit({ ...draft, name }, `Saved ${name}.`);
  };

  const sortedSlots = draft ? [...draft.slots].sort((a, b) => a.z - b.z) : [];
  const hasContentSlot = Boolean(draft?.slots.some((slot) => slot.kind === 'content'));

  return (
    <div className="cle-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div ref={panelRef} className="cle-panel" role="dialog" aria-modal="true" aria-labelledby="cle-title">
        <header className="cle-header">
          <h2 id="cle-title">Custom layouts</h2>
          <button type="button" className="cle-close" onClick={onClose} aria-label="Close layout editor">×</button>
        </header>
        <div className="cle-body">
          <aside className="cle-sidebar" aria-label="Saved layouts">
            <div className="cle-new">
              <label className="cle-label" htmlFor="cle-template">Start from</label>
              <select id="cle-template" value={templateId} onChange={(event) => setTemplateId(event.currentTarget.value as CustomLayoutTemplateId)}>
                {CUSTOM_LAYOUT_TEMPLATES.map((template) => (
                  <option key={template.id} value={template.id}>{template.label}</option>
                ))}
              </select>
              <button type="button" className="btn-primary cle-btn" onClick={createFromTemplate}>
                New {orientation === 'portrait' ? '9:16' : '16:9'} layout
              </button>
            </div>
            <ul className="cle-list">
              {layouts.map((layout) => (
                <li key={layout.id}>
                  <button
                    type="button"
                    className={`cle-list-item${layout.id === selectedLayoutId ? ' is-selected' : ''}`}
                    aria-current={layout.id === selectedLayoutId || undefined}
                    onClick={() => selectLayout(layout.id)}
                  >
                    <span className="cle-list-name">{layout.name}</span>
                    <span className="cle-list-meta">
                      {layout.orientation === 'portrait' ? '9:16' : '16:9'}
                      {layout.id === activeLayoutId ? ' · On stage' : ''}
                    </span>
                  </button>
                </li>
              ))}
              {layouts.length === 0 && <li className="cle-empty">No layouts yet. Pick a starting point above.</li>}
            </ul>
          </aside>

          <section className="cle-main" aria-label="Layout canvas">
            {draft ? (
              <>
                <div className="cle-toolbar">
                  <label className="cle-label" htmlFor="cle-name">Name</label>
                  <input
                    id="cle-name"
                    className="cle-name"
                    value={draft.name}
                    maxLength={40}
                    onChange={(event) => {
                      const name = event.currentTarget.value;
                      editDraft((layout) => ({ ...layout, name }));
                    }}
                  />
                  <button type="button" className="btn-secondary cle-btn" onClick={() => addSlot('camera')} disabled={draft.slots.length >= MAX_CUSTOM_LAYOUT_SLOTS}>+ Camera</button>
                  <button type="button" className="btn-secondary cle-btn" onClick={() => addSlot('content')} disabled={hasContentSlot || draft.slots.length >= MAX_CUSTOM_LAYOUT_SLOTS}>+ Content</button>
                </div>
                {draft.orientation !== orientation && (
                  <p className="cle-note">This layout was drawn for {draft.orientation === 'portrait' ? '9:16 portrait' : '16:9 landscape'} output; on the current output its boxes stretch to fit.</p>
                )}
                <div className={`cle-surface-wrap is-${surfaceOrientation}`}>
                  <div
                    ref={surfaceRef}
                    className={`cle-surface is-${surfaceOrientation}`}
                    onPointerMove={onPointerMove}
                    onPointerUp={endDrag}
                    onPointerCancel={endDrag}
                    onPointerDown={(event) => { if (event.target === event.currentTarget) setSelectedSlotId(null); }}
                  >
                    <div className="cle-grid" aria-hidden="true" />
                    {guides.x.map((x) => <div key={`gx-${x}`} className="cle-guide is-x" style={{ left: `${x * 100}%` }} aria-hidden="true" />)}
                    {guides.y.map((y) => <div key={`gy-${y}`} className="cle-guide is-y" style={{ top: `${y * 100}%` }} aria-hidden="true" />)}
                    {sortedSlots.map((slot) => {
                      const selected = slot.id === selectedSlotId;
                      const label = slotLabel(slot, draft, names);
                      return (
                        <div
                          key={slot.id}
                          role="button"
                          tabIndex={0}
                          aria-pressed={selected}
                          aria-label={`${label}. Drag to move, arrow keys to nudge, Shift for bigger steps, Delete to remove.`}
                          className={`cle-slot is-${slot.kind}${selected ? ' is-selected' : ''}`}
                          style={{
                            left: `${slot.x * 100}%`,
                            top: `${slot.y * 100}%`,
                            width: `${slot.w * 100}%`,
                            height: `${slot.h * 100}%`,
                            zIndex: 2 + slot.z,
                            borderRadius: typeof getCustomLayoutSlotRadius(slot.shape) === 'number'
                              ? `${(getCustomLayoutSlotRadius(slot.shape) as number) / 2}px`
                              : getCustomLayoutSlotRadius(slot.shape),
                          }}
                          onPointerDown={(event) => onPointerDown(event, slot, null)}
                          onFocus={() => setSelectedSlotId(slot.id)}
                          onKeyDown={(event) => onSlotKeyDown(event, slot)}
                        >
                          <span className="cle-slot-label">{label}</span>
                          {selected && HANDLES.map((handle) => (
                            <span
                              key={handle}
                              className={`cle-handle is-${handle}`}
                              aria-hidden="true"
                              onPointerDown={(event) => onPointerDown(event, slot, handle)}
                            />
                          ))}
                        </div>
                      );
                    })}
                  </div>
                </div>
                <p className="cle-hint">Boxes snap to the grid, the canvas centre and each other. Hold Alt (Option) while dragging to place freely.</p>
              </>
            ) : (
              <p className="cle-empty">Create a layout to start arranging boxes.</p>
            )}
          </section>

          <aside className="cle-inspector" aria-label="Box settings">
            {draft && selectedSlot ? (
              <>
                <h3>{slotLabel(selectedSlot, draft, names)}</h3>
                <label className="cle-label" htmlFor="cle-kind">Shows</label>
                <select
                  id="cle-kind"
                  value={selectedSlot.kind}
                  onChange={(event) => {
                    const kind = event.currentTarget.value as CustomLayoutSlot['kind'];
                    if (kind === 'content' && hasContentSlot && selectedSlot.kind !== 'content') {
                      setStatus('A layout has one content box.');
                      return;
                    }
                    editDraft((layout) => updateCustomLayoutSlot(layout, selectedSlot.id, { kind }));
                  }}
                >
                  <option value="camera">A camera</option>
                  <option value="content">Shared content (slides, video, screen)</option>
                </select>
                <span className="cle-label">Shape</span>
                <div className="cle-segmented" role="radiogroup" aria-label="Box shape">
                  {SHAPES.map((shape) => (
                    <button
                      key={shape.id}
                      type="button"
                      role="radio"
                      aria-checked={selectedSlot.shape === shape.id}
                      className={selectedSlot.shape === shape.id ? 'is-active' : ''}
                      onClick={() => editDraft((layout) => updateCustomLayoutSlot(layout, selectedSlot.id, { shape: shape.id }))}
                    >
                      {shape.label}
                    </button>
                  ))}
                </div>
                {selectedSlot.kind === 'camera' && (
                  <>
                    <label className="cle-label" htmlFor="cle-pin">Who fills it</label>
                    <select
                      id="cle-pin"
                      value={selectedSlot.participantId || ''}
                      onChange={(event) => {
                        const participantId = event.currentTarget.value || null;
                        editDraft((layout) => updateCustomLayoutSlot(layout, selectedSlot.id, { participantId }));
                      }}
                    >
                      <option value="">Next person on stage</option>
                      {stageParticipants.map((person) => (
                        <option key={person.id} value={person.id}>{person.name}</option>
                      ))}
                      {selectedSlot.participantId && !names.has(selectedSlot.participantId) && (
                        <option value={selectedSlot.participantId}>Pinned person (not on stage)</option>
                      )}
                    </select>
                  </>
                )}
                <div className="cle-inspector-actions">
                  <button type="button" className="btn-secondary cle-btn" onClick={() => editDraft((layout) => restackCustomLayoutSlot(layout, selectedSlot.id, 'front'))}>Bring to front</button>
                  <button type="button" className="btn-secondary cle-btn" onClick={() => editDraft((layout) => restackCustomLayoutSlot(layout, selectedSlot.id, 'back'))}>Send to back</button>
                  <button
                    type="button"
                    className="btn-secondary cle-btn"
                    disabled={selectedSlot.kind === 'content' || draft.slots.length >= MAX_CUSTOM_LAYOUT_SLOTS}
                    onClick={() => {
                      const result = duplicateCustomLayoutSlot(draft, selectedSlot.id);
                      if (result) {
                        setDraft(result.layout);
                        setSelectedSlotId(result.slotId);
                      }
                    }}
                  >
                    Duplicate box
                  </button>
                  <button
                    type="button"
                    className="btn-secondary cle-btn cle-danger"
                    disabled={draft.slots.length <= 1}
                    onClick={() => {
                      editDraft((layout) => removeCustomLayoutSlot(layout, selectedSlot.id));
                      setSelectedSlotId(null);
                    }}
                  >
                    Remove box
                  </button>
                </div>
              </>
            ) : (
              <p className="cle-hint">{draft ? 'Select a box to change its shape, contents or stacking.' : ''}</p>
            )}
          </aside>
        </div>
        <footer className="cle-footer">
          <span className="cle-status" role="status">{status || (dirty ? 'Unsaved changes' : '')}</span>
          {draft && saved && (
            confirmDelete ? (
              <>
                <span className="cle-status">Delete {saved.name}?</span>
                <button type="button" className="btn-secondary cle-btn cle-danger" onClick={deleteLayout}>Delete</button>
                <button type="button" className="btn-secondary cle-btn" onClick={() => setConfirmDelete(false)}>Keep</button>
              </>
            ) : (
              <button type="button" className="btn-secondary cle-btn cle-danger" onClick={() => setConfirmDelete(true)}>Delete layout</button>
            )
          )}
          {draft && <button type="button" className="btn-secondary cle-btn" onClick={duplicateLayout}>Duplicate layout</button>}
          {draft && <button type="button" className="btn-secondary cle-btn" onClick={save} disabled={!dirty}>Save</button>}
          {draft && (
            <button
              type="button"
              className="btn-primary cle-btn"
              onClick={() => {
                const name = draft.name.trim() || saved?.name || 'Custom layout';
                const next = { ...draft, name };
                onLayoutsChange(upsertCustomLayout(layouts, next));
                setDraft(next);
                onUseLayout(next.id);
                setStatus(`${name} is on stage.`);
              }}
            >
              {dirty ? 'Save and use on stage' : 'Use on stage'}
            </button>
          )}
        </footer>
      </div>
    </div>
  );
}
