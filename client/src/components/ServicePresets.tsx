import { useEffect, useId, useRef, useState } from 'react';
import {
  groupServicePresets,
  importServicePreset,
  listServicePresetLibrary,
  MAX_SERVICE_PRESET_FOLDER_NAME,
  moveServicePreset,
  removeServicePreset,
  removeServicePresetFolder,
  saveServicePreset,
  saveServicePresetFolder,
  type ServicePreset,
  type ServicePresetLibrary,
  type ServicePresetSnapshot,
} from '../utils/servicePresets.ts';

export interface ServicePresetControls {
  capture: () => Promise<ServicePresetSnapshot>;
  load: (preset: ServicePreset) => void;
  download: (preset: ServicePreset) => void;
}

type PresetAction =
  | { kind: 'edit-folder'; id?: string; name: string }
  | { kind: 'move-preset' | 'remove-preset' | 'remove-folder'; id: string };

export function ServicePresets({ capture, load, download }: ServicePresetControls) {
  const importInput = useRef<HTMLInputElement>(null);
  const groupLabelId = useId();
  const [open, setOpen] = useState(false);
  const [library, setLibrary] = useState<ServicePresetLibrary>({ presets: [], folders: [] });
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [action, setAction] = useState<PresetAction | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);
  const { groups, unfiled } = groupServicePresets(library);

  useEffect(() => {
    if (!open) return;
    let current = true;
    void listServicePresetLibrary().then(items => {
      if (current) setLibrary(items);
    }, error => {
      if (current) setNotice({ text: error instanceof Error ? error.message : 'Could not open presets.', error: true });
    });
    return () => { current = false; };
  }, [open]);

  async function update(write: () => Promise<void>, note: string) {
    setBusy(true);
    setNotice(null);
    try {
      await write();
      setLibrary(await listServicePresetLibrary());
      setAction(null);
      setNotice({ text: note });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : 'Could not update presets.', error: true });
    } finally {
      setBusy(false);
    }
  }

  function renderFolderForm(edit: Extract<PresetAction, { kind: 'edit-folder' }>) {
    const saveLabel = edit.id ? 'Save folder name' : 'Create folder';
    return (
      <form className="scene-preset-form" onSubmit={event => {
        event.preventDefault();
        if (!edit.name.trim() || busy) return;
        void update(() => saveServicePresetFolder(edit.name, edit.id), edit.id ? 'Folder renamed.' : 'Folder created.');
      }}>
        <label>
          <span>Folder name</span>
          <input className="scene-input" value={edit.name} maxLength={MAX_SERVICE_PRESET_FOLDER_NAME} autoFocus required
            onChange={event => setAction({ ...edit, name: event.currentTarget.value })} />
        </label>
        <div className="scene-preset-actions">
          <button className="scene-secondary" type="submit" disabled={busy || !edit.name.trim()}>{saveLabel}</button>
          <button className="scene-text-button" type="button" disabled={busy} onClick={() => setAction(null)}>Cancel</button>
        </div>
      </form>
    );
  }

  function renderPresets(presets: ServicePreset[]) {
    if (!presets.length) return null;
    return (
      <ul className="scene-preset-list">
        {presets.map(preset => {
          const currentAction = action?.id === preset.id ? action.kind : null;
          return (
            <li key={preset.id}>
              <span>{preset.name}</span>
              {currentAction === 'remove-preset' ? (
                <>
                  <button type="button" className="scene-text-button" disabled={busy} onClick={() =>
                    void update(() => removeServicePreset(preset.id), 'Service preset removed.')
                  }>Remove preset</button>
                  <button type="button" className="scene-text-button" disabled={busy} onClick={() => setAction(null)}>Cancel</button>
                </>
              ) : currentAction === 'move-preset' ? (
                <>
                  <select className="scene-input" aria-label={'Folder for ' + preset.name} autoFocus disabled={busy}
                    value={groups.some(group => group.id === preset.folderId) ? preset.folderId : ''}
                    onChange={event => {
                      const folderId = event.currentTarget.value || undefined;
                      void update(() => moveServicePreset(preset.id, folderId), 'Service preset moved.');
                    }}>
                    <option value="">Unfiled</option>
                    {groups.map(group => <option key={group.id} value={group.id}>{group.name}</option>)}
                  </select>
                  <button type="button" className="scene-text-button" disabled={busy} onClick={() => setAction(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <button type="button" className="scene-secondary" disabled={busy} onClick={() => {
                    setNotice(null);
                    try { load(preset); }
                    catch (error) { setNotice({ text: error instanceof Error ? error.message : 'Could not load this preset.', error: true }); }
                  }} aria-label={'Add scenes from ' + preset.name}>Add scenes</button>
                  <button type="button" className="scene-text-button" disabled={busy} aria-label={'Download ' + preset.name} onClick={() => download(preset)}>Download</button>
                  {!!groups.length && (
                    <button type="button" className="scene-text-button" disabled={busy} aria-label={'Move ' + preset.name}
                      onClick={() => setAction({ kind: 'move-preset', id: preset.id })}>Move</button>
                  )}
                  <button type="button" className="scene-text-button" disabled={busy} aria-label={'Remove ' + preset.name}
                    onClick={() => setAction({ kind: 'remove-preset', id: preset.id })}>Remove</button>
                </>
              )}
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <details className="scene-service-presets" onToggle={event => setOpen(event.currentTarget.open)}>
      <summary>Service presets</summary>
      <p className="scene-note">Reuse scenes, graphics and countdowns. Download a preset to move it to another browser.</p>
      <form className="scene-preset-form" onSubmit={event => {
        event.preventDefault();
        if (!name.trim() || busy) return;
        void update(async () => {
          await saveServicePreset(name, await capture());
          setName('');
        }, 'Service preset saved.');
      }}>
        <label>
          <span>Preset name</span>
          <input className="scene-input" value={name} maxLength={60} onChange={event => setName(event.currentTarget.value)} required />
        </label>
        <button className="scene-secondary" type="submit" disabled={busy || !name.trim()}>Save service preset</button>
      </form>
      <div className="scene-preset-actions">
        <button className="scene-text-button" type="button" disabled={busy} onClick={() => importInput.current?.click()}>Import preset</button>
        <button className="scene-text-button" type="button" disabled={busy} onClick={() => setAction({ kind: 'edit-folder', name: '' })}>New folder</button>
      </div>
      <input ref={importInput} type="file" accept=".json,application/json" aria-label="Service preset file" hidden onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file && !busy) void update(() => importServicePreset(file), 'Service preset imported.');
      }} />
      {action?.kind === 'edit-folder' && !action.id && renderFolderForm(action)}
      {groups.map(group => {
        const labelId = groupLabelId + '-' + group.id;
        return (
          <div key={group.id} className="scene-preset-group" role="group" aria-labelledby={labelId}>
            <h4 id={labelId}>{group.name}</h4>
            {renderPresets(group.presets)}
            {action?.id === group.id && action.kind === 'edit-folder' ? (
              renderFolderForm(action)
            ) : action?.id === group.id && action.kind === 'remove-folder' ? (
              <>
                {group.presets.length > 0 && <p className="scene-note">Presets in this folder will move to Unfiled.</p>}
                <div className="scene-preset-actions">
                  <button className="scene-text-button" type="button" disabled={busy} onClick={() =>
                    void update(() => removeServicePresetFolder(group.id), 'Folder removed.')
                  }>Remove folder</button>
                  <button className="scene-text-button" type="button" disabled={busy} onClick={() => setAction(null)}>Cancel</button>
                </div>
              </>
            ) : (
              <div className="scene-preset-actions">
                <button className="scene-text-button" type="button" disabled={busy} aria-label={'Rename folder ' + group.name}
                  onClick={() => setAction({ kind: 'edit-folder', id: group.id, name: group.name })}>Rename folder</button>
                <button className="scene-text-button" type="button" disabled={busy} aria-label={'Remove folder ' + group.name}
                  onClick={() => setAction({ kind: 'remove-folder', id: group.id })}>Remove folder</button>
              </div>
            )}
          </div>
        );
      })}
      {unfiled.length > 0 && (
        <div className={groups.length ? 'scene-preset-group' : undefined} role="group" aria-label="Unfiled">
          {!!groups.length && <h4>Unfiled</h4>}
          {renderPresets(unfiled)}
        </div>
      )}
      {notice && <p className="scene-note" role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    </details>
  );
}
