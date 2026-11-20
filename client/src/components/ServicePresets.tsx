import { useEffect, useRef, useState } from 'react';
import { importServicePreset, listServicePresets, removeServicePreset, saveServicePreset, type ServicePreset, type ServicePresetSnapshot } from '../utils/servicePresets.ts';

export interface ServicePresetControls {
  capture: () => Promise<ServicePresetSnapshot>;
  load: (preset: ServicePreset) => void;
  download: (preset: ServicePreset) => void;
}

export function ServicePresets({ capture, load, download }: ServicePresetControls) {
  const importInput = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  const [presets, setPresets] = useState<ServicePreset[]>([]);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [removeId, setRemoveId] = useState<string | null>(null);
  const [notice, setNotice] = useState<{ text: string; error?: boolean } | null>(null);

  useEffect(() => {
    if (!open) return;
    let current = true;
    void listServicePresets().then(items => {
      if (current) setPresets(items);
    }, error => {
      if (current) setNotice({ text: error instanceof Error ? error.message : 'Could not open presets.', error: true });
    });
    return () => { current = false; };
  }, [open]);

  async function update(action: () => Promise<void>, note: string) {
    setBusy(true);
    setNotice(null);
    try {
      await action();
      setPresets(await listServicePresets());
      setNotice({ text: note });
    } catch (error) {
      setNotice({ text: error instanceof Error ? error.message : 'Could not update presets.', error: true });
    } finally {
      setBusy(false);
    }
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
      <button className="scene-text-button" type="button" disabled={busy} onClick={() => importInput.current?.click()}>Import preset</button>
      <input ref={importInput} type="file" accept=".json,application/json" aria-label="Service preset file" hidden onChange={event => {
        const file = event.currentTarget.files?.[0];
        event.currentTarget.value = '';
        if (file && !busy) void update(() => importServicePreset(file), 'Service preset imported.');
      }} />
      {presets.length > 0 && (
        <ul className="scene-preset-list">
          {presets.map(preset => (
            <li key={preset.id}>
              <span>{preset.name}</span>
              {removeId === preset.id ? (
                <>
                  <button type="button" className="scene-text-button" disabled={busy} onClick={() => void update(async () => {
                    await removeServicePreset(preset.id);
                    setRemoveId(null);
                  }, 'Service preset removed.')}>Remove preset</button>
                  <button type="button" className="scene-text-button" onClick={() => setRemoveId(null)}>Cancel</button>
                </>
              ) : (
                <>
                  <button type="button" className="scene-secondary" disabled={busy} onClick={() => {
                    setNotice(null);
                    try { load(preset); }
                    catch (error) { setNotice({ text: error instanceof Error ? error.message : 'Could not load this preset.', error: true }); }
                  }} aria-label={'Add scenes from ' + preset.name}>Add scenes</button>
                  <button type="button" className="scene-text-button" disabled={busy} aria-label={'Download ' + preset.name} onClick={() => download(preset)}>Download</button>
                  <button type="button" className="scene-text-button" disabled={busy} aria-label={'Remove ' + preset.name} onClick={() => setRemoveId(preset.id)}>Remove</button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
      {notice && <p className="scene-note" role={notice.error ? 'alert' : 'status'}>{notice.text}</p>}
    </details>
  );
}
