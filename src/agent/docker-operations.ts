import type {
  BashOperations,
  ReadOperations,
  EditOperations,
  WriteOperations,
  GrepOperations,
  FindOperations,
  LsOperations,
} from '@mariozechner/pi-coding-agent';
import { dockerExec } from './docker-exec.js';
import { mapHostPath, type PathMapConfig } from './path-map.js';

/**
 * Configuration for the Docker-backed pi-coding-agent tool operations.
 *
 * `container` is the long-running sandbox container name; `paths` is the
 * host→container mapping that every path argument must pass through before
 * being handed to `docker exec`. The mapping is the only sandbox boundary —
 * never bypass it.
 */
export interface DockerOpsConfig {
  container: string;
  paths: PathMapConfig;
}

/** Single-quote-safe shell quoting. Wrap in `'...'` and escape interior `'`. */
export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Run a one-shot command inside the sandbox, collecting stdout/stderr into a
 * single Buffer. Returns `{ exitCode, output }`. Used by every non-bash
 * adapter — bash forwards streaming directly to its caller.
 */
async function execOnce(
  cfg: DockerOpsConfig,
  containerCwd: string,
  command: string,
  env?: Record<string, string>,
): Promise<{ exitCode: number; output: Buffer }> {
  const chunks: Buffer[] = [];
  const { exitCode } = await dockerExec({
    container: cfg.container,
    cwd: containerCwd,
    command,
    onData: (b) => chunks.push(b),
    env,
  });
  return { exitCode, output: Buffer.concat(chunks) };
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------

export function createDockerBashOperations(
  cfg: DockerOpsConfig,
): BashOperations {
  return {
    exec: async (command, cwd, options) => {
      const containerCwd = mapHostPath(cwd, cfg.paths);
      const env = options.env
        ? Object.fromEntries(
            Object.entries(options.env).filter(
              (entry): entry is [string, string] =>
                typeof entry[1] === 'string',
            ),
          )
        : undefined;
      const result = await dockerExec({
        container: cfg.container,
        cwd: containerCwd,
        command,
        onData: options.onData,
        signal: options.signal,
        timeout: options.timeout,
        env,
      });
      return { exitCode: result.exitCode };
    },
  };
}

// ---------------------------------------------------------------------------
// read
// ---------------------------------------------------------------------------

export function createDockerReadOperations(
  cfg: DockerOpsConfig,
): ReadOperations {
  return {
    readFile: async (absolutePath) => {
      const containerPath = mapHostPath(absolutePath, cfg.paths);
      const { exitCode, output } = await execOnce(
        cfg,
        '/',
        `cat -- ${shellQuote(containerPath)}`,
      );
      if (exitCode !== 0) {
        throw new Error(
          `read failed (exit ${exitCode}) for ${absolutePath}: ${output.toString('utf8')}`,
        );
      }
      return output;
    },
    access: async (absolutePath) => {
      const containerPath = mapHostPath(absolutePath, cfg.paths);
      const { exitCode } = await execOnce(
        cfg,
        '/',
        `test -r ${shellQuote(containerPath)}`,
      );
      if (exitCode !== 0) {
        throw new Error(`access denied: ${absolutePath}`);
      }
    },
    // detectImageMimeType is optional — we omit it; the tool will treat all
    // files as non-image. Image preview support can be added later.
  };
}

// ---------------------------------------------------------------------------
// edit
// ---------------------------------------------------------------------------

export function createDockerEditOperations(
  cfg: DockerOpsConfig,
): EditOperations {
  return {
    readFile: async (absolutePath) => {
      const containerPath = mapHostPath(absolutePath, cfg.paths);
      const { exitCode, output } = await execOnce(
        cfg,
        '/',
        `cat -- ${shellQuote(containerPath)}`,
      );
      if (exitCode !== 0) {
        throw new Error(
          `read failed (exit ${exitCode}) for ${absolutePath}: ${output.toString('utf8')}`,
        );
      }
      return output;
    },
    writeFile: async (absolutePath, content) => {
      const containerPath = mapHostPath(absolutePath, cfg.paths);
      // Pass content via env var to avoid any shell-level interpretation of
      // user-supplied bytes. `printf '%s' "$VAR"` is byte-faithful for text;
      // for binary content the agent should use bash directly.
      const { exitCode, output } = await execOnce(
        cfg,
        '/',
        `printf '%s' "$NANOCLAW_CONTENT" > ${shellQuote(containerPath)}`,
        { NANOCLAW_CONTENT: content },
      );
      if (exitCode !== 0) {
        throw new Error(
          `write failed (exit ${exitCode}) for ${absolutePath}: ${output.toString('utf8')}`,
        );
      }
    },
    access: async (absolutePath) => {
      const containerPath = mapHostPath(absolutePath, cfg.paths);
      const { exitCode } = await execOnce(
        cfg,
        '/',
        `test -r ${shellQuote(containerPath)} && test -w ${shellQuote(containerPath)}`,
      );
      if (exitCode !== 0) {
        throw new Error(`access denied: ${absolutePath}`);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// write
// ---------------------------------------------------------------------------

export function createDockerWriteOperations(
  cfg: DockerOpsConfig,
): WriteOperations {
  return {
    writeFile: async (absolutePath, content) => {
      const containerPath = mapHostPath(absolutePath, cfg.paths);
      const { exitCode, output } = await execOnce(
        cfg,
        '/',
        `printf '%s' "$NANOCLAW_CONTENT" > ${shellQuote(containerPath)}`,
        { NANOCLAW_CONTENT: content },
      );
      if (exitCode !== 0) {
        throw new Error(
          `write failed (exit ${exitCode}) for ${absolutePath}: ${output.toString('utf8')}`,
        );
      }
    },
    mkdir: async (dir) => {
      const containerPath = mapHostPath(dir, cfg.paths);
      const { exitCode, output } = await execOnce(
        cfg,
        '/',
        `mkdir -p -- ${shellQuote(containerPath)}`,
      );
      if (exitCode !== 0) {
        throw new Error(
          `mkdir failed (exit ${exitCode}) for ${dir}: ${output.toString('utf8')}`,
        );
      }
    },
  };
}

// ---------------------------------------------------------------------------
// grep
// ---------------------------------------------------------------------------

export function createDockerGrepOperations(
  cfg: DockerOpsConfig,
): GrepOperations {
  return {
    isDirectory: async (absolutePath) => {
      const containerPath = mapHostPath(absolutePath, cfg.paths);
      const { exitCode } = await execOnce(
        cfg,
        '/',
        `test -e ${shellQuote(containerPath)} || exit 2; test -d ${shellQuote(containerPath)}`,
      );
      if (exitCode === 2) {
        throw new Error(`path does not exist: ${absolutePath}`);
      }
      return exitCode === 0;
    },
    readFile: async (absolutePath) => {
      const containerPath = mapHostPath(absolutePath, cfg.paths);
      const { exitCode, output } = await execOnce(
        cfg,
        '/',
        `cat -- ${shellQuote(containerPath)}`,
      );
      if (exitCode !== 0) {
        throw new Error(
          `read failed (exit ${exitCode}) for ${absolutePath}: ${output.toString('utf8')}`,
        );
      }
      return output.toString('utf8');
    },
  };
}

// ---------------------------------------------------------------------------
// find
// ---------------------------------------------------------------------------

export function createDockerFindOperations(
  cfg: DockerOpsConfig,
): FindOperations {
  return {
    exists: async (absolutePath) => {
      const containerPath = mapHostPath(absolutePath, cfg.paths);
      const { exitCode } = await execOnce(
        cfg,
        '/',
        `test -e ${shellQuote(containerPath)}`,
      );
      return exitCode === 0;
    },
    glob: async (pattern, cwd, options) => {
      const containerCwd = mapHostPath(cwd, cfg.paths);
      // Use bash globstar to expand `**` patterns. Pass pattern + ignores via
      // env vars so neither can shell-inject. Walk the matches in shell, drop
      // anything matching an ignore glob (via bash `[[ == ]]`), and stop at
      // the limit.
      const ignoreGlobs = options.ignore ?? [];
      const env: Record<string, string> = {
        NANOCLAW_PATTERN: pattern,
        NANOCLAW_LIMIT: String(options.limit),
        NANOCLAW_IGNORE_COUNT: String(ignoreGlobs.length),
      };
      ignoreGlobs.forEach((g, i) => {
        env[`NANOCLAW_IGNORE_${i}`] = g;
      });
      // The script enables nullglob+globstar+dotglob, expands the pattern,
      // then for each match checks each NANOCLAW_IGNORE_<i> via bash pattern
      // matching. Outputs one path per line.
      const script = [
        'shopt -s globstar nullglob dotglob',
        'count=0',
        'for f in $NANOCLAW_PATTERN; do',
        '  skip=0',
        '  i=0',
        '  while [ "$i" -lt "$NANOCLAW_IGNORE_COUNT" ]; do',
        '    var="NANOCLAW_IGNORE_$i"',
        '    pat="${!var}"',
        '    if [[ "$f" == $pat ]]; then skip=1; break; fi',
        '    i=$((i+1))',
        '  done',
        '  if [ "$skip" -eq 0 ]; then',
        '    printf "%s\\n" "$f"',
        '    count=$((count+1))',
        '    if [ "$count" -ge "$NANOCLAW_LIMIT" ]; then break; fi',
        '  fi',
        'done',
      ].join('\n');
      const { exitCode, output } = await execOnce(
        cfg,
        containerCwd,
        `bash -c ${shellQuote(script)}`,
        env,
      );
      if (exitCode !== 0) {
        throw new Error(
          `glob failed (exit ${exitCode}) for ${pattern} in ${cwd}: ${output.toString('utf8')}`,
        );
      }
      const text = output.toString('utf8');
      if (text.length === 0) return [];
      return text.split('\n').filter((l) => l.length > 0);
    },
  };
}

// ---------------------------------------------------------------------------
// ls
// ---------------------------------------------------------------------------

export function createDockerLsOperations(cfg: DockerOpsConfig): LsOperations {
  return {
    exists: async (absolutePath) => {
      const containerPath = mapHostPath(absolutePath, cfg.paths);
      const { exitCode } = await execOnce(
        cfg,
        '/',
        `test -e ${shellQuote(containerPath)}`,
      );
      return exitCode === 0;
    },
    stat: async (absolutePath) => {
      const containerPath = mapHostPath(absolutePath, cfg.paths);
      const { exitCode: existsCode } = await execOnce(
        cfg,
        '/',
        `test -e ${shellQuote(containerPath)}`,
      );
      if (existsCode !== 0) {
        throw new Error(`stat failed: ${absolutePath} does not exist`);
      }
      const { exitCode: dirCode } = await execOnce(
        cfg,
        '/',
        `test -d ${shellQuote(containerPath)}`,
      );
      const isDir = dirCode === 0;
      return { isDirectory: () => isDir };
    },
    readdir: async (absolutePath) => {
      const containerPath = mapHostPath(absolutePath, cfg.paths);
      // `ls -1A` lists one entry per line, including dotfiles, excluding . and ..
      const { exitCode, output } = await execOnce(
        cfg,
        '/',
        `ls -1A -- ${shellQuote(containerPath)}`,
      );
      if (exitCode !== 0) {
        throw new Error(
          `readdir failed (exit ${exitCode}) for ${absolutePath}: ${output.toString('utf8')}`,
        );
      }
      const text = output.toString('utf8');
      if (text.length === 0) return [];
      return text.split('\n').filter((l) => l.length > 0);
    },
  };
}

// ---------------------------------------------------------------------------
// bundle
// ---------------------------------------------------------------------------

export interface DockerOperationsBundle {
  bash: BashOperations;
  read: ReadOperations;
  edit: EditOperations;
  write: WriteOperations;
  grep: GrepOperations;
  find: FindOperations;
  ls: LsOperations;
}

export function createDockerOperations(
  cfg: DockerOpsConfig,
): DockerOperationsBundle {
  return {
    bash: createDockerBashOperations(cfg),
    read: createDockerReadOperations(cfg),
    edit: createDockerEditOperations(cfg),
    write: createDockerWriteOperations(cfg),
    grep: createDockerGrepOperations(cfg),
    find: createDockerFindOperations(cfg),
    ls: createDockerLsOperations(cfg),
  };
}
