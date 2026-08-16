import { useId, useState } from 'react';
import { Icon } from './icons';
import { inputClass } from './ui';

/**
 * A controlled password field with an accessible visibility toggle. The toggle
 * flips only the input's `type`; the value is never cleared or re-read, and the
 * button reports its state through aria-pressed so screen readers announce it.
 * The label is associated explicitly (htmlFor/id) and the toggle lives outside
 * the label element, so the button never inherits the field's accessible name.
 */
export function PasswordInput({
  label,
  value,
  onChange,
  placeholder,
  autoComplete,
  hint
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  autoComplete?: string;
  hint?: string;
}) {
  const [visible, setVisible] = useState(false);
  const inputId = useId();
  return (
    <div className="block">
      <label htmlFor={inputId} className="mb-1.5 block text-xs font-medium text-muted">
        {label}
      </label>
      <span className="relative block">
        <input
          id={inputId}
          className={`${inputClass} pr-11`}
          type={visible ? 'text' : 'password'}
          value={value}
          placeholder={placeholder}
          autoComplete={autoComplete}
          onChange={(event) => onChange(event.target.value)}
        />
        <button
          type="button"
          onClick={() => setVisible((current) => !current)}
          aria-label={visible ? 'Hide password' : 'Show password'}
          aria-pressed={visible}
          className="focus-ring absolute inset-y-0 right-0 flex w-10 items-center justify-center rounded-r-lg text-muted transition-colors hover:text-ink"
        >
          <Icon name={visible ? 'eyeOff' : 'eye'} size={16} />
        </button>
      </span>
      {hint && <span className="mt-1 block text-xs text-muted">{hint}</span>}
    </div>
  );
}
