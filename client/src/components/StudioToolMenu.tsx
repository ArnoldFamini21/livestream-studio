import { useEffect, useRef, useState, type ReactNode } from 'react';
import { StudioIcon } from './StudioIcon.tsx';

export interface StudioTool { label: string; icon: ReactNode; onClick: () => void; }
const groups = [
  { title: 'Production', labels: ['Media', 'Teleprompter', 'Producer', 'Recordings'] },
  { title: 'Audience', labels: ['Chat', 'Q&A', 'Polls', 'Captions', 'Captions On'] },
  { title: 'Audio & setup', labels: ['Sounds', 'Music', 'Health'] },
];
const searchAliases: Record<string, string> = {
  Teleprompter: 'script read notes', Recordings: 'local recording tracks export',
  Producer: 'scenes show rundown', Captions: 'subtitles transcription', 'Captions On': 'subtitles transcription',
  Health: 'connection network quality diagnostics', Music: 'background audio', Sounds: 'soundboard effects',
};

export function StudioToolMenu({ items, onDismiss }: { items: StudioTool[]; onDismiss: () => void }) {
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector('input')?.focus(); }, []);
  const visible = items.filter(item => `${item.label} ${searchAliases[item.label] || ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  return <div ref={ref} className="studio-tool-menu" role="dialog" aria-label="Studio tools" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDismiss(); }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const controls = Array.from(ref.current?.querySelectorAll<HTMLElement>('input, button') || []);
      const index = controls.indexOf(document.activeElement as HTMLElement);
      const next = (index + (event.key === 'ArrowDown' ? 1 : -1) + controls.length) % controls.length;
      event.preventDefault(); controls[next]?.focus();
    }
  }}>
    <div className="studio-tools-heading"><strong>Studio tools</strong><button aria-label="Close tools" onClick={onDismiss}><StudioIcon name="close" /></button></div>
    <label className="studio-tools-search"><StudioIcon name="search" /><input aria-label="Find a studio tool" placeholder="Find a tool…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && visible.length === 1) visible[0].onClick(); }} /></label>
    <div className="studio-tools-results">
      {groups.map(group => {
        const matches = visible.filter(item => group.labels.includes(item.label));
        return matches.length > 0 && <section key={group.title}><h3>{group.title}</h3><div>{matches.map(item => <button key={item.label} onClick={item.onClick}>{item.icon}<span>{item.label}</span></button>)}</div></section>;
      })}
      {visible.length === 0 && <p role="status">No tools found. Try “audio” or “recording”.</p>}
    </div>
    <div className="studio-tools-footer"><span>↑ ↓ to navigate</span><span>esc to close</span></div>
  </div>;
}
