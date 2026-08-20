export type JsxElement = { type: string; key: string | null; props: Record<string, unknown> }
export function jsxDEV(type: string, props: Record<string, unknown>, key?: string | null): JsxElement
export function jsxs(type: string, props: Record<string, unknown>, key?: string | null): JsxElement
export const Fragment: string
export namespace JSX {
  type Element = JsxElement
  interface IntrinsicElements { [elemName: string]: Record<string, unknown> }
}
