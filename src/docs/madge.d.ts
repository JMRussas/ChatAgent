/** The parts of Madge's API used by the import-graph tool; Madge ships no types. */
declare module "madge" {
  interface MadgeResult {
    obj(): Record<string, string[]>;
    warnings(): { skipped: string[] };
    circular(): string[][];
  }
  interface MadgeOptions {
    fileExtensions?: string[];
    tsConfig?: string;
    detectiveOptions?: Record<string, unknown>;
  }
  export default function madge(
    path: string | string[],
    config?: MadgeOptions
  ): Promise<MadgeResult>;
}
