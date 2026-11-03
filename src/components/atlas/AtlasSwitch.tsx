interface AtlasSwitchProps {
  checked: boolean;
  label: string;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  title?: string;
  id?: string;
}

export function AtlasSwitch({ checked, label, onChange, disabled = false, title, id }: AtlasSwitchProps) {
  return (
    <span className="atlas-switch" title={title}>
      <input
        id={id}
        type="checkbox"
        role="switch"
        aria-label={label}
        checked={checked}
        disabled={disabled}
        onChange={event => onChange(event.currentTarget.checked)}
      />
      <span className="atlas-switch-track" aria-hidden="true"><i /></span>
    </span>
  );
}
