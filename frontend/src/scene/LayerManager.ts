import * as THREE from 'three'

export interface LayerParams {
  source: string
  variable: string
  timeIdx: number
  depthIdx: number
  bbox: [number, number, number, number]
  colormap: string
  clim: [number, number]
  opacity?: number
}

export interface Layer {
  build(scene: THREE.Scene): void
  update(params: Partial<LayerParams>): Promise<void>
  // Layers are built once and kept alive for the scene's lifetime — this hides/shows
  // whatever mesh(es) they currently own without disposing them, so switching render
  // mode or unchecking a layer actually removes it from view instead of leaving a
  // stale mesh from the last time it had data.
  setVisible(visible: boolean): void
  dispose(): void
}

export class LayerManager {
  private scene: THREE.Scene
  private layers: Map<string, Layer> = new Map()

  constructor(scene: THREE.Scene) {
    this.scene = scene
  }

  addLayer(id: string, layer: Layer) {
    if (this.layers.has(id)) {
      this.layers.get(id)!.dispose()
    }
    this.layers.set(id, layer)
    layer.build(this.scene)
  }

  getLayer(id: string): Layer | undefined {
    return this.layers.get(id)
  }

  removeLayer(id: string) {
    const layer = this.layers.get(id)
    if (layer) {
      layer.dispose()
      this.layers.delete(id)
    }
  }

  disposeAll() {
    this.layers.forEach(layer => layer.dispose())
    this.layers.clear()
  }
}
