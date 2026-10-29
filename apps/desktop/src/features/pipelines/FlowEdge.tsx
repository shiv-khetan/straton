import { BaseEdge, getSmoothStepPath } from '@xyflow/react';
import type { Edge, EdgeProps } from '@xyflow/react';
import type { FlowState } from './pipeline-model';

export type FlowEdgeType = Edge<{ flow: FlowState }, 'flow'>;

export function FlowEdge(props: EdgeProps<FlowEdgeType>) {
  const flow = props.data?.flow ?? 'idle';
  const [path] = getSmoothStepPath({ ...props, borderRadius: 10 });
  return (
    <g className={'flow-edge flow-' + flow + (props.selected ? ' selected' : '')}>
      <BaseEdge id={props.id} path={path} markerEnd={props.markerEnd} className="flow-track" />
      {(flow === 'flowing' || flow === 'idle') && (
        // pathLength normalises any edge to 100 units, so one dash pattern fits every hop.
        <path d={path} pathLength={100} className="flow-pulse" fill="none" aria-hidden="true" />
      )}
    </g>
  );
}
export const edgeTypes = { flow: FlowEdge };
