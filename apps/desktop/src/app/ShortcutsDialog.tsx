import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { shortcuts as sqlShortcuts } from '@/features/sql/workspace-model';
import { navigation, sectionLabels } from './navigation';

const mod = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl';
// One reference for every shortcut the app answers to; the SQL list is SqlWorkspace's own keymap.
const groups: { title: string; keys: [string, string][] }[] = [
  {
    title: 'Everywhere',
    keys: [
      [mod + ' K', 'Search pages, tables, jobs and models'],
      ['?', 'Show this list'],
      ['Alt ← / Alt →', 'Back and forward through pages'],
      ...navigation.map((group, i): [string, string] => [
        'Alt ' + (i + 1),
        'Go to ' + sectionLabels[group.label],
      ]),
    ],
  },
  {
    title: 'SQL Workspace',
    keys: sqlShortcuts.map(([keys, action]): [string, string] => [
      keys.replaceAll('+', ' '),
      action,
    ]),
  },
];

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[calc(100dvh-2rem)] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
          <DialogDescription>
            Press ? anywhere outside a text field to open this list.
          </DialogDescription>
        </DialogHeader>
        {groups.map((group) => (
          <section key={group.title} className="space-y-1">
            <h3 className="text-xs font-medium text-ink-3">{group.title}</h3>
            <ul className="divide-y divide-line">
              {group.keys.map(([keys, action]) => (
                <li key={keys} className="flex items-center justify-between gap-4 py-1.5 text-body">
                  <span className="text-ink-2">{action}</span>
                  <span className="shrink-0">
                    <kbd className="rounded-xs border border-line bg-panel px-1.5 py-0.5 font-mono text-caption whitespace-nowrap">
                      {keys}
                    </kbd>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        ))}
      </DialogContent>
    </Dialog>
  );
}
