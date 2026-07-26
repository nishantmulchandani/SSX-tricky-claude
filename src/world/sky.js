import * as THREE from 'three';
// OWNER: agent "atmosphere". Placeholder until replaced.
export function createSky(scene) {
  scene.background = new THREE.Color(0x88bbee);
  const sun = new THREE.DirectionalLight(0xffffff, 3);
  sun.position.set(-300, 500, 200); sun.castShadow = true;
  scene.add(sun, new THREE.HemisphereLight(0xbfd8ff, 0xeaf4ff, 1.2));
  return { sun, sunDir: sun.position.clone().normalize(), update() {} };
}
