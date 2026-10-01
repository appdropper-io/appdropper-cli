/**
 * `appdropper/api` — the CLI's internals as a library, for other App Dropper
 * clients (the MCP server first) to build on instead of re-implementing the
 * API, the resumable upload or the login storage.
 *
 * Semver applies to everything exported here. Nothing in this module prints.
 */
export {
  AbortError,
  ApiError,
  AppDropperClient,
  uploadFile,
  userAgent,
  type BuildDetail,
  type BuildSummary,
  type ClientOptions,
  type TokenApp,
  type TokenIdentity,
  type UploadStatus,
  type UploadTicket,
} from "./client";
export {
  DEFAULT_API_URL,
  apiUrl,
  configPath,
  loadCredential,
  resolveToken,
  resolveTokenWithSource,
  type StoredCredential,
  type TokenSource,
} from "./config";
export { detectCi, type CiInfo } from "./ci";
export {
  BUILD_EXTENSIONS,
  BuildFileError,
  BuildProcessingError,
  DEFAULT_PROCESS_TIMEOUT_MS,
  StillProcessingError,
  TransferError,
  inspectBuildFile,
  uploadBuild,
  type BuildFile,
  type BuildFileErrorCode,
  type BuildPlatform,
  type ReadyUpload,
  type UploadBuildOptions,
  type UploadPhase,
} from "./upload-build";
