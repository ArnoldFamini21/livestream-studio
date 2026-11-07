import { useId, useState } from 'react';
import { MAX_PARTICIPANT_TITLE_LENGTH, type Participant } from '@studio/shared';

interface NameTagEditorProps {
  person: Participant;
  onSave: (profile: { name: string; title: string }) => void;
}

/** Host tool: fix how a guest's name reads on their tile and add a subtitle for the name tag. */
export function NameTagEditor({ person, onSave }: NameTagEditorProps) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(person.name);
  const [title, setTitle] = useState(person.title || '');
  const id = useId();
  const trimmedName = name.trim();
  const changed = trimmedName !== person.name || title.trim() !== (person.title || '');

  if (!open) {
    return (
      <button
        type="button"
        className="people-nametag-open"
        onClick={() => {
          setName(person.name);
          setTitle(person.title || '');
          setOpen(true);
        }}
      >
        Edit name &amp; title
      </button>
    );
  }

  return (
    <form
      className="people-nametag"
      onSubmit={(event) => {
        event.preventDefault();
        if (!trimmedName || !changed) return;
        onSave({ name: trimmedName, title: title.trim() });
        setOpen(false);
      }}
    >
      <label htmlFor={`${id}-name`}>Name on stage</label>
      <input
        id={`${id}-name`}
        value={name}
        maxLength={50}
        onChange={(event) => setName(event.target.value)}
        autoComplete="off"
        autoFocus
      />
      <label htmlFor={`${id}-title`}>Title (optional)</label>
      <input
        id={`${id}-title`}
        value={title}
        maxLength={MAX_PARTICIPANT_TITLE_LENGTH}
        placeholder="e.g. Author, The Long Game"
        onChange={(event) => setTitle(event.target.value)}
        autoComplete="off"
      />
      <div className="people-nametag-actions">
        <button type="button" onClick={() => setOpen(false)}>Cancel</button>
        <button type="submit" className="people-nametag-save" disabled={!trimmedName || !changed}>Save</button>
      </div>
    </form>
  );
}
