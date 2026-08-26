precision highp float;
precision highp sampler3D;

in vec3 vOrigin;
in vec3 vDirection;

uniform sampler3D u_data;
uniform vec2 u_clim;
uniform float u_opacity;
uniform float u_missing;
uniform int u_renderstyle; // 0: MIP, 1: ISO
uniform float u_iso_threshold;


layout(location = 0) out highp vec4 pc_fragColor;

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

vec2 hitBox(vec3 orig, vec3 dir) {
    vec3 box_min = vec3(-0.5);
    vec3 box_max = vec3(0.5);
    vec3 inv_dir = 1.0 / dir;
    vec3 tmin_tmp = (box_min - orig) * inv_dir;
    vec3 tmax_tmp = (box_max - orig) * inv_dir;
    vec3 tmin = min(tmin_tmp, tmax_tmp);
    vec3 tmax = max(tmin_tmp, tmax_tmp);
    float t0 = max(tmin.x, max(tmin.y, tmin.z));
    float t1 = min(tmax.x, min(tmax.y, tmax.z));
    return vec2(t0, t1);
}

float sample1(vec3 p) {
    return texture(u_data, p).r;
}

void main() {
    vec3 rayDir = normalize(vDirection);
    vec2 bounds = hitBox(vOrigin, rayDir);
    
    if (bounds.x > bounds.y) discard;

    bounds.x = max(bounds.x, 0.0);
    vec3 p = vOrigin + bounds.x * rayDir;
    vec3 inc = 1.0 / abs(rayDir);
    float delta = min(inc.x, min(inc.y, inc.z)) / 200.0;
    vec3 rayStep = rayDir * delta;
    
    float maxValue = -99999.0;
    vec4 accColor = vec4(0.0);

    for (int i = 0; i < 500; i++) {
        float t = bounds.x + float(i) * delta;
        if (t > bounds.y || accColor.a >= 0.95) break;

        vec3 uvw = p + vec3(0.5);
        float val = sample1(uvw);

        if (val != u_missing && val > -999.0 && val < 9999.0) {
            if (u_renderstyle == 0) { // MIP
                if (val > maxValue) maxValue = val;
            } else { // ISO
                if (val >= u_iso_threshold) {
                    float norm = clamp((val - u_clim.x) / (u_clim.y - u_clim.x), 0.0, 1.0);
                    accColor = vec4(safeColormap(norm), u_opacity);
                    break;
                }
            }
        }
        p += rayStep;
    }

    if (u_renderstyle == 0) {
        if (maxValue == -99999.0) discard;
        float norm = clamp((maxValue - u_clim.x) / (u_clim.y - u_clim.x), 0.0, 1.0);
        accColor = vec4(safeColormap(norm), u_opacity);
    }

    if (accColor.a == 0.0) discard;
    pc_fragColor = accColor;
}
