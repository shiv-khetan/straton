import { useId, useState } from 'react';
import { Check, ChevronsUpDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Popover, PopoverTrigger, PopoverContent } from '@/components/ui/popover';
import {
  Command,
  CommandInput,
  CommandList,
  CommandEmpty,
  CommandItem,
} from '@/components/ui/command';

export function SearchableChoice({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <Label id={id}>{label}</Label>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            variant="outline"
            role="combobox"
            aria-expanded={open}
            aria-labelledby={id}
            className="max-w-full justify-between"
            disabled={disabled}
          >
            <span className="truncate">
              {options.find((option) => option.value === value)?.label ?? (value || 'Choose…')}
            </span>
            <ChevronsUpDown size={16} aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-80 max-w-[calc(100vw-2rem)] p-0" align="start">
          <Command>
            <CommandInput
              aria-label={'Search ' + label.toLowerCase()}
              placeholder={'Search ' + label.toLowerCase() + '…'}
            />
            <CommandList>
              <CommandEmpty>No matches.</CommandEmpty>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={option.value + ' ' + option.label}
                  onSelect={() => {
                    onChange(option.value);
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 break-words">{option.label}</span>
                  {option.value === value && <Check size={16} aria-hidden="true" />}
                </CommandItem>
              ))}
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>
    </div>
  );
}
