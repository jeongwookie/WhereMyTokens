import type { ProviderAdapter, ProviderId } from './types';

export class ProviderRegistry {
  private providers = new Map<ProviderId, ProviderAdapter>();

  register(provider: ProviderAdapter): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
  }

  get(id: ProviderId): ProviderAdapter | null {
    return this.providers.get(id) ?? null;
  }

  getAll(): ProviderAdapter[] {
    return [...this.providers.values()];
  }

  getEnabled(ids: readonly ProviderId[]): ProviderAdapter[] {
    return ids
      .map(id => this.providers.get(id))
      .filter((provider): provider is ProviderAdapter => !!provider);
  }
}
