export interface CliOptions {
  /** `--only <id>`: restrict the run to one destination. */
  readonly only: string | null;
  /** Boolean flags such as `--latest` or `--refresh`. */
  readonly flags: ReadonlySet<string>;
}

/** Minimal argument parser shared by the data scripts (no dependency needed for two options). */
export function parseCliArgs(argv: readonly string[], allowedFlags: readonly string[]): CliOptions {
  let only: string | null = null;
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--only') {
      const value = argv[i + 1];
      if (value === undefined || value.startsWith('--')) {
        throw new Error('--only requires a destination id');
      }
      only = value;
      i++;
    } else if (arg !== undefined && allowedFlags.includes(arg)) {
      flags.add(arg);
    } else {
      const usage = ['--only <id>', ...allowedFlags].join(' | ');
      throw new Error(`Unknown argument "${arg ?? ''}". Allowed: ${usage}`);
    }
  }
  return { only, flags };
}
