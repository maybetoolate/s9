import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '@/lib/utils';

const badgeVariants = cva(
  'inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-xs font-medium transition-colors',
  {
    variants: {
      variant: {
        default: 'border-transparent bg-[var(--color-primary)] text-[var(--color-primary-foreground)]',
        secondary: 'border-transparent bg-[var(--color-secondary)] text-[var(--color-secondary-foreground)]',
        outline: 'border-[var(--color-border)] text-[var(--color-foreground)]',
        success: 'border-transparent bg-[var(--color-success)] text-[var(--color-success-foreground)]',
        warning: 'border-transparent bg-[var(--color-warning)] text-[var(--color-warning-foreground)]',
        destructive: 'border-transparent bg-[var(--color-destructive)] text-[var(--color-destructive-foreground)]',
        muted: 'border-transparent bg-[var(--color-muted)] text-[var(--color-muted-foreground)]',
      },
    },
    defaultVariants: { variant: 'default' },
  },
);

export interface BadgeProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
