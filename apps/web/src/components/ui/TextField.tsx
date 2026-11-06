import { clsx } from 'clsx';
import { forwardRef, type InputHTMLAttributes, useId } from 'react';

export interface TextFieldProps extends InputHTMLAttributes<HTMLInputElement> {
  label: string;
  error?: string;
  hint?: string;
  /** `lg` is the kiosk size: large type and a tall touch target. */
  inputSize?: 'md' | 'lg';
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, error, hint, className, id, inputSize = 'md', ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const describedBy =
    [hint && `${inputId}-hint`, error && `${inputId}-error`].filter(Boolean).join(' ') || undefined;
  return (
    <div className={clsx('flex flex-col gap-1.5', className)}>
      <label
        htmlFor={inputId}
        className={clsx(
          'font-medium text-slate-700 dark:text-slate-200',
          inputSize === 'lg' ? 'text-base' : 'text-sm',
        )}
      >
        {label}
      </label>
      <input
        ref={ref}
        id={inputId}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={clsx(
          'w-full rounded-xl border bg-white text-slate-900 shadow-xs transition-colors placeholder:text-slate-400 focus:border-brand-500 dark:bg-slate-900 dark:text-slate-100',
          inputSize === 'lg'
            ? 'min-h-14 px-4 text-2xl tracking-wide'
            : 'min-h-10 px-3 py-2 text-sm',
          error ? 'border-red-500' : 'border-slate-300 dark:border-slate-700',
        )}
        {...rest}
      />
      {hint && !error && (
        <p id={`${inputId}-hint`} className="text-xs text-slate-500 dark:text-slate-400">
          {hint}
        </p>
      )}
      {error && (
        <p id={`${inputId}-error`} className="text-xs text-red-600 dark:text-red-400">
          {error}
        </p>
      )}
    </div>
  );
});
