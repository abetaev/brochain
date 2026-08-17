export interface Registry {
  list(): readonly string[];
}

export const registryServiceName = "registry";

export function createRegistry(hostedServiceNames: () => readonly string[]): Registry {
  return { list: hostedServiceNames };
}

export function validateServiceNames(value: unknown): readonly string[] {
  if (
    !Array.isArray(value) ||
    !value.every((name) => typeof name === "string" && name.length > 0) ||
    !value.includes(registryServiceName) ||
    new Set(value).size !== value.length
  ) {
    throw new Error("Peer returned invalid service names.");
  }
  return [...value];
}
