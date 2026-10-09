/// <reference types="vite/client" />

interface ViteTypeOptions {
  // Reading an undeclared `import.meta.env.*` key is a type error instead of `any`.
  strictImportMetaEnv: unknown;
}

interface ImportMetaEnv {
  /**
   * Origin (optionally with a path prefix) of the Wanderly API, without a trailing slash.
   * Empty or unset means same origin: the dev server and nginx proxy `/api`, `/health`, `/ready`.
   */
  readonly VITE_API_BASE_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
