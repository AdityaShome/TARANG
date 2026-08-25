out vec3 vOrigin;
out vec3 vDirection;

void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vOrigin = vec3(inverse(modelMatrix) * vec4(cameraPosition, 1.0));
    vDirection = position - vOrigin;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
}
