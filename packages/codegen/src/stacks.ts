// Browser safe: the IDE client offers the stacks from here.

/** The stacks Appling generates, by the extension package of each. */
export const STACKS = {
    django: '@appling/codegen-django',
    ash: '@appling/codegen-ash',
    go: '@appling/codegen-go',
    rust: '@appling/codegen-rust'
};
export type Stack = keyof typeof STACKS;
export const STACK_LABELS: Record<Stack, string> = { django: 'Django', ash: 'Ash', go: 'Go', rust: 'Rust' };
