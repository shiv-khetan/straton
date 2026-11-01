import { Checkbox } from '@/components/ui/checkbox';
import { CronField } from '@/features/schedules/CronField';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { FeatureError } from '@/components/workbench/FeatureState';
import type { Model, ModelExplain, ModelInput, ModelLineage } from '@/lib/api';
import { Button, Sheet, Tabs } from '@/components/workbench/primitives';
import { ExplainPlan, Skeleton } from '@/features/console/ConsoleDrawer';
import type { AsyncState } from './ModelPanels';

// Side sheet for creating or editing one model: definition form, lineage and explain tabs.
export function ModelSheet({
  open,
  selected,
  editable,
  busy,
  tab,
  onTab,
  error,
  notice,
  lineageState,
  onRetryLineage,
  explainState,
  onRetryExplain,
  onClose,
  ...form
}: Omit<DefinitionProps, 'selected' | 'editable' | 'busy'> & {
  open: boolean;
  selected: Model | null;
  editable: boolean;
  busy: boolean;
  tab: string;
  onTab: (tab: string) => void;
  error: string;
  notice: string;
  lineageState: AsyncState<ModelLineage>;
  onRetryLineage: () => void;
  explainState: AsyncState<ModelExplain>;
  onRetryExplain: () => void;
  onClose: () => void;
}) {
  const lineage = lineageState.data;
  return (
    <Sheet
      open={open}
      title={selected ? 'Model · ' + selected.name : 'New SQL model'}
      onClose={onClose}
    >
      <Tabs
        id="model"
        items={
          selected
            ? editable
              ? ['Definition', 'Lineage', 'Explain']
              : ['Definition', 'Lineage']
            : ['Definition']
        }
        value={tab}
        onChange={onTab}
      />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
      <section role="tabpanel" id={'model-panel-' + tab} aria-labelledby={'model-tab-' + tab}>
        {tab === 'Definition' && (
          <DefinitionForm {...form} selected={selected} editable={editable} busy={busy} />
        )}
        {tab === 'Lineage' &&
          (lineage ? (
            <div className="model-lineage">
              {(['upstream', 'downstream'] as const).map((direction) => (
                <section key={direction}>
                  <h3>{direction === 'upstream' ? 'Upstream inputs' : 'Downstream consumers'}</h3>
                  {lineage[direction]?.length ? (
                    <ul>
                      {lineage[direction]?.map((d) => (
                        <li key={d.id}>
                          <code>
                            {d.sql_schema}.{d.sql_table}
                          </code>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <p className="hint">No visible {direction} datasets.</p>
                  )}
                </section>
              ))}
            </div>
          ) : lineageState.pending ? (
            <Skeleton label="Loading lineage…" />
          ) : lineageState.error ? (
            <FeatureError error={lineageState.error} retry={onRetryLineage} />
          ) : (
            <p className="hint">No lineage has been loaded.</p>
          ))}
        {tab === 'Explain' &&
          (explainState.pending ? (
            <Skeleton label="Planning…" />
          ) : explainState.error ? (
            <FeatureError
              error={explainState.error}
              retry={selected ? onRetryExplain : undefined}
            />
          ) : (
            <ExplainPlan plans={explainState.data} />
          ))}
      </section>
    </Sheet>
  );
}

type DefinitionProps = {
  selected: Model | null;
  editable: boolean;
  busy: boolean;
  draft: ModelInput;
  setDraft: (draft: ModelInput) => void;
  onSqlEdit: () => void;
  onSave: () => void;
  validate: () => void;
  onRun: () => void;
  onDelete: () => void;
};

function DefinitionForm({
  selected,
  editable,
  busy,
  draft,
  setDraft,
  onSqlEdit,
  onSave,
  validate,
  onRun,
  onDelete,
}: DefinitionProps) {
  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        onSave();
      }}
    >
      <label className="field">
        <span>Name</span>
        <Input
          required
          pattern="[a-z_][a-z0-9_]*"
          maxLength={128}
          disabled={!editable || busy}
          value={draft.name}
          onChange={(e) => setDraft({ ...draft, name: e.target.value })}
        />
      </label>
      <label className="field">
        <span>SQL · one SELECT</span>
        <Textarea
          className="model-sql"
          rows={14}
          required
          spellCheck={false}
          disabled={!editable || busy}
          value={draft.sql}
          onChange={(e) => {
            setDraft({ ...draft, sql: e.target.value });
            onSqlEdit();
          }}
          onKeyDown={(e) => {
            if (editable && !busy && e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              validate();
            }
          }}
        />
      </label>
      <p className="hint">
        Ctrl / Cmd + Enter validates. Table runs use the owner's access. Views use the querying
        user's access.
      </p>
      <div className="form-grid">
        <label className="field">
          <span>Materialization</span>
          <select
            disabled={!editable || busy}
            value={draft.materialization}
            onChange={(e) => {
              const materialization = e.target.value as ModelInput['materialization'];
              setDraft({
                ...draft,
                materialization,
                ...(materialization === 'view' ? { trigger: 'manual', cron: null } : {}),
              });
            }}
          >
            <option value="table">Table · published snapshot</option>
            <option value="view">View · evaluated on query</option>
          </select>
        </label>
        <label className="field">
          <span>Trigger</span>
          <select
            disabled={!editable || busy || draft.materialization === 'view'}
            value={draft.trigger}
            onChange={(e) => {
              const trigger = e.target.value as ModelInput['trigger'];
              setDraft({
                ...draft,
                trigger,
                cron: trigger === 'cron' ? '0 */5 * * * *' : null,
              });
            }}
          >
            <option value="manual">Manual</option>
            <option value="cron">Cron</option>
            <option value="upstream">Upstream publish</option>
          </select>
        </label>
        {draft.trigger === 'cron' && (
          <CronField
            required
            optional={false}
            disabled={!editable || busy}
            value={draft.cron ?? ''}
            onChange={(cron) => setDraft({ ...draft, cron })}
          />
        )}
      </div>
      <label>
        <Checkbox
          disabled={!editable || busy}
          checked={draft.optimize}
          onCheckedChange={(checked) => setDraft({ ...draft, optimize: checked === true })}
        />{' '}
        Enable Straton optimizer rules
      </label>
      {editable && (
        <div className="actions model-actions">
          <Button type="button" variant="ghost" disabled={busy} onClick={validate}>
            Validate SQL
          </Button>
          <Button type="submit" variant="default" disabled={busy}>
            Save model
          </Button>
          {selected && selected.materialization === 'table' && (
            <Button
              type="button"
              variant="ghost"
              disabled={busy || selected.status === 'broken'}
              onClick={onRun}
            >
              Run now
            </Button>
          )}
          {selected && (
            <Button type="button" variant="destructive" disabled={busy} onClick={onDelete}>
              Delete
            </Button>
          )}
        </div>
      )}
    </form>
  );
}
