import * as THREE from 'three'

// Must match SceneManager.tsx's EARTH_RADIUS exactly — every layer that places geometry on the
// globe shares this convention (duplicated per-file historically; kept here for the one thing
// that must never drift between layers: orientation — see surfaceBasis below).
export const EARTH_RADIUS = 200

export function latLonToXYZ(lat: number, lon: number, r = EARTH_RADIUS): THREE.Vector3 {
  const phi = (90 - lat) * (Math.PI / 180)
  const theta = (lon + 180) * (Math.PI / 180)
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
     r * Math.cos(phi),
     r * Math.sin(phi) * Math.sin(theta),
  )
}

// Orthonormal outward/east/north basis at a lat/lon point on the globe.
//
// Every layer that orients a mesh tangent to the sphere (VolumeLayer's box, IsosurfaceLayer's
// marching-cubes mesh) MUST build its rotation from this same basis. Independently computing
// `Quaternion.setFromUnitVectors(localDepthAxis, outward)` per layer only pins the depth axis —
// rotation around that axis is left unconstrained, and starts from a different local axis in
// each layer (VolumeLayer's box uses local Z as depth, IsosurfaceLayer's marching-cubes mesh is
// forced to local X by the voxel index order) — so two boxes representing the identical bbox
// rendered at different rotations around the outward normal. This was a real, visible bug: a
// volume box and an isosurface box for the same region appeared as two overlapping, misaligned
// boxes. Building the full three-axis rotation here for every layer to share removes the
// ambiguity entirely.
export function surfaceBasis(lat: number, lon: number) {
  const outward = latLonToXYZ(lat, lon, 1)
  const eps = 0.05
  const east  = latLonToXYZ(lat, lon + eps, 1).sub(outward).normalize()
  const north = latLonToXYZ(lat + eps, lon, 1).sub(outward).normalize()
  return { east, north, outward }
}
