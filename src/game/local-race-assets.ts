let catalog: Promise<Set<string>> | undefined;

export async function localRaceAsset(file: string): Promise<string | null> {
  catalog ??= fetch("/local-assets/race-assets.json")
    .then(async (response) => response.ok ? await response.json() as unknown : [])
    .then((files) => new Set(Array.isArray(files) ? files : []))
    .catch(() => new Set<string>());

  if (!/^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.(?:png|ogg)$/.test(file)) return null;
  return (await catalog).has(file) ? `/local-assets/${file}` : null;
}
