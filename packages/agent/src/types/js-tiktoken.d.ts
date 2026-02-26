declare module "js-tiktoken" {
  export function encodingForModel(model: string): { encode: (text: string) => number[] };
  export function encoding_for_model(model: string): { encode: (text: string) => number[] };
  export function getEncoding(name: string): { encode: (text: string) => number[] };
  const _default: any;
  export default _default;
}
