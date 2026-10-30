import { useState } from 'react';
import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { Api, Me } from '@/lib/api';
import { queryKeys } from '@/lib/queryKeys';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Field } from '@/components/workbench/Field';
import {
  Choice,
  FeatureEmpty,
  FeatureError,
  FeatureLoading,
} from '@/components/workbench/FeatureState';
import { groupActivity } from './activity-model';
import { PageToolbar } from '@/components/workbench/page-layout';
export default function Activity({ client, me }: { client: Api; me: Me }) {
  const [group, setGroup] = useState('');
  const [actor, setActor] = useState('');
  const [entity, setEntity] = useState('');
  const [entityDraft, setEntityDraft] = useState('');
  const actors = useQuery({
    queryKey: [...queryKeys.access, 'view', 'activity-actors'],
    queryFn: () => client.users(),
    enabled: me.privileges.admin,
  });
  const query = useInfiniteQuery({
    queryKey: [...queryKeys.activity, 'view', 'feed', group, actor, entity],
    initialPageParam: undefined as number | undefined,
    queryFn: ({ pageParam }) =>
      client.activity({
        before_id: pageParam,
        limit: 50,
        ...(group ? { action_prefix: group } : {}),
        ...(actor ? { actor } : {}),
        ...(entity ? { entity } : {}),
      }),
    getNextPageParam: (last) => (last.length === 50 ? last[last.length - 1].id : undefined),
  });
  const grouped = groupActivity(query.data?.pages.flat() ?? []);
  return (
    <section className="space-y-5">
      <PageToolbar>
        <Choice
          label="Action group"
          value={group}
          options={[
            { value: '', label: 'All actions' },
            ...[
              'source',
              'dataset',
              'job',
              'run',
              'model',
              'pipeline',
              'quality',
              'chart',
              'dashboard',
              'notification',
              'user',
              'role',
              'backup',
              'audit',
              'token',
              'grant',
              'policy',
            ].map((k) => ({ value: k + '.', label: k })),
          ]}
          onChange={setGroup}
        />
        {me.privileges.admin ? (
          <Choice
            label="Actor"
            value={actor}
            options={[
              { value: '', label: 'All actors' },
              ...(actors.data ?? []).map((u) => ({ value: u.id, label: u.name })),
            ]}
            onChange={setActor}
          />
        ) : (
          <p className="text-ink-2">Showing your activity</p>
        )}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            setEntity(entityDraft.trim());
          }}
        >
          <Field label="Entity ID">
            <Input
              value={entityDraft}
              placeholder="Filter by entity ID"
              onChange={(e) => setEntityDraft(e.target.value)}
            />
          </Field>
          <Button variant="outline" type="submit">
            Apply
          </Button>
        </form>
        <Button
          variant="ghost"
          onClick={() => {
            setGroup('');
            setActor('');
            setEntity('');
            setEntityDraft('');
          }}
        >
          Clear filters
        </Button>
      </PageToolbar>
      <FeatureError error={actors.error} retry={() => void actors.refetch()} />
      {query.isPending && <FeatureLoading label="Loading activity" />}
      <FeatureError error={query.error} retry={() => void query.refetch()} />
      {!query.isPending && !query.isError && !grouped.length && (
        <FeatureEmpty
          title="No activity matches"
          action="Clear filters"
          onAction={() => {
            setGroup('');
            setActor('');
            setEntity('');
            setEntityDraft('');
          }}
        >
          Workspace actions appear here as they happen. Try clearing filters or return after running
          work.
        </FeatureEmpty>
      )}
      {grouped.map((g) => (
        <section key={g.day}>
          <h2 className="mb-2 border-b border-line pb-2 font-medium">
            {g.day} <span className="text-caption text-ink-2">UTC</span>
          </h2>
          <ol className="divide-y divide-line">
            {g.items.map((e) => (
              <li key={e.id} className="flex flex-wrap items-start gap-4 py-3">
                <time
                  className="w-20 shrink-0 font-mono text-caption text-ink-2"
                  dateTime={new Date(e.at * 1000).toISOString()}
                >
                  {new Date(e.at * 1000).toISOString().slice(11, 19)}
                </time>
                <div className="min-w-0 flex-1">
                  <p>{e.summary}</p>
                  <p className="mt-1 break-all text-caption text-ink-2">
                    {e.actor_name ?? e.actor_id ?? 'Engine'} · {e.action}
                    {e.entity_id ? ' · ' + e.entity_id : ''}
                  </p>
                </div>
              </li>
            ))}
          </ol>
        </section>
      ))}
      {query.hasNextPage && (
        <Button
          variant="outline"
          disabled={query.isFetchingNextPage}
          onClick={() => void query.fetchNextPage()}
        >
          {query.isFetchingNextPage ? 'Loading older activity…' : 'Load older activity'}
        </Button>
      )}
      {query.isFetchingNextPage && <FeatureLoading label="Loading older activity" />}
    </section>
  );
}
