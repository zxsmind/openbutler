#!/usr/bin/env node
// Load the CLI only after selecting React's production reconciler.
process.env.NODE_ENV ??= 'production';
await import('./cli-main.js');
