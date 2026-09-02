// Ocean Cube fragment shader — GLSL 3.00 ES
// Renders a 3D cuboid ocean section with:
//   - Vertical depth gradient: deep (dark navy) → surface (teal/cyan)
//   - Seabed solid face when vLocalPos.z < SEABED_THICKNESS
//   - Optional volume data colouring via 3D texture
//   - Transparent water body (uses alpha blending)
//   - Surface water colour tint at top

precision highp float;
precision highp sampler3D;

in vec3 vLocalPos;   // [0,1] box UVW: U=lon, V=lat, W=depth (0=seabed, 1=surface)
in vec3 vWorldPos;

// Volume data (optional — when u_hasData = 1)
uniform sampler3D u_data;
uniform int       u_hasData;
uniform vec2      u_clim;
uniform float     u_missing;
uniform float     u_opacity;

// Gradient parameters
uniform vec3 u_seabedColor;   // bottom face colour
uniform vec3 u_deepColor;     // deep water body colour
uniform vec3 u_surfaceColor;  // surface water colour

// Seabed face thickness in local Z [0,1]
const float SEABED = 0.025;

layout(location = 0) out highp vec4 pc_fragColor;

// Viridis palette — shared with volumeFrag_v2.glsl
vec3 mix5(float t, vec3 c0, vec3 c1, vec3 c2, vec3 c3, vec3 c4) {
    t = clamp(t, 0.0, 1.0) * 4.0;
    float seg = floor(t);
    float f = t - seg;
    if      (seg < 1.0) return mix(c0, c1, f);
    else if (seg < 2.0) return mix(c1, c2, f);
    else if (seg < 3.0) return mix(c2, c3, f);
    else                return mix(c3, c4, f);
}
vec3 viridis(float t) {
    return mix5(t,
        vec3(0.267,0.005,0.329), vec3(0.231,0.322,0.545),
        vec3(0.128,0.567,0.551), vec3(0.369,0.789,0.383),
        vec3(0.993,0.906,0.144));
}

void main() {
    float depthT = clamp(vLocalPos.z, 0.0, 1.0);   // 0 = seabed, 1 = surface

    // ── Seabed solid face ──────────────────────────────────────────────────
    if (depthT < SEABED) {
        // Slightly vary seabed with a procedural pattern for realism
        float nx = sin(vLocalPos.x * 40.0) * sin(vLocalPos.y * 40.0) * 0.07;
        vec3 seabed = u_seabedColor + vec3(nx * 0.5, nx * 0.3, nx * 0.1);
        pc_fragColor = vec4(seabed, 1.0);
        return;
    }

    // ── Sample volume data if available ───────────────────────────────────
    vec3 dataCol = vec3(0.0);
    float dataBlend = 0.0;
    if (u_hasData == 1) {
        // Map depth: local Z=1 = surface → texture depth 0; local Z=0 = seabed → texture depth 1
        // This is because volume textures store depth level 0 at the top (shallowest).
        vec3 uvw = vec3(vLocalPos.x, vLocalPos.y, 1.0 - vLocalPos.z);
        float val = texture(u_data, uvw).r;
        bool valid = (val == val) && (val != u_missing) && (val > -1.0e4) && (val < 1.0e4);
        if (valid) {
            float norm = clamp((val - u_clim.x) / max(u_clim.y - u_clim.x, 1e-6), 0.0, 1.0);
            dataCol = viridis(norm);
            dataBlend = 0.55;  // blend 55% data colour, 45% gradient
        }
    }

    // ── Depth gradient ─────────────────────────────────────────────────────
    // depthT=0 → seabed (just above floor), depthT=1 → surface
    vec3 gradientCol = mix(u_deepColor, u_surfaceColor, depthT * depthT);  // quadratic easing

    // ── Blend gradient + data ──────────────────────────────────────────────
    vec3 waterCol = mix(gradientCol, dataCol, dataBlend);

    // ── Water column transparency: deeper = more opaque, surface = semi-transparent ──
    float waterAlpha = u_opacity * mix(0.92, 0.55, depthT);

    // ── Subtle caustic shimmer at the surface top face ─────────────────────
    if (depthT > 0.95) {
        float shimmer = sin(vLocalPos.x * 80.0 + vLocalPos.y * 80.0) * 0.5 + 0.5;
        waterCol += vec3(0.0, 0.08, 0.12) * shimmer * (depthT - 0.95) * 20.0;
        waterAlpha = mix(waterAlpha, 0.35, (depthT - 0.95) * 20.0);  // surface face very transparent
    }

    pc_fragColor = vec4(waterCol, waterAlpha);
}
