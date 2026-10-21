import { useEffect, useState } from 'react';
import {
  CommandDialog,
  CommandInput,
  CommandItem,
  CommandList,
  CommandEmpty,
  CommandGroup,
  CommandShortcut,
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
      <CommandList>
        <CommandEmpty>No matches. Try a page or entity name.</CommandEmpty>
        <CommandGroup heading="Workspace">
          {matches.map((command) => (
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
              <Icon
                name={
                  command.kind === 'dataset'
                    ? 'table'
                    : command.kind === 'model'
                      ? 'model'
                      : command.kind === 'job'
                        ? 'jobs'
                        : command.kind === 'source'
                          ? 'source'
                          : 'arrow'
                }
              />
              <span className="min-w-0 flex-1">
                <span className="block truncate">{command.label}</span>
                <span className="block truncate text-caption text-muted-foreground">
                  {command.detail ?? command.kind}
                </span>
              </span>
              <CommandShortcut>↵</CommandShortcut>
            </CommandItem>
          ))}
        </CommandGroup>
      </CommandList>
      <footer className="border-t border-line px-4 py-2 text-caption text-ink-3">
        ↑ ↓ to navigate · Enter to open · Esc to close
      </footer>
    </CommandDialog>
  );
}
