/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** 'offline' | 'ion' | 'google' — voir src/core/config.ts */
  readonly VITE_CESIUM_ION_TOKEN?: string;
  readonly VITE_GOOGLE_MAPS_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Injecté par vite.config.ts pour que Cesium trouve ses Workers et ses Assets. */
declare const CESIUM_BASE_URL: string;
