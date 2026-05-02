// src/agent/container-mounts.ts
//
// Thin compatibility shim over `mount-policy.ts`. Kept so external
// imports of CONTAINER_PATHS / safeContainerName / buildVolumeMounts
// continue to resolve while consumers migrate. New code should import
// from `./mount-policy.js` directly.

import {
  CONTAINER_PATHS,
  computeMountPolicy,
  ensureLarkCliStateDir,
  larkCliStateDir,
  safeContainerName,
  type VolumeMount,
} from './mount-policy.js';

export {
  CONTAINER_PATHS,
  ensureLarkCliStateDir,
  larkCliStateDir,
  safeContainerName,
};
export type { VolumeMount };

/**
 * Compute the bind mount set for a given chat. Equivalent to
 * `computeMountPolicy(groupFolder, isMain).volumeMounts()`.
 */
export function buildVolumeMounts(
  groupFolder: string,
  isMain: boolean,
): VolumeMount[] {
  return [...computeMountPolicy(groupFolder, isMain).volumeMounts()];
}
