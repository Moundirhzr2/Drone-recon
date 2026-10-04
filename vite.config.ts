import { defineConfig } from 'vite';
import { viteStaticCopy } from 'vite-plugin-static-copy';

// Cesium a besoin que ses Workers / Assets / Widgets soient servis en statique.
// C'est la methode recommandee par Cesium pour Vite.
const cesiumSource = 'node_modules/cesium/Build/Cesium';
const cesiumBaseUrl = 'cesiumStatic';

export default defineConfig({
  define: {
    CESIUM_BASE_URL: JSON.stringify(`/${cesiumBaseUrl}`),
  },
  plugins: [
    viteStaticCopy({
      targets: [
        { src: `${cesiumSource}/ThirdParty`, dest: cesiumBaseUrl },
        { src: `${cesiumSource}/Workers`, dest: cesiumBaseUrl },
        { src: `${cesiumSource}/Assets`, dest: cesiumBaseUrl },
        { src: `${cesiumSource}/Widgets`, dest: cesiumBaseUrl },
      ],
    }),
  ],
  // onnxruntime-web charge son moteur WebAssembly à côté de son propre script
  // (`new URL(…, import.meta.url)`) : le préassemblage de Vite casserait ce
  // chemin en développement. Le worker du modèle, lui, est un module ES.
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 5173,
    open: true,
  },
});
