#!/usr/bin/env node

import * as fs from 'node:fs';
import process from 'node:process';

const CONVERSATION_ID = 'a126a126-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const RECOVERED_PLAN = '# recovered plan\n\nExact fixture bytes.\n';
const RECOVERED_GOAL = '{\n  "scalar": null,\n  "gates": []\n}\n';
const INITIAL_DIRECTIVE = {
  goal: 'execute the recovered plan',
  constraints: ['preserve exact artifact bytes'],
  success_criteria: ['run the synthetic gate'],
  max_attempts: 1,
};
const VALUE_FLAGS = new Set([
  '-p',
  '--output-format',
  '--log-file',
  '--mode',
  '--model',
  '--effort',
  '--conversation',
  '--print-timeout',
]);

function fail(message) {
  process.stderr.write(`agy fixture: ${message}\n`);
  process.exit(64);
}

const argv = process.argv.slice(2);
const values = new Map();
for (let index = 0; index < argv.length; index += 2) {
  const flag = argv[index];
  if (!VALUE_FLAGS.has(flag)) fail('received an unsupported argument');
  if (index + 1 >= argv.length) fail(`missing value for ${flag}`);
  if (values.has(flag)) fail(`received duplicate ${flag}`);
  values.set(flag, argv[index + 1]);
}

function required(flag) {
  const value = values.get(flag);
  if (typeof value !== 'string' || value.length === 0) fail(`expected one ${flag}`);
  return value;
}

const prompt = required('-p');
const outputFormat = required('--output-format');
const logFile = required('--log-file');
const mode = required('--mode');
const printTimeout = required('--print-timeout');
const conversation = values.get('--conversation');

if (!prompt.trim()) fail('prompt must not be blank');
if (outputFormat !== 'stream-json') fail('--output-format must be stream-json');
if (mode !== 'plan') fail('--mode must be plan');
if (!/^\d+s$/.test(printTimeout)) fail('--print-timeout must use seconds');
if (values.has('--model') && !values.get('--model').trim()) fail('--model must not be blank');
if (values.has('--effort') && !['low', 'medium', 'high'].includes(values.get('--effort'))) {
  fail('--effort must be low, medium, or high');
}

function writeTurnLog(content) {
  try {
    fs.writeFileSync(logFile, content, 'utf8');
  } catch {
    fail('could not write the requested turn log');
  }
}

function emit(event) {
  process.stdout.write(`${JSON.stringify(event)}\n`);
}

emit({ event: 'init', conversation_id: CONVERSATION_ID });

if (conversation === undefined) {
  writeTurnLog('tool_confirmation_manager.go:188] mode: soft-denying tool confirmation\n');
  emit({
    event: 'result',
    result: {
      conversation_id: CONVERSATION_ID,
      status: 'SUCCESS',
      response: '',
    },
  });
} else {
  if (conversation !== CONVERSATION_ID) fail('--conversation did not preserve the first turn id');
  writeTurnLog('');
  const response = [
    {
      tool: 'spawn_subagents',
      args: { initial_directive: INITIAL_DIRECTIVE },
    },
    { tool: 'write_goal', args: { content: RECOVERED_GOAL } },
    { tool: 'write_plan', args: { content: RECOVERED_PLAN } },
  ]
    .map((control) => `\`\`\`autoloop\n${JSON.stringify(control)}\n\`\`\``)
    .join('\n');
  emit({
    event: 'result',
    result: {
      conversation_id: CONVERSATION_ID,
      status: 'SUCCESS',
      response,
      usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 0 },
    },
  });
}
