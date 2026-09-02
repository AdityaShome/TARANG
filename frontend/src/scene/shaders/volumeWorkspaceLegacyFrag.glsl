// Fragment shader for Workspace Volume Raymarching
// A simplified AABB raymarcher for a local box in [0, 1] space

precision highp float;
precision highp sampler3D;

in vec3 vLocalPos;
in vec3 vWorldPos;

uniform sampler3D u_data;
uniform vec2 u_clim;
uniform float u_missing;
uniform float u_opacity;
uniform vec3 u_cameraPos;

layout(location = 0) out highp vec4 pc_fragColor;

// Viridis colormap
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

// AABB Intersection against unit box [0, 1]
vec2 intersectAABB(vec3 rayOrigin, vec3 rayDir) {
    vec3 boxMin = vec3(0.0);
    vec3 boxMax = vec3(1.0);
    vec3 tMin = (boxMin - rayOrigin) / rayDir;
    vec3 tMax = (boxMax - rayOrigin) / rayDir;
    vec3 t1 = min(tMin, tMax);
    vec3 t2 = max(tMin, tMax);
    float tNear = max(max(t1.x, t1.y), t1.z);
    float tFar = min(min(t2.x, t2.y), t2.z);
    return vec2(tNear, tFar);
}

void main() {
    // The geometry is a 1x1x1 box at [0,1], but we can just trace from the fragment
    // Calculate ray direction in local space.
    // To do this, we need the camera position in local space. Wait, it's easier to trace in world space?
    // No, standard volume raymarching: camera pos and world pos are known.
    // Instead of doing proper object-space ray intersection which requires `u_modelInv`,
    // we can just use the fragment's local position as the entry point, and the ray direction
    // as normalize(vLocalPos - cameraLocalPos). But wait, what if the camera is inside the box?
    // For the workspace, the camera is always outside.
    
    // Actually, since we have vLocalPos and the camera position in local space (passed via uniform),
    // the ray direction in local space is:
    vec3 rayDir = normalize(vLocalPos - u_cameraPos);
    
    // We already know the ray entered the box at vLocalPos!
    // We just need to find where it exits.
    vec2 tHit = intersectAABB(u_cameraPos, rayDir);
    
    // tHit.x is entry, tHit.y is exit distance from camera
    // Since we are at the front face, the distance from camera to here is exactly tHit.x (if outside).
    // So we just march from vLocalPos to the exit point.
    
    float tStart = max(tHit.x, 0.0);
    float tEnd = tHit.y;
    
    if (tEnd < tStart) {
        discard; // missed box
    }
    
    // Marching parameters
    int maxSteps = 128; // high quality
    float stepSize = (tEnd - tStart) / float(maxSteps);
    vec3 stepVec = rayDir * stepSize;
    
    vec3 currentPos = u_cameraPos + rayDir * tStart;
    // Add small jitter to prevent wood-grain artifacts
    currentPos += stepVec * fract(sin(gl_FragCoord.x * 12.9898 + gl_FragCoord.y * 78.233) * 43758.5453);
    
    vec4 accum = vec4(0.0);
    
    for (int i = 0; i < maxSteps; i++) {
        if (accum.a >= 0.99) break; // early exit
        
        // Sample texture
        // uvw: x=lon, y=lat, z=depth (1=bottom, 0=top in raw data arrays usually)
        // Note: the backend data arrays usually have depth 0 at the surface (index 0).
        // Let's assume standard UVW:
        float val = texture(u_data, currentPos).r;
        
        bool valid = (val == val) && (val != u_missing) && (val > -1.0e4) && (val < 1.0e4);
        if (valid) {
            float norm = clamp((val - u_clim.x) / max(u_clim.y - u_clim.x, 1e-6), 0.0, 1.0);
            vec3 color = viridis(norm);
            float alpha = u_opacity * 0.05; // base density
            
            // Front-to-back alpha blending
            // C = C + (1 - A) * alpha * color
            // A = A + (1 - A) * alpha
            vec4 src = vec4(color * alpha, alpha);
            accum += src * (1.0 - accum.a);
        }
        
        currentPos += stepVec;
        
        // Break if we exit the [0, 1] bounds
        if (any(lessThan(currentPos, vec3(0.0))) || any(greaterThan(currentPos, vec3(1.0)))) {
            break;
        }
    }
    
    if (accum.a < 0.01) {
        discard;
    }
    
    pc_fragColor = accum;
}
