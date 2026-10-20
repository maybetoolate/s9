import * as React from 'react';
import { AlertTriangle, CheckCircle2, Info, XCircle } from 'lucide-react';
import { cn } from '@/lib/utils';

/** A compact alert used for inline feedback. */
export function Alert({
  variant = 'info',
  title,
  children,
  className,
}: {
  variant?: 'info' | 'success' | 'warning' | 'error';
  title?: string;
  children?: React.ReactNode;
  className?: string;
}) {
  const icons = {
    info: Info,
    success: CheckCircle2,
    warning: AlertTriangle,
    error: XCircle,
  };
  const Icon = icons[variant];
  const tones = {
    info: 'border-[var(--color-border)] bg-[var(--color-muted)] text-[var(--color-foreground)]',
    success: 'border-[var(--color-success)]/30 bg-[var(--color-success)]/10 text-[var(--color-foreground)]',
    warning: 'border-[var(--color-warning)]/40 bg-[var(--color-warning)]/10 text-[var(--color-foreground)]',
    error: 'border-[var(--color-destructive)]/30 bg-[var(--color-destructive)]/10 text-[var(--color-foreground)]',
  };

  return (
    <div className={cn('flex gap-3 rounded-md border p-3 text-sm', tones[variant], className)}>
      <Icon className="mt-0.5 size-4 shrink-0" />
      <div className="space-y-1">
        {title ? <p className="font-medium">{title}</p> : null}
        {children ? <div className="text-[var(--color-muted-foreground)]">{children}</div> : null}
      </div>
    </div>
  );
}

export function Skeleton({ className }: { className?: string }) {
  return <div className={cn('animate-pulse rounded-md bg-[var(--color-muted)]', className)} />;
}

export function Separator({ className }: { className?: string }) {
  return <div className={cn('h-px w-full bg-[var(--color-border)]', className)} />;
}

/** An empty state with a call to action. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon?: React.ComponentType<{ className?: string }>;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed border-[var(--color-border)] px-6 py-12 text-center">
      {Icon ? <Icon className="size-8 text-[var(--color-muted-foreground)]" /> : null}
      <div className="space-y-1">
        <p className="font-medium">{title}</p>
        {description ? (
          <p className="max-w-md text-sm text-[var(--color-muted-foreground)]">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/** Renders a JSON value in a readable way. */
export function CodeBlock({ value }: { value: unknown }) {
  const text = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
  return (
    <pre className="ff-scrollbar max-h-96 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-muted)]/50 p-3 text-xs">
      {text ?? '—'}
    </pre>
  );
}
