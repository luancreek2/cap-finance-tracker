#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');

function fail(message) {
  console.error('[supabase-config] ' + message);
  process.exit(1);
}

function required(name) {
  const value = process.env[name];
  if (typeof value !== 'string' || value.trim() === '') {
    fail('Missing required environment variable: ' + name);
  }
  return value.trim();
}

function main() {
  const urlValue = required('CAP_SUPABASE_URL');
  const publishableKey = required('CAP_SUPABASE_PUBLISHABLE_KEY');

  let parsed;
  try {
    parsed = new URL(urlValue);
  } catch {
    fail('CAP_SUPABASE_URL must be an absolute URL');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    fail('CAP_SUPABASE_URL must use http or https');
  }

  // Serialize the complete object so quotes, backslashes, newlines, and other
  // characters in deployment values cannot break out of the JavaScript literal.
  const config = { url: urlValue, publishableKey };
  const outputPath = path.resolve(__dirname, '..', 'supabase-config.js');
  const source = [
    '/* Generated at deployment time from CAP_SUPABASE_URL and CAP_SUPABASE_PUBLISHABLE_KEY. Do not edit or commit. */',
    'window.CAP_SUPABASE_CONFIG = window.CAP_SUPABASE_CONFIG || ' + JSON.stringify(config, null, 2) + ';',
    ''
  ].join('\n');

  fs.writeFileSync(outputPath, source, 'utf8');
  console.log('[supabase-config] Generated ' + path.basename(outputPath));
}

main();
