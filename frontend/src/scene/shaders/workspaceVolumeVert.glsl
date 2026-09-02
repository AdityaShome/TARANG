// Vertex shader for Workspace Volume Raymarching
out vec3 vLocalPos;
out vec3 vWorldPos;

void main() {
  // position is the local vertex position in [-0.5, 0.5] from BoxGeometry
  vLocalPos = position + 0.5; // shift to [0, 1] for 3D texture sampling UVW
  vec4 worldPos = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos;
}
