import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
const thinking = new Set(["off","minimal","low","medium","high","xhigh","max"]);
export function absoluteDir(value: unknown, name="cwd"): string { if(typeof value!=="string"||!value.trim()) throw new Error(`${name} must be a non-empty path`); if(!value.startsWith("/")) throw new Error(`${name} must be absolute`); return resolve(value); }
export function safeText(value: unknown, name:string, max=16_384): string|undefined { if(value===undefined) return undefined; if(typeof value!=="string" || value.length>max || value.includes("\0")) throw new Error(`${name} must be text up to ${max} bytes`); return value; }
export function safeName(value:unknown):string|undefined { const x=safeText(value,"name",120); if(x!==undefined&&!/^[\w .:/-]+$/.test(x)) throw new Error("name contains unsupported characters"); return x; }
export function validateModel(value:unknown, allowed?:string[]):string|undefined { const x=safeText(value,"model",200); if(x!==undefined && (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.:-]+$/.test(x)||(allowed?.length&&!allowed.includes(x)))) throw new Error("model is not permitted by configuration"); return x; }
export function validateThinking(value:unknown, allowed?:string[]):string|undefined { const x=safeText(value,"thinking",20); if(x!==undefined && (!thinking.has(x)||(allowed?.length&&!allowed.includes(x)))) throw new Error("thinking is not permitted"); return x; }
export function branch(value:unknown):string { if(typeof value!=="string"||! /^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(value)||value.includes("..")||value.endsWith("/")||value.includes("//")) throw new Error("invalid Git branch"); return value; }
export function uuid():string{return randomUUID();}
