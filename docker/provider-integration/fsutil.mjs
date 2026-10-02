// Filesystem seams for the provider integration.
//
// The module's only real side effect is writing T3's settings file and its own
// small state file. Both go through this object so the unit tests can drive the
// merge/clear logic without a container or the host filesystem.
import { promises as fsp } from "node:fs";

export function createFs() {
  return {
    readFile: (file, encoding = "utf8") => fsp.readFile(file, encoding),
    writeFile: (file, data, options) => fsp.writeFile(file, data, options),
    mkdir: (dir, options) => fsp.mkdir(dir, options),
    rename: (from, to) => fsp.rename(from, to),
    stat: (file) => fsp.stat(file),
    async exists(file) {
      try {
        await fsp.stat(file);
        return true;
      } catch {
        return false;
      }
    },
  };
}
