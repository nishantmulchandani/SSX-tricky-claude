/**
 * OWNER: agent "props".
 *
 *   createProps(scene, { mountain, sky }) -> { update(dt, body, camera), nearestRail(pos, maxDist) }
 *
 * Everything that is not snow and not sky. Five subsystems, all streamed, all
 * instanced or merged, all seeded from mulberry32 so the mountain is identical
 * on every boot:
 *
 *   propTrees       the conifer forest, three LOD tiers, three draw calls
 *   propRocks       boulders and outcrops on the steep ground
 *   propRails       rails, boxes and handrails, plus the grind query the
 *                   trick system consumes
 *   propCourse      what makes it a race course: start gate, marker flags,
 *                   B-net, banners, distance boards, finish arch
 *   propStructures  chairlift, lodge, patrol hut, snow cannons
 *
 * The last three all emit into the shared `Dressing` bucket system, which
 * merges a 400 m slice of course furniture down to one mesh per material.
 */

import * as THREE from 'three';
import { Dressing } from './propCommon.js';
import { makeMatte, makeMetal, makeFabric, makeRock, propTime, propWind, useAerial } from '../shaders/propShaders.js';
import { createForest } from './propTrees.js';
import { createRocks } from './propRocks.js';
import { createRails } from './propRails.js';
import { emitCourse } from './propCourse.js';
import { createStructures } from './propStructures.js';

export function createProps(scene, { mountain, sky } = {}) {
  // Must happen before any material is constructed: it decides whether the
  // aerial-perspective chunk is spliced into their shaders.
  useAerial(sky && sky.fogParams);

  const materials = {
    matte: makeMatte({ snow: 0.42 }),
    metal: makeMetal({ snow: 0.20 }),
    fabric: makeFabric({ wave: 0.55 }),
  };
  const rockMaterial = makeRock();

  const dressing = new Dressing(scene, materials, { bucketSize: 400, range: 1150, castRange: 240 });

  const forest = createForest(scene);
  const rocks = createRocks(scene, rockMaterial);
  const rails = createRails();
  const structures = createStructures(scene, materials);

  dressing.addEmitter(rails.emit);
  dressing.addEmitter(emitCourse);
  dressing.addEmitter(structures.emit);

  let elapsed = 0;

  function update(dt, body, camera) {
    if (!camera) return;
    elapsed += dt;
    propTime.value = elapsed;
    // A gusting wind, so banners and trees are never in lockstep.
    propWind.value = 0.72 + 0.34 * Math.sin(elapsed * 0.21) + 0.16 * Math.sin(elapsed * 0.83);

    forest.update(dt, camera);
    rocks.update(dt, camera);
    dressing.update(camera.position.z, 1);
    structures.update(dt, camera);
  }

  return {
    update,
    /** The interface src/tricks/rails.js probes for. */
    nearestRail: rails.nearestRail,
    rails: rails.list,

    // debug handles for tools/probe.mjs and the console
    forest, rocks, dressing, structures, materials,
    stats() {
      return {
        trees: forest.stats(),
        rocks: rocks.stats(),
        rails: rails.list.length,
        buckets: dressing.buckets.size,
      };
    },
    dispose() {
      scene.remove(forest.group);
      scene.remove(rocks.group);
      scene.remove(dressing.group);
      for (const m of Object.values(materials)) m.dispose();
      rockMaterial.dispose();
    },
  };
}

export { THREE as _three };
