// Ocean Cube vertex shader
// Passes local normalised position (0-1) and world position to fragment shader.
// The mesh is a unit BoxGeometry centred at origin; SceneManager sets its
// world transform via position/quaternion/scale after every fetch.

out vec3 vLocalPos;
out vec3 vWorldPos;

void main() {
  // position is already in local box space [-0.5, 0.5]; shift to [0, 1].
  vLocalPos = position + 0.5;
  vec4 worldPos4 = modelMatrix * vec4(position, 1.0);
  vWorldPos = worldPos4.xyz;
  gl_Position = projectionMatrix * viewMatrix * worldPos4;
}
