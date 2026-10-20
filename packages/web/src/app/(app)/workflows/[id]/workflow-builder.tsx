'use client';

import { useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  KeyRound,
  Loader2,
  Play,
  Plus,
  Rocket,
  Save,
  Trash2,
} from 'lucide-react';
import type { ActionTypeDto, WorkflowDefinition, WorkflowDetailDto } from '@flowforge/core';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label, Textarea } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from '@/components/ui/primitives';
import { Alert, CodeBlock, Separator } from '@/components/ui/feedback';
import { WorkflowStatusBadge } from '@/components/status-badge';
import { api, ApiRequestError } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';
import { HeaderMapField, MappedField, type VariableOption } from './step-config-form';

/**
 * The workflow builder.
 *
 * A constrained, linear builder: one trigger, an ordered list of actions and
 * an execution policy. The design is deliberately not a general graph editor:
 * every run has to be understandable and every step recoverable.
 */

interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
  stepKey?: string;
  severity: 'error' | 'warning' | 'info';
}

const STEP_TYPES: { type: ActionTypeDto['type']; label: string }[] = [
  { type: 'http_request', label: 'HTTP request' },
  { type: 'send_email', label: 'Send email' },
  { type: 'database_insert', label: 'Database insert' },
  { type: 'notification', label: 'Notification' },
];

export function WorkflowBuilder({
  workflow,
  actionTypes,
}: {
  workflow: WorkflowDetailDto;
  actionTypes: ActionTypeDto[];
}) {
  const router = useRouter();

  const [definition, setDefinition] = useState<WorkflowDefinition>(workflow.draft.definition);
  const [revision, setRevision] = useState(workflow.draft.revision);
  const [selected, setSelected] = useState<string>('trigger');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [secret, setSecret] = useState<string | null>(null);
  const [secretEndpoint, setSecretEndpoint] = useState<string | null>(null);
  const [testInput, setTestInput] = useState('{}');
  const [testOpen, setTestOpen] = useState(false);
  const [runInput, setRunInput] = useState('{}');
  const [runOpen, setRunOpen] = useState(false);

  const triggerSelected = selected === 'trigger';
  const selectedStep = definition.steps.find((step) => step.key === selected);

  const variables = useMemo<VariableOption[]>(() => {
    const options: VariableOption[] = [];
    const sample =
      definition.trigger.type === 'webhook' || definition.trigger.type === 'manual'
        ? (definition.trigger.samplePayload ?? {})
        : {};
    for (const key of Object.keys(sample)) {
      options.push({ path: `trigger.body.${key}`, label: `Trigger input: ${key}` });
    }
    if (Object.keys(sample).length === 0) {
      options.push({ path: 'trigger.body', label: 'The whole trigger payload' });
    }

    definition.steps.forEach((step, index) => {
      const isCurrent = step.key === selected;
      const isLater = definition.steps.findIndex((candidate) => candidate.key === selected) < index;
      const fields = step.type === 'database_insert' ? ['contactId'] : ['id', 'status'];
      for (const field of fields) {
        options.push({
          path: `steps.${step.key}.output.${field}`,
          label: `Output of ${step.name}`,
          invalid: isCurrent || isLater,
        });
      }
    });

    return options;
  }, [definition, selected]);

  function update(mutate: (draft: WorkflowDefinition) => void) {
    setDefinition((current) => {
      const next = structuredClone(current);
      mutate(next);
      return next;
    });
    setDirty(true);
  }

  function updateStep(key: string, mutate: (step: WorkflowDefinition['steps'][number]) => void) {
    update((draft) => {
      const step = draft.steps.find((candidate) => candidate.key === key);
      if (step) mutate(step);
    });
  }

  function updateStepConfig(key: string, config: Record<string, unknown>) {
    updateStep(key, (step) => {
      step.config = config;
    });
  }

  async function save(): Promise<boolean> {
    setSaving(true);
    try {
      const response = await api.put<{ draft: { revision: number } }>(
        `/api/workflows/${workflow.id}/draft`,
        { definition, revision },
        { browser: true },
      );
      setRevision(response.draft.revision);
      setDirty(false);
      toast.success('The draft was saved');
      startRefresh();
      return true;
    } catch (error) {
      if (error instanceof ApiRequestError) {
        if (error.status === 409) {
          toast.error('Someone else changed the draft. Reload the page to see their changes.');
        } else {
          toast.error(error.message);
        }
      } else {
        toast.error('the draft could not be saved');
      }
      return false;
    } finally {
      setSaving(false);
    }
  }

  function startRefresh() {
    router.refresh();
  }

  async function validate(): Promise<boolean> {
    if (dirty) {
      const saved = await save();
      if (!saved) return false;
    }
    try {
      const response = await api.post<{ valid: boolean; issues: ValidationIssue[] }>(
        `/api/workflows/${workflow.id}/validate`,
        undefined,
        { browser: true },
      );
      setIssues(response.issues);
      if (response.valid) {
        toast.success('The workflow is valid');
      } else {
        toast.error('The workflow has validation errors');
      }
      return response.valid;
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : 'the workflow could not be validated');
      return false;
    }
  }

  async function publish() {
    if (dirty) {
      const saved = await save();
      if (!saved) return;
    }
    try {
      const response = await api.post<{
        version: { versionNumber: number };
        webhookSecret?: string;
        webhookEndpoint?: { url: string } | null;
      }>(`/api/workflows/${workflow.id}/publish`, undefined, { browser: true });

      toast.success(`Version ${response.version.versionNumber} was published`);
      if (response.webhookSecret) {
        setSecret(response.webhookSecret);
        setSecretEndpoint(response.webhookEndpoint?.url ?? null);
      }
      setIssues([]);
      startRefresh();
    } catch (error) {
      if (error instanceof ApiRequestError) {
        if (Array.isArray(error.details)) setIssues(error.details as ValidationIssue[]);
        toast.error(error.message);
      } else {
        toast.error('the workflow could not be published');
      }
    }
  }

  async function rotateSecret() {
    try {
      const response = await api.post<{ secret: string; endpoint: { url: string } }>(
        `/api/workflows/${workflow.id}/webhook/rotate`,
        undefined,
        { browser: true },
      );
      setSecret(response.secret);
      setSecretEndpoint(response.endpoint.url);
      toast.success('The signing secret was rotated');
      startRefresh();
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : 'the secret could not be rotated');
    }
  }

  async function runTest() {
    try {
      const parsed = JSON.parse(testInput || '{}') as Record<string, unknown>;
      const response = await api.post<{ executionId: string }>(
        `/api/workflows/${workflow.id}/test`,
        { input: parsed },
        { browser: true },
      );
      setTestOpen(false);
      toast.success('The test run was queued');
      router.push(`/executions/${response.executionId}`);
    } catch (error) {
      toast.error(
        error instanceof ApiRequestError ? error.message : 'the test run could not be started',
      );
    }
  }

  async function runNow() {
    try {
      const parsed = JSON.parse(runInput || '{}') as Record<string, unknown>;
      const response = await api.post<{ executionId: string }>(
        `/api/workflows/${workflow.id}/run`,
        { input: parsed },
        { browser: true },
      );
      setRunOpen(false);
      toast.success('The run was queued');
      router.push(`/executions/${response.executionId}`);
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : 'the run could not be started');
    }
  }

  function addStep(type: ActionTypeDto['type']) {
    const meta = actionTypes.find((candidate) => candidate.type === type);
    const key = uniqueKey(type);
    update((draft) => {
      draft.steps.push({
        key,
        name: meta?.label ?? type,
        type,
        config: { ...(meta?.example ?? {}) },
      });
    });
    setSelected(key);
  }

  function uniqueKey(type: string): string {
    const prefix = type.split('_')[0] ?? 'step';
    const existing = new Set(definition.steps.map((step) => step.key));
    let index = 1;
    let candidate = `${prefix}_${index}`;
    while (existing.has(candidate)) {
      index += 1;
      candidate = `${prefix}_${index}`;
    }
    return candidate;
  }

  function moveStep(index: number, direction: -1 | 1) {
    update((draft) => {
      const target = index + direction;
      if (target < 0 || target >= draft.steps.length) return;
      const [step] = draft.steps.splice(index, 1);
      draft.steps.splice(target, 0, step!);
    });
  }

  function removeStep(key: string) {
    update((draft) => {
      draft.steps = draft.steps.filter((step) => step.key !== key);
    });
    setSelected('trigger');
  }

  const stepIssues = (key: string) => issues.filter((issue) => issue.stepKey === key);

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------- top bar */}
      <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[var(--color-border)] bg-[var(--color-card)] p-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate text-base font-semibold tracking-tight">{workflow.name}</h1>
            <WorkflowStatusBadge status={workflow.status} />
            {workflow.hasUnpublishedChanges || dirty ? (
              <span className="rounded-full bg-[var(--color-warning)]/20 px-2 py-0.5 text-[10px] uppercase text-[var(--color-warning)]">
                published with unpublished changes
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 text-xs text-[var(--color-muted-foreground)]">
            {dirty ? 'Unsaved changes' : `Saved · revision ${revision}`}
            {workflow.currentVersionNumber ? ` · published version ${workflow.currentVersionNumber}` : ' · not published yet'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <Button variant="outline" size="sm" onClick={save} disabled={saving || !dirty}>
            {saving ? <Loader2 className="animate-spin" /> : <Save />}
            Save
          </Button>
          <Button variant="outline" size="sm" onClick={validate}>
            <Check />
            Validate
          </Button>
          <Button variant="outline" size="sm" onClick={() => setTestOpen(true)}>
            <Play />
            Test
          </Button>
          <Button variant="outline" size="sm" onClick={() => setRunOpen(true)} disabled={workflow.status !== 'published'}>
            <Rocket />
            Run now
          </Button>
          <Button size="sm" onClick={publish}>
            <Rocket />
            Publish
          </Button>
        </div>
      </div>

      {issues.length > 0 ? (
        <Alert variant="warning" title="Validation issues">
          <ul className="list-disc space-y-1 pl-4">
            {issues.map((issue, index) => (
              <li key={`${issue.code}-${index}`}>
                <span className="font-mono text-xs">{issue.code}</span> — {issue.message}
                {issue.stepKey ? <span className="text-xs"> (step {issue.stepKey})</span> : null}
              </li>
            ))}
          </ul>
        </Alert>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-[320px_minmax(0,1fr)]">
        {/* --------------------------------------------------- step list */}
        <Card className="h-fit">
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Flow</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            <button
              type="button"
              onClick={() => setSelected('trigger')}
              className={`flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-sm transition-colors ${
                triggerSelected
                  ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10'
                  : 'border-[var(--color-border)] hover:bg-[var(--color-accent)]'
              }`}
            >
              <span className="flex size-5 items-center justify-center rounded-full bg-[var(--color-secondary)] text-[10px] font-semibold">
                T
              </span>
              <span className="truncate">Trigger: {definition.trigger.type}</span>
            </button>

            <div className="space-y-2">
              {definition.steps.map((step, index) => {
                const problems = stepIssues(step.key);
                return (
                  <div
                    key={step.key}
                    className={`flex items-center gap-2 rounded-md border px-3 py-2 text-sm transition-colors ${
                      selected === step.key
                        ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10'
                        : 'border-[var(--color-border)] hover:bg-[var(--color-accent)]'
                    }`}
                  >
                    <button
                      type="button"
                      onClick={() => setSelected(step.key)}
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-[var(--color-secondary)] text-[10px] font-semibold">
                        {index + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="block truncate font-medium">{step.name}</span>
                        <span className="block truncate font-mono text-[11px] text-[var(--color-muted-foreground)]">
                          {step.key} · {step.type}
                        </span>
                      </span>
                    </button>
                    {problems.length > 0 ? (
                      <AlertTriangle className="size-3.5 shrink-0 text-[var(--color-warning)]" />
                    ) : null}
                    <div className="flex shrink-0">
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => moveStep(index, -1)}
                        disabled={index === 0}
                      >
                        <ArrowUp />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7"
                        onClick={() => moveStep(index, 1)}
                        disabled={index === definition.steps.length - 1}
                      >
                        <ArrowDown />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        className="size-7 text-[var(--color-destructive)]"
                        onClick={() => removeStep(step.key)}
                      >
                        <Trash2 />
                      </Button>
                    </div>
                  </div>
                );
              })}
            </div>

            <Separator className="my-3" />

            <div className="space-y-1">
              <p className="text-xs font-medium text-[var(--color-muted-foreground)]">Add an action</p>
              {STEP_TYPES.map((option) => (
                <button
                  key={option.type}
                  type="button"
                  onClick={() => addStep(option.type)}
                  className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-sm hover:bg-[var(--color-accent)]"
                >
                  <Plus className="size-3.5" />
                  {option.label}
                </button>
              ))}
            </div>
          </CardContent>
        </Card>

        {/* ------------------------------------------------ config panel */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">
              {triggerSelected ? 'Trigger configuration' : selectedStep?.name ?? 'Configuration'}
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-5">
            {triggerSelected ? (
              <TriggerConfig definition={definition} update={update} />
            ) : selectedStep ? (
              <StepConfig
                step={selectedStep}
                actionTypes={actionTypes}
                variables={variables}
                onRename={(name) => updateStep(selectedStep.key, (step) => (step.name = name))}
                onKeyChange={(key) => {
                  updateStep(selectedStep.key, (step) => (step.key = key));
                  setSelected(key);
                }}
                onConfig={(config) => updateStepConfig(selectedStep.key, config)}
                issues={stepIssues(selectedStep.key)}
              />
            ) : (
              <p className="text-sm text-[var(--color-muted-foreground)]">Select a step to configure it.</p>
            )}

            <Separator />

            <Tabs defaultValue="policy">
              <TabsList>
                <TabsTrigger value="policy">Policy</TabsTrigger>
                <TabsTrigger value="versions">Versions</TabsTrigger>
                <TabsTrigger value="webhook">Webhook</TabsTrigger>
              </TabsList>

              <TabsContent value="policy" className="space-y-4">
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-1.5">
                    <Label htmlFor="maxAttempts">Maximum attempts</Label>
                    <Input
                      id="maxAttempts"
                      type="number"
                      min={1}
                      max={5}
                      value={definition.policy.retry.maxAttempts}
                      onChange={(event) =>
                        update((draft) => {
                          draft.policy.retry.maxAttempts = Number(event.target.value);
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="stepTimeout">Step timeout (ms)</Label>
                    <Input
                      id="stepTimeout"
                      type="number"
                      min={1000}
                      max={120000}
                      value={definition.policy.retry.timeoutMs}
                      onChange={(event) =>
                        update((draft) => {
                          draft.policy.retry.timeoutMs = Number(event.target.value);
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="executionTimeout">Execution timeout (ms)</Label>
                    <Input
                      id="executionTimeout"
                      type="number"
                      min={10000}
                      max={600000}
                      value={definition.policy.executionTimeoutMs}
                      onChange={(event) =>
                        update((draft) => {
                          draft.policy.executionTimeoutMs = Number(event.target.value);
                        })
                      }
                    />
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="concurrency">Concurrent runs</Label>
                    <Input
                      id="concurrency"
                      type="number"
                      min={1}
                      max={5}
                      value={definition.policy.concurrency}
                      onChange={(event) =>
                        update((draft) => {
                          draft.policy.concurrency = Number(event.target.value);
                        })
                      }
                    />
                  </div>
                </div>
                <p className="text-xs text-[var(--color-muted-foreground)]">
                  The execution stops at the first permanent failure. The MVP has no continue-on-error behaviour.
                </p>
              </TabsContent>

              <TabsContent value="versions" className="space-y-2">
                {workflow.versions.length === 0 ? (
                  <p className="text-sm text-[var(--color-muted-foreground)]">
                    Not published yet. Publishing creates an immutable snapshot that new runs pin.
                  </p>
                ) : (
                  workflow.versions.map((version) => (
                    <div
                      key={version.id}
                      className="flex items-center justify-between rounded-md border border-[var(--color-border)] px-3 py-2 text-sm"
                    >
                      <span>
                        Version {version.versionNumber}
                        {version.id === workflow.currentVersionId ? (
                          <span className="ml-2 rounded-full bg-[var(--color-success)]/20 px-1.5 py-0.5 text-[10px] uppercase text-[var(--color-success)]">
                            current
                          </span>
                        ) : null}
                      </span>
                      <span className="text-xs text-[var(--color-muted-foreground)]">
                        {formatDateTime(version.publishedAt)}
                      </span>
                    </div>
                  ))
                )}
              </TabsContent>

              <TabsContent value="webhook" className="space-y-3">
                {workflow.webhookEndpoint ? (
                  <>
                    <div className="space-y-1.5">
                      <Label>Endpoint URL</Label>
                      <div className="flex items-center gap-2">
                        <Input readOnly value={workflow.webhookEndpoint.url} className="font-mono text-xs" />
                        <Button
                          variant="outline"
                          size="icon"
                          onClick={() => {
                            void navigator.clipboard?.writeText(workflow.webhookEndpoint!.url);
                            toast.success('The URL was copied');
                          }}
                        >
                          <Copy />
                        </Button>
                      </div>
                    </div>
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      Sign the request with HMAC-SHA256 over `&lt;timestamp&gt;.&lt;body&gt;` and send it as
                      `X-FlowForge-Signature: t=&lt;ts&gt;,v1=&lt;hmac&gt;`. The timestamp tolerance is five minutes.
                    </p>
                    {workflow.webhookEndpoint.previousSecretValidUntil ? (
                      <Alert variant="info">
                        The previous secret is still accepted until{' '}
                        {formatDateTime(workflow.webhookEndpoint.previousSecretValidUntil)}.
                      </Alert>
                    ) : null}
                    <Button variant="outline" size="sm" onClick={rotateSecret}>
                      <KeyRound />
                      Rotate the signing secret
                    </Button>
                  </>
                ) : (
                  <p className="text-sm text-[var(--color-muted-foreground)]">
                    This workflow has no webhook endpoint. Publish a webhook trigger to create one.
                  </p>
                )}
              </TabsContent>
            </Tabs>
          </CardContent>
        </Card>
      </div>

      {/* ------------------------------------------------------ dialogs */}
      <Dialog open={secret !== null} onOpenChange={(open) => !open && setSecret(null)}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>Store this signing secret now</DialogTitle>
            <DialogDescription>
              The secret is shown exactly once. FlowForge stores only an encrypted copy and a hash, so it can never be
              displayed again. If you lose it, rotate it.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="rounded-md border border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 p-3 font-mono text-xs break-all">
              {secret}
            </div>
            {secretEndpoint ? (
              <CodeBlock
                value={`curl -X POST ${secretEndpoint} \\
  -H "content-type: application/json" \\
  -H "idempotency-key: $(uuidgen)" \\
  -H "x-flowforge-signature: t=$TS,v1=$SIG" \\
  -d '{"name":"Ada","email":"ada@example.com"}'`}
              />
            ) : null}
          </div>
          <DialogFooter>
            <Button onClick={() => setSecret(null)}>I have stored this secret</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={testOpen} onOpenChange={setTestOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Test run</DialogTitle>
            <DialogDescription>
              A test run executes a snapshot of the draft. Side effects are simulated unless a step opts in with
              `executeForReal`.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={testInput}
            onChange={(event) => setTestInput(event.target.value)}
            className="h-40 font-mono text-xs"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setTestOpen(false)}>
              Cancel
            </Button>
            <Button onClick={runTest}>Start the test run</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={runOpen} onOpenChange={setRunOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Run now</DialogTitle>
            <DialogDescription>
              This creates a production execution that pins the published version. The side effects are real.
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={runInput}
            onChange={(event) => setRunInput(event.target.value)}
            className="h-40 font-mono text-xs"
          />
          <DialogFooter>
            <Button variant="outline" onClick={() => setRunOpen(false)}>
              Cancel
            </Button>
            <Button onClick={runNow}>Run now</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/* ------------------------------------------------------------------ trigger */

function TriggerConfig({
  definition,
  update,
}: {
  definition: WorkflowDefinition;
  update: (mutate: (draft: WorkflowDefinition) => void) => void;
}) {
  const trigger = definition.trigger;

  return (
    <div className="space-y-4">
      {trigger.type === 'webhook' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="slug">Endpoint slug</Label>
            <Input
              id="slug"
              value={trigger.slug}
              onChange={(event) =>
                update((draft) => {
                  if (draft.trigger.type === 'webhook') draft.trigger.slug = event.target.value;
                })
              }
              className="font-mono text-xs"
            />
            <p className="text-xs text-[var(--color-muted-foreground)]">
              The endpoint binds to the workflow, not to a version, so the URL survives a republish.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={trigger.requireSignature}
              onChange={(event) =>
                update((draft) => {
                  if (draft.trigger.type === 'webhook') draft.trigger.requireSignature = event.target.checked;
                })
              }
            />
            Require an HMAC signature on every delivery
          </label>
          <div className="space-y-1.5">
            <Label htmlFor="samplePayload">Sample payload</Label>
            <Textarea
              id="samplePayload"
              value={JSON.stringify(trigger.samplePayload ?? {}, null, 2)}
              onChange={(event) => {
                try {
                  const parsed = JSON.parse(event.target.value) as Record<string, unknown>;
                  update((draft) => {
                    if (draft.trigger.type === 'webhook') draft.trigger.samplePayload = parsed;
                  });
                } catch {
                  // Keep the last valid value while the user is typing.
                }
              }}
              className="h-32 font-mono text-xs"
            />
            <p className="text-xs text-[var(--color-muted-foreground)]">
              The sample payload powers the variable picker and the test run input.
            </p>
          </div>
        </>
      ) : null}

      {trigger.type === 'schedule' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="cron">Cron expression</Label>
            <Input
              id="cron"
              value={trigger.cron}
              onChange={(event) =>
                update((draft) => {
                  if (draft.trigger.type === 'schedule') draft.trigger.cron = event.target.value;
                })
              }
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="timezone">Timezone</Label>
            <Input
              id="timezone"
              value={trigger.timezone}
              onChange={(event) =>
                update((draft) => {
                  if (draft.trigger.type === 'schedule') draft.trigger.timezone = event.target.value;
                })
              }
              className="font-mono text-xs"
            />
            <p className="text-xs text-[var(--color-muted-foreground)]">
              The schedule is evaluated in this IANA timezone. A time that does not exist on a daylight-saving day fires
              once at the end of the gap; a repeated hour fires once.
            </p>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={trigger.catchUp}
              onChange={(event) =>
                update((draft) => {
                  if (draft.trigger.type === 'schedule') draft.trigger.catchUp = event.target.checked;
                })
              }
            />
            Catch up the latest missed occurrence after downtime
          </label>
        </>
      ) : null}

      {trigger.type === 'manual' ? (
        <p className="text-sm text-[var(--color-muted-foreground)]">
          A manual workflow is started with the Run now button and never runs automatically.
        </p>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------- step config */

function StepConfig({
  step,
  actionTypes,
  variables,
  onRename,
  onKeyChange,
  onConfig,
  issues,
}: {
  step: WorkflowDefinition['steps'][number];
  actionTypes: ActionTypeDto[];
  variables: VariableOption[];
  onRename: (name: string) => void;
  onKeyChange: (key: string) => void;
  onConfig: (config: Record<string, unknown>) => void;
  issues: ValidationIssue[];
}) {
  const config = (step.config ?? {}) as Record<string, unknown>;
  const meta = actionTypes.find((candidate) => candidate.type === step.type);

  function set(key: string, value: unknown) {
    onConfig({ ...config, [key]: value });
  }

  return (
    <div className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-1.5">
          <Label htmlFor="stepName">Name</Label>
          <Input id="stepName" value={step.name} onChange={(event) => onRename(event.target.value)} />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="stepKey">Step key</Label>
          <Input
            id="stepKey"
            value={step.key}
            onChange={(event) => onKeyChange(event.target.value)}
            className="font-mono text-xs"
          />
          <p className="text-xs text-[var(--color-muted-foreground)]">
            The key is fixed once steps reference it. Lowercase slug, e.g. save_contact.
          </p>
        </div>
      </div>

      <div className="space-y-1.5">
        <Label>Action type</Label>
        <Select value={step.type} onValueChange={() => undefined}>
          <SelectTrigger>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {STEP_TYPES.map((option) => (
              <SelectItem key={option.type} value={option.type}>
                {option.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <p className="text-xs text-[var(--color-muted-foreground)]">
          {meta?.description ?? 'The action type cannot be changed after it was created.'}
        </p>
      </div>

      {issues.length > 0 ? (
        <Alert variant="warning">
          <ul className="list-disc space-y-1 pl-4">
            {issues.map((issue, index) => (
              <li key={index}>{issue.message}</li>
            ))}
          </ul>
        </Alert>
      ) : null}

      {step.type === 'http_request' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="method">Method</Label>
            <Select value={String(config.method ?? 'POST')} onValueChange={(value) => set('method', value)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {['GET', 'POST', 'PUT', 'PATCH', 'DELETE'].map((method) => (
                  <SelectItem key={method} value={method}>
                    {method}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <MappedField
            id="url"
            label="URL"
            value={String(config.url ?? '')}
            onChange={(value) => set('url', value)}
            variables={variables}
            hint="Private and internal destinations are blocked unless they are explicitly allowed."
          />
          <HeaderMapField
            value={(config.headers as Record<string, string>) ?? {}}
            onChange={(value) => set('headers', value)}
            variables={variables}
          />
          <MappedField
            id="body"
            label="Body"
            value={String(config.body ?? '')}
            onChange={(value) => set('body', value)}
            variables={variables}
            multiline
            placeholder='{"email":"{{trigger.body.email}}"}'
          />
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="bodyType">Body type</Label>
              <Select value={String(config.bodyType ?? 'json')} onValueChange={(value) => set('bodyType', value)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {['json', 'text', 'form'].map((type) => (
                    <SelectItem key={type} value={type}>
                      {type}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="timeout">Timeout (ms)</Label>
              <Input
                id="timeout"
                type="number"
                min={1000}
                max={120000}
                value={Number(config.timeoutMs ?? 30000)}
                onChange={(event) => set('timeoutMs', Number(event.target.value))}
              />
            </div>
          </div>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={config.allowPrivateNetwork === true}
              onChange={(event) => set('allowPrivateNetwork', event.target.checked)}
            />
            Allow a private or internal destination (SSRF protection off)
          </label>
        </>
      ) : null}

      {step.type === 'send_email' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="provider">Provider</Label>
            <Select value={String(config.provider ?? 'mailpit')} onValueChange={(value) => set('provider', value)}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="mailpit">Local mail catcher</SelectItem>
                <SelectItem value="resend">Resend</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="from">From</Label>
            <Input id="from" value={String(config.from ?? '')} onChange={(event) => set('from', event.target.value)} />
          </div>
          <MappedField
            id="to"
            label="To"
            value={String(config.to ?? '')}
            onChange={(value) => set('to', value)}
            variables={variables}
          />
          <MappedField
            id="subject"
            label="Subject"
            value={String(config.subject ?? '')}
            onChange={(value) => set('subject', value)}
            variables={variables}
          />
          <MappedField
            id="emailBody"
            label="Body"
            value={String(config.body ?? '')}
            onChange={(value) => set('body', value)}
            variables={variables}
            multiline
          />
        </>
      ) : null}

      {step.type === 'database_insert' ? (
        <>
          <Alert variant="info">
            This action writes into the FlowForge managed contacts table. Values are parameterized and the
            <span className="font-mono"> dedupeKey </span>
            turns the write into an idempotent upsert.
          </Alert>
          <MappedField
            id="contactName"
            label="Name"
            value={String((config.values as Record<string, string>)?.name ?? '')}
            onChange={(value) =>
              set('values', { ...((config.values as Record<string, string>) ?? {}), name: value })
            }
            variables={variables}
          />
          <MappedField
            id="contactEmail"
            label="Email"
            value={String((config.values as Record<string, string>)?.email ?? '')}
            onChange={(value) =>
              set('values', { ...((config.values as Record<string, string>) ?? {}), email: value })
            }
            variables={variables}
          />
          <MappedField
            id="contactMessage"
            label="Message"
            value={String((config.values as Record<string, string>)?.message ?? '')}
            onChange={(value) =>
              set('values', { ...((config.values as Record<string, string>) ?? {}), message: value })
            }
            variables={variables}
            multiline
          />
          <MappedField
            id="dedupeKey"
            label="Business key (idempotent upsert)"
            value={String(config.dedupeKey ?? '')}
            onChange={(value) => set('dedupeKey', value)}
            variables={variables}
          />
        </>
      ) : null}

      {step.type === 'notification' ? (
        <>
          <div className="space-y-1.5">
            <Label htmlFor="channel">Channel</Label>
            <Input
              id="channel"
              value={String(config.channel ?? '')}
              onChange={(event) => set('channel', event.target.value)}
            />
          </div>
          <MappedField
            id="message"
            label="Message"
            value={String(config.message ?? '')}
            onChange={(value) => set('message', value)}
            variables={variables}
            multiline
          />
          <MappedField
            id="webhookUrl"
            label="Destination URL"
            value={String(config.webhookUrl ?? '')}
            onChange={(value) => set('webhookUrl', value)}
            variables={variables}
            hint="Prefer a credential: an incoming webhook URL is a secret."
          />
        </>
      ) : null}

      <label className="flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={config.executeForReal === true}
          onChange={(event) => set('executeForReal', event.target.checked)}
        />
        Perform the real side effect during a test run
      </label>
    </div>
  );
}
