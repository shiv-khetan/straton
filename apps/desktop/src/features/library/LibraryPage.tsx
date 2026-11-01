import { Star, Clock3, ArrowUpRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import type { LibraryEntry } from '@/stores/library';
import { useLibrary } from '@/stores/library';
import { relativeTime } from '@/lib/view-model';
import { PageIntro } from '@/components/workbench/page-layout';
export function LibraryPage({
  kind,
  scope,
  onOpen,
  available,
}: {
  kind: 'Favorites' | 'Recent';
  scope: string;
  onOpen: (entry: LibraryEntry) => void;
  available: (entry: LibraryEntry) => boolean;
}) {
  const { favorites, recent, toggle } = useLibrary();
  const entries = (kind === 'Favorites' ? favorites : recent).filter(
    (entry) => entry.scope === scope && available(entry),
  );
  return (
    <section>
      <PageIntro>Saved on this device for this engine and account.</PageIntro>
      {entries.length ? (
        <ul className="divide-y divide-line border-y border-line">
          {entries.map((entry) => (
            <li key={entry.id} className="flex items-center gap-3 py-3">
              <Button
                type="button"
                variant="ghost"
                className="h-auto min-w-0 flex-1 justify-start px-2 py-2 text-left"
                onClick={() => onOpen(entry)}
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate">{entry.label}</span>
                  <span className="block truncate text-caption font-normal text-ink-3">
                    {entry.detail ?? entry.kind}
                  </span>
                </span>
                <ArrowUpRight size={16} />
              </Button>
              {kind === 'Recent' && (
                <time className="text-caption text-ink-3 tabular-nums">
                  {relativeTime(entry.visitedAt)}
                </time>
              )}
              <Button
                type="button"
                variant="ghost"
                size="icon-sm"
                aria-label={
                  (favorites.some((item) => item.id === entry.id && item.scope === scope)
                    ? 'Remove favorite '
                    : 'Favorite ') + entry.label
                }
                aria-pressed={favorites.some(
                  (item) => item.id === entry.id && item.scope === scope,
                )}
                onClick={() => toggle(entry)}
              >
                <Star
                  size={16}
                  className={
                    favorites.some((item) => item.id === entry.id && item.scope === scope)
                      ? 'fill-ink text-ink'
                      : 'text-ink-2'
                  }
                />
              </Button>
            </li>
          ))}
        </ul>
      ) : (
        <div className="flex min-h-64 flex-col items-center justify-center gap-4 text-center">
          {kind === 'Favorites' ? (
            <Star size={28} strokeWidth={1.5} />
          ) : (
            <Clock3 size={28} strokeWidth={1.5} />
          )}
          <h2>
            {kind === 'Favorites'
              ? 'Keep your frequent work close'
              : 'Your recent work appears here'}
          </h2>
          <p className="max-w-md text-body text-ink-2">
            {kind === 'Favorites'
              ? 'Use the star beside a page or selected dataset to save it here.'
              : 'Open pages, datasets, transformations or connections to build your recent list.'}
          </p>
        </div>
      )}
    </section>
  );
}
