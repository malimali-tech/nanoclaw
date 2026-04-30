/**
 * Setup CLI entry point.
 *
 * Most setup checks (environment / timezone / verify / mount allowlist write)
 * are now driven directly by the Claude Code `/setup` skill via Read/Bash —
 * see `.claude/skills/setup/SKILL.md`. The two steps that remain here have
 * real complexity worth scripting:
 *
 *   --step service   Generate launchd plist or systemd unit, install + load
 *   --step register  Insert a registered group + folder scaffolding
 *
 * Usage: npx tsx setup/index.ts --step <name> [args...]
 */
import { logger } from '../src/logger.js';
import { emitStatus } from './status.js';

const STEPS: Record<
  string,
  () => Promise<{ run: (args: string[]) => Promise<void> }>
> = {
  register: () => import('./register.js'),
  service: () => import('./service.js'),
};

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const stepIdx = args.indexOf('--step');

  if (stepIdx === -1 || !args[stepIdx + 1]) {
    console.error(
      `Usage: npx tsx setup/index.ts --step <${Object.keys(STEPS).join('|')}> [args...]`,
    );
    process.exit(1);
  }

  const stepName = args[stepIdx + 1];
  const stepArgs = args.filter(
    (a, i) => i !== stepIdx && i !== stepIdx + 1 && a !== '--',
  );

  const loader = STEPS[stepName];
  if (!loader) {
    console.error(`Unknown step: ${stepName}`);
    console.error(`Available steps: ${Object.keys(STEPS).join(', ')}`);
    process.exit(1);
  }

  try {
    const mod = await loader();
    await mod.run(stepArgs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error({ err, step: stepName }, 'Setup step failed');
    emitStatus(stepName.toUpperCase(), {
      STATUS: 'failed',
      ERROR: message,
    });
    process.exit(1);
  }
}

main();
