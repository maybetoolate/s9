'use client';

import { useState } from 'react';
import { ChevronDown, ChevronRight, Plus, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input, Label, Textarea } from '@/components/ui/input';

/**
 * The variable picker.
 *
 * Users should be able to map values from the trigger input and the outputs of
 * earlier steps without memorising paths. The syntax is fixed:
 * `{{trigger.body.email}}` and `{{steps.save_contact.output.id}}`.
 */
export interface VariableOption {
  path: string;
  label: string;
  hint?: string;
  /** True when the reference points at a later step and is therefore invalid. */
  invalid?: boolean;
}

export function VariablePicker({
  options,
  onInsert,
  label = 'Insert variable',
}: {
  options: VariableOption[];
  onInsert: (path: string) => void;
  label?: string;
}) {
  const [open, setOpen] = useState(false);

  if (options.length === 0) return null;

  return (
    <div className="relative">
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() => setOpen((current) => !current)}
        title="Insert a variable"
      >
        <Plus />
        {label}
        {open ? <ChevronDown /> : <ChevronRight />}
      </Button>

      {open ? (
        <>
          <button
            type="button"
            aria-label="Close the variable picker"
            className="fixed inset-0 z-10 cursor-default"
            onClick={() => setOpen(false)}
          />
          <div className="absolute left-0 z-20 mt-1 max-h-72 w-72 overflow-auto rounded-md border border-[var(--color-border)] bg-[var(--color-popover)] p-1 shadow-lg">
            {options.map((option) => (
              <button
                key={option.path}
                type="button"
                disabled={option.invalid}
                onClick={() => {
                  onInsert(option.path);
                  setOpen(false);
                }}
                className="flex w-full flex-col items-start rounded-sm px-2 py-1.5 text-left text-xs transition-colors hover:bg-[var(--color-accent)] disabled:opacity-40 disabled:hover:bg-transparent"
              >
                <span className="font-mono">{`{{${option.path}}}`}</span>
                <span className="text-[var(--color-muted-foreground)]">
                  {option.hint ?? option.label}
                  {option.invalid ? ' — not available yet' : ''}
                </span>
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

/**
 * A labelled text field with an attached variable picker.
 */
export function MappedField({
  id,
  label,
  value,
  onChange,
  variables,
  hint,
  multiline,
  placeholder,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  variables: VariableOption[];
  hint?: string;
  multiline?: boolean;
  placeholder?: string;
}) {
  function insert(path: string) {
    const token = `{{${path}}}`;
    onChange(value ? `${value}${token}` : token);
  }

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label htmlFor={id}>{label}</Label>
        <VariablePicker options={variables} onInsert={insert} />
      </div>
      {multiline ? (
        <Textarea
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="font-mono text-xs"
        />
      ) : (
        <Input
          id={id}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          placeholder={placeholder}
          className="font-mono text-xs"
        />
      )}
      {hint ? <p className="text-xs text-[var(--color-muted-foreground)]">{hint}</p> : null}
    </div>
  );
}

/** An editor for a header map (`{ "content-type": "application/json" }`). */
export function HeaderMapField({
  value,
  onChange,
  variables,
}: {
  value: Record<string, string>;
  onChange: (value: Record<string, string>) => void;
  variables: VariableOption[];
}) {
  const entries = Object.entries(value ?? {});

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <Label>Headers</Label>
        <VariablePicker
          options={variables}
          onInsert={(path) => onChange({ ...value, [path]: '' })}
        />
      </div>
      {entries.length === 0 ? (
        <p className="text-xs text-[var(--color-muted-foreground)]">No headers configured.</p>
      ) : null}
      {entries.map(([key, headerValue], index) => (
        <div key={`${key}-${index}`} className="flex items-center gap-2">
          <Input
            value={key}
            onChange={(event) => {
              const next = { ...value };
              delete next[key];
              next[event.target.value] = headerValue;
              onChange(next);
            }}
            className="font-mono text-xs"
          />
          <Input
            value={headerValue}
            onChange={(event) => onChange({ ...value, [key]: event.target.value })}
            className="font-mono text-xs"
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            onClick={() => {
              const next = { ...value };
              delete next[key];
              onChange(next);
            }}
          >
            <X />
          </Button>
        </div>
      ))}
      <Button type="button" variant="outline" size="sm" onClick={() => onChange({ ...value, '': '' })}>
        <Plus />
        Add header
      </Button>
    </div>
  );
}
