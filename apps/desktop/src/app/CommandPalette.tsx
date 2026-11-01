import { useEffect, useState } from 'react';
import {
  CommandDialog,
  CommandInput,
  CommandItem,
  CommandList,
  CommandEmpty,
  CommandGroup,
} from '@/components/ui/command';
import { Icon } from '@/components/workbench/Icon';
import { rankCommands } from '@/features/console/workbench-model';
import type { Command } from '@/features/console/workbench-model';
export function CommandPalette({
  open,
  commands,
  onClose,
  onSelect,
}: {
  open: boolean;
  commands: Command[];
  onClose: () => void;
  onSelect: (command: Command) => void;
}) {
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (open) setQuery('');
  }, [open]);
  const matches = rankCommands(commands, query).slice(0, 60);
  return (
    <CommandDialog
      shouldFilter={false}
      title="Search workspace"
      description="Navigate pages and act on datasets, models, jobs and connections."
      open={open}
      onOpenChange={(value) => {
        if (!value) onClose();
      }}
    >
      <CommandInput
        aria-label="Search pages, datasets, models, jobs and sources"
        placeholder="Search pages, datasets, models, jobs…"
        value={query}
        onValueChange={setQuery}
      />
      <CommandList className="max-h-[60vh]">
        <CommandEmpty>No matches. Try a page or entity name.</CommandEmpty>
        {groupCommands(matches).map(([heading, items]) => (
          <CommandGroup key={heading} heading={heading}>
            {items.map((command) => (
              <CommandItem
                key={command.id}
                value={
                  command.id +
                  ' ' +
                  command.label +
                  ' ' +
                  (command.detail ?? '') +
                  ' ' +
                  (command.keywords ?? '')
                }
                onSelect={() => {
                  onClose();
                  onSelect(command);
                }}
              >
                <Icon name={iconOf(command)} />
                <span className="min-w-0 flex-1 truncate">{command.label}</span>
                {command.detail && (
                  <span className="max-w-[45%] shrink truncate text-caption text-ink-3">
                    {command.detail}
                  </span>
                )}
              </CommandItem>
            ))}
          </CommandGroup>
        ))}
      </CommandList>
      <footer className="border-t border-line px-4 py-2 text-caption text-ink-3">
        ↑ ↓ to navigate · Enter to open · Esc to close
      </footer>
    </CommandDialog>
  );
}

const headings: Record<Command['kind'] | 'page', string> = {
  page: 'Pages',
  action: 'Actions',
  dataset: 'Datasets',
  model: 'Models',
  job: 'Jobs',
  source: 'Connections',
};
/** Ranked matches grouped by kind; groups appear in the order of their best match. */
export function groupCommands(matches: Command[]): [string, Command[]][] {
  const groups = new Map<string, Command[]>();
  for (const command of matches) {
    const heading = headings[command.id.startsWith('route:') ? 'page' : command.kind];
    groups.set(heading, [...(groups.get(heading) ?? []), command]);
  }
  return [...groups];
}
function iconOf(command: Command) {
  if (command.id.startsWith('route:')) return 'arrow' as const;
  return (
    { dataset: 'table', model: 'model', job: 'jobs', source: 'source', action: 'plus' } as const
  )[command.kind];
}
