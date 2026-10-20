'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { toast } from 'sonner';
import { KeyRound, Loader2, Plus, RefreshCw, Trash2 } from 'lucide-react';
import type { CredentialDto } from '@flowforge/core';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input, Label } from '@/components/ui/input';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/primitives';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Alert } from '@/components/ui/feedback';
import { api, ApiRequestError } from '@/lib/api';
import { formatDateTime } from '@/lib/utils';

/**
 * Credentials.
 *
 * Secrets are encrypted at rest and never returned by the API, so the UI only
 * ever shows that a secret exists.
 */

const PROVIDERS = [
  { id: 'resend', label: 'Resend (API key)', hint: 'The Resend API key, e.g. re_...' },
  { id: 'http_header', label: 'HTTP header value', hint: 'The value sent as the Authorization header.' },
  { id: 'notification', label: 'Notification webhook URL', hint: 'The incoming webhook URL of the destination.' },
  { id: 'custom', label: 'Custom', hint: 'Any secret the adapter expects.' },
];

export function CredentialsManager({ credentials }: { credentials: CredentialDto[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [rotateTarget, setRotateTarget] = useState<CredentialDto | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<CredentialDto | null>(null);
  const [name, setName] = useState('');
  const [provider, setProvider] = useState('resend');
  const [secret, setSecret] = useState('');
  const [rotateSecret, setRotateSecret] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function create() {
    setPending(true);
    setError(null);
    try {
      await api.post(
        '/api/credentials',
        { name, provider, secret, metadata: {} },
        { browser: true },
      );
      toast.success('The credential was saved');
      setOpen(false);
      setName('');
      setSecret('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'the credential could not be saved');
    } finally {
      setPending(false);
    }
  }

  async function rotate() {
    if (!rotateTarget) return;
    setPending(true);
    setError(null);
    try {
      await api.post(
        `/api/credentials/${rotateTarget.id}/rotate`,
        { secret: rotateSecret },
        { browser: true },
      );
      toast.success('The secret was rotated');
      setRotateTarget(null);
      setRotateSecret('');
      router.refresh();
    } catch (caught) {
      setError(caught instanceof ApiRequestError ? caught.message : 'the secret could not be rotated');
    } finally {
      setPending(false);
    }
  }

  async function remove() {
    if (!deleteTarget) return;
    setPending(true);
    setError(null);
    try {
      await api.delete(`/api/credentials/${deleteTarget.id}`, { browser: true });
      toast.success('The credential was deleted');
      setDeleteTarget(null);
      router.refresh();
    } catch (caught) {
      if (caught instanceof ApiRequestError && caught.code === 'credential_in_use') {
        setError(
          'A published workflow version still uses this credential. Update those workflows before deleting it.',
        );
      } else {
        setError(caught instanceof ApiRequestError ? caught.message : 'the credential could not be deleted');
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <Card>
        <CardHeader className="flex flex-row items-center justify-between">
          <CardTitle>Credentials</CardTitle>
          <Button size="sm" onClick={() => setOpen(true)}>
            <Plus />
            Add credential
          </Button>
        </CardHeader>
        <CardContent>
          {credentials.length === 0 ? (
            <p className="text-sm text-[var(--color-muted-foreground)]">
              No credentials yet. A credential keeps provider secrets out of the workflow definition.
            </p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Provider</TableHead>
                  <TableHead>Secret</TableHead>
                  <TableHead>Updated</TableHead>
                  <TableHead className="w-24 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {credentials.map((credential) => (
                  <TableRow key={credential.id}>
                    <TableCell className="font-medium">{credential.name}</TableCell>
                    <TableCell className="text-sm text-[var(--color-muted-foreground)]">{credential.provider}</TableCell>
                    <TableCell className="text-sm text-[var(--color-muted-foreground)]">
                      {credential.hasSecret ? 'stored (hidden)' : '—'}
                    </TableCell>
                    <TableCell className="text-sm text-[var(--color-muted-foreground)]">
                      {formatDateTime(credential.updatedAt)}
                    </TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-1">
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Rotate the secret"
                          onClick={() => setRotateTarget(credential)}
                        >
                          <RefreshCw />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          title="Delete the credential"
                          className="text-[var(--color-destructive)]"
                          onClick={() => setDeleteTarget(credential)}
                        >
                          <Trash2 />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </CardContent>
      </Card>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a credential</DialogTitle>
            <DialogDescription>
              The secret is encrypted with the master key before it is stored and is never returned by the API.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1.5">
              <Label htmlFor="credentialName">Name</Label>
              <Input
                id="credentialName"
                value={name}
                onChange={(event) => setName(event.target.value)}
                placeholder="Resend production key"
              />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="credentialProvider">Provider</Label>
              <select
                id="credentialProvider"
                value={provider}
                onChange={(event) => setProvider(event.target.value)}
                className="h-9 w-full rounded-md border border-[var(--color-input)] bg-[var(--color-card)] px-3 text-sm"
              >
                {PROVIDERS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
              <p className="text-xs text-[var(--color-muted-foreground)]">
                {PROVIDERS.find((option) => option.id === provider)?.hint}
              </p>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="credentialSecret">Secret</Label>
              <Input
                id="credentialSecret"
                type="password"
                value={secret}
                onChange={(event) => setSecret(event.target.value)}
                autoComplete="off"
              />
            </div>
            {error ? <Alert variant="error">{error}</Alert> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button onClick={create} disabled={pending || !name || !secret}>
              {pending ? <Loader2 className="animate-spin" /> : <KeyRound />}
              Save
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rotateTarget !== null} onOpenChange={(openState) => !openState && setRotateTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Rotate the secret</DialogTitle>
            <DialogDescription>
              The old secret stops working immediately. Update every workflow that references this credential.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-1.5">
            <Label htmlFor="rotateSecret">New secret</Label>
            <Input
              id="rotateSecret"
              type="password"
              value={rotateSecret}
              onChange={(event) => setRotateSecret(event.target.value)}
              autoComplete="off"
            />
            {error ? <Alert variant="error">{error}</Alert> : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setRotateTarget(null)}>
              Cancel
            </Button>
            <Button onClick={rotate} disabled={pending || !rotateSecret}>
              {pending ? <Loader2 className="animate-spin" /> : <RefreshCw />}
              Rotate
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteTarget !== null} onOpenChange={(openState) => !openState && setDeleteTarget(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete this credential?</DialogTitle>
            <DialogDescription>
              A credential that a published workflow still uses cannot be deleted.
            </DialogDescription>
          </DialogHeader>
          {error ? <Alert variant="error">{error}</Alert> : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleteTarget(null)}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={remove} disabled={pending}>
              Delete
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
