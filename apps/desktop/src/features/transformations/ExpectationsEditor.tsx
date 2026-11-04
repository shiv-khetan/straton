import { X } from 'lucide-react';
import { Input } from '@/components/ui/input';
import type { ExpectationAction, ExpectationResult, ModelExpectation } from '@/lib/api';
import { Button, StatePill } from '@/components/workbench/primitives';
import { expectationNameValid, expectationOutcome } from './model-model';

const actions: { value: ExpectationAction; label: string }[] = [
  { value: 'warn', label: 'Warn' },
  { value: 'drop', label: 'Drop rows' },
  { value: 'fail', label: 'Fail run' },
];

// Data expectations on a table model (DLT-style): each row must make the predicate true.
// The engine checks them while the model materializes; results come from the last run.
export function ExpectationsEditor({
  expectations,
  results,
  editable,
  busy,
  onChange,
}: {
  expectations: ModelExpectation[];
  results: ExpectationResult[] | undefined;
  editable: boolean;
  busy: boolean;
  onChange: (next: ModelExpectation[]) => void;
}) {
  const update = (index: number, patch: Partial<ModelExpectation>) =>
    onChange(expectations.map((e, i) => (i === index ? { ...e, ...patch } : e)));
  const nextName = () => {
    let n = expectations.length + 1;
    while (expectations.some((e) => e.name === 'rule_' + n)) n++;
    return 'rule_' + n;
  };
  return (
    <section className="model-expectations" aria-labelledby="model-expectations-title">
      <h3 id="model-expectations-title">Expectations</h3>
      <p className="hint">
        A row passes when its rule is true. Warn records failing rows, Drop rows removes them before
        publishing, and Fail run stops the run so the last snapshot stays current.
      </p>
      {expectations.length === 0 ? (
        <p className="text-ink-3">No expectations. Add one to check rows on every run.</p>
      ) : (
        <ol className="model-expectation-list" aria-label="Expectations">
          {expectations.map((e, i) => {
            const outcome = expectationOutcome(results?.find((r) => r.name === e.name));
            const label = e.name || 'expectation ' + (i + 1);
            return (
              <li key={i} className="model-expectation">
                <div className="model-expectation-head">
                  <Input
                    aria-label={'Expectation ' + (i + 1) + ' name'}
                    aria-invalid={!expectationNameValid(e.name)}
                    className="w-40 font-mono"
                    maxLength={64}
                    disabled={!editable || busy}
                    value={e.name}
                    onChange={(ev) => update(i, { name: ev.target.value })}
                  />
                  <select
                    className="w-32"
                    aria-label={'On failure for ' + label}
                    disabled={!editable || busy}
                    value={e.action}
                    onChange={(ev) => update(i, { action: ev.target.value as ExpectationAction })}
                  >
                    {actions.map((a) => (
                      <option key={a.value} value={a.value}>
                        {a.label}
                      </option>
                    ))}
                  </select>
                  {editable && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-sm"
                      className="ms-auto"
                      aria-label={'Remove expectation ' + label}
                      disabled={busy}
                      onClick={() => onChange(expectations.filter((_, j) => j !== i))}
                    >
                      <X aria-hidden="true" />
                    </Button>
                  )}
                </div>
                <Input
                  aria-label={'Rule for ' + label}
                  className="w-full font-mono"
                  placeholder="amount >= 0"
                  maxLength={2000}
                  spellCheck={false}
                  disabled={!editable || busy}
                  value={e.predicate}
                  onChange={(ev) => update(i, { predicate: ev.target.value })}
                />
                <span className="model-expectation-result">
                  <StatePill state={outcome.state} label={outcome.label} />
                  {outcome.detail && (
                    <span className="text-caption text-ink-2 tabular-nums">{outcome.detail}</span>
                  )}
                </span>
              </li>
            );
          })}
        </ol>
      )}
      {editable && (
        <Button
          type="button"
          variant="outline"
          disabled={busy || expectations.length >= 32}
          onClick={() =>
            onChange([...expectations, { name: nextName(), predicate: '', action: 'warn' }])
          }
        >
          Add expectation
        </Button>
      )}
    </section>
  );
}
