// Compile-time contract: the renderer mirror must be structurally identical to the main public type.
// If either side drifts, `tsc --noEmit` on the scoped tsconfig below fails to compile.
import type { ProviderResetCreditsData as MainRC, ProviderResetCredit as MainRow } from '../src/main/providers/types';
import type { ProviderResetCreditsData as RendererRC, ProviderResetCredit as RendererRow } from '../src/renderer/types';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
type Assert<T extends true> = T;

// These lines are compile errors if the two definitions ever diverge in field set or types.
type _RCContract = Assert<Equal<MainRC, RendererRC>>;
type _RowContract = Assert<Equal<MainRow, RendererRow>>;
