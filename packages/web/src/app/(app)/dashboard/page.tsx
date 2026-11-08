import Link from 'next/link';
import { AlertTriangle, ArrowRight, Clock, Plus, Workflow } from 'lucide-react';
import type { DashboardStatsDto } from '@s9/core';
import { api } from '@/lib/api-server';
import { requireSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
import { ExecutionStatusBadge } from '@/components/status-badge';
import { formatDateTime, formatDuration } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * The dashboard.
 *
 * Summary cards, the runs that need attention and the most recent runs. Test
 * runs are excluded from the metrics.
 */
export default async function DashboardPage() {
  await requireSession();
  const stats = await api.get<DashboardStatsDto>('/api/dashboard');

  const cards = [
    { label: 'Workflows', value: stats.workflows.total, hint: `${stats.workflows.published} published` },
    { label: 'Successful runs', value: stats.executions.succeeded, hint: 'last 7 days excluded' },
    { label: 'Failed runs', value: stats.executions.failed, hint: 'need attention' },
    {
      label: 'Average duration',
      value: formatDuration(stats.executions.averageDurationMs),
      hint: `${stats.executions.last7Days} runs in the last 7 days`,
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Dashboard</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            Every run is inspectable. Every failure is recoverable.
          </p>
        </div>
        <Button asChild>
          <Link href="/workflows/new">
            <Plus />
            Create workflow
          </Link>
        </Button>
      </div>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <Card key={card.label}>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-[var(--color-muted-foreground)]">
                {card.label}
              </CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-2xl font-semibold tabular-nums">{card.value}</p>
              <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">{card.hint}</p>
            </CardContent>
          </Card>
        ))}
      </div>

      {stats.needsAttention.length > 0 ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <AlertTriangle className="size-4 text-[var(--color-warning)]" />
              Needs attention
            </CardTitle>
          </CardHeader>
          <CardContent>
            <ExecutionTable
              executions={stats.needsAttention}
              emptyMessage="No failed executions. Nothing needs your attention."
            />
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Clock className="size-4 text-[var(--color-muted-foreground)]" />
            Recent executions
          </CardTitle>
        </CardHeader>
        <CardContent>
          <ExecutionTable
            executions={stats.recentExecutions}
            emptyMessage="No executions yet. Publish a workflow or send a webhook to get started."
          />
        </CardContent>
      </Card>
    </div>
  );
}

function ExecutionTable({
  executions,
  emptyMessage,
}: {
  executions: DashboardStatsDto['recentExecutions'];
  emptyMessage: string;
}) {
  if (executions.length === 0) {
    return (
      <EmptyState
        icon={Workflow}
        title={emptyMessage}
        action={
          <Button asChild variant="outline" size="sm">
            <Link href="/workflows/new">
              Create a workflow
              <ArrowRight />
            </Link>
          </Button>
        }
      />
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>Workflow</TableHead>
          <TableHead>Status</TableHead>
          <TableHead>Trigger</TableHead>
          <TableHead>Started</TableHead>
          <TableHead>Duration</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {executions.map((execution) => (
          <TableRow key={execution.id}>
            <TableCell>
              <Link
                href={`/executions/${execution.id}`}
                className="font-medium hover:text-[var(--color-primary)]"
              >
                {execution.workflowName}
              </Link>
              {execution.isTest ? (
                <span className="ml-2 rounded-full bg-[var(--color-muted)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-muted-foreground)]">
                  test
                </span>
              ) : null}
            </TableCell>
            <TableCell>
              <ExecutionStatusBadge status={execution.status} />
            </TableCell>
            <TableCell className="text-sm text-[var(--color-muted-foreground)]">{execution.triggerType}</TableCell>
            <TableCell className="text-sm text-[var(--color-muted-foreground)]">
              {formatDateTime(execution.startedAt ?? execution.createdAt)}
            </TableCell>
            <TableCell className="text-sm tabular-nums text-[var(--color-muted-foreground)]">
              {formatDuration(execution.durationMs)}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
