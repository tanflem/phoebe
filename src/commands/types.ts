import type { CliContext } from "../cli-context.ts";

/**
 * One entry in the `phoebe` command table (#73). `run` returns the process
 * exit code (0 for success) and touches only `argv`/`ctx` — no `process.*` —
 * so dispatch is testable through a fake `CliContext`.
 */
export type Command = {
  name: string;
  /** One line, shown in the generated root usage. */
  summary: string;
  /** Authored long-form help, shown by `phoebe <command> --help`. */
  help: string;
  run(argv: readonly string[], ctx: CliContext): Promise<number>;
};
