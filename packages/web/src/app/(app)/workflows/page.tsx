import Link from 'next/link';
import { Plus, Workflow as WorkflowIcon } from 'lucide-react';
import type { Paginated, WorkflowSummaryDto } from '@s9/core';
import { api } from '@/lib/api-server';
import { requireSession } from '@/lib/session';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EmptyState } from '@/components/ui/feedback';
import { WorkflowStatusBadge } from '@/components/status-badge';
import { WorkflowActions } from './workflow-actions';
import { formatDateTime, relativeTime } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * The workflow list.
 *
 * Columns: name, status, trigger type, last run, step count, updated time.
 */
export default async function WorkflowsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  await requireSession();
  const params = await searchParams;

  const status = typeof params.status === 'string' ? params.status : 'all';
  const triggerType = typeof params.triggerType === 'string' ? params.triggerType : 'all';
  const search = typeof params.search === 'string' ? params.search : '';

  const query = new URLSearchParams();
  if (status !== 'all') query.set('status', status);
  if (triggerType !== 'all') query.set('triggerType', triggerType);
  if (search) query.set('search', search);
  query.set('pageSize', '100');

  const result = await api.get<Paginated<WorkflowSummaryDto>>(`/api/workflows?${query.toString()}`);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Workflows</h1>
          <p className="text-sm text-[var(--color-muted-foreground)]">
            {result.pagination.total} workflow{result.pagination.total === 1 ? '' : 's'} in this workspace.
          </p>
        </div>
        <Button asChild>
          <Link href="/workflows/new">
            <Plus />
            Create workflow
          </Link>
        </Button>
      </div>

      <Card>
        <CardContent className="pt-5">
          <form method="get" className="mb-4 flex flex-wrap gap-3">
            <input
              type="search"
              name="search"
              defaultValue={search}
              placeholder="Search by name"
              className="h-9 w-full max-w-xs rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-ring)]"
            />
            <select
              name="status"
              defaultValue={status}
              className="h-9 rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 text-sm"
            >
              <option value="all">All statuses</option>
              <option value="draft">Draft</option>
              <option value="published">Published</option>
              <option value="paused">Paused</option>
              <option value="archived">Archived</option>
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
            <Button type="submit" variant="outline">
              Filter
            </Button>
          </form>

          {result.data.length === 0 ? (
            <EmptyState
              icon={WorkflowIcon}
              title="No workflows yet"
              description="Create a workflow to start accepting webhook deliveries, scheduled runs or manual runs."
              action={
                <Button asChild size="sm">
                  <Link href="/workflows/new">Create workflow</Link>
                </Button>
              }
            />
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Steps</TableHead>
                  <TableHead>Last run</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-24 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {result.data.map((workflow) => (
                  <TableRow key={workflow.id}>
                    <TableCell>
                      <Link
                        href={`/workflows/${workflow.id}`}
                        className="font-medium hover:text-[var(--color-primary)]"
                      >
                        {workflow.name}
                      </Link>
                      {workflow.hasUnpublishedChanges ? (
                        <span className="ml-2 rounded-full bg-[var(--color-warning)]/20 px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-warning)]">
                          unpublished changes
                        </span>
                      ) : null}
                    </TableCell>
                    <TableCell>
                      <WorkflowStatusBadge status={workflow.status} />
                    </TableCell>
                    <TableCell className="text-sm text-[var(--color-muted-foreground)]">{workflow.triggerType}</TableCell>
                    <TableCell className="text-sm tabular-nums text-[var(--color-muted-foreground)]">
                      {workflow.stepCount}
                    </TableCell>
                    <TableCell className="text-sm text-[var(--color-muted-foreground)]">
                      {workflow.lastRunAt ? relativeTime(workflow.lastRunAt) : 'never'}
                    </TableCell>
                    <TableCell className="text-sm text-[var(--color-muted-foreground)]">
                      {formatDateTime(workflow.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <WorkflowActions workflowId={workflow.id} status={workflow.status} />
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
