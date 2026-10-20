'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { Ban, CheckCircle2, Loader2, PlayCircle, RefreshCw, XCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/primitives';
import { Textarea } from '@/components/ui/input';
import { Alert } from '@/components/ui/feedback';
import { api, ApiRequestError } from '@/lib/api';

/**
 * The recovery actions.
 *
 * A retry continues the same execution and repeats only the failed step. A
 * rerun creates a new execution and repeats every step, so the UI has to warn
 * about the repeated side effects. An unknown outcome is never retried
 * automatically: the operator decides.
 */
export function ExecutionRecovery({
  executionId,
  availableActions,
  failedStepKey,
  unknownStepKey,
  successfulStepKeys,
  stepsSafeToRepeat,
}: {
  executionId: string;
  availableActions: { retryStep: boolean; rerun: boolean; cancel: boolean; resolveOutcomeUnknown: boolean };
  failedStepKey: string | null;
  unknownStepKey: string | null;
  successfulStepKeys: string[];
  stepsSafeToRepeat: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [rerunOpen, setRerunOpen] = useState(false);
  const [resolveOpen, setResolveOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [resolution, setResolution] = useState<'succeeded' | 'failed'>('succeeded');

  async function retry() {
    const stepKey = failedStepKey ?? unknownStepKey;
    if (!stepKey) return;

    setPending(true);
    try {
      // The idempotency key is generated on the client, so a double click
      // cannot create two recoveries.
      const response = await api.post<{ duplicate: boolean }>(
        `/api/executions/${executionId}/retry`,
        { stepKey, idempotencyKey: crypto.randomUUID() },
        { browser: true },
      );
      toast.success(
        response.duplicate
          ? 'That recovery was already requested'
          : 'The step was queued for another attempt',
      );
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : 'the retry could not be started');
    } finally {
      setPending(false);
    }
  }

  async function rerun() {
    setPending(true);
    try {
      await api.post(`/api/executions/${executionId}/rerun`, { useCurrentVersion: false }, { browser: true });
      toast.success('A new execution was created from this run');
      setRerunOpen(false);
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : 'the rerun could not be started');
    } finally {
      setPending(false);
    }
  }

  async function cancel() {
    setPending(true);
    try {
      await api.post(`/api/executions/${executionId}/cancel`, undefined, { browser: true });
      toast.success('The execution was cancelled');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : 'the execution could not be cancelled');
    } finally {
      setPending(false);
    }
  }

  async function resolve() {
    if (reason.trim().length < 3) {
      toast.error('A reason is required, it is stored with the resolution');
      return;
    }
    setPending(true);
    try {
      await api.post(
        `/api/executions/${executionId}/steps/${unknownStepKey}/resolve`,
        { outcome: resolution, reason: reason.trim() },
        { browser: true },
      );
      toast.success('The outcome was resolved and recorded');
      setResolveOpen(false);
      setReason('');
      router.refresh();
    } catch (error) {
      toast.error(error instanceof ApiRequestError ? error.message : 'the outcome could not be resolved');
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {availableActions.retryStep && failedStepKey ? (
        <Button variant="outline" size="sm" onClick={retry} disabled={pending}>
          {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
          Retry the failed step
        </Button>
      ) : null}

      {availableActions.resolveOutcomeUnknown && unknownStepKey ? (
        <Button variant="outline" size="sm" onClick={() => setResolveOpen(true)} disabled={pending}>
          <CheckCircle2 />
          Resolve the unknown outcome
        </Button>
      ) : null}

      {availableActions.rerun ? (
        <Button variant="outline" size="sm" onClick={() => setRerunOpen(true)} disabled={pending}>
          <PlayCircle />
          Rerun as a new execution
        </Button>
      ) : null}

      {availableActions.cancel ? (
        <Button variant="ghost" size="sm" onClick={cancel} disabled={pending}>
          <Ban />
          Cancel
        </Button>
      ) : null}

      <Dialog open={rerunOpen} onOpenChange={setRerunOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rerun this execution?</DialogTitle>
            <DialogDescription>
              A rerun creates a new execution and repeats <strong>every</strong> step, including the{' '}
              {successfulStepKeys.length} step{successfulStepKeys.length === 1 ? '' : 's'} that already succeeded.
              {stepsSafeToRepeat
                ? ' The actions in this workflow are safe to repeat.'
                : ' Some actions have external side effects that may happen twice.'}
            </DialogDescription>
          </DialogHeader>
          <Alert variant="warning">
            Use <strong>retry</strong> instead when only the failed step should run again.
          </Alert>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRerunOpen(false)}>
              Cancel
            </Button>
            <Button onClick={rerun}>Rerun everything</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={resolveOpen} onOpenChange={setResolveOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Resolve the unknown outcome</DialogTitle>
            <DialogDescription>
              The step timed out without a response. That does not prove the remote operation failed, so the decision
              is yours. The original attempt history is kept exactly as it was; your decision is stored as a separate
              resolution record.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="flex gap-2">
              <Button
                variant={resolution === 'succeeded' ? 'default' : 'outline'}
                size="sm"
                onClick={() => setResolution('succeeded')}
              >
                <CheckCircle2 />
                Mark as succeeded
              </Button>
              <Button
                variant={resolution === 'failed' ? 'destructive' : 'outline'}
                size="sm"
                onClick={() => setResolution('failed')}
              >
                <XCircle />
                Mark as failed
              </Button>
            </div>
            <Textarea
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              placeholder="I verified the contact in the provider dashboard."
            />
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setResolveOpen(false)}>
              Cancel
            </Button>
            <Button onClick={resolve}>Record the resolution</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
