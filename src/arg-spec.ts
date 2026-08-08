// The one shared tokenizer behind every Phoebe CLI parser (#73). Before this,
// seven hand-rolled argv loops each re-implemented "does this flag take a
// value", "reject an unknown flag", and "how many positionals are allowed" —
// including two independent copies of the same value-taking-flag guard
// (`--url` in the old parseCommandArgs, `--repo` in the old extractRepoFlag).
// Every command now declares that shape as a plain `ArgSpec` and calls
// `parseArgs` once; whatever is left over — content validation (is this value
// shaped right?), cross-flag rules (mutual exclusion), argv-order-sensitive
// messages — stays hand-written in that command's own `parse*Args`, because
// none of that is tokenization.

export type ArgSpec = {
  /** Flags that must be followed by a value (`--flag value` or `--flag=value`).
   *  The very next token is always consumed as the value, even if it is
   *  itself flag-shaped — only whether a next token exists at all is checked
   *  here. Missing entirely (end of argv) throws `missingValue(token)`. */
  valueFlags?: readonly string[];
  /** Flags that take a value only when the next token doesn't itself look
   *  like a flag (does not start with `--`); otherwise the flag is recorded
   *  present with value `true` and the next token is left for the next
   *  iteration. Never throws for a missing value — the shared home for the
   *  mirrored `--url` / `--repo` guard. */
  guardedValueFlags?: readonly string[];
  /** Presence-only flags. `--flag=x` does not match one of these (falls
   *  through to unknown-flag handling), matching every existing parser. */
  booleanFlags?: readonly string[];
  /** Single-character (or otherwise short) aliases, e.g. `{ c: "config" }`. */
  aliases?: Readonly<Record<string, string>>;
  /** Maximum positional arguments accepted. `undefined` = unlimited. */
  maxPositionals?: number;
  /** Only tokens starting with this prefix are attempted as flags; anything
   *  else is a positional attempt. Default `"-"` (single dash included, so a
   *  stray `-x` is still rejected as an unknown flag rather than silently
   *  accepted as a positional). */
  flagPrefix?: "-" | "--";
  /**
   * How a `flagPrefix`-shaped token that matches none of the above is
   * handled:
   *  - `"reject"` (default): call `unknownFlag(token)` and throw.
   *  - `"forward"`: push the raw token onto `positionals`, for the caller to
   *    interpret itself (engine argv forwarding — `phoebe [flags]` doesn't
   *    know the engine's own flag surface).
   *  - `"capture"`: record it as a boolean-true flag with no rejection
   *    (today's permissive tenant-lifecycle commands, which never rejected
   *    an unrecognized flag).
   */
  onUnknownFlag?: "reject" | "forward" | "capture";
  unknownFlag?: (token: string) => string;
  missingValue?: (token: string) => string;
  /** Overflow message for a positional beyond `maxPositionals`. Receives the
   *  first-accepted positional and the rejected extra. When omitted, an
   *  overflowing positional is handled like an unrecognized flag (used by
   *  commands, like `config resolve`, that accept no positionals at all and
   *  give every extra token the same "unknown flag" wording). */
  tooManyPositionals?: (first: string, extra: string) => string;
};

export type ParsedCommandArgs = {
  positionals: string[];
  flags: Record<string, string | true>;
};

export function parseArgs(argv: readonly string[], spec: ArgSpec): ParsedCommandArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | true> = {};
  const valueFlags = new Set(spec.valueFlags ?? []);
  const guardedValueFlags = new Set(spec.guardedValueFlags ?? []);
  const booleanFlags = new Set(spec.booleanFlags ?? []);
  const aliases = spec.aliases ?? {};
  const flagPrefix = spec.flagPrefix ?? "-";
  const onUnknownFlag = spec.onUnknownFlag ?? "reject";

  const handleUnknown = (raw: string, name: string, inlineValue: string | undefined): void => {
    if (onUnknownFlag === "forward") {
      positionals.push(raw);
      return;
    }
    if (onUnknownFlag === "capture") {
      flags[name] = inlineValue ?? true;
      return;
    }
    if (!spec.unknownFlag) throw new Error(`Unknown flag \`${raw}\`.`);
    throw new Error(spec.unknownFlag(raw));
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;

    if (!arg.startsWith(flagPrefix)) {
      if (spec.maxPositionals !== undefined && positionals.length >= spec.maxPositionals) {
        if (spec.tooManyPositionals) {
          throw new Error(spec.tooManyPositionals(positionals[0] ?? "", arg));
        }
        handleUnknown(arg, arg, undefined);
        continue;
      }
      positionals.push(arg);
      continue;
    }

    const eq = arg.indexOf("=");
    const rawName = (eq === -1 ? arg : arg.slice(0, eq)).replace(/^--?/, "");
    const name = aliases[rawName] ?? rawName;
    const inlineValue = eq === -1 ? undefined : arg.slice(eq + 1);

    if (booleanFlags.has(name) && inlineValue === undefined) {
      flags[name] = true;
      continue;
    }

    if (valueFlags.has(name)) {
      const value = inlineValue ?? argv[++i];
      if (value === undefined) {
        const build = spec.missingValue ?? ((token: string) => `${token} requires a value.`);
        throw new Error(build(arg));
      }
      flags[name] = value;
      continue;
    }

    if (guardedValueFlags.has(name)) {
      if (inlineValue !== undefined) {
        flags[name] = inlineValue;
        continue;
      }
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
      continue;
    }

    handleUnknown(arg, name, inlineValue);
  }

  return { positionals, flags };
}
