import Link from 'next/link';
import type { ExecutionSummaryDto, Paginated } from '@s9/core';
import { api } from '@/lib/api-server';
import { requireSession } from '@/lib/session';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/feedback';
import { ExecutionStatusBadge } from '@/components/status-badge';
import { formatDateTime, formatDuration } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * The execution history.
 *
 * Filters: workflow, status, trigger type, test or production, time range and
 * a search by execution id.
 */
export default async function ExecutionsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const params = await searchParams;

  const status = typeof params.status === 'string' ? params.status : 'all';
  const triggerType = typeof params.triggerType === 'string' ? params.triggerType : 'all';
  const isTest = typeof params.isTest === 'string' ? params.isTest : 'all';
  const workflowId = typeof params.workflowId === 'string' ? params.workflowId : '';
  const search = typeof params.search === 'string' ? params.search : '';
  const page = typeof params.page === 'string' ? Number(params.page) : 1;

  const query = new URLSearchParams();
  if (status !== 'all') query.set('status', status);
  if (triggerType !== 'all') query.set('triggerType', triggerType);
  if (isTest !== 'all') query.set('isTest', isTest);
  if (workflowId) query.set('workflowId', workflowId);
  if (search) query.set('search', search);
  query.set('page', String(page));
  query.set('pageSize', '50');

  const result = await api.get<Paginated<ExecutionSummaryDto>>(`/api/executions?${query.toString()}`);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Executions</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          {result.pagination.total} execution{result.pagination.total === 1 ? '' : 's'} recorded.
        </p>
      </div>

      <Card>
        <CardContent className="pt-5">
          <form method="get" className="mb-4 flex flex-wrap gap-3">
            <input
              type="search"
              name="search"
              defaultValue={search}
              placeholder="Search by execution id"
              className="h-9 w-full max-w-xs rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
            />
            <select
              name="status"
              defaultValue={status}
              className="h-9 rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 text-sm"
            >
              <option value="all">All statuses</option>
              <option value="queued">Queued</option>
              <option value="running">Running</option>
              <option value="retrying">Retrying</option>
              <option value="succeeded">Succeeded</option>
              <option value="failed">Failed</option>
              <option value="cancelled">Cancelled</option>
            </select>
            <select
              name="triggerType"
              defaultValue={triggerType}
              className="h-9 rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 text-sm"
            >
              <option value="all">All triggers</option>
              <option value="webhook">Webhook</option>
              <option value="schedule">Schedule</option>
              <option value="manual">Manual</option>
            </select>
            <select
              name="isTest"
              defaultValue={isTest}
              className="h-9 rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 text-sm"
            >
              <option value="all">Test and production</option>
              <option value="false">Production only</option>
              <option value="true">Test only</option>
            </select>
            <Button type="submit" variant="outline">
              Filter
            </Button>
          </form>

          {result.data.length === 0 ? (
            <EmptyState
              title="No executions match these filters"
              description="Clear the filters, or trigger a workflow to see a run here."
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Execution</TableHead>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Started</TableHead>
                  <TableHead>Duration</TableHead>
                  <TableHead>Error</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.map((execution) => (
                  <TableRow key={execution.id}>
                    <TableCell>
                      <Link
                        href={`/executions/${execution.id}`}
                        className="font-mono text-xs hover:text-[var(--color-primary)]"
                      >
                        {execution.id.slice(0, 8)}
                      </Link>
                      {execution.isTest ? (
                        <span className="ml-2 rounded-full bg-[var(--color-muted)] px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-muted-foreground)]">
                          test
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <Link
                        href={`/workflows/${execution.workflowId}`}
                        className="text-sm hover:text-[var(--color-primary)]"
                      >
                        {execution.workflowName}
                      </Link>
                    </TableCell>
                    <TableCell>
                      <ExecutionStatusBadge status={execution.status} />
                    </TableCell>
                    <TableCell className="text-sm text-[var(--color-muted-foreground)]">
                      {execution.triggerType}
                    </TableCell>
                    <TableCell className="text-sm text-[var(--color-muted-foreground)]">
                      {formatDateTime(execution.startedAt ?? execution.createdAt)}
                    </TableCell>
                    <TableCell className="text-sm tabular-nums text-[var(--color-muted-foreground)]">
                      {formatDuration(execution.durationMs)}
                    </TableCell>
                    <TableCell className="max-w-[280px] truncate text-xs text-[var(--color-muted-foreground)]">
                      {execution.error?.message ?? '—'}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}

          {result.pagination.totalPages > 1 ? (
            <div className="mt-4 flex items-center justify-between text-sm">
              <span className="text-[var(--color-muted-foreground)]">
                Page {result.pagination.page} of {result.pagination.totalPages}
              </span>
              <div className="flex gap-2">
                {result.pagination.page > 1 ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/executions?${new URLSearchParams({ ...Object.fromEntries(query), page: String(result.pagination.page - 1) })}`}>
                      Previous
                    </Link>
                  </Button>
                ) : null}
                {result.pagination.page < result.pagination.totalPages ? (
                  <Button asChild variant="outline" size="sm">
                    <Link href={`/executions?${new URLSearchParams({ ...Object.fromEntries(query), page: String(result.pagination.page + 1) })}`}>
                      Next
                    </Link>
                  </Button>
                ) : null}
              </div>
            </div>
          ) : null}
        </CardContent>
      </Card>
    </div>
  );
}
