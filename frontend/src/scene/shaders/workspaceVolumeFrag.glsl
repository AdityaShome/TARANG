precision highp float;
precision highp sampler3D;

in vec3 vWorldPos;

uniform sampler3D u_data;
uniform mat4 u_worldToUnit;   // world → [0,1]^3 box space, ordered (lon, lat, depth)
uniform vec2 u_clim;
uniform float u_opacity;
uniform float u_missing;
uniform float u_colormap;     // 0=viridis 1=plasma 2=magma 3=inferno 4=jet
uniform float u_log_scale;    // 0=linear 1=log
uniform float u_lat_flip;     // 1 → data rows run north→south, mirror the lat axis

layout(location = 0) out highp vec4 pc_fragColor;

// Palette — kept in sync with volumeFrag_v2.glsl / colormapFrag.glsl.
vec3 mix5(float t, vec3 c0, vec3 c1, vec3 c2, vec3 c3, vec3 c4) {
    t = clamp(t, 0.0, 1.0) * 4.0;
    float seg = floor(t);
    float f = t - seg;
    if (seg < 1.0)      return mix(c0, c1, f);
    else if (seg < 2.0) return mix(c1, c2, f);
    else if (seg < 3.0) return mix(c2, c3, f);
    else                return mix(c3, c4, f);
}
vec3 viridis(float t) { return mix5(t, vec3(0.267,0.005,0.329), vec3(0.231,0.322,0.545), vec3(0.128,0.567,0.551), vec3(0.369,0.789,0.383), vec3(0.993,0.906,0.144)); }
vec3 plasma(float t)  { return mix5(t, vec3(0.051,0.031,0.529), vec3(0.494,0.012,0.658), vec3(0.799,0.279,0.471), vec3(0.973,0.585,0.255), vec3(0.940,0.975,0.131)); }
vec3 magma(float t)   { return mix5(t, vec3(0.001,0.001,0.016), vec3(0.231,0.059,0.439), vec3(0.549,0.161,0.506), vec3(0.871,0.288,0.409), vec3(0.987,0.991,0.749)); }
vec3 inferno(float t) { return mix5(t, vec3(0.001,0.001,0.016), vec3(0.259,0.039,0.408), vec3(0.576,0.149,0.404), vec3(0.867,0.318,0.227), vec3(0.988,1.000,0.643)); }
vec3 jetMap(float t) {
    t = clamp(t, 0.0, 1.0);
    return vec3(
        clamp(min(1.5 - abs(2.0*t - 1.5), 1.0), 0.0, 1.0),
        clamp(min(1.5 - abs(2.0*t - 1.0), 1.0), 0.0, 1.0),
        clamp(min(1.5 - abs(2.0*t - 0.5), 1.0), 0.0, 1.0));
}
vec3 safeColormap(float t) {
    // else-if chain (not independent returns) — see the identical note in colormapFrag.glsl.
    if (u_colormap < 0.5)      return viridis(t);
    else if (u_colormap < 1.5) return plasma(t);
    else if (u_colormap < 2.5) return magma(t);
    else if (u_colormap < 3.5) return inferno(t);
    else                       return jetMap(t);
}
float normalize_val(float val) {
    if (u_log_scale > 0.5) {
        float eps = 1e-3;
        float sv = max(val - u_clim.x + eps, eps);
        float sm = max(u_clim.y - u_clim.x + eps, eps * 2.0);
        return clamp(log(sv) / log(sm), 0.0, 1.0);
    }
    return clamp((val - u_clim.x) / (u_clim.y - u_clim.x), 0.0, 1.0);
}

// Slab intersection against the unit box [0,1]^3 for ray ro + t*rd.
vec2 hitBox(vec3 ro, vec3 rd) {
    vec3 safeRd = mix(rd, vec3(1e-6), lessThan(abs(rd), vec3(1e-6)));
    vec3 inv = 1.0 / safeRd;
    vec3 t0s = (vec3(0.0) - ro) * inv;
    vec3 t1s = (vec3(1.0) - ro) * inv;
    vec3 tmin = min(t0s, t1s);
    vec3 tmax = max(t0s, t1s);
    return vec2(max(max(tmin.x, tmin.y), tmin.z),
                min(min(tmax.x, tmax.y), tmax.z));
}

void main() {
    vec3 rdWorld = normalize(vWorldPos - cameraPosition);
    vec3 ro = (u_worldToUnit * vec4(cameraPosition, 1.0)).xyz;
    vec3 rd = (u_worldToUnit * vec4(rdWorld, 0.0)).xyz;

    vec2 bounds = hitBox(ro, rd);
    bounds.x = max(bounds.x, 0.0);
    if (bounds.x >= bounds.y) discard;

    const int STEPS = 256;
    float dt = (bounds.y - bounds.x) / float(STEPS);

    float maxValue = -1e20;
    int validSamples = 0;

    for (int i = 0; i < STEPS; i++) {
        float t = bounds.x + (float(i) + 0.5) * dt;
        vec3 uvw = clamp(ro + t * rd, 0.0, 1.0);
        if (u_lat_flip > 0.5) uvw.y = 1.0 - uvw.y;
        float val = texture(u_data, uvw).r;
        bool valid = (val == val) && (val != u_missing) && (val > -1.0e4) && (val < 1.0e4);
        if (valid) {
            validSamples++;
            maxValue = max(maxValue, val);
        }
    }

    if (validSamples == 0) discard;
    pc_fragColor = vec4(safeColormap(normalize_val(maxValue)), u_opacity);
}
