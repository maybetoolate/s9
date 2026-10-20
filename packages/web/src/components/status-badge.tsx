import { Badge } from '@/components/ui/badge';
import type { ExecutionStatus, StepStatus, WorkflowStatus } from '@flowforge/core';

type Variant = 'default' | 'secondary' | 'outline' | 'success' | 'warning' | 'destructive' | 'muted';

const EXECUTION_VARIANTS: Record<ExecutionStatus, Variant> = {
  queued: 'muted',
  running: 'default',
  retrying: 'warning',
  succeeded: 'success',
  failed: 'destructive',
  cancelled: 'secondary',
};

const STEP_VARIANTS: Record<StepStatus, Variant> = {
  pending: 'muted',
  running: 'default',
  retrying: 'warning',
  succeeded: 'success',
  failed: 'destructive',
  skipped: 'secondary',
  outcome_unknown: 'warning',
};

const WORKFLOW_VARIANTS: Record<WorkflowStatus, Variant> = {
  draft: 'muted',
  published: 'success',
  paused: 'warning',
  archived: 'secondary',
};

export function ExecutionStatusBadge({ status }: { status: ExecutionStatus }) {
  return <Badge variant={EXECUTION_VARIANTS[status] ?? 'muted'}>{status.replace('_', ' ')}</Badge>;
}

export function StepStatusBadge({ status }: { status: StepStatus }) {
  return <Badge variant={STEP_VARIANTS[status] ?? 'muted'}>{status.replace('_', ' ')}</Badge>;
}

export function WorkflowStatusBadge({ status }: { status: WorkflowStatus }) {
  return <Badge variant={WORKFLOW_VARIANTS[status] ?? 'muted'}>{status}</Badge>;
}

export function ErrorClassBadge({ errorClass }: { errorClass: string }) {
  const variant: Variant =
    errorClass === 'permanent_provider' || errorClass === 'validation'
      ? 'destructive'
      : errorClass === 'timeout' || errorClass === 'rate_limited'
        ? 'warning'
        : errorClass === 'internal_infrastructure'
          ? 'secondary'
          : 'muted';
  return <Badge variant={variant}>{errorClass.replace(/_/g, ' ')}</Badge>;
}
