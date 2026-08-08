// The I/O seam every CLI command runs against instead of touching `process.*`
// directly. `runCli` (src/cli.ts) is the only place that builds a real one
// (from `process.cwd()` / `process.env` / `process.stdout` / `process.stderr`);
// tests build a fake one over in-memory buffers, which is what makes dispatch
// testable for the first time (#73).

export type Writer = { write(text: string): void };

export type CliContext = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: Writer;
  stderr: Writer;
};
