import * as THREE from 'three'
import { Layer, LayerParams } from '../LayerManager'
import { fetchIsosurface } from '../../api/client'
import { useTarangStore } from '../../state/store'

export class IsosurfaceLayer implements Layer {
  private mesh: THREE.Mesh | null = null
  private scene: THREE.Scene | null = null
  private abortController: AbortController | null = null

  build(scene: THREE.Scene) {
    this.scene = scene
  }

  async update(params: Partial<LayerParams>) {
    const state = useTarangStore.getState()
    const threshold = state.isoThreshold
    
    if (params.source && params.variable && params.bbox && params.timeIdx !== undefined) {
      if (this.abortController) this.abortController.abort()
      this.abortController = new AbortController()

      try {
        const { header, verts, normals, faces } = await fetchIsosurface({
          source: params.source,
          var: params.variable,
          time: params.timeIdx,
          bbox: params.bbox,
          threshold: threshold
        }, this.abortController.signal)
        
        if (this.mesh && this.scene) {
          this.scene.remove(this.mesh)
          this.mesh.geometry.dispose()
          ;(this.mesh.material as THREE.Material).dispose()
        }

        const geometry = new THREE.BufferGeometry()
        
        // Note: skimage marching_cubes on (depth, lat, lon) returns verts as (z, y, x)
        // Three.js uses (x, y, z) for rendering. We should ideally swizzle it, 
        // but we can also use scaling and rotation to fix the orientation.
        // Let's just create the buffer directly for performance:
        geometry.setAttribute('position', new THREE.BufferAttribute(verts, 3))
        geometry.setAttribute('normal', new THREE.BufferAttribute(normals, 3))
        geometry.setIndex(new THREE.BufferAttribute(faces, 1))
        
        const material = new THREE.MeshPhongMaterial({
          color: 0x00d4ff, // Cyan for isosurface
          side: THREE.DoubleSide,
          transparent: true,
          opacity: params.opacity ?? 0.8,
          shininess: 60
        })

        this.mesh = new THREE.Mesh(geometry, material)
        
        const widthDeg = 20
        const heightDeg = 20
        
        const maxDepthM = Math.max(...header.depth_levels)
        const vExag = state.colormap.verticalExaggeration || 50
        const depthScale = (maxDepthM / 111000) * vExag 

        // Apply scale. Verts are (depth, lat, lon).
        // scale.x applies to depth, scale.y applies to lat, scale.z applies to lon.
        this.mesh.scale.set(depthScale / depthSize, heightDeg / latSize, widthDeg / lonSize)
        
        // Rotate to match standard XZ ocean plane
        this.mesh.rotation.order = 'YXZ'
        this.mesh.rotation.y = Math.PI / 2
        this.mesh.rotation.x = -Math.PI / 2
        
        this.scene!.add(this.mesh)
        
      } catch (err: any) {
        if (err.name !== 'AbortError') console.error(err)
      }
    }
  }

  dispose() {
    if (this.abortController) this.abortController.abort()
    if (this.mesh && this.scene) {
      this.scene.remove(this.mesh)
      this.mesh.geometry.dispose()
      ;(this.mesh.material as THREE.Material).dispose()
    }
  }
}
