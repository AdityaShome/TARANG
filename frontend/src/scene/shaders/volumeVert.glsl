out vec3 vWorldPos;

// Pass world position only; the fragment shader builds the ray from it + u_modelInv.
void main() {
    vec4 wp = modelMatrix * vec4(position, 1.0);
    vWorldPos = wp.xyz;
    gl_Position = projectionMatrix * viewMatrix * wp;
}
