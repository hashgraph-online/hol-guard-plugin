import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const sourceCheckout = typeof process.env.DSH_SOURCE === 'string' && process.env.DSH_SOURCE.trim()
  ? path.resolve(process.env.DSH_SOURCE.trim())
  : null;
const sourceDshEntry = sourceCheckout === null
  ? null
  : path.join(sourceCheckout, 'apps', 'cli', 'lib', 'bin.js');
const dshCommand = sourceDshEntry === null
  ? path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'dsh.cmd' : 'dsh')
  : process.execPath;
const dshPrefixArgs = sourceDshEntry === null ? [] : [sourceDshEntry];
if (sourceDshEntry === null) await access(dshCommand);
else await access(sourceDshEntry);

async function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd ?? root,
      env: options.env ?? process.env,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code: code ?? 1, signal, stdout, stderr }));
  });
}

function runDsh(args, options = {}) {
  return run(dshCommand, [...dshPrefixArgs, ...args], options);
}

function writeSse(response, payload) {
  response.write(`data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`);
}

function usage(promptTokens, completionTokens) {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0 },
    prompt_cache_hit_tokens: 0,
    prompt_cache_miss_tokens: promptTokens,
  };
}

function writeAssistantStart(response) {
  writeSse(response, {
    choices: [{
      delta: {
        content: null,
        reasoning_content: '',
        role: 'assistant',
      },
    }],
  });
}

function writeToolCallResponse(response, command) {
  const toolArguments = JSON.stringify({
    command,
    description: 'Write the DSH integration sentinel',
  });
  writeAssistantStart(response);
  writeSse(response, {
    choices: [{
      delta: {
        content: null,
        reasoning_content: null,
        tool_calls: [{
          function: {
            arguments: toolArguments,
            name: 'bash',
          },
          id: 'hol-guard-dsh-e2e-call',
          type: 'function',
          index: 0,
        }],
      },
    }],
  });
  writeSse(response, {
    choices: [{
      delta: {
        content: '',
        reasoning_content: null,
      },
      finish_reason: 'tool_calls',
    }],
    usage: usage(3, 2),
  });
}

function writeTextResponse(response) {
  writeAssistantStart(response);
  writeSse(response, {
    choices: [{
      delta: {
        content: 'DSH integration scenario completed.',
        reasoning_content: null,
      },
    }],
  });
  writeSse(response, {
    choices: [{
      delta: { content: '' },
      finish_reason: 'stop',
    }],
    usage: usage(3, 4),
  });
}

function summarizeProviderRequests(requests) {
  return requests.map((request, index) => {
    const messages = Array.isArray(request?.messages) ? request.messages : [];
    const lastMessage = messages.length > 0 ? messages[messages.length - 1] : null;
    return {
      index: index + 1,
      model: typeof request?.model === 'string' ? request.model : null,
      messageCount: messages.length,
      lastMessageRole: typeof lastMessage?.role === 'string' ? lastMessage.role : null,
      offeredToolCount: Array.isArray(request?.tools) ? request.tools.length : 0,
      streaming: request?.stream === true,
    };
  });
}

async function startMockProvider({ command }) {
  const requests = [];
  const errors = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.method, 'POST');
      assert.ok(request.url === '/chat/completions' || request.url === '/v1/chat/completions');
      assert.equal(request.headers.authorization, 'Bearer mock-key');
      let raw = '';
      request.setEncoding('utf8');
      for await (const chunk of request) raw += chunk;
      const body = JSON.parse(raw);
      requests.push(body);

      response.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      if (requests.length === 1) writeToolCallResponse(response, command);
      else writeTextResponse(response);
      writeSse(response, '[DONE]');
      response.end();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: 'mock inference provider failure' } }));
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    requests,
    errors,
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function createFakeGuard(tempDir, logPath) {
  const binDir = path.join(tempDir, 'guard-bin');
  await mkdir(binDir, { recursive: true });
  const script = path.join(binDir, 'hol-guard');
  await writeFile(script, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
let input = '';
process.stdin.setEncoding('utf8');
for await (const chunk of process.stdin) input += chunk;
const args = process.argv.slice(2);
if (!args.includes('guard') || !args.includes('hook') || !args.includes('dsh')) process.exit(64);
const payload = JSON.parse(input);
appendFileSync(${JSON.stringify(logPath)}, JSON.stringify(payload) + '\\n');
console.log(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: 'deny',
    permissionDecisionReason: 'HOL Guard DSH end-to-end policy denial',
  },
}));
process.exitCode = 2;
`, 'utf8');
  await chmod(script, 0o755);
  return { binDir, script };
}

async function runScenario({ protectedByGuard }) {
  const scenario = protectedByGuard ? 'protected' : 'control';
  const prefix = protectedByGuard ? '.dsh-guard-' : '.dsh-control-';
  const tempDir = await mkdtemp(path.join(os.homedir(), prefix));
  const dshHome = path.join(tempDir, '.dsh');
  const dshConfigDir = path.join(tempDir, 'config');
  const workspace = path.join(tempDir, 'workspace');
  const sentinel = path.join(workspace, 'sentinel.txt');
  const guardLog = path.join(tempDir, 'guard.jsonl');
  await mkdir(workspace, { recursive: true });
  const command = 'printf executed > sentinel.txt';
  const provider = await startMockProvider({ command });
  const {
    HOL_GUARD_COMMAND: _guardCommand,
    HOL_GUARD_DSH_TIMEOUT_MS: _guardTimeout,
    HOL_GUARD_HOME: _guardHome,
    DSH_HOME: _dshHome,
    DSH_CONFIG_DIR: _dshConfigDir,
    DSH_PERMISSION_MODE: _dshPermissionMode,
    ...baseEnv
  } = process.env;
  const env = {
    ...baseEnv,
    DSH_HOME: dshHome,
    DSH_CONFIG_DIR: dshConfigDir,
    // This test isolates the HOL Guard pre-tool boundary. DSH's documented
    // danger-full-access mode bypasses only its own file sandbox so the
    // unprotected control must execute; the protected case must still be
    // stopped by HOL Guard before the bash side effect.
    DSH_PERMISSION_MODE: 'danger-full-access',
    DEEPSEEK_BASE_URL: provider.baseUrl,
    DEEPSEEK_API_KEY: 'mock-key',
    NO_COLOR: '1',
  };

  try {
    if (protectedByGuard) {
      const fakeGuard = await createFakeGuard(tempDir, guardLog);
      env.PATH = `${fakeGuard.binDir}${path.delimiter}${baseEnv.PATH ?? ''}`;
      const install = await runDsh(['plugin', '--profile', 'headless', 'add', root], { env, cwd: workspace });
      assert.equal(install.code, 0, `DSH plugin install failed:\n${install.stdout}\n${install.stderr}`);
      const dumped = await runDsh(['--profile', 'headless', '--dump-config'], { env, cwd: workspace });
      assert.equal(dumped.code, 0, `DSH config dump failed:\n${dumped.stdout}\n${dumped.stderr}`);
      assert.match(`${dumped.stdout}\n${dumped.stderr}`, /hol-guard/);
    }

    const result = await runDsh(['--profile', 'headless', 'Write the integration sentinel with bash.'], {
      env,
      cwd: workspace,
    });
    const combined = `${result.stdout}\n${result.stderr}`;
    assert.deepEqual(provider.errors, [], `Mock provider failed during ${scenario} scenario:\n${provider.errors.join('\n')}`);
    assert.ok(
      result.code === 0 || /HOL Guard DSH end-to-end policy denial/.test(combined),
      `DSH ${scenario} run failed before policy enforcement:\n${combined}`,
    );
    assert.ok(
      provider.requests.length >= 1,
      `DSH ${scenario} run never reached the mock inference endpoint:\n${combined}`,
    );

    let sentinelExists = true;
    try {
      await access(sentinel);
    } catch {
      sentinelExists = false;
    }
    if (protectedByGuard) {
      assert.equal(sentinelExists, false, 'DSH executed a command that HOL Guard denied');
      const records = (await readFile(guardLog, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
      assert.ok(records.length >= 1, 'HOL Guard did not receive a DSH tool event');
      assert.equal(records[0].hook_event_name, 'PreToolUse');
      assert.equal(records[0].tool_name, 'bash');
      assert.equal(records[0].tool_input.command, command);
    } else {
      assert.equal(
        sentinelExists,
        true,
        `Unprotected DSH control did not execute its bash tool:\n${combined}\nProvider flow:\n${JSON.stringify(summarizeProviderRequests(provider.requests), null, 2)}`,
      );
    }
  } finally {
    await provider.close();
    await rm(tempDir, { recursive: true, force: true });
  }
}

await runScenario({ protectedByGuard: false });
await runScenario({ protectedByGuard: true });
console.log('DSH real-runtime end-to-end test passed.');
