import { spawn } from 'node:child_process';

export interface DockerExecArgs {
  container: string;
  cwd: string;
  command: string;
  onData: (buf: Buffer) => void;
  signal?: AbortSignal;
  timeout?: number;
  env?: Record<string, string>;
}

export async function dockerExec(
  args: DockerExecArgs,
): Promise<{ exitCode: number }> {
  const { container, cwd, command, onData, signal, timeout, env } = args;

  const argv: string[] = ['exec', '--workdir', cwd];
  if (env) {
    for (const [k, v] of Object.entries(env)) {
      argv.push('-e', `${k}=${v}`);
    }
  }
  argv.push(container, '/bin/sh', '-c', command);

  const child = spawn('docker', argv, { stdio: ['ignore', 'pipe', 'pipe'] });

  let aborted = false;
  let timedOut = false;
  let timeoutHandle: NodeJS.Timeout | undefined;

  const onAbort = () => {
    aborted = true;
    child.kill('SIGKILL');
  };

  if (signal) {
    if (signal.aborted) {
      onAbort();
    } else {
      signal.addEventListener('abort', onAbort, { once: true });
    }
  }

  if (timeout && timeout > 0) {
    timeoutHandle = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, timeout * 1000);
  }

  child.stdout?.on('data', (chunk: Buffer) => onData(chunk));
  child.stderr?.on('data', (chunk: Buffer) => onData(chunk));

  return new Promise<{ exitCode: number }>((resolve, reject) => {
    const cleanup = () => {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
        timeoutHandle = undefined;
      }
      if (signal) {
        signal.removeEventListener('abort', onAbort);
      }
    };

    child.on('error', (err) => {
      cleanup();
      reject(err);
    });

    child.on('close', (code) => {
      cleanup();
      if (aborted) {
        reject(new Error('aborted'));
        return;
      }
      if (timedOut) {
        reject(new Error('timeout:' + timeout));
        return;
      }
      resolve({ exitCode: code ?? -1 });
    });
  });
}
