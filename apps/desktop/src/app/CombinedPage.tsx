import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { PageActionsSlot } from '@/components/workbench/primitives';
import { SectionHeader } from '@/components/workbench/page-layout';
import type { Route } from '@/stores/route-history';

export type CombinedSection = {
  route: Route;
  label: string;
  content: ReactNode;
  actions?: ReactNode;
};

const sectionId = (route: Route) => 'section-' + route.replaceAll(' ', '-').toLowerCase();
const behavior = (): ScrollBehavior =>
  matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth';

// Several related pages stacked on one page, all visible at once. The bar jumps between them
// and follows the scroll position; the current route decides which section is brought into view.
export function CombinedPage({
  page,
  sections,
  onNavigate,
}: {
  page: Route;
  sections: CombinedSection[];
  onNavigate: (route: Route) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [inView, setInView] = useState<Route>(page);
  const reveal = (route: Route, motion = behavior()) =>
    document.getElementById(sectionId(route))?.scrollIntoView({ behavior: motion, block: 'start' });
  useEffect(() => {
    setInView(page);
    // The first section is already at the top; scrolling there would only shift the page.
    if (page === sections[0]?.route) return;
    requestAnimationFrame(() => reveal(page));
    // Sections above may still be loading and push the target down; hold it in place while
    // they settle. ponytail: fixed 1.5 s window, switch to per-section ready signals if needed.
    const settle = new ResizeObserver(() => reveal(page, 'auto'));
    if (root.current) settle.observe(root.current);
    const stop = setTimeout(() => settle.disconnect(), 1500);
    return () => {
      settle.disconnect();
      clearTimeout(stop);
    };
  }, [page]);
  useEffect(() => {
    const scroller = root.current?.closest('.page-content');
    if (!scroller) return;
    const observer = new IntersectionObserver(
      (entries) => {
        // With nothing to scroll every section is in view; keep the one the user chose.
        if (scroller.scrollHeight <= scroller.clientHeight + 1) return;
        // At the end of the page the last section can never reach the top; it is the current one.
        if (scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 2) {
          setInView(sections[sections.length - 1].route);
          return;
        }
        const top = entries
          .filter((entry) => entry.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)[0];
        const route = sections.find((s) => sectionId(s.route) === top?.target.id)?.route;
        if (route) setInView(route);
      },
      // A section counts as current once its heading passes just under the sticky bar.
      { root: scroller, rootMargin: '-48px 0px -60% 0px' },
    );
    for (const s of sections) {
      const element = document.getElementById(sectionId(s.route));
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, [sections.map((s) => s.route).join()]);
  return (
    <div ref={root}>
      <div className="page-tabs">
        <nav aria-label="Page sections" className="tabs">
          {sections.map((s) => (
            <button
              key={s.route}
              type="button"
              aria-current={inView === s.route ? 'location' : undefined}
              onClick={() => {
                if (s.route === page) reveal(s.route);
                else onNavigate(s.route);
              }}
            >
              {s.label}
            </button>
          ))}
        </nav>
      </div>
      <div className="space-y-10">
        {sections.map((s) => (
          <section
            key={s.route}
            id={sectionId(s.route)}
            aria-labelledby={sectionId(s.route) + '-title'}
            className="scroll-mt-16"
          >
            <SectionHeader
              id={sectionId(s.route) + '-title'}
              title={s.label}
              actions={
                <>
                  {s.actions}
                  <span id={sectionId(s.route) + '-actions'} className="contents" />
                </>
              }
            />
            <PageActionsSlot.Provider value={sectionId(s.route) + '-actions'}>
              {s.content}
            </PageActionsSlot.Provider>
          </section>
        ))}
      </div>
    </div>
  );
}
