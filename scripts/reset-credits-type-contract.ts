// Compile-time contract: main and renderer share one reset-credit definition.
// Any attempt to restore main/renderer mirror DTOs is intentionally unnecessary.
import type { ProviderResetCreditsData, ProviderResetCredit } from '../src/shared/quotaTypes';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

type _RCContract = Assert<Equal<ProviderResetCreditsData['credits'][number], ProviderResetCredit>>;
type _SourceContract = Assert<Equal<ProviderResetCreditsData['source'], 'api' | 'cache' | 'usage'>>;
