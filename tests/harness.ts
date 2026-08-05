/** Dependency-free assertions with a tally, so tests read as a checklist. */

let passed = 0;
let failed = 0;
const failures: string[] = [];
let group = '';

export function describe(name: string, fn: () => void): void {
  group = name;
  fn();
  group = '';
}

export function check(label: string, condition: boolean, detail?: string): void {
  const full = group ? `${group} › ${label}` : label;
  if (condition) {
    passed++;
  } else {
    failed++;
    failures.push(`${full}${detail ? `\n      ${detail}` : ''}`);
  }
}

export function near(label: string, actual: number, expected: number, tolerance: number): void {
  const ok = Number.isFinite(actual) && Math.abs(actual - expected) <= tolerance;
  check(label, ok, ok ? undefined : `expected ${expected} ±${tolerance}, got ${actual}`);
}

export function range(label: string, actual: number, min: number, max: number): void {
  const ok = Number.isFinite(actual) && actual >= min && actual <= max;
  check(label, ok, ok ? undefined : `expected within [${min}, ${max}], got ${actual}`);
}

export function report(suite: string): void {
  const total = passed + failed;
  if (failed === 0) {
    console.log(`\x1b[32m✓\x1b[0m ${suite}: ${passed}/${total} checks passed`);
  } else {
    console.log(`\x1b[31m✗\x1b[0m ${suite}: ${failed} of ${total} checks FAILED`);
    for (const f of failures) console.log(`  \x1b[31m•\x1b[0m ${f}`);
    process.exitCode = 1;
  }
}
