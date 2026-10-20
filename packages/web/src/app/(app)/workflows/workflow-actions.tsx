'use client';

import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';
import { toast } from 'sonner';
import { Archive, Copy, Pause, Play } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/primitives';
import { api, ApiRequestError } from '@/lib/api';

/**
 * Workflow row actions.
 *
 * Destructive actions require a confirmation, and every action reports what
 * happened instead of failing silently.
 */
export function WorkflowActions({ workflowId, status }: { workflowId: string; status: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmArchive, setConfirmArchive] = useState(false);

  async function call(path: string, body?: unknown, successMessage?: string) {
    try {
      await api.post(path, body, { browser: true });
      if (successMessage) toast.success(successMessage);
      startTransition(() => router.refresh());
    } catch (error) {
      const message =
        error instanceof ApiRequestError ? error.message : 'the action could not be completed';
      toast.error(message);
    }
  }

  return (
    <div className="flex items-center justify-end gap-1">
      {status === 'published' ? (
        <Button
          variant="ghost"
          size="icon"
          title="Pause the workflow"
          disabled={pending}
          onClick={() => call(`/api/workflows/${workflowId}/pause`, undefined, 'The workflow is paused')}
        >
          <Pause />
        </Button>
      ) : null}

      {status === 'paused' ? (
        <Button
          variant="ghost"
          size="icon"
          title="Resume the workflow"
          disabled={pending}
          onClick={() => call(`/api/workflows/${workflowId}/resume`, undefined, 'The workflow is running again')}
        >
          <Play />
        </Button>
      ) : null}

      <Button
        variant="ghost"
        size="icon"
        title="Duplicate the workflow"
        disabled={pending}
        onClick={() => call(`/api/workflows/${workflowId}/duplicate`, undefined, 'The workflow was duplicated')}
      >
        <Copy />
      </Button>

      {status !== 'archived' ? (
        <Button
          variant="ghost"
          size="icon"
          title="Archive the workflow"
          disabled={pending}
          onClick={() => setConfirmArchive(true)}
        >
          <Archive />
        </Button>
      ) : null}

      <Dialog open={confirmArchive} onOpenChange={setConfirmArchive}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Archive this workflow?</DialogTitle>
            <DialogDescription>
              Archiving stops new runs from being created. The execution history and the published versions are kept,
              and the workflow can still be inspected.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirmArchive(false)}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={async () => {
                setConfirmArchive(false);
                await call(`/api/workflows/${workflowId}/archive`, undefined, 'The workflow was archived');
              }}
            >
              Archive
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
