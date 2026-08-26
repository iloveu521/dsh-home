import { t as ReefContext } from "./types-C0SycesU.mjs";
//#region src/console.d.ts
declare const name = "reef-console";
declare const inject: string[];
declare function apply(ctx: ReefContext, rawConfig: Record<string, any>): void;
//#endregion
export { apply, inject, name };