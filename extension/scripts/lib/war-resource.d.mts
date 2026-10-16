export function resourceCovers(resource: string, path: string): boolean;
export function exposedPromptResources(
  manifest: { web_accessible_resources?: Array<{ resources?: string[] }> },
  path: string,
): string[];
