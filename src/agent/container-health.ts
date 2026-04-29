export type ContainerHealth =
  | { status: 'running' }
  | { status: 'stopped' }
  | { status: 'missing' };

export type ExecFn = (
  argv: string[],
) => Promise<{ stdout: string; code: number }>;

export async function checkContainerHealth(
  name: string,
  exec: ExecFn,
): Promise<ContainerHealth> {
  const { stdout, code } = await exec([
    'docker',
    'inspect',
    '-f',
    '{{.State.Status}}',
    name,
  ]);
  if (code !== 0) return { status: 'missing' };
  if (stdout.trim() === 'running') return { status: 'running' };
  return { status: 'stopped' };
}
