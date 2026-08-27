/// <reference types="vite/client" />

declare module '*.glsl?raw' {
  const content: string
  export default content
}

declare module 'plotly.js-dist-min' {
  export * from 'plotly.js'
  export { default } from 'plotly.js'
}
