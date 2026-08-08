// Shared minimal `.env` parser used by both the supervisor's per-tenant env
// scrub (bootstrap/engine-child-env.ts) and `phoebe setup`'s pre-fill reader
// (src/setup.ts). `KEY=value` lines, blanks and `#` comments skipped, an
// optional `export ` prefix stripped, the key validated against
// `/^[A-Za-z_][A-Za-z0-9_]*$/`, surrounding single/double quotes stripped, and
// `=` inside a value preserved. No interpolation, no multiline values.

export function parseDotenv(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of contents.split("\n")) {
    const line = raw.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const withoutExport = line.startsWith("export ") ? line.slice("export ".length) : line;
    const eq = withoutExport.indexOf("=");
    if (eq === -1) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if (value.length >= 2 && (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}
