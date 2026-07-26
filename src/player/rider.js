import * as THREE from 'three';
// OWNER: agent "character". Placeholder capsule + board.
export class Rider {
  constructor() {
    this.group = new THREE.Group();
    const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.32, 0.9, 6, 12),
      new THREE.MeshStandardMaterial({ color: 0xdd3355, roughness: 0.6 }));
    body.position.y = 0.95; body.castShadow = true;
    const board = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.04, 1.55),
      new THREE.MeshStandardMaterial({ color: 0x111318, roughness: 0.35 }));
    board.position.y = 0.04; board.castShadow = true;
    this.group.add(body, board);
  }
  update() {}
}
