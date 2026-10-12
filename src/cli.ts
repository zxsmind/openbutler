#!/usr/bin/env node
// Load the CLI only after selecting React's production reconciler.
process.env.NODE_ENV ??= 'production';

const originalEmitWarning = process.emitWarning.bind(process) as unknown as (warning: string | Error, ...args: unknown[]) => void;
process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const message = typeof warning === 'string' ? warning : warning.message;
  if (message.includes('SQLite is an experimental feature')) return;
  originalEmitWarning(warning, ...args);
}) as typeof process.emitWarning;

await import('./cli-main.js');
