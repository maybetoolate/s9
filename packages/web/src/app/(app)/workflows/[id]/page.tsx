import { notFound } from 'next/navigation';
import type { ActionTypeDto, WorkflowDetailDto } from '@flowforge/core';
import { api, ApiRequestError } from '@/lib/api-server';
import { requireSession } from '@/lib/session';
import { WorkflowBuilder } from './workflow-builder';

export const dynamic = 'force-dynamic';

/**
 * The workflow editor.
 *
 * The draft is editable, the published versions are immutable snapshots.
 */
export default async function WorkflowPage({ params }: { params: Promise<{ id: string }> }) {
  await requireSession();
  const { id } = await params;

  let workflow: WorkflowDetailDto;
  try {
    workflow = await api.get<WorkflowDetailDto>(`/api/workflows/${id}`);
  } catch (error) {
    if (error instanceof ApiRequestError && error.status === 404) notFound();
    throw error;
  }

  const actionTypes = await api.get<{ data: ActionTypeDto[] }>('/api/actions');

  return <WorkflowBuilder workflow={workflow} actionTypes={actionTypes.data} />;
}
