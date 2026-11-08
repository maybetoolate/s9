'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { ArrowLeft, ArrowRight, Loader2 } from 'lucide-react';
import type { WorkflowDefinition } from '@s9/core';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label, Textarea } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/primitives';
import { Alert } from '@/components/ui/feedback';
import { api, ApiRequestError } from '@/lib/api';

/**
 * The workflow creation wizard.
 *
 * Basics -> trigger -> review. The review step validates the complete
 * definition before it is created, so an invalid workflow never reaches the
 * database.
 */

type TriggerType = 'webhook' | 'schedule' | 'manual';

interface ValidationIssue {
  code: string;
  message: string;
  path?: string;
  stepKey?: string;
  severity: 'error' | 'warning' | 'info';
}

const TEMPLATES = [
  {
    id: 'contact-form',
    name: 'Contact form follow-up',
    description: 'A webhook that saves the contact, sends a confirmation email and notifies the team.',
    triggerType: 'webhook' as TriggerType,
  },
  {
    id: 'manual',
    name: 'Manual trigger',
    description: 'A workflow that only runs when you press Run now.',
    triggerType: 'manual' as TriggerType,
  },
];

export function NewWorkflowForm() {
  const router = useRouter();

  const [step, setStep] = useState(0);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [triggerType, setTriggerType] = useState<TriggerType>('webhook');
  const [slug, setSlug] = useState('');
  const [cron, setCron] = useState('0 9 * * *');
  const [timezone, setTimezone] = useState('UTC');
  const [template, setTemplate] = useState('contact-form');
  const [issues, setIssues] = useState<ValidationIssue[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function buildDefinition(): WorkflowDefinition {
    const policy = {
      maxSteps: 10,
      executionTimeoutMs: 600_000,
      concurrency: 1,
      retry: { maxAttempts: 3, baseDelayMs: 5_000, maxDelayMs: 300_000, timeoutMs: 30_000 },
    };

    if (template === 'manual') {
      return {
        trigger: { type: 'manual', samplePayload: {} },
        steps: [
          {
            key: 'save_contact',
            name: 'Save contact',
            type: 'database_insert',
            config: {
              table: 'contacts',
              values: { name: '{{trigger.body.name}}', email: '{{trigger.body.email}}' },
              dedupeKey: '{{trigger.body.email}}',
            },
          },
        ],
        policy,
      };
    }

    const trigger: WorkflowDefinition['trigger'] =
      triggerType === 'webhook'
        ? { type: 'webhook', slug: slug || 'contact-form-endpoint', requireSignature: true, samplePayload: {} }
        : triggerType === 'schedule'
          ? { type: 'schedule', cron, timezone, catchUp: true }
          : { type: 'manual', samplePayload: {} };

    return {
      trigger,
      steps: [
        {
          key: 'save_contact',
          name: 'Save contact',
          type: 'database_insert',
          config: {
            table: 'contacts',
            values: { name: '{{trigger.body.name}}', email: '{{trigger.body.email}}' },
            dedupeKey: '{{trigger.body.email}}',
          },
        },
        {
          key: 'send_confirmation',
          name: 'Send confirmation email',
          type: 'send_email',
          config: {
            provider: 'mailpit',
            from: 's9 <no-reply@s9.local>',
            to: '{{trigger.body.email}}',
            subject: 'We received your message',
            body: 'Thanks for reaching out.',
          },
        },
      ],
      policy,
    };
  }

  async function create() {
    setPending(true);
    setError(null);
    setIssues([]);

    try {
      const response = await api.post<{ id: string }>(
        '/api/workflows',
        {
          name,
          description: description || undefined,
          triggerType: template === 'manual' ? 'manual' : triggerType,
          definition: buildDefinition(),
        },
        { browser: true },
      );

      toast.success('The workflow was created');
      router.push(`/workflows/${response.id}`);
    } catch (caught) {
      if (caught instanceof ApiRequestError) {
        setError(caught.message);
        const details = caught.details;
        if (Array.isArray(details)) {
          setIssues(details as ValidationIssue[]);
        }
      } else {
        setError('the workflow could not be created');
      }
    } finally {
      setPending(false);
    }
  }

  const steps = ['Basics', 'Trigger', 'Review'];

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Create a workflow</h1>
        <p className="text-sm text-[var(--color-muted-foreground)]">
          A workflow combines one trigger, an ordered list of actions and an execution policy.
        </p>
      </div>

      <ol className="flex items-center gap-2 text-sm">
        {steps.map((label, index) => (
          <li key={label} className="flex items-center gap-2">
            <span
              className={`flex size-6 items-center justify-center rounded-full text-xs font-semibold ${
                index === step
                  ? 'bg-[var(--color-primary)] text-[var(--color-primary-foreground)]'
                  : index < step
                    ? 'bg-[var(--color-success)]/20 text-[var(--color-success)]'
                    : 'bg-[var(--color-muted)] text-[var(--color-muted-foreground)]'
              }`}
            >
              {index + 1}
            </span>
            <span className={index === step ? 'font-medium' : 'text-[var(--color-muted-foreground)]'}>{label}</span>
            {index < steps.length - 1 ? <span className="text-[var(--color-muted-foreground)]">/</span> : null}
          </li>
        ))}
      </ol>

      <Card>
        <CardHeader>
          <CardTitle>{steps[step]}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-5">
          {step === 0 ? (
            <>
              <div className="space-y-1.5">
                <Label htmlFor="name">Name</Label>
                <Input
                  id="name"
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  placeholder="Contact form follow-up"
                  required
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="description">Description (optional)</Label>
                <Textarea
                  id="description"
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  placeholder="What does this workflow do?"
                />
              </div>
              <div className="space-y-1.5">
                <Label>Start from</Label>
                <div className="grid gap-3 sm:grid-cols-2">
                  {TEMPLATES.map((option) => (
                    <button
                      key={option.id}
                      type="button"
                      onClick={() => {
                        setTemplate(option.id);
                        setTriggerType(option.triggerType);
                      }}
                      className={`rounded-md border p-3 text-left transition-colors ${
                        template === option.id
                          ? 'border-[var(--color-primary)] bg-[var(--color-primary)]/10'
                          : 'border-[var(--color-border)] hover:bg-[var(--color-accent)]'
                      }`}
                    >
                      <p className="text-sm font-medium">{option.name}</p>
                      <p className="mt-1 text-xs text-[var(--color-muted-foreground)]">{option.description}</p>
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : null}

          {step === 1 ? (
            <>
              <div className="space-y-1.5">
                <Label>Trigger type</Label>
                <Select value={triggerType} onValueChange={(value) => setTriggerType(value as TriggerType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="webhook">Webhook</SelectItem>
                    <SelectItem value="schedule">Schedule</SelectItem>
                    <SelectItem value="manual">Manual</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              {triggerType === 'webhook' ? (
                <div className="space-y-1.5">
                  <Label htmlFor="slug">Endpoint slug</Label>
                  <Input
                    id="slug"
                    value={slug}
                    onChange={(event) => setSlug(event.target.value)}
                    placeholder="contact-form-endpoint"
                  />
                  <p className="text-xs text-[var(--color-muted-foreground)]">
                    The public path of the intake endpoint. Lowercase letters, digits, dashes and underscores.
                  </p>
                </div>
              ) : null}

              {triggerType === 'schedule' ? (
                <>
                  <div className="space-y-1.5">
                    <Label htmlFor="cron">Cron expression</Label>
                    <Input id="cron" value={cron} onChange={(event) => setCron(event.target.value)} />
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      Standard 5-field cron: minute hour day-of-month month day-of-week.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor="timezone">Timezone</Label>
                    <Input
                      id="timezone"
                      value={timezone}
                      onChange={(event) => setTimezone(event.target.value)}
                      placeholder="UTC"
                    />
                    <p className="text-xs text-[var(--color-muted-foreground)]">
                      An IANA timezone. The schedule is evaluated in this timezone, not in server local time.
                    </p>
                  </div>
                </>
              ) : null}

              {triggerType === 'manual' ? (
                <p className="text-sm text-[var(--color-muted-foreground)]">
                  A manual workflow only runs when you press Run now.
                </p>
              ) : null}
            </>
          ) : null}

          {step === 2 ? (
            <>
              <p className="text-sm text-[var(--color-muted-foreground)]">
                The workflow will be created as a draft. You can change the steps, validate and publish it on the next
                screen.
              </p>
              <dl className="grid gap-2 rounded-md border border-[var(--color-border)] bg-[var(--color-muted)]/40 p-4 text-sm">
                <div className="flex justify-between gap-4">
                  <dt className="text-[var(--color-muted-foreground)]">Name</dt>
                  <dd className="font-medium">{name || '—'}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-[var(--color-muted-foreground)]">Trigger</dt>
                  <dd className="font-medium">{template === 'manual' ? 'manual' : triggerType}</dd>
                </div>
                <div className="flex justify-between gap-4">
                  <dt className="text-[var(--color-muted-foreground)]">Steps</dt>
                  <dd className="font-medium">{buildDefinition().steps.length}</dd>
                </div>
              </dl>

              {error ? <Alert variant="error">{error}</Alert> : null}

              {issues.length > 0 ? (
                <Alert variant="warning" title="The definition has issues">
                  <ul className="list-disc space-y-1 pl-4">
                    {issues.map((issue, index) => (
                      <li key={`${issue.code}-${index}`}>
                        <span className="font-mono text-xs">{issue.code}</span> — {issue.message}
                      </li>
                    ))}
                  </ul>
                </Alert>
              ) : null}
            </>
          ) : null}

          <div className="flex justify-between border-t border-[var(--color-border)] pt-4">
            <Button
              variant="outline"
              onClick={() => setStep((current) => Math.max(0, current - 1))}
              disabled={step === 0 || pending}
            >
              <ArrowLeft />
              Back
            </Button>
            {step < steps.length - 1 ? (
              <Button onClick={() => setStep((current) => current + 1)} disabled={step === 0 && !name.trim()}>
                Next
                <ArrowRight />
              </Button>
            ) : (
              <Button onClick={create} disabled={pending}>
                {pending ? <Loader2 className="animate-spin" /> : null}
                Create draft
              </Button>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
