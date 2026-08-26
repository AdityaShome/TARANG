uniform vec4 u_bounds; // minLon, maxLon, minLat, maxLat
varying vec2 vUv;

void main() {
  vUv = uv;
  
  // 1. Map uv to lat/lon using bounds
  float lon = mix(u_bounds.x, u_bounds.y, uv.x);
  float lat = mix(u_bounds.z, u_bounds.w, uv.y);
  
  // 2. Convert lat/lon to spherical XYZ (Radius = 200.5, slightly above Earth radius 200)
  float phi = (90.0 - lat) * (3.14159265 / 180.0);
  float theta = (lon + 90.0) * (3.14159265 / 180.0); // +90 to match Earth's texture alignment
  
  float r = 200.5;
  vec3 spherePos;
  spherePos.x = r * sin(phi) * cos(theta);
  spherePos.y = r * cos(phi);
  spherePos.z = r * sin(phi) * sin(theta);

  gl_Position = projectionMatrix * modelViewMatrix * vec4(spherePos, 1.0);
}
