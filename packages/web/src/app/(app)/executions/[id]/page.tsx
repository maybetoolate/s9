import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AlertTriangle, ArrowLeft } from 'lucide-react';
import type { ExecutionDetailDto } from '@flowforge/core';
import { api, ApiRequestError } from '@/lib/api-server';
import { requireSession } from '@/lib/session';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/primitives';
import { Alert, CodeBlock, EmptyState } from '@/components/ui/feedback';
import { ErrorClassBadge, ExecutionStatusBadge, StepStatusBadge } from '@/components/status-badge';
import { ExecutionRecovery } from './execution-recovery';
import { formatDateTime, formatDuration } from '@/lib/utils';

export const dynamic = 'force-dynamic';

/**
 * The execution detail.
 *
 * Timeline, input, steps, output and audit. Every attempt is visible, and
 * the recovery actions are only offered when they are valid.
 */
export default async function ExecutionDetailPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;

  let execution: ExecutionDetailDto;
  try {
    execution = await api.get<ExecutionDetailDto>(`/api/executions/${id}`);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    throw error;
  }

  const failedStep = execution.steps.find((step) => step.status === 'failed') ?? null;
  const unknownStep = execution.steps.find((step) => step.status === 'outcome_unknown') ?? null;
  const successfulSteps = execution.steps.filter((step) => step.status === 'succeeded');
  const allSafeToRepeat = execution.steps.every((step) => step.safeToRepeat);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <Link
            href="/executions"
            className="inline-flex items-center gap-1 text-xs text-[var(--color-muted-foreground)] hover:text-[var(--color-foreground)]"
          >
            <ArrowLeft className="size-3" />
            All executions
          </Link>
          <h1 className="mt-1 flex items-center gap-2 text-lg font-semibold tracking-tight">
            {execution.workflowName}
            <ExecutionStatusBadge status={execution.status} />
            {execution.isTest ? (
              <span className="rounded-full bg-[var(--color-muted)] px-2 py-0.5 text-[10px] uppercase text-[var(--color-muted-foreground)]">
                test run
              </span>
            ) : null}
          </h1>
          <p className="mt-0.5 font-mono text-xs text-[var(--color-muted-foreground)]">{execution.id}</p>
        </div>

        <ExecutionRecovery
          executionId={execution.id}
          availableActions={execution.availableActions}
          failedStepKey={failedStep?.stepKey ?? null}
          unknownStepKey={unknownStep?.stepKey ?? null}
          successfulStepKeys={successfulSteps.map((step) => step.stepKey)}
          stepsSafeToRepeat={allSafeToRepeat}
        />
      </div>

      <Card>
        <CardContent className="grid gap-4 py-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Workflow version" value={`v${execution.workflowVersionNumber}`} />
          <Field label="Trigger" value={execution.triggerType} />
          <Field label="Started" value={formatDateTime(execution.startedAt)} />
          <Field label="Duration" value={formatDuration(execution.durationMs)} />
          {execution.rerunOfExecutionId ? (
            <Field
              label="Rerun of"
              value={
                <Link href={`/executions/${execution.rerunOfExecutionId}`} className="hover:text-[var(--color-primary)]">
                  {execution.rerunOfExecutionId.slice(0, 8)}
                </Link>
              }
            />
          ) : null}
          {execution.idempotencyKey ? (
            <Field label="Idempotency key" value={<span className="font-mono text-xs">{execution.idempotencyKey}</span>} />
          ) : null}
        </CardContent>
      </Card>

      {execution.error ? (
        <Alert variant="error" title={`The execution failed (${execution.error.class})`}>
          <p>{execution.error.message}</p>
          {execution.error.stepKey ? (
            <p className="mt-1 text-xs">Step: {execution.error.stepKey}</p>
          ) : null}
        </Alert>
      ) : null}

      {unknownStep ? (
        <Alert variant="warning" title="A step ended with an unknown outcome">
          The action timed out without a response. The remote operation may or may not have completed, so the step is not
          retried automatically. Resolve it after verifying the remote system.
        </Alert>
      ) : null}

      <Card>
        <CardContent className="pt-5">
          <Tabs defaultValue="timeline">
            <TabsList>
              <TabsTrigger value="timeline">Timeline</TabsTrigger>
              <TabsTrigger value="steps">Steps</TabsTrigger>
              <TabsTrigger value="input">Input</TabsTrigger>
              <TabsTrigger value="output">Output</TabsTrigger>
              <TabsTrigger value="audit">Audit</TabsTrigger>
            </TabsList>

            <TabsContent value="timeline">
              {execution.timeline.length === 0 ? (
                <EmptyState title="Nothing happened yet" />
              ) : (
                <ol className="space-y-2">
                  {execution.timeline.map((event, index) => (
                    <li key={index} className="flex gap-3 text-sm">
                      <span className="w-40 shrink-0 text-xs tabular-nums text-[var(--color-muted-foreground)]">
                        {formatDateTime(event.at)}
                      </span>
                      <span className="min-w-0">
                        {event.stepKey ? (
                          <span className="font-mono text-xs text-[var(--color-muted-foreground)]">
                            {event.stepKey}{' '}
                          </span>
                        ) : null}
                        <span className="text-[var(--color-foreground)]">{event.message}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              )}
            </TabsContent>

            <TabsContent value="steps">
              <div className="space-y-3">
                {execution.steps.map((step) => (
                  <Card key={step.id}>
                    <CardHeader className="pb-2">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <CardTitle className="text-sm">
                          {step.stepIndex + 1}. {step.name}{' '}
                          <span className="font-mono text-xs text-[var(--color-muted-foreground)]">{step.stepKey}</span>
                        </CardTitle>
                        <div className="flex items-center gap-2">
                          <StepStatusBadge status={step.status} />
                          {step.resolvedManually ? (
                            <span className="rounded-full bg-[var(--color-secondary)] px-2 py-0.5 text-[10px] uppercase">
                              resolved manually
                            </span>
                          ) : null}
                        </div>
                      </div>
                    </CardHeader>
                    <CardContent className="space-y-3">
                      {step.error ? (
                        <div className="flex items-start gap-2 rounded-md border border-[var(--color-destructive)]/30 bg-[var(--color-destructive)]/10 p-3 text-sm">
                          <AlertTriangle className="mt-0.5 size-4 shrink-0 text-[var(--color-destructive)]" />
                          <div className="space-y-1">
                            <div className="flex items-center gap-2">
                              <ErrorClassBadge errorClass={step.error.class} />
                              {step.error.status ? (
                                <span className="text-xs text-[var(--color-muted-foreground)]">
                                  HTTP {step.error.status}
                                </span>
                              ) : null}
                            </div>
                            <p>{step.error.message}</p>
                          </div>
                        </div>
                      ) : null}

                      {step.resolution ? (
                        <Alert variant="info">
                          Resolved manually as <strong>{step.resolution.outcome}</strong>: {step.resolution.reason}
                          <span className="mt-1 block text-xs">
                            {formatDateTime(step.resolution.resolvedAt)}
                          </span>
                        </Alert>
                      ) : null}

                      {step.attempts.length > 0 ? (
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>Attempt</TableHead>
                              <TableHead>Status</TableHead>
                              <TableHead>Started</TableHead>
                              <TableHead>Duration</TableHead>
                              <TableHead>Idempotency key</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {step.attempts.map((attempt) => (
                              <TableRow key={attempt.id}>
                                <TableCell className="tabular-nums">#{attempt.attemptNumber}</TableCell>
                                <TableCell>
                                  <span className="text-xs uppercase">{attempt.status}</span>
                                </TableCell>
                                <TableCell className="text-xs text-[var(--color-muted-foreground)]">
                                  {formatDateTime(attempt.startedAt)}
                                </TableCell>
                                <TableCell className="text-xs tabular-nums text-[var(--color-muted-foreground)]">
                                  {formatDuration(attempt.durationMs)}
                                </TableCell>
                                <TableCell className="font-mono text-[10px] text-[var(--color-muted-foreground)]">
                                  {attempt.idempotencyKey}
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      ) : null}

                      <div className="grid gap-3 sm:grid-cols-2">
                        <div>
                          <p className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">Input</p>
                          <CodeBlock value={step.input} />
                        </div>
                        <div>
                          <p className="mb-1 text-xs font-medium text-[var(--color-muted-foreground)]">Output</p>
                          <CodeBlock value={step.output ?? '—'} />
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </TabsContent>

            <TabsContent value="input">
              <CodeBlock value={execution.input} />
            </TabsContent>

            <TabsContent value="output">
              <CodeBlock value={execution.output ?? '—'} />
            </TabsContent>

            <TabsContent value="audit">
              {execution.audit.length === 0 ? (
                <EmptyState title="No audit events yet" />
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>When</TableHead>
                      <TableHead>Actor</TableHead>
                      <TableHead>Action</TableHead>
                      <TableHead>Metadata</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {execution.audit.map((event) => (
                      <TableRow key={event.id}>
                        <TableCell className="text-xs text-[var(--color-muted-foreground)]">
                          {formatDateTime(event.createdAt)}
                        </TableCell>
                        <TableCell className="text-xs">
                          {event.actorType === 'system' ? 'system' : (event.actorId ?? 'user')}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{event.action}</TableCell>
                        <TableCell className="max-w-[320px] truncate font-mono text-[10px] text-[var(--color-muted-foreground)]">
                          {JSON.stringify(event.metadata)}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}

function Field({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <p className="text-xs text-[var(--color-muted-foreground)]">{label}</p>
      <p className="mt-0.5 text-sm">{value}</p>
    </div>
  );
}
