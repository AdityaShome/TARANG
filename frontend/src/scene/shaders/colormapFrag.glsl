uniform sampler2D u_data;
uniform vec2 u_clim;
uniform float u_opacity;
uniform float u_missing;
varying vec2 vUv;

// Google Turbo colormap approximation
vec3 colormap(float t) {
    t = clamp(t, 0.0, 1.0);
    vec4 c = vec4(
        0.13572138, 4.61539260, -42.66032258, 132.13108234
    );
    vec4 c1 = vec4(
        -152.94239396, 59.05220028, 5.23537139, -27.63670222
    );
    vec4 c2 = vec4(
        3.26620573, -10.42877914, 27.27976775, -57.73030386
    );
    vec4 c3 = vec4(
        42.63973900, -11.66699313, 0.0, 0.0
    );

    float r = c.x + t * (c.y + t * (c.z + t * (c.w + t * (c1.x + t * c1.y))));
    float g = c1.z + t * (c1.w + t * (c2.x + t * (c2.y + t * (c2.z + t * c2.w))));
    float b = c3.x + t * (c3.y + t * (c3.z + t * c3.w)); // Actually wait, Turbo is polynomial, but let's use a robust approximation
    return vec3(r, g, b); // Note: This might not be mathematically perfect Turbo, let's use a guaranteed visual mix instead
}

// Safer, visually stunning Turbo/Inferno mix
vec3 safeColormap(float t) {
    t = clamp(t, 0.0, 1.0);
    // Dark Blue -> Cyan -> Green -> Yellow -> Orange -> Deep Red
    vec3 c0 = vec3(0.1, 0.1, 0.5); // Cold
    vec3 c1 = vec3(0.0, 0.8, 0.8); // Cool
    vec3 c2 = vec3(0.2, 0.9, 0.2); // Mid
    vec3 c3 = vec3(0.9, 0.9, 0.1); // Warm
    vec3 c4 = vec3(0.9, 0.3, 0.0); // Hot
    vec3 c5 = vec3(0.6, 0.0, 0.0); // Extremely Hot
    
    float n = 5.0;
    float scaled = t * n;
    int idx = int(scaled);
    float fract = scaled - float(idx);
    
    if (idx == 0) return mix(c0, c1, fract);
    if (idx == 1) return mix(c1, c2, fract);
    if (idx == 2) return mix(c2, c3, fract);
    if (idx == 3) return mix(c3, c4, fract);
    if (idx >= 4) return mix(c4, c5, fract);
    return c5;
}

void main() {
    float val = texture2D(u_data, vUv).r;
    
    // Discard missing or NaNs (check for equality with tolerance for huge missing values)
    if (val != val || abs(val - u_missing) < (0.01 * abs(u_missing)) || val < -999.0 || val > 9999.0) {
        discard;
    }
    
    float norm = clamp((val - u_clim.x) / (u_clim.y - u_clim.x), 0.0, 1.0);
    vec3 color = safeColormap(norm);
    
    gl_FragColor = vec4(color, u_opacity);
}
