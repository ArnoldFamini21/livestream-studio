import { useId, useRef, useState, type FormEvent } from 'react';
import {
  MAX_RUNDOWN_ITEMS,
  MAX_RUNDOWN_NOTES,
  MAX_RUNDOWN_SCENE_NAME,
  MAX_RUNDOWN_TITLE,
  type ProductionRundownCommand,
  type ProductionRundownItem,
  type Scene,
} from '@studio/shared';
import type { useProductionRundown } from '../hooks/useProductionRundown.ts';
import './production-rundown.css';

interface Props {
  connection: ReturnType<typeof useProductionRundown>;
  scenes: Pick<Scene, 'id' | 'name'>[];
  onTakeScene?: (sceneId: string) => void;
}

function findRundownScene(scenes: Props['scenes'], name: string) {
  const matches = scenes.filter(scene => scene.name.trim().toLowerCase() === name.trim().toLowerCase());
  return matches.length === 1 ? matches[0] : null;
}

export function ProductionRundown({ connection, scenes, onTakeScene }: Props) {
  const { rundown, connected, update } = connection;
  const [draft, setDraft] = useState<{ item: ProductionRundownItem; revision: number; editing: boolean } | null>(null);
  const [pending, setPending] = useState(false);
  const [notice, setNotice] = useState('');
  const sceneOptionsId = useId();
  const takeScene = useRef(onTakeScene);
  takeScene.current = onTakeScene;

  if (!rundown) return null;

  const disabled = pending || !connected;
  const next = rundown.items.find(item => item.id === rundown.cueItemId);
  const scene = next?.sceneName ? findRundownScene(scenes, next.sceneName) : null;
  const currentItem = rundown.items.find(item => item.id === draft?.item.id);
  const staleDraft = draft && draft.revision !== rundown.revision;
  const revision = rundown.revision;

  async function mutate(command: ProductionRundownCommand, options: { revision?: number; after?: () => void } = {}) {
    setPending(true);
    setNotice('');
    try {
      await update(command, options.revision ?? revision);
      options.after?.();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not update the rundown.');
    } finally {
      setPending(false);
    }
  }

  function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (disabled || !draft || staleDraft || !draft.item.title.trim()) return;
    void mutate({ action: 'save-item', item: draft.item }, { revision: draft.revision, after: () => setDraft(null) });
  }

  return (
    <section className="production-rundown" aria-label="Production rundown">
      <h2>Production rundown</h2>
      {next && <div className="production-rundown-cue" role="status">
        <strong>Up next · {next.title}</strong>
        {next.sceneName && <span>Scene · {next.sceneName}</span>}
        {onTakeScene && scene && <button type="button" className="btn-primary" disabled={disabled} onClick={() => void mutate(
          { action: 'take-item', itemId: next.id },
          { after: () => takeScene.current?.(scene.id) },
        )}>Take scene</button>}
        {onTakeScene && next.sceneName && !scene && <p>Save exactly one scene with this name in this browser to take it.</p>}
        <button type="button" className="btn-ghost" disabled={disabled} onClick={() => void mutate({ action: 'cue-item', itemId: null })}>Clear cue</button>
      </div>}
      {!connected && <p role="status">Reconnecting to the studio…</p>}
      {rundown.items.length === 0 && <p>Add your first item to share it with the production team.</p>}
      {rundown.items.length > 0 && <ol className="production-rundown-list">
        {rundown.items.map((item, index) => <li key={item.id}>
          <div className="production-rundown-item-head">
            <strong>{item.title}</strong>
            {item.id === rundown.cueItemId && <span>Cued</span>}
            {item.id === rundown.lastTakenItemId && <span>Last taken</span>}
          </div>
          {item.sceneName && <span>Scene · {item.sceneName}</span>}
          {item.notes && <p className="production-rundown-notes">{item.notes}</p>}
          <div className="production-rundown-actions">
            <button type="button" className="btn-secondary" disabled={disabled || item.id === rundown.cueItemId} onClick={() => void mutate({ action: 'cue-item', itemId: item.id })} aria-label={'Cue ' + item.title}>Cue</button>
            <button type="button" className="btn-ghost" disabled={disabled} onClick={() => setDraft({ item, revision, editing: true })} aria-label={'Edit ' + item.title}>Edit</button>
            <button type="button" className="btn-ghost" disabled={disabled || index === 0} onClick={() => void mutate({ action: 'move-item', itemId: item.id, direction: 'up' })} aria-label={'Move ' + item.title + ' earlier'}>↑</button>
            <button type="button" className="btn-ghost" disabled={disabled || index === rundown.items.length - 1} onClick={() => void mutate({ action: 'move-item', itemId: item.id, direction: 'down' })} aria-label={'Move ' + item.title + ' later'}>↓</button>
          </div>
        </li>)}
      </ol>}
      {draft ? <form className="production-rundown-editor" onSubmit={save} aria-label={draft.editing ? 'Edit rundown item' : 'Add rundown item'}>
        <label>Title
          <input required maxLength={MAX_RUNDOWN_TITLE} value={draft.item.title} onChange={event => setDraft({ ...draft, item: { ...draft.item, title: event.target.value } })} />
        </label>
        <label>Scene name
          <input list={sceneOptionsId} maxLength={MAX_RUNDOWN_SCENE_NAME} placeholder="Optional" value={draft.item.sceneName} onChange={event => setDraft({ ...draft, item: { ...draft.item, sceneName: event.target.value } })} />
          <datalist id={sceneOptionsId}>{Array.from(new Set(scenes.map(entry => entry.name))).map(name => <option key={name} value={name} />)}</datalist>
        </label>
        <label>Private notes
          <textarea rows={3} maxLength={MAX_RUNDOWN_NOTES} value={draft.item.notes} onChange={event => setDraft({ ...draft, item: { ...draft.item, notes: event.target.value } })} />
        </label>
        {staleDraft && <p role="alert">{draft.editing && !currentItem
          ? 'That item was removed from the rundown.'
          : 'The rundown changed. Compare your draft with the saved item before continuing.'}</p>}
        <div className="production-rundown-actions">
          <button type="submit" className="btn-primary" disabled={disabled || Boolean(staleDraft)}>Save item</button>
          {staleDraft && currentItem && <button type="button" className="btn-secondary" disabled={disabled} onClick={() => setDraft({ ...draft, item: currentItem, revision })}>Load saved item</button>}
          {staleDraft && (!draft.editing || currentItem) && <button type="button" className="btn-secondary" disabled={disabled} onClick={() => setDraft({ ...draft, revision })}>Keep my draft</button>}
          <button type="button" className="btn-ghost" disabled={pending} onClick={() => setDraft(null)}>Cancel</button>
          {draft.editing && !staleDraft && <button type="button" className="btn-ghost" disabled={disabled} onClick={() => void mutate(
            { action: 'remove-item', itemId: draft.item.id }, { revision: draft.revision, after: () => setDraft(null) },
          )}>Remove item</button>}
        </div>
      </form> : <button type="button" className="btn-secondary" disabled={disabled || rundown.items.length >= MAX_RUNDOWN_ITEMS} onClick={() => setDraft({
        item: { id: crypto.randomUUID(), title: '', sceneName: '', notes: '' },
        revision,
        editing: false,
      })}>Add rundown item</button>}
      {notice && <p role="alert">{notice}</p>}
    </section>
  );
}
