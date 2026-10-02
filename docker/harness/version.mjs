// Minimal version comparison for the one minimum the manager enforces
// (OpenCode). Harness versions are otherwise opaque strings that are recorded
// verbatim, never re-derived.

/** Compare two dotted numeric versions: -1, 0, or 1. */
export function compareVersions(a, b) {
  const left = split(a);
  const right = split(b);
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const one = left[index];
    const two = right[index];
    if (one === undefined) return -1;
    if (two === undefined) return 1;
    const numeric = /^\d+$/.test(one) && /^\d+$/.test(two);
    if (numeric) {
      const diff = Number(one) - Number(two);
      if (diff !== 0) return diff < 0 ? -1 : 1;
    } else if (one !== two) {
      return one < two ? -1 : 1;
    }
  }
  return 0;
}

/** Whether `version` is at least `minimum`. Null minimum means no constraint. */
export function meetsMinimum(version, minimum) {
  if (!minimum) return true;
  if (!version) return null;
  return compareVersions(version, minimum) >= 0;
}

function split(value) {
  return String(value ?? "")
    .trim()
    .replace(/^v/i, "")
    .split(/[.+-]/)
    .filter((part) => part !== "");
}
