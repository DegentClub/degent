/** What a command hands back to the dispatcher: help text, or data (for --json) plus its human rendering. */
export type CommandResult = { help: string } | { data: Record<string, unknown>; human: string };
