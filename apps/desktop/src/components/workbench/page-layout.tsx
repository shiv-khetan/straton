import type { ReactNode } from 'react';
import { Tabs } from './primitives';

// One page anatomy for every page: the shell header (title, breadcrumb, primary action), an
// optional PageTabs bar directly under it, then the body. Titled groups start with a
// SectionHeader; filter rows use PageToolbar; framed content sits in a Tray.

/** Page-level views. Full-width bar under the title, the same on every page. */
export function PageTabs({
  id,
  items,
  value,
  onChange,
  aside,
}: {
  id: string;
  items: string[];
  value: string;
  onChange: (value: string) => void;
  /** Quiet status text or a control at the bar's end. */
  aside?: ReactNode;
}) {
  return (
    <div className="page-tabs">
      <Tabs id={id} items={items} value={value} onChange={onChange} />
      {aside && <div className="page-tabs-aside">{aside}</div>}
    </div>
  );
}

/** Heading row for a group of content: title, optional description, actions at the end. */
export function SectionHeader({
  id,
  title,
  description,
  actions,
}: {
  id?: string;
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="section-header">
      <div className="min-w-0">
        <h2 id={id}>{title}</h2>
        {description && <p className="hint">{description}</p>}
      </div>
      {actions && <div className="section-header-actions">{actions}</div>}
    </div>
  );
}

/** One short line on what this page or section is for, above its content. */
export function PageIntro({ children }: { children: ReactNode }) {
  return <p className="page-intro">{children}</p>;
}

/** Filters, search and view options above the content they affect. */
export function PageToolbar({ children }: { children: ReactNode }) {
  return <div className="toolbar">{children}</div>;
}
