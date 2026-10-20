import type { ModelExplain } from './api';
import type { Tone } from './ui';
export function modelStatus(status: string, lastRun: string | null): { label: string; tone: Tone } {
  const label = status === 'broken' ? 'broken' : (lastRun ?? status);
  const tone: Tone = ['broken', 'failed', 'interrupted', 'error'].includes(label)
    ? 'danger'
    : ['queued', 'cancelled'].includes(label)
      ? 'warning'
      : label === 'running'
        ? 'primary'
        : ['ready', 'succeeded'].includes(label)
          ? 'success'
          : 'neutral';
  return { label, tone };
}
export function ruleDiffRows(rules: ModelExplain['rules_fired']) {
  return rules.flatMap((rule, index) => [
    { id: index + '-before', rule: rule.rule, sign: '−', expression: rule.before, kind: 'before' },
    { id: index + '-after', rule: rule.rule, sign: '+', expression: rule.after, kind: 'after' },
  ]);
}
