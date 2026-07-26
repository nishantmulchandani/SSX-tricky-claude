/**
 * OWNER: agent "character".
 *
 * Rider material library. Everything is MeshPhysicalMaterial so we can use
 * sheen (fabric), clearcoat (helmet, board topsheet) and iridescence (goggle
 * lens). They all pick up `scene.environment` from the atmosphere module —
 * `envMapIntensity` is the main dial per material.
 */
import * as THREE from 'three';
import {
  fabricNormal, canvasNormal, fabricRough, shellNormal, rubberNormal,
  jacketMap, pantsMap, boardBaseMap, boardTopMap, baseRough,
} from './procTex.js';

const V2 = (x, y) => new THREE.Vector2(x, y);

export function createMaterials(palette = {}) {
  const p = {
    jacket: '#d8402f',
    jacketDark: '#7c1a18',
    accent: '#f2f0ea',
    pants: '#2b2f3a',
    helmet: '#12151c',
    lens: '#2b3f6b',
    glove: '#191c24',
    boot: '#23262e',
    skin: '#c99a76',
    ...palette,
  };

  const jacket = new THREE.MeshPhysicalMaterial({
    map: jacketMap({ base: p.jacket, dark: p.jacketDark, accent: p.accent }),
    normalMap: fabricNormal(),
    normalScale: V2(0.85, 0.85),
    roughnessMap: fabricRough(),
    roughness: 1.0,
    metalness: 0.0,
    sheen: 0.65,
    sheenRoughness: 0.55,
    sheenColor: new THREE.Color('#ffd9c8'),
    envMapIntensity: 0.85,
  });
  jacket.map.repeat.set(1, 1);
  jacket.normalMap = fabricNormal();

  const pants = new THREE.MeshPhysicalMaterial({
    map: pantsMap({ base: p.pants }),
    normalMap: canvasNormal(),
    normalScale: V2(0.9, 0.9),
    roughnessMap: fabricRough(),
    roughness: 1.0,
    metalness: 0.0,
    sheen: 0.35,
    sheenRoughness: 0.7,
    sheenColor: new THREE.Color('#b9c6e0'),
    envMapIntensity: 0.7,
  });

  const skin = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(p.skin),
    roughness: 0.62,
    metalness: 0.0,
    sheen: 0.25,
    sheenRoughness: 0.4,
    sheenColor: new THREE.Color('#ff9d7a'),
    envMapIntensity: 0.6,
  });

  const gaiter = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#1a1d24'),
    normalMap: canvasNormal(),
    normalScale: V2(1.2, 1.2),
    roughness: 0.95,
    sheen: 0.5,
    sheenColor: new THREE.Color('#8fa0c0'),
    envMapIntensity: 0.5,
  });

  const helmet = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(p.helmet),
    normalMap: shellNormal(),
    normalScale: V2(0.35, 0.35),
    roughness: 0.24,
    metalness: 0.1,
    clearcoat: 1.0,
    clearcoatRoughness: 0.08,
    envMapIntensity: 1.5,
  });

  const lens = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(p.lens),
    roughness: 0.05,
    metalness: 1.0,
    iridescence: 1.0,
    iridescenceIOR: 1.9,
    iridescenceThicknessRange: [120, 620],
    envMapIntensity: 2.6,
  });

  const rubber = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#14161b'),
    normalMap: rubberNormal(),
    normalScale: V2(0.7, 0.7),
    roughness: 0.82,
    metalness: 0.0,
    envMapIntensity: 0.5,
  });

  const glove = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(p.glove),
    normalMap: canvasNormal(),
    normalScale: V2(1.0, 1.0),
    roughness: 0.72,
    sheen: 0.4,
    sheenColor: new THREE.Color('#9fb2d0'),
    envMapIntensity: 0.7,
  });

  const boot = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color(p.boot),
    normalMap: canvasNormal(),
    normalScale: V2(1.1, 1.1),
    roughness: 0.55,
    metalness: 0.05,
    clearcoat: 0.4,
    clearcoatRoughness: 0.4,
    envMapIntensity: 0.9,
  });

  const metal = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#c9ced8'),
    roughness: 0.22,
    metalness: 1.0,
    envMapIntensity: 1.8,
  });

  const plastic = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#20242d'),
    roughness: 0.35,
    metalness: 0.0,
    clearcoat: 0.7,
    clearcoatRoughness: 0.25,
    envMapIntensity: 1.0,
  });

  const accent = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#ff5a1f'),
    roughness: 0.45,
    metalness: 0.0,
    clearcoat: 0.5,
    envMapIntensity: 1.0,
  });

  const boardBase = new THREE.MeshPhysicalMaterial({
    map: boardBaseMap(),
    roughnessMap: baseRough(),
    roughness: 1.0,
    metalness: 0.15,
    clearcoat: 0.85,
    clearcoatRoughness: 0.12,
    envMapIntensity: 1.4,
  });

  const boardTop = new THREE.MeshPhysicalMaterial({
    map: boardTopMap(),
    normalMap: shellNormal(),
    normalScale: V2(0.25, 0.25),
    roughness: 0.28,
    metalness: 0.1,
    clearcoat: 1.0,
    clearcoatRoughness: 0.10,
    envMapIntensity: 1.6,
  });

  const strap = new THREE.MeshPhysicalMaterial({
    color: new THREE.Color('#2a2f3a'),
    normalMap: rubberNormal(),
    normalScale: V2(0.8, 0.8),
    roughness: 0.7,
    envMapIntensity: 0.6,
  });

  return {
    jacket, pants, skin, gaiter, helmet, lens, rubber, glove, boot,
    metal, plastic, accent, boardBase, boardTop, strap,
    all: [jacket, pants, skin, gaiter, helmet, lens, rubber, glove, boot,
      metal, plastic, accent, boardBase, boardTop, strap],
  };
}
