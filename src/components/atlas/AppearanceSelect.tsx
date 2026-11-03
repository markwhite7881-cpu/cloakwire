import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

interface Option<T extends string> {
  id: T;
  label: string;
  icon?: ReactNode;
  lang?: string;
}

interface Props<T extends string> {
  label: string;
  value: T;
  options: Option<T>[];
  onChange: (value: T) => void;
}

export function AppearanceSelect<T extends string>({ label, value, options, onChange }: Props<T>) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const search = useRef({ prefix: "", at: 0 });
  const selected = options.find(item => item.id === value) ?? options[0];
  const [cursor, setCursor] = useState<T | null>(null);
  const [bounds, setBounds] = useState<CSSProperties>({ visibility: "hidden" });
  const open = cursor !== null;
  const close = () => setCursor(null);

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      const rect = trigger.current!.getBoundingClientRect();
      const viewport = window.visualViewport;
      const viewportTop = viewport?.offsetTop ?? 0;
      const viewportBottom = viewportTop + (viewport?.height ?? window.innerHeight);
      const below = viewportBottom - rect.bottom - 12;
      const above = rect.top - viewportTop - 12;
      if (rect.bottom <= viewportTop || rect.top >= viewportBottom) { close(); return; }
      const flip = below < Math.min(options.length * 44 + 10, 280) && above > below;
      const maxHeight = Math.max(0, Math.min(280, flip ? above : below));
      setBounds({ left: rect.left, width: rect.width, maxHeight,
        ...(flip ? { bottom: window.innerHeight - rect.top + 4 } : { top: rect.bottom + 4 }) });
    };
    position();
    const onScroll = (event: Event) => { if (!(event.target instanceof Node && menu.current?.contains(event.target))) position(); };
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", position);
    window.visualViewport?.addEventListener("resize", position);
    return () => {
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", position);
      window.visualViewport?.removeEventListener("resize", position);
    };
  }, [open, options.length]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      const node = event.target as Node;
      if (!trigger.current?.contains(node) && !menu.current?.contains(node)) close();
    };
    document.addEventListener("pointerdown", outside);
    return () => document.removeEventListener("pointerdown", outside);
  }, [open]);

  useLayoutEffect(() => {
    if (cursor && bounds.width) document.getElementById(id + cursor)?.scrollIntoView({ block: "nearest" });
  }, [cursor, id, bounds.width]);

  function choose(choice: T) {
    onChange(choice);
    close();
    trigger.current?.focus({ preventScroll: true });
  }

  function handleKey(event: KeyboardEvent<HTMLButtonElement>) {
    const index = options.findIndex(item => item.id === cursor);
    switch (event.key) {
      case "Escape":
        if (!open) return;
        event.stopPropagation();
        close();
        break;
      case "Tab":
        close();
        return;
      case "ArrowDown":
      case "ArrowUp":
        setCursor(open ? options[Math.min(options.length - 1, Math.max(0, index + (event.key === "ArrowDown" ? 1 : -1)))].id : selected.id);
        break;
      case "Home": setCursor(options[0].id); break;
      case "End": setCursor(options[options.length - 1].id); break;
      case "Enter":
      case " ":
        if (cursor) choose(cursor); else setCursor(selected.id);
        break;
      default: {
        if (event.key.length !== 1 || event.ctrlKey || event.metaKey || event.altKey) return;
        const now = Date.now();
        const prefix = (now - search.current.at < 700 ? search.current.prefix : "") + event.key.toLocaleLowerCase();
        search.current = { prefix, at: now };
        const match = options.find(item => item.label.toLocaleLowerCase().startsWith(prefix));
        if (match) setCursor(match.id);
      }
    }
    event.preventDefault();
  }

  return (
    <div className="atlas-pref-row">
      <label id={id + "-label"} htmlFor={id}>{label}</label>
      <button ref={trigger} id={id} type="button" role="combobox" className="atlas-pref-trigger"
        aria-labelledby={id + "-label"} aria-haspopup="listbox" aria-expanded={open}
        aria-controls={open ? id + "-list" : undefined} aria-activedescendant={cursor ? id + cursor : undefined}
        onKeyDown={handleKey} onBlur={() => close()} onClick={() => setCursor(open ? null : selected.id)}>
        {selected.icon}<span lang={selected.lang}>{selected.label}</span><ChevronDown size={16} aria-hidden="true" />
      </button>
      {open && createPortal(
        <div ref={menu} id={id + "-list"} role="listbox" aria-labelledby={id + "-label"}
          className="atlas-pref-menu" style={bounds}>
          {options.map(item => (
            <div key={item.id} id={id + item.id} role="option" aria-selected={value === item.id}
              data-highlighted={cursor === item.id} onMouseDown={event => event.preventDefault()}
              onClick={() => choose(item.id)}>
              {item.icon}<span lang={item.lang}>{item.label}</span>
              {value === item.id && <Check size={16} aria-hidden="true" />}
            </div>
          ))}
        </div>, document.body)}
    </div>
  );
}
