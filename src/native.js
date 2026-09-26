const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const EARLY_EXIT_MS = 2000;
const READY_TIMEOUT_MS = 15000;
const READY_LINE = 'ready';
const POWER_REQUEST_REASON = 'agentic-insomnia: coding agent session active';
const POWER_REQUEST_SYSTEM_REQUIRED = 1;

const commandOnPath = name =>
  (process.env.PATH || '')
    .split(path.delimiter)
    .filter(Boolean)
    .some(dir => {
      try {
        fs.accessSync(path.join(dir, name), fs.constants.X_OK);
        return true;
      } catch {
        return false;
      }
    });

const windowsPowerShellPath = () =>
  path.win32.join(
    process.env.SystemRoot || 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );

let deps = {
  spawn,
  platform: process.platform,
  commandExists: commandOnPath,
  isSystemdBooted: () => fs.existsSync('/run/systemd/system'),
  fileExists: fs.existsSync,
  now: Date.now
};

const setDependencies = overrides => {
  deps = { ...deps, ...overrides };
};

const psString = value => `'${value}'`;

// Declared through reflection rather than Add-Type, which starts the C# compiler.
// The script has no double quotes so it survives Windows command-line quoting.
const windowsPowerRequestScript = () => {
  const marshal = '[Runtime.InteropServices.Marshal]';
  const pinvoke = (name, returnType, parameterTypes) =>
    `$type.DefinePInvokeMethod(${psString(name)}, ${psString('kernel32.dll')}, ` +
    `[Reflection.MethodAttributes]${psString('Public, Static')}, ` +
    '[Reflection.CallingConventions]::Standard, ' +
    `${returnType}, [Type[]]@(${parameterTypes}), ` +
    '[Runtime.InteropServices.CallingConvention]::Winapi, ' +
    '[Runtime.InteropServices.CharSet]::Unicode)';

  return [
    `$ErrorActionPreference = ${psString('Stop')}`,
    '$assembly = [AppDomain]::CurrentDomain.DefineDynamicAssembly(' +
      `(New-Object Reflection.AssemblyName ${psString('AgenticInsomnia')}), ` +
      '[Reflection.Emit.AssemblyBuilderAccess]::Run)',
    `$type = $assembly.DefineDynamicModule(${psString('AgenticInsomnia')})` +
      `.DefineType(${psString('Power')}, [Reflection.TypeAttributes]${psString('Public, Class')})`,
    `$create = ${pinvoke('PowerCreateRequest', '[IntPtr]', '[IntPtr]')}`,
    '$create.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)',
    `$set = ${pinvoke('PowerSetRequest', '[bool]', '[IntPtr], [int]')}`,
    '$set.SetImplementationFlags([Reflection.MethodImplAttributes]::PreserveSig)',
    '$power = $type.CreateType()',
    // REASON_CONTEXT: Version (0), Flags (POWER_REQUEST_CONTEXT_SIMPLE_STRING), string pointer.
    `$context = ${marshal}::AllocHGlobal(32)`,
    `${marshal}::WriteInt32($context, 0, 0)`,
    `${marshal}::WriteInt32($context, 4, 1)`,
    `${marshal}::WriteIntPtr($context, 8, ${marshal}::StringToHGlobalUni(${psString(POWER_REQUEST_REASON)}))`,
    '$handle = $power::PowerCreateRequest($context)',
    `if ($handle.ToInt64() -le 0) { throw ${psString('PowerCreateRequest failed')} }`,
    `if (-not $power::PowerSetRequest($handle, ${POWER_REQUEST_SYSTEM_REQUIRED})) { throw ${psString('PowerSetRequest failed')} }`,
    `[Console]::Out.WriteLine(${psString(READY_LINE)})`,
    '[Console]::Out.Flush()',
    '[void][Console]::In.ReadToEnd()'
  ].join('; ');
};

const resolveNativeCommand = platform => {
  if (platform === 'darwin') {
    return { cmd: 'caffeinate', args: ['-i'], stdio: 'ignore' };
  }

  if (platform === 'linux') {
    // `cat` holds the lock until its stdin pipe closes. The pipe also closes when
    // this process dies, so a crashed server cannot leave the lock behind.
    return {
      cmd: 'systemd-inhibit',
      args: [
        '--what=sleep:idle',
        '--who=agentic-insomnia',
        '--why=coding agent session active',
        '--mode=block',
        'cat'
      ],
      stdio: ['pipe', 'ignore', 'pipe']
    };
  }

  if (platform === 'win32') {
    // Windows does not end children when their parent dies, so the script blocks
    // on stdin for the same crash release as `cat` on Linux.
    return {
      cmd: windowsPowerShellPath(),
      args: ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', windowsPowerRequestScript()],
      stdio: ['pipe', 'pipe', 'pipe'],
      readyLine: READY_LINE
    };
  }

  return null;
};

const isAvailable = () => {
  if (deps.platform === 'darwin') {
    return deps.commandExists('caffeinate');
  }

  if (deps.platform === 'linux') {
    return deps.isSystemdBooted() && deps.commandExists('systemd-inhibit');
  }

  if (deps.platform === 'win32') {
    return deps.fileExists(windowsPowerShellPath());
  }

  return false;
};

const recordFailure = (state, reason) => {
  if (state.nativeFailure) {
    return;
  }

  state.nativeFailure = reason;
  console.error(`Native sleep prevention disabled: ${reason}`);
};

// A tool that fails to start, or exits before it holds the lock, is recorded on
// `state.nativeFailure`, and later calls do nothing, so the poller does not
// respawn a failing process on every tick. A tool with a `readyLine` holds the
// lock once it prints that line. Other tools are trusted after EARLY_EXIT_MS.
const enableCaffeine = state => {
  if (state.isCaffeinated || state.nativeFailure) {
    return;
  }

  const command = resolveNativeCommand(deps.platform);
  if (!command) {
    recordFailure(state, `no native sleep tool for platform ${deps.platform}`);
    return;
  }

  const child = deps.spawn(command.cmd, command.args, {
    stdio: command.stdio,
    windowsHide: true
  });
  const startedAt = deps.now();
  let stderr = '';
  let stdout = '';
  let ready = false;
  let readyTimer = null;

  if (child.stderr) {
    child.stderr.on('data', chunk => {
      stderr += chunk.toString();
    });
  }

  const release = () => {
    if (state.caffeinateProcess !== child) {
      return false;
    }
    state.caffeinateProcess = null;
    state.isCaffeinated = false;
    return true;
  };

  if (command.readyLine) {
    child.stdout.on('data', chunk => {
      stdout += chunk.toString();
      if (!ready && stdout.split(/\r?\n/).includes(command.readyLine)) {
        ready = true;
        clearTimeout(readyTimer);
      }
    });

    readyTimer = setTimeout(() => {
      if (ready || !release()) {
        return;
      }
      recordFailure(state, `${command.cmd} did not report ready within ${READY_TIMEOUT_MS} ms`);
      child.kill();
    }, READY_TIMEOUT_MS);
    if (typeof readyTimer.unref === 'function') {
      readyTimer.unref();
    }
  }

  child.on('error', error => {
    clearTimeout(readyTimer);
    release();
    recordFailure(state, `${command.cmd} failed to start: ${error.message}`);
  });

  child.on('exit', (code, signal) => {
    clearTimeout(readyTimer);
    if (!release()) {
      return;
    }

    const exitedEarly = command.readyLine ? !ready : deps.now() - startedAt < EARLY_EXIT_MS;
    if (exitedEarly) {
      const detail = stderr.trim() ? `: ${stderr.trim()}` : '';
      recordFailure(
        state,
        `${command.cmd} exited early (code ${code}, signal ${signal})${detail}`
      );
    }
  });

  state.caffeinateProcess = child;
  state.isCaffeinated = true;
};

const disableCaffeine = state => {
  if (!state.isCaffeinated || !state.caffeinateProcess) {
    return;
  }

  const child = state.caffeinateProcess;
  state.caffeinateProcess = null;
  state.isCaffeinated = false;
  child.kill();
};

module.exports = {
  enableCaffeine,
  disableCaffeine,
  isAvailable,
  resolveNativeCommand,
  setDependencies,
  windowsPowerShellPath,
  EARLY_EXIT_MS,
  READY_TIMEOUT_MS
};
