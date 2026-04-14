import { createContext, useContext } from 'react';
import { Theme, LIGHT } from './theme';

export const ThemeContext = createContext<Theme>(LIGHT);
export const ThemeProvider = ThemeContext.Provider;

export function useTheme(): Theme {
  return useContext(ThemeContext);
}
