uniform sampler2D u_data;
uniform vec2 u_clim;
uniform float u_opacity;
uniform float u_missing;
uniform float u_colormap;   // 0=viridis 1=plasma 2=magma 3=inferno 4=jet — see ColormapName in api/types.ts
uniform float u_log_scale;  // 0=linear 1=log
varying vec2 vUv;

// 5-stop piecewise-linear interpolation, evenly spaced at t=0,0.25,0.5,0.75,1.0. Stop colors
// below are standard matplotlib colormap sample points (viridis/plasma/magma/inferno) — not a
// mathematically exact reproduction, but visually matches the real thing closely enough to
// actually mean something when a researcher picks one from the dropdown, unlike the previous
// single hardcoded gradient that never changed no matter which palette was selected.
vec3 mix5(float t, vec3 c0, vec3 c1, vec3 c2, vec3 c3, vec3 c4) {
    t = clamp(t, 0.0, 1.0) * 4.0;
    float seg = floor(t);
    float f = t - seg;
    if (seg < 1.0) {
        return mix(c0, c1, f);
    } else if (seg < 2.0) {
        return mix(c1, c2, f);
    } else if (seg < 3.0) {
        return mix(c2, c3, f);
    } else {
        return mix(c3, c4, f);
    }
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
vec3 jet(float t) {
    t = clamp(t, 0.0, 1.0);
    float r = clamp(min(1.5 - abs(2.0 * t - 1.5), 1.0), 0.0, 1.0);
    float g = clamp(min(1.5 - abs(2.0 * t - 1.0), 1.0), 0.0, 1.0);
    float b = clamp(min(1.5 - abs(2.0 * t - 0.5), 1.0), 0.0, 1.0);
    return vec3(r, g, b);
}

vec3 applyColormap(float t) {
    // else-if (not independent `if (cond) return`) so every backend's control-flow analysis can
    // see this is exhaustive — the ANGLE GLSL->HLSL translator (used on the D3D11 WebGL backend)
    // flagged the independent-if form as "use of potentially uninitialized variable" even though
    // every branch returns, because it flattens early returns into a temp-variable pattern and
    // couldn't statically prove the conditions cover all cases without an explicit else.
    if (u_colormap < 0.5) {
        return viridis(t);
    } else if (u_colormap < 1.5) {
        return plasma(t);
    } else if (u_colormap < 2.5) {
        return magma(t);
    } else if (u_colormap < 3.5) {
        return inferno(t);
    } else {
        return jet(t);
    }
}

void main() {
    float val = texture2D(u_data, vUv).r;

    // Discard missing or NaNs (check for equality with tolerance for huge missing values)
    if (val != val || abs(val - u_missing) < (0.01 * abs(u_missing)) || val < -999.0 || val > 9999.0) {
        discard;
    }

    float norm;
    if (u_log_scale > 0.5) {
        // Shift so the bottom of the range sits just above zero — log() is undefined/negative
        // at and below 0, and clim.x can itself be negative (e.g. temperature in °C), so we
        // can't log the raw value directly. A fixed epsilon keeps log(shiftedMin) finite instead
        // of spiking to -infinity right at the range floor.
        float epsilon = 1e-3;
        float shiftedVal = max(val - u_clim.x + epsilon, epsilon);
        float shiftedMax = max(u_clim.y - u_clim.x + epsilon, epsilon * 2.0);
        norm = clamp(log(shiftedVal) / log(shiftedMax), 0.0, 1.0);
    } else {
        norm = clamp((val - u_clim.x) / (u_clim.y - u_clim.x), 0.0, 1.0);
    }

    vec3 color = applyColormap(norm);

    gl_FragColor = vec4(color, u_opacity);
}
