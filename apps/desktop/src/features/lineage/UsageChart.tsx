import { useQuery } from '@tanstack/react-query';
import type { Api } from '@/lib/api';
import { Button } from '@/components/ui/button';
import { FeatureError, FeatureLoading } from '@/components/workbench/FeatureState';
import { ChartPreview } from '@/features/analytics/ChartPreview';
export default function UsageChart({
  client,
  id,
  scope,
  onClose,
}: {
  client: Api;
  id: string;
  scope: string;
  onClose: () => void;
}) {
  const chart = useQuery({
    queryKey: ['engine', 'charts', 'view', 'lineage', id],
    queryFn: () => client.chart(id),
  });
  const data = useQuery({
    queryKey: ['engine', 'charts', 'view', 'lineage-data', id],
    queryFn: () => client.chartData(id),
    enabled: !!chart.data,
  });
  return (
    <section className="space-y-4" aria-label="Chart used by field">
      <Button variant="outline" onClick={onClose}>
        Back to charts
      </Button>
      {chart.isPending && <FeatureLoading label="Loading chart" />}
      <FeatureError error={chart.error} retry={() => void chart.refetch()} />
      {chart.data && (
        <>
          <h2>{chart.data.name}</h2>
          <pre className="field-expression" tabIndex={0} aria-label="Read-only chart SQL">
            <code>{chart.data.sql}</code>
          </pre>
          {data.isPending && <FeatureLoading label="Running chart query" />}
          <FeatureError error={data.error} retry={() => void data.refetch()} />
          {data.data && (
            <ChartPreview
              data={data.data}
              kind={chart.data.kind}
              config={chart.data.config}
              scope={scope}
            />
          )}
        </>
      )}
    </section>
  );
}
