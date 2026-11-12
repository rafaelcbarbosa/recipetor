import type { Recipe } from "../recipe-schema.ts";

export interface ExtractOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

export interface ExtractorAdapter {
  readonly name: string;
  readonly model: string | null;
  readonly provider: string | null;
  extract(url: string, options: ExtractOptions): Promise<Recipe>;
  isAvailable(): Promise<boolean>;
}
