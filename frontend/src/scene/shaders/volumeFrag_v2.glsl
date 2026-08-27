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
uniform float u_colormap;   // 0=viridis 1=plasma 2=magma 3=inferno 4=jet — see colormapFrag.glsl
uniform float u_log_scale;  // 0=linear 1=log


layout(location = 0) out highp vec4 pc_fragColor;

// Same palette functions as colormapFrag.glsl (DepthSliceLayer) — kept in sync so a colormap
// picked in the UI looks the same whether you're looking at a Slice or a Volume render. See
// that file for the "why 5-stop mix, why these particular stops" rationale.
vec3 mix5(float t, vec3 c0, vec3 c1, vec3 c2, vec3 c3, vec3 c4) {
    t = clamp(t, 0.0, 1.0) * 4.0;
    float seg = floor(t);
    float f = t - seg;
    if (seg < 1.0) return mix(c0, c1, f);
    if (seg < 2.0) return mix(c1, c2, f);
    if (seg < 3.0) return mix(c2, c3, f);
    return mix(c3, c4, f);
}
vec3 viridis(float t) {
    return mix5(t,
        vec3(0.267, 0.005, 0.329), vec3(0.231, 0.322, 0.545),
        vec3(0.128, 0.567, 0.551), vec3(0.369, 0.789, 0.383),
        vec3(0.993, 0.906, 0.144));
}
vec3 plasma(float t) {
    return mix5(t,
        vec3(0.051, 0.031, 0.529), vec3(0.494, 0.012, 0.658),
        vec3(0.799, 0.279, 0.471), vec3(0.973, 0.585, 0.255),
        vec3(0.940, 0.975, 0.131));
}
vec3 magma(float t) {
    return mix5(t,
        vec3(0.001, 0.001, 0.016), vec3(0.231, 0.059, 0.439),
        vec3(0.549, 0.161, 0.506), vec3(0.871, 0.288, 0.409),
        vec3(0.987, 0.991, 0.749));
}
vec3 inferno(float t) {
    return mix5(t,
        vec3(0.001, 0.001, 0.016), vec3(0.259, 0.039, 0.408),
        vec3(0.576, 0.149, 0.404), vec3(0.867, 0.318, 0.227),
        vec3(0.988, 1.000, 0.643));
}
vec3 jetMap(float t) {
    t = clamp(t, 0.0, 1.0);
    float r = clamp(min(1.5 - abs(2.0 * t - 1.5), 1.0), 0.0, 1.0);
    float g = clamp(min(1.5 - abs(2.0 * t - 1.0), 1.0), 0.0, 1.0);
    float b = clamp(min(1.5 - abs(2.0 * t - 0.5), 1.0), 0.0, 1.0);
    return vec3(r, g, b);
}
vec3 safeColormap(float t) {
    if (u_colormap < 0.5) return viridis(t);
    if (u_colormap < 1.5) return plasma(t);
    if (u_colormap < 2.5) return magma(t);
    if (u_colormap < 3.5) return inferno(t);
    return jetMap(t);
}
float normalize_val(float val) {
    if (u_log_scale > 0.5) {
        float epsilon = 1e-3;
        float shiftedVal = max(val - u_clim.x + epsilon, epsilon);
        float shiftedMax = max(u_clim.y - u_clim.x + epsilon, epsilon * 2.0);
        return clamp(log(shiftedVal) / log(shiftedMax), 0.0, 1.0);
    }
    return clamp((val - u_clim.x) / (u_clim.y - u_clim.x), 0.0, 1.0);
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
                    accColor = vec4(safeColormap(normalize_val(val)), u_opacity);
                    break;
                }
            }
        }
        p += rayStep;
    }

    if (u_renderstyle == 0) {
        if (maxValue == -99999.0) discard;
        accColor = vec4(safeColormap(normalize_val(maxValue)), u_opacity);
    }

    if (accColor.a == 0.0) discard;
    pc_fragColor = accColor;
}
