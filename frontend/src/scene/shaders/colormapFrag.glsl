uniform sampler2D u_data;
uniform vec2 u_clim;
uniform float u_opacity;
uniform float u_missing;
varying vec2 vUv;

// Simple viridis approximation
vec3 colormap(float t) {
    const vec3 c0 = vec3(0.277, 0.005, 0.334);
    const vec3 c1 = vec3(0.105, 0.403, 0.468);
    const vec3 c2 = vec3(0.122, 0.617, 0.419);
    const vec3 c3 = vec3(0.993, 0.906, 0.144);
    return mix(mix(c0, c1, smoothstep(0.0, 0.33, t)),
               mix(c2, c3, smoothstep(0.66, 1.0, t)),
               smoothstep(0.33, 0.66, t));
}

void main() {
    float val = texture2D(u_data, vUv).r;
    
    // Discard missing or NaNs
    if (val == u_missing || val < -999.0 || val > 9999.0) {
        discard;
    }
    
    float norm = clamp((val - u_clim.x) / (u_clim.y - u_clim.x), 0.0, 1.0);
    vec3 color = colormap(norm);
    
    gl_FragColor = vec4(color, u_opacity);
}
