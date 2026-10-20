import { useEffect, useState } from 'react';
import type { Api, Me, Model, ModelInput, ModelExplain, ModelLineage } from './api';
import { Button, Card, EmptyState, Pill, Sheet, Table, Tabs } from './ui';
import { modelStatus, ruleDiffRows } from './model-model';
import { relativeTime } from './view-model';
const initial: ModelInput = {
  name: '',
  sql: 'SELECT id, name FROM app_db.users',
  materialization: 'table',
  trigger: 'manual',
  cron: null,
  optimize: true,
};
export default function Models({
  client,
  me,
  revision,
  changed,
}: {
  client: Api;
  me: Me;
  revision: number;
  changed: () => void;
}) {
  const [models, setModels] = useState<Model[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Model | null>(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<ModelInput>(initial);
  const [tab, setTab] = useState('Definition');
  const [plans, setPlans] = useState<ModelExplain | null>(null);
  const [lineage, setLineage] = useState<ModelLineage | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const editable = !selected || me.privileges.admin || selected.owner_id === me.user.id;
  useEffect(() => {
    let active = true;
    client
      .models()
      .then((rows) => {
        if (active) {
          setModels(rows);
          setLoading(false);
        }
      })
      .catch((e) => {
        if (active) {
          setError(String(e));
          setLoading(false);
        }
      });
    return () => {
      active = false;
    };
  }, [client, revision]);
  useEffect(() => {
    if (!selected || !open) return;
    let active = true;
    setLineage(null);
    client
      .modelLineage(selected.id)
      .then((result) => {
        if (active) setLineage(result);
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [client, selected, open, revision]);
  async function action(work: () => Promise<unknown>, message: string, refresh = true) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      setNotice(message);
      if (refresh) changed();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function edit(model: Model | null) {
    setSelected(model);
    setDraft(
      model
        ? {
            name: model.name,
            sql: model.sql,
            materialization: model.materialization,
            trigger: model.trigger,
            cron: model.cron,
            optimize: model.optimize,
          }
        : { ...initial },
    );
    setTab('Definition');
    setPlans(null);
    setError('');
    setNotice('');
    setOpen(true);
  }
  const validate = () =>
    void action(() => client.validateModel(draft), 'SQL is valid for your access.', false);
  return (
    <>
      <div className="page-heading">
        <div>
          <h1>Models</h1>
          <p className="hint">Build reusable SQL transformations and follow their lineage.</p>
        </div>
        <Button variant="primary" disabled={busy} onClick={() => edit(null)}>
          New model
        </Button>
      </div>
      {!open && error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
      {!open && notice && <p role="status">{notice}</p>}
      <Card aria-busy={loading}>
        {loading ? (
          <p role="status">Loading models…</p>
        ) : models.length ? (
          <Table label="SQL models">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col">Materialization</th>
                <th scope="col">Trigger</th>
                <th scope="col">Status</th>
                <th scope="col">Last run</th>
                <th scope="col">Rows</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {models.map((m) => {
                const status = modelStatus(m.status, m.last_run_status);
                const canEdit = me.privileges.admin || m.owner_id === me.user.id;
                return (
                  <tr key={m.id}>
                    <td>
                      <button className="model-name" disabled={busy} onClick={() => edit(m)}>
                        <code>models.{m.name}</code>
                      </button>
                      {m.error && <small className="error">{m.error}</small>}
                    </td>
                    <td>
                      <Pill>{m.materialization}</Pill>
                    </td>
                    <td>{m.trigger}</td>
                    <td>
                      <Pill tone={status.tone}>{status.label}</Pill>
                    </td>
                    <td>{m.last_run ? relativeTime(m.last_run * 1000) : 'Never'}</td>
                    <td>
                      {m.materialization === 'view'
                        ? 'On query'
                        : (m.row_count?.toLocaleString() ?? '—')}
                    </td>
                    <td>
                      <div className="actions">
                        <Button disabled={busy} onClick={() => edit(m)}>
                          {canEdit ? 'Edit / Explain' : 'Lineage'}
                        </Button>
                        {canEdit && m.materialization === 'table' && (
                          <Button
                            disabled={busy || m.status === 'broken'}
                            onClick={() => void action(() => client.runModel(m.id), 'Run queued')}
                          >
                            Run now
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        ) : (
          <EmptyState
            action={
              <Button variant="primary" onClick={() => edit(null)}>
                New model
              </Button>
            }
          >
            Create a model from a synced dataset. Table models publish snapshots; views run when
            queried.
          </EmptyState>
        )}
      </Card>
      <Sheet
        open={open}
        title={selected ? 'Model · ' + selected.name : 'New SQL model'}
        onClose={() => setOpen(false)}
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
          onChange={(next) => {
            setTab(next);
            if (next === 'Explain' && selected)
              void action(
                async () => setPlans(await client.explainModel(selected.id)),
                'Explain ready',
                false,
              );
          }}
        />
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {notice && <p role="status">{notice}</p>}
        <section role="tabpanel" id={'model-panel-' + tab} aria-labelledby={'model-tab-' + tab}>
          {tab === 'Definition' && (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                void action(async () => {
                  if (selected) await client.updateModel(selected.id, draft);
                  else await client.createModel(draft);
                  setOpen(false);
                }, 'Model saved');
              }}
            >
              <label className="field">
                <span>Name</span>
                <input
                  required
                  pattern="[a-z_][a-z0-9_]*"
                  maxLength={128}
                  disabled={!editable}
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </label>
              <label className="field">
                <span>SQL · one SELECT</span>
                <textarea
                  className="model-sql"
                  rows={14}
                  required
                  spellCheck={false}
                  disabled={!editable}
                  value={draft.sql}
                  onChange={(e) => {
                    setDraft({ ...draft, sql: e.target.value });
                    setNotice('');
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
                Ctrl / Cmd + Enter validates. Table runs use the owner's access. Views use the
                querying user's access.
              </p>
              <div className="form-grid">
                <label className="field">
                  <span>Materialization</span>
                  <select
                    disabled={!editable}
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
                    disabled={!editable || draft.materialization === 'view'}
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
                  <label className="field">
                    <span>Cron · UTC, seconds first</span>
                    <input
                      required
                      disabled={!editable}
                      value={draft.cron ?? ''}
                      onChange={(e) => setDraft({ ...draft, cron: e.target.value })}
                    />
                  </label>
                )}
              </div>
              <label>
                <input
                  type="checkbox"
                  disabled={!editable}
                  checked={draft.optimize}
                  onChange={(e) => setDraft({ ...draft, optimize: e.target.checked })}
                />{' '}
                Enable Straton optimizer rules
              </label>
              {editable && (
                <div className="actions model-actions">
                  <Button disabled={busy} onClick={validate}>
                    Validate SQL
                  </Button>
                  <Button type="submit" variant="primary" disabled={busy}>
                    Save model
                  </Button>
                  {selected && (
                    <Button
                      variant="danger"
                      disabled={busy}
                      onClick={() => {
                        if (
                          window.confirm(
                            'Delete ' + selected.name + '? Historical runs will be retained.',
                          )
                        )
                          void action(async () => {
                            await client.deleteModel(selected.id);
                            setOpen(false);
                          }, 'Model deleted');
                      }}
                    >
                      Delete
                    </Button>
                  )}
                </div>
              )}
            </form>
          )}
          {tab === 'Lineage' &&
            (lineage ? (
              <div className="model-lineage">
                {(['upstream', 'downstream'] as const).map((direction) => (
                  <section key={direction}>
                    <h3>{direction === 'upstream' ? 'Upstream inputs' : 'Downstream consumers'}</h3>
                    {lineage[direction].length ? (
                      <ul>
                        {lineage[direction].map((d) => (
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
            ) : (
              <p role="status">Loading lineage…</p>
            ))}
          {tab === 'Explain' &&
            (plans ? (
              <>
                <p className="hint">Explain uses the saved definition and the owner's access.</p>
                <h3>Rule firings</h3>
                {plans.rules_fired.length ? (
                  <Table label="Optimizer before and after">
                    <thead>
                      <tr>
                        <th scope="col">Rule</th>
                        <th scope="col">Change</th>
                        <th scope="col">Expression</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ruleDiffRows(plans.rules_fired).map((row) => (
                        <tr key={row.id} className={'rule-' + row.kind}>
                          <td>{row.rule}</td>
                          <td>{row.sign}</td>
                          <td>
                            <code>{row.expression}</code>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </Table>
                ) : (
                  <p className="hint">No Straton rules fired for this plan.</p>
                )}
                {(['logical_before', 'logical_after', 'physical'] as const).map((key) => (
                  <details key={key} className="model-plan">
                    <summary>{key.replaceAll('_', ' ')}</summary>
                    <pre>{plans[key]}</pre>
                  </details>
                ))}
              </>
            ) : (
              <p role="status">Planning…</p>
            ))}
        </section>
      </Sheet>
    </>
  );
}
