import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Glyph } from './Glyph.js';

export interface SelectOption {
    value: string;
    label: string;
    /** Muted text after the label, such as the module of a declaration. */
    hint?: string;
}

interface SelectProps {
    value: string;
    options: SelectOption[];
    /** What is picked, for assistive technology and in front of the value. */
    label: string;
    /** Shows the label in front of the value. */
    showLabel?: boolean;
    /** Drawn before the value, such as an avatar. */
    lead?: ReactNode;
    /** Which edge of the trigger the list aligns to. */
    align?: 'start' | 'end';
    className?: string;
    onChange(value: string): void;
}

/** A dropdown in the look of the canvas: a trigger with the picked value and a list of the options under it. */
export function Select({ value, options, label, showLabel, lead, align = 'start', className, onChange }: SelectProps) {
    const [open, setOpen] = useState(false);
    const [active, setActive] = useState(0);
    const root = useRef<HTMLDivElement>(null);
    const list = useRef<HTMLUListElement>(null);
    const trigger = useRef<HTMLButtonElement>(null);
    const id = useId();
    const picked = options.find(o => o.value === value);

    const show = () => {
        setActive(Math.max(0, options.findIndex(o => o.value === value)));
        setOpen(true);
    };
    const close = (refocus: boolean) => {
        setOpen(false);
        if (refocus) trigger.current?.focus();
    };
    const choose = (option: SelectOption) => {
        close(true);
        if (option.value !== value) onChange(option.value);
    };

    useEffect(() => {
        if (!open) return;
        list.current?.focus();
        const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) close(false); };
        document.addEventListener('pointerdown', outside);
        return () => document.removeEventListener('pointerdown', outside);
    }, [open]);
    useEffect(() => {
        if (open) list.current?.children[active]?.scrollIntoView({ block: 'nearest' });
    }, [open, active]);

    const onListKey = (event: React.KeyboardEvent) => {
        const move = { ArrowDown: 1, ArrowUp: -1 }[event.key];
        if (move) setActive(i => (i + move + options.length) % options.length);
        else if (event.key === 'Home') setActive(0);
        else if (event.key === 'End') setActive(options.length - 1);
        else if (event.key === 'Enter' || event.key === ' ') choose(options[active]);
        else if (event.key === 'Escape') close(true);
        else if (event.key === 'Tab') close(false);
        else {
            // typing a letter jumps to the next option that starts with it
            const next = options.findIndex((o, i) => i > active && o.label.toLowerCase().startsWith(event.key.toLowerCase()));
            const first = options.findIndex(o => o.label.toLowerCase().startsWith(event.key.toLowerCase()));
            if (event.key.length !== 1 || first < 0) return;
            setActive(next >= 0 ? next : first);
        }
        event.preventDefault();
        event.stopPropagation();
    };

    return (
        <div ref={root} className={`select${open ? ' open' : ''}${className ? ` ${className}` : ''}`}>
            <button ref={trigger} type="button" className="select-trigger" aria-haspopup="listbox" aria-expanded={open} aria-controls={id} aria-label={`${label}: ${picked?.label ?? value}`}
                onClick={() => open ? close(false) : show()}
                onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); show(); } }}>
                {lead}
                {showLabel && <span className="select-label">{label}</span>}
                <span className="select-value">{picked?.label ?? value}</span>
                <Glyph name="chevron-down" size={14} />
            </button>
            {open && (
                <ul ref={list} id={id} className={`select-list ${align}`} role="listbox" tabIndex={-1} aria-label={label} aria-activedescendant={`${id}-${active}`} onKeyDown={onListKey}>
                    {options.map((o, i) => (
                        <li key={o.value} id={`${id}-${i}`} role="option" aria-selected={o.value === value} className={i === active ? 'active' : undefined}
                            onPointerEnter={() => setActive(i)} onClick={() => choose(o)}>
                            <span className="select-value">{o.label}</span>
                            {o.hint && <span className="select-hint">{o.hint}</span>}
                            {o.value === value && <Glyph name="check" size={14} />}
                        </li>
                    ))}
                </ul>
            )}
        </div>
    );
}

/** The options of qualified names: the name, its module as the hint. */
export function qualifiedOptions(qns: string[]): SelectOption[] {
    return qns.map(qn => {
        const dot = qn.lastIndexOf('.');
        return { value: qn, label: qn.slice(dot + 1), hint: dot > 0 ? qn.slice(0, dot) : undefined };
    });
}
