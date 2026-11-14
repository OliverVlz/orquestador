/**
 * Los motores que conoce el orquestador. Este es el único archivo que sabe cuáles existen:
 * añadir uno es un archivo nuevo en esta carpeta y una línea aquí.
 */
import { agy } from './agy.ts';
import { claude } from './claude.ts';
import { codex } from './codex.ts';
import { desktop } from './desktop.ts';
import { gemini } from './gemini.ts';
import type { Motor } from './tipos.ts';

export const MOTORES: Record<string, Motor> = {
  claude,
  codex,
  agy,
  gemini,
  desktop,
};
