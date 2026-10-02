export * from "./models.js";
export * from "./fixtures/index.js";
export * from "./encounter-ingest.js";
export * from "./eightMinute.js";
export * from "./claimDocument.js";

export const prototype = "pt-rcm";

export function projectStatus(): string {
  return "pt-rcm skeleton ready";
}
