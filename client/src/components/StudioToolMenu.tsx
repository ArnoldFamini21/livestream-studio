import { useEffect, useRef, useState } from 'react';
import { StudioIcon } from './StudioIcon.tsx';

const groups = ['Production', 'Audience', 'Settings'] as const;

export interface StudioTool {
  group: typeof groups[number];
  label: string;
  keywords?: string;
  onClick: () => void;
}

export function StudioToolMenu({ items, onDismiss }: { items: StudioTool[]; onDismiss: () => void }) {
  const [query, setQuery] = useState('');
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.querySelector('input')?.focus(); }, []);
  const visible = items.filter(item => `${item.label} ${item.keywords || ''}`.toLowerCase().includes(query.trim().toLowerCase()));
  const select = (item: StudioTool) => {
    onDismiss();
    item.onClick();
  };
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
    <label className="studio-tools-search"><StudioIcon name="search" /><input aria-label="Find a studio tool" placeholder="Find a tool…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && visible.length === 1) select(visible[0]); }} /></label>
    <div className="studio-tools-results">
      {groups.map(group => {
        const matches = visible.filter(item => item.group === group);
        return matches.length > 0 && <section key={group}><h2>{group}</h2><div>{matches.map(item => <button key={item.label} onClick={() => select(item)}>{item.label}</button>)}</div></section>;
      })}
      {visible.length === 0 && <p role="status">No matching tools.</p>}
    </div>
  </div>;
}
